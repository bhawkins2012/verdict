// Admin approval board: drag lever cards between "Candidates" and a five-slot "Publish set".
//
// - Mouse, touch and keyboard drag (dnd-kit): each card has a drag handle; on the keyboard, focus the handle,
//   press Space or Enter to pick up, arrow keys to move, Space or Enter to drop, Escape to cancel.
// - Every move is also in the card's Actions menu (Add to set / Move up / Move down / Remove from set), so
//   nothing needs dragging.
// - Screen readers hear what each drag and menu action does; the wording comes from the same planDrop() the
//   drop itself uses (lib/publishSet.ts).
// - A sixth lever is refused, with the reason shown and announced. The server enforces the five too.
import { KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  Announcements, closestCorners, CollisionDetection, DndContext, getClientRect, DroppableContainer, KeyboardCode, KeyboardCoordinateGetter, DragEndEvent, DragOverEvent, DragOverlay, DragStartEvent,
  KeyboardSensor, MouseSensor, ScreenReaderInstructions, TouchSensor, UniqueIdentifier, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, MoreHorizontal, X } from 'lucide-react'
import clsx from 'clsx'
import { AdminLever } from '../../types/levers'
import { TYPE_LABEL } from './LeverForm'
import {
  addToSet, applyDrop, candidatesOf, FULL_MESSAGE, isComplete, moveBy, planDrop, publishPayload, removeFromSet,
  SET_SIZE, Zone, zoneOf,
} from '../../lib/publishSet'

export interface PublishBoardProps {
  levers: AdminLever[]
  set: string[]
  onSetChange: (next: string[]) => void
  onPublish: (leverIds: string[]) => void
  publishing?: boolean
  /** Edit and Retire controls (and the edit form) for a card. */
  renderControls: (lever: AdminLever) => ReactNode
  /** Status shown under the publish button (errors, "Published."). */
  publishStatus?: ReactNode
  /** Cards that must not move (their Edit form is open): moving remounts the card and would drop the draft. */
  lockedIds?: ReadonlySet<string>
}

const NO_LOCKS: ReadonlySet<string> = new Set()
const LOCKED_HINT = 'close its edit form first'

export const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To move a lever, press Space or Enter on its drag handle to pick it up. Up and Down arrows move it within its ' +
    'list; Left and Right arrows move it between Candidates and the publish set. Press Space or Enter to drop it, ' +
    'or Escape to cancel. Each card also has an Actions menu with the same moves.',
}

/**
 * Mouse and touch (a pointer): whatever the pointer is inside wins, a card over the zone around it, so
 * dropping anywhere in a zone counts (closestCorners alone lets a nearby small card beat the tall zone the
 * pointer is in). Outside both zones there is no target, so the drop changes nothing. In the gaps between
 * publish-set cards the nearest card wins, so a drop between #3 and #4 does not jump to the last slot.
 *
 * Hit-testing uses each drop target's live position (measured now, ignoring sort transforms): dnd-kit keeps the positions it
 * measured when the drag started, and when auto-scroll moves <main> under a held card (on phones, the publish
 * set is above the candidates and off screen) those are stale and the drop would miss the zone under the finger.
 *
 * Keyboard drags use closestCorners, which follows the arrow-key movement (see createBoardCollision).
 */
export function pointerCollision(args: Parameters<CollisionDetection>[0], point: { x: number; y: number }): ReturnType<CollisionDetection> {
  const { x, y } = point
  const targets = args.droppableContainers
    .filter((c) => !c.disabled)
    .map((c) => {
      const node = c.node.current
      // Live position, but ignoring the CSS transform dnd-kit applies to shift cards while sorting (the slot a
      // card occupies is where it sits untransformed, which is also how dnd-kit measures).
      return { id: c.id, zone: c.data.current?.zone as unknown, rect: node ? getClientRect(node, { ignoreTransform: true }) : args.droppableRects.get(c.id) }
    })
    .filter((t): t is { id: UniqueIdentifier; zone: unknown; rect: NonNullable<typeof t.rect> } => t.rect !== undefined && t.rect !== null)
  const inside = (r: { top: number; left: number; width: number; height: number }) =>
    x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height
  const hits = targets.filter((t) => inside(t.rect))
  const cards = hits.filter((t) => t.id !== 'set' && t.id !== 'candidates')
  if (cards.length > 0) return cards.map((t) => ({ id: t.id }))
  if (hits.some((t) => t.id === 'set')) {
    const setCards = targets.filter((t) => t.zone === 'set')
    if (setCards.length > 0) {
      const top = Math.min(...setCards.map((c) => c.rect.top))
      const bottom = Math.max(...setCards.map((c) => c.rect.top + c.rect.height))
      if (y >= top && y <= bottom) {
        const dist = (c: (typeof setCards)[number]) => Math.abs(c.rect.top + c.rect.height / 2 - y)
        const nearest = setCards.reduce((a, b) => (dist(b) < dist(a) ? b : a))
        return [{ id: nearest.id }]
      }
    }
  }
  // The zone itself (empty-slot area: append), or nothing (outside both zones).
  return hits.map((t) => ({ id: t.id }))
}

/** Per-board drag state the collision detection needs between events. */
export class DragTracking {
  /** Last pointer position seen in this drag. A touchend carries no coordinates, so the drop reuses it. */
  lastPointer: { x: number; y: number } | null = null
  /** Called at every drag start, so a keyboard drag never inherits a pointer from an earlier mouse drag. */
  start() {
    this.lastPointer = null
  }
}

/**
 * The board's collision detection. Mouse and touch: pointerCollision at the pointer, or at the last known
 * pointer when an event has none (touchend), so the drop lands where the last "would go to …" announcement
 * said rather than on whatever droppable happens to be nearest. Keyboard drags never have a pointer:
 * closestCorners, which follows the arrow-key movement.
 */
export function createBoardCollision(tracking: DragTracking): CollisionDetection {
  return (args) => {
    const point = args.pointerCoordinates ?? tracking.lastPointer
    if (!point) return closestCorners(args)
    tracking.lastPointer = point
    return pointerCollision(args, point)
  }
}

/**
 * Keyboard moves: Up and Down move within a list (dnd-kit's sortable behaviour); Left and Right always go to
 * the other zone. By default Left/Right pick the nearest droppable in that direction, which from a publish-set
 * card is the set's own zone edge, so the card jumped to slot 1 and could not be moved out with the keyboard.
 */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (event.code !== KeyboardCode.Left && event.code !== KeyboardCode.Right) return sortableKeyboardCoordinates(event, args)
  const { context } = args
  const activeId = context.active?.id
  const zone: unknown = context.active?.data.current?.zone
  if (activeId === undefined || (zone !== 'set' && zone !== 'candidates')) return sortableKeyboardCoordinates(event, args)
  // Same class as dnd-kit's own map (it is not exported), holding only the other zone and its cards; the active
  // card stays in it because the helper looks it up.
  const ContainersMap = context.droppableContainers.constructor as new (entries: [UniqueIdentifier, DroppableContainer][]) => typeof context.droppableContainers
  const otherZone = [...context.droppableContainers.entries()].filter(
    ([id, c]) => id === activeId || (id !== zone && c.data.current?.zone !== zone),
  )
  return sortableKeyboardCoordinates(event, { ...args, context: { ...context, droppableContainers: new ContainersMap(otherZone) } })
}

export function PublishBoard({ levers, set, onSetChange, onPublish, publishing = false, renderControls, publishStatus, lockedIds = NO_LOCKS }: PublishBoardProps) {
  const byId = new Map(levers.map((l) => [l.id, l]))
  const candidates = candidatesOf(levers, set)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overFull, setOverFull] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [message, setMessage] = useState('') // polite live region for menu actions
  const [tracking] = useState(() => new DragTracking())
  const [collision] = useState(() => createBoardCollision(tracking))

  // After a menu or Remove action the card is re-rendered (in the other zone, or at another slot), and the
  // focused button goes with the old node. Put focus back on the moved card's Actions button.
  const rootRef = useRef<HTMLDivElement>(null)
  const focusAfter = useRef<string | null>(null)
  useEffect(() => {
    const id = focusAfter.current
    if (!id) return
    focusAfter.current = null
    const card = [...(rootRef.current?.querySelectorAll('[data-dnd-id]') ?? [])].find((el) => el.getAttribute('data-dnd-id') === id)
    card?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus()
  })

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // The handle has touch-action: none, so a short hold starts the drag without fighting page scroll.
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }),
  )

  const name = (id: UniqueIdentifier) => byId.get(String(id))?.name ?? 'Lever'
  const where = (id: string) => {
    const i = set.indexOf(id)
    return i >= 0 ? `position ${i + 1} of ${SET_SIZE} in the publish set` : 'Candidates'
  }
  const overId = (over: { id: UniqueIdentifier } | null) => (over ? String(over.id) : null)

  const describe = (id: string, target: string | null, done: boolean): string => {
    const plan = planDrop(set, id, target)
    const n = name(id)
    switch (plan.kind) {
      case 'add':
        return done ? `${n} added to the publish set at position ${plan.index + 1} of ${SET_SIZE}.` : `${n} would go to position ${plan.index + 1} of the publish set.`
      case 'reorder':
        return done ? `${n} moved to position ${plan.to + 1} of ${SET_SIZE}.` : `${n} would move to position ${plan.to + 1} of the publish set.`
      case 'remove':
        return done ? `${n} returned to Candidates.` : `${n} would return to Candidates.`
      case 'full':
        return `${FULL_MESSAGE}${done ? ` ${n} stays in Candidates.` : ''}`
      case 'none': {
        if (done) return `${n} dropped. It stays in ${where(id)}.`
        const zone = target === null ? null : target === 'set' || target === 'candidates' ? target : zoneOf(set, target)
        return `${n} is over ${zone === null ? 'no drop zone' : zone === 'set' ? 'the publish set' : 'Candidates'}.`
      }
    }
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}, in ${where(String(active.id))}.`,
    // Silent while the card is still over its own place, so "Picked up …" is not replaced at once.
    onDragOver: ({ active, over }) => (over && over.id === active.id ? undefined : describe(String(active.id), overId(over), false)),
    onDragEnd: ({ active, over }) => describe(String(active.id), overId(over), true),
    onDragCancel: ({ active }) => `Moving ${name(active.id)} was cancelled. It stays in ${where(String(active.id))}.`,
  }

  const onDragStart = (e: DragStartEvent) => {
    tracking.start()
    setActiveId(String(e.active.id))
    setNotice(null)
  }
  const onDragOver = (e: DragOverEvent) => {
    setOverFull(planDrop(set, String(e.active.id), overId(e.over)).kind === 'full')
  }
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id)
    const plan = planDrop(set, id, overId(e.over))
    setActiveId(null)
    setOverFull(false)
    if (plan.kind === 'full') {
      setNotice(FULL_MESSAGE)
      return
    }
    if (plan.kind !== 'none') onSetChange(applyDrop(set, id, plan))
  }
  const onDragCancel = () => {
    setActiveId(null)
    setOverFull(false)
  }

  // ── Menu actions (non-drag fallback) ──────────────────────────────────────────────────────────────
  const say = (text: string) => setMessage(text)
  const add = (id: string) => {
    const r = addToSet(set, id)
    if (!r.ok) {
      setNotice(FULL_MESSAGE)
      say(FULL_MESSAGE)
      return
    }
    setNotice(null)
    focusAfter.current = id
    onSetChange(r.set)
    say(`${name(id)} added to the publish set at position ${r.set.length} of ${SET_SIZE}.`)
  }
  const remove = (id: string) => {
    setNotice(null)
    focusAfter.current = id
    onSetChange(removeFromSet(set, id))
    say(`${name(id)} returned to Candidates.`)
  }
  const move = (id: string, delta: -1 | 1) => {
    const next = moveBy(set, id, delta)
    focusAfter.current = id
    onSetChange(next)
    say(`${name(id)} moved to position ${next.indexOf(id) + 1} of ${SET_SIZE}.`)
  }

  const payload = publishPayload(set)
  const active = activeId ? byId.get(activeId) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
    >
      <p className="sr-only" role="status" aria-live="polite" data-testid="board-status">{message}</p>
      <div ref={rootRef} className="grid gap-4 lg:grid-cols-2 items-start">
        {/* Publish set first in reading order (on top below lg); from lg up the zones sit side by side, set on the right. */}
        <DropZone id="set" label="Publish set" className="lg:order-2" highlight={activeId !== null} refused={overFull}>
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="font-medium text-ink-800">Publish set <span className="text-ink-400 text-sm">({set.length} / {SET_SIZE})</span></h3>
          </div>
          <SortableContext id="set" items={set} strategy={verticalListSortingStrategy}>
            <ol className="space-y-2" aria-label="Publish set slots">
              {Array.from({ length: SET_SIZE }, (_, i) => {
                const id = set[i]
                const lever = id ? byId.get(id) : undefined
                const locked = lever ? lockedIds.has(lever.id) : false
                return lever ? (
                  <li key={lever.id}>
                    <LeverCard
                      lever={lever} zone="set" slot={i + 1} dragging={activeId === lever.id} locked={locked}
                      menu={[
                        { label: 'Move up', onSelect: () => move(lever.id, -1), disabled: locked || i === 0, hint: locked ? LOCKED_HINT : i === 0 ? 'already first' : undefined },
                        { label: 'Move down', onSelect: () => move(lever.id, 1), disabled: locked || i === set.length - 1, hint: locked ? LOCKED_HINT : i === set.length - 1 ? 'already last' : undefined },
                        { label: 'Remove from set', onSelect: () => remove(lever.id), disabled: locked, hint: locked ? LOCKED_HINT : undefined },
                      ]}
                      onRemove={locked ? undefined : () => remove(lever.id)}
                      controls={renderControls(lever)}
                    />
                  </li>
                ) : (
                  <li key={`empty-${i}`} className="rounded-xl border-2 border-dashed border-ink-200 p-3 text-sm text-ink-400 flex items-center gap-3" data-testid="empty-slot">
                    <span className="w-6 h-6 rounded-full border border-ink-200 flex items-center justify-center text-xs">{i + 1}</span>
                    Empty slot: drag a candidate here, or use its Actions menu
                  </li>
                )
              })}
            </ol>
          </SortableContext>
          {/* Visible only: screen readers already hear this from the drag or menu announcement. */}
          {(notice || overFull) && (
            <p className="mt-2 text-sm text-red-700" data-testid="full-notice">{FULL_MESSAGE}</p>
          )}
          <button className="btn-primary mt-3 w-full md:w-auto" disabled={!payload || publishing} onClick={() => payload && onPublish(payload)}>
            Approve and publish these five
          </button>
          {!payload && <p className="text-xs text-ink-500 mt-1">Fill all {SET_SIZE} slots to publish ({set.length} / {SET_SIZE}).</p>}
          {publishStatus}
        </DropZone>

        <DropZone id="candidates" label="Candidates" className="lg:order-1" highlight={activeId !== null && zoneOf(set, activeId) === 'set'}>
          <h3 className="font-medium text-ink-800 mb-2">Candidates <span className="text-ink-400 text-sm">({candidates.length})</span></h3>
          <SortableContext id="candidates" items={candidates.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-2" aria-label="Candidate levers">
              {candidates.map((lever) => (
                <li key={lever.id}>
                  <LeverCard
                    lever={lever} zone="candidates" dragging={activeId === lever.id} locked={lockedIds.has(lever.id)}
                    menu={[{
                      label: 'Add to set', onSelect: () => add(lever.id),
                      disabled: isComplete(set) || lockedIds.has(lever.id),
                      hint: lockedIds.has(lever.id) ? LOCKED_HINT : isComplete(set) ? 'the set already has five; remove one first' : undefined,
                    }]}
                    controls={renderControls(lever)}
                  />
                </li>
              ))}
              {candidates.length === 0 && <li className="text-sm text-ink-500">No other levers. Run a generation or add one.</li>}
            </ul>
          </SortableContext>
        </DropZone>
      </div>

      <DragOverlay>
        {active ? (
          <div className="card p-3 shadow-lg bg-white text-sm" data-testid="drag-overlay" data-dnd-overlay={active.id}>
            <span className="font-medium text-ink-900">{active.name}</span>
            <span className="text-ink-400"> · {TYPE_LABEL[active.type]}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function DropZone({ id, label, className, highlight, refused, children }: {
  id: Zone; label: string; className?: string; highlight: boolean; refused?: boolean; children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      data-dnd-zone={id}
      className={clsx(
        'card p-4 transition-colors', className,
        refused && isOver ? 'ring-2 ring-red-400 bg-red-50' : isOver ? 'ring-2 ring-ink-400' : highlight ? 'ring-1 ring-ink-200' : '',
      )}
    >
      {children}
    </section>
  )
}

interface MenuItem { label: string; onSelect: () => void; disabled?: boolean; hint?: string }

function LeverCard({ lever, zone, slot, dragging, locked = false, menu, onRemove, controls }: {
  lever: AdminLever; zone: Zone; slot?: number; dragging: boolean; locked?: boolean; menu: MenuItem[]; onRemove?: () => void; controls: ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id: lever.id, data: { zone }, disabled: locked })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx('card p-3 bg-white', dragging && 'opacity-40')}
      data-testid={`lever-${lever.name}`}
      data-dnd-id={lever.id}
    >
      <div className="flex items-start gap-2">
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          type="button"
          aria-label={`Drag ${lever.name}${slot ? `, position ${slot} of ${SET_SIZE}` : ', candidate'}${locked ? ` (${LOCKED_HINT})` : ''}`}
          aria-disabled={locked ? 'true' : undefined}
          title={locked ? `To move this lever, ${LOCKED_HINT}` : undefined}
          className={clsx('btn-ghost p-1 mt-0.5 text-ink-400', locked ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing')}
          style={{ touchAction: 'none' }}
          data-testid={`handle-${lever.name}`}
        >
          <GripVertical size={16} />
        </button>
        {slot !== undefined && (
          <span className="w-6 h-6 mt-0.5 shrink-0 rounded-full bg-ink-900 text-white flex items-center justify-center text-xs" aria-hidden="true">{slot}</span>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm">
            <span className="font-medium text-ink-900">{lever.name}</span>
            <span className="text-ink-400"> · {TYPE_LABEL[lever.type]}{lever.unit ? ` (${lever.unit})` : ''}{lever.inputFormat === 'DIMENSIONS' ? ', from L × W × H' : ''}</span>
            {lever.status === 'APPROVED' && <span className="ml-2 text-xs text-green-700">Published #{lever.position}</span>}
            {lever.survey && <span className="ml-2 text-xs bg-blue-50 text-blue-800 px-1.5 py-0.5 rounded">Survey #{lever.survey.rank} · {lever.survey.respondents} owners</span>}
          </p>
          <p className="text-xs text-ink-600">{lever.explanation}</p>
          <p className="text-[11px] text-ink-400">
            {lever.origin === 'GENERATED' ? 'Generated' : 'Added by admin'}
            {lever.relatedNeeds.length > 0 && ` · needs: ${lever.relatedNeeds.join(', ')}`}
            {lever.allowedValues.length > 0 && ` · values: ${lever.allowedValues.join(', ')}`}
            {lever.approvedAt && ` · approved by ${lever.approvedBy ?? 'seed'} ${new Date(lever.approvedAt).toLocaleDateString()}`}
            {lever.editedAt && ` · edited by ${lever.editedBy} ${new Date(lever.editedAt).toLocaleDateString()}`}
            {lever.valueCount > 0 && ` · ${lever.valueCount} product values`}
          </p>
        </div>
        {onRemove && (
          <button type="button" className="btn-ghost p-1" aria-label={`Remove ${lever.name} from the publish set`} onClick={onRemove}><X size={14} /></button>
        )}
        <ActionsMenu leverName={lever.name} items={menu} />
      </div>
      {controls}
    </div>
  )
}

/**
 * A small accessible menu (APG menu button): Enter/Space opens it and focuses the first item; arrow keys,
 * Home and End move; Escape closes and returns focus; Tab closes. Disabled items stay focusable so their
 * reason can be read. It closes on a pointer press outside it (not on blur: Safari does not focus buttons on
 * click, so a blur-based close can unmount the menu before the click lands).
 */
function ActionsMenu({ leverName, items }: { leverName: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const menuId = useId()

  const menuItems = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    menuItems()[0]?.focus()
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) return
    const els = menuItems()
    const i = els.indexOf(document.activeElement as HTMLButtonElement)
    const focusAt = (n: number) => { e.preventDefault(); els[(n + els.length) % els.length]?.focus() }
    if (e.key === 'Escape') { e.preventDefault(); close(true) }
    else if (e.key === 'ArrowDown') focusAt(i + 1)
    else if (e.key === 'ArrowUp') focusAt(i - 1)
    else if (e.key === 'Home') focusAt(0)
    else if (e.key === 'End') focusAt(els.length - 1)
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className="btn-ghost p-1"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${leverName}`}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <ul ref={listRef} id={menuId} role="menu" aria-label={`Actions for ${leverName}`} className="absolute right-0 z-20 mt-1 w-56 card bg-white p-1 shadow-lg">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                aria-disabled={item.disabled ? 'true' : undefined}
                className={clsx('w-full text-left px-3 py-2 text-sm rounded-lg', item.disabled ? 'text-ink-300 cursor-not-allowed' : 'hover:bg-ink-50 text-ink-800')}
                onClick={() => {
                  if (item.disabled) return
                  close(true)
                  item.onSelect()
                }}
              >
                {item.label}
                {item.hint && <span className="block text-[11px] text-ink-400">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

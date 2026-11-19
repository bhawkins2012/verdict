// Admin approval board: drag lever cards between "Candidates" and a five-slot "Publish set".
//
// - Mouse, touch and keyboard drag (dnd-kit): each card has a drag handle; on the keyboard, focus the handle,
//   press Space or Enter to pick up, arrow keys to move, Space or Enter to drop, Escape to cancel.
// - Every move is also in the card's Actions menu (Add to set / Move up / Move down / Remove from set), so
//   nothing needs dragging.
// - Screen readers hear what each drag and menu action does; the wording comes from the same planDrop() the
//   drop itself uses (lib/publishSet.ts).
// - A sixth lever is refused, with the reason shown and announced. The server enforces the five too.
import { KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react'
import {
  Announcements, closestCorners, CollisionDetection, DndContext, DragEndEvent, DragOverEvent, DragOverlay, DragStartEvent,
  KeyboardSensor, MouseSensor, pointerWithin, ScreenReaderInstructions, TouchSensor, UniqueIdentifier, useDroppable, useSensor, useSensors,
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
}

export const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To move a lever, press Space or Enter on its drag handle to pick it up. Use the arrow keys to move it between ' +
    'Candidates and the publish set, or to another position in the set. Press Space or Enter to drop it, or Escape ' +
    'to cancel. Each card also has an Actions menu with the same moves.',
}

/**
 * Mouse and touch: whatever the pointer is inside wins, a card over the zone around it, so dropping anywhere
 * in a zone counts (closestCorners alone lets a nearby small card beat the tall zone the pointer is in).
 * Keyboard drags have no pointer and use closestCorners, which follows the arrow-key movement.
 */
export const boardCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  if (hits.length > 0) {
    const cards = hits.filter((c) => c.id !== 'set' && c.id !== 'candidates')
    return cards.length > 0 ? cards : hits
  }
  return closestCorners(args)
}

export function PublishBoard({ levers, set, onSetChange, onPublish, publishing = false, renderControls, publishStatus }: PublishBoardProps) {
  const byId = new Map(levers.map((l) => [l.id, l]))
  const candidates = candidatesOf(levers, set)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overFull, setOverFull] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [message, setMessage] = useState('') // polite live region for menu actions

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // The handle has touch-action: none, so a short hold starts the drag without fighting page scroll.
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
    onSetChange(r.set)
    say(`${name(id)} added to the publish set at position ${r.set.length} of ${SET_SIZE}.`)
  }
  const remove = (id: string) => {
    setNotice(null)
    onSetChange(removeFromSet(set, id))
    say(`${name(id)} returned to Candidates.`)
  }
  const move = (id: string, delta: -1 | 1) => {
    const next = moveBy(set, id, delta)
    onSetChange(next)
    say(`${name(id)} moved to position ${next.indexOf(id) + 1} of ${SET_SIZE}.`)
  }

  const payload = publishPayload(set)
  const active = activeId ? byId.get(activeId) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
    >
      <p className="sr-only" role="status" aria-live="polite" data-testid="board-status">{message}</p>
      <div className="grid gap-4 lg:grid-cols-2 items-start">
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
                return lever ? (
                  <li key={lever.id}>
                    <LeverCard
                      lever={lever} zone="set" slot={i + 1} dragging={activeId === lever.id}
                      menu={[
                        { label: 'Move up', onSelect: () => move(lever.id, -1), disabled: i === 0, hint: i === 0 ? 'already first' : undefined },
                        { label: 'Move down', onSelect: () => move(lever.id, 1), disabled: i === set.length - 1, hint: i === set.length - 1 ? 'already last' : undefined },
                        { label: 'Remove from set', onSelect: () => remove(lever.id) },
                      ]}
                      onRemove={() => remove(lever.id)}
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
          {(notice || overFull) && (
            <p role="alert" className="mt-2 text-sm text-red-700" data-testid="full-notice">{FULL_MESSAGE}</p>
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
                    lever={lever} zone="candidates" dragging={activeId === lever.id}
                    menu={[{
                      label: 'Add to set', onSelect: () => add(lever.id),
                      disabled: isComplete(set), hint: isComplete(set) ? 'the set already has five; remove one first' : undefined,
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

function LeverCard({ lever, zone, slot, dragging, menu, onRemove, controls }: {
  lever: AdminLever; zone: Zone; slot?: number; dragging: boolean; menu: MenuItem[]; onRemove?: () => void; controls: ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id: lever.id, data: { zone } })
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
          aria-label={`Drag ${lever.name}${slot ? `, position ${slot} of ${SET_SIZE}` : ', candidate'}`}
          className="btn-ghost p-1 mt-0.5 cursor-grab active:cursor-grabbing text-ink-400"
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

/** A small accessible menu: button + role="menu", arrow keys move, Escape closes and returns focus. */
function ActionsMenu({ leverName, items }: { leverName: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const focusable = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]

  useEffect(() => {
    if (open) focusable()[0]?.focus()
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const els = focusable()
    const i = els.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); close(true) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus() }
    else if (e.key === 'Tab') close(false)
  }

  return (
    <div className="relative" onKeyDown={onKeyDown} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      <button
        ref={buttonRef}
        type="button"
        className="btn-ghost p-1"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${leverName}`}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <ul ref={listRef} role="menu" aria-label={`Actions for ${leverName}`} className="absolute right-0 z-20 mt-1 w-56 card bg-white p-1 shadow-lg">
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

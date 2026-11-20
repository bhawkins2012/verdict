// The lever edit/add form, shared by the board cards and "Add a lever by hand". Editing changes the shared
// definition for every node that uses it (public pages keep their published snapshot until republished).
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { apiError } from '../../lib/levers'
import { BoardLever, LeverInputFormat, LeverType } from '../../types/levers'

export const TYPE_LABEL: Record<LeverType, string> = {
  MEASUREMENT: 'Measurement', CATEGORY: 'Category', COMPATIBILITY_LIST: 'Compatibility list', BOOLEAN: 'Yes / no',
}

/** Canonical units: extracted values are converted to these (backend catalog/units.ts). */
export const UNITS = ['lb', 'in', 'cu ft', 'years', 'count'] as const

export interface LeverBody {
  name: string; type: LeverType; inputFormat: LeverInputFormat; unit: string | null; explanation: string
  relatedNeeds: string[]; allowedValues: string[]; safetyFlag?: boolean
}

const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

export function LeverForm({ initial, onSave, onDone }: { initial?: Partial<BoardLever>; onSave: (b: LeverBody) => Promise<unknown>; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<LeverType>(initial?.type ?? 'MEASUREMENT')
  const [inputFormat, setInputFormat] = useState<LeverInputFormat>(initial?.inputFormat ?? 'SINGLE')
  const [unit, setUnit] = useState(initial?.unit ?? 'lb')
  const [explanation, setExplanation] = useState(initial?.explanation ?? '')
  const [needs, setNeeds] = useState((initial?.relatedNeeds ?? []).join(', '))
  const [values, setValues] = useState((initial?.allowedValues ?? []).join(', '))
  // Only sent when changed here: a lever can be safety-flagged by its node (car seats) without its shared
  // definition being flagged, and saving must not flag the definition for every other node.
  const [safety, setSafety] = useState<boolean | null>(null)
  const save = useMutation({
    mutationFn: () => onSave({
      name, type, inputFormat: type === 'MEASUREMENT' ? inputFormat : 'SINGLE',
      unit: type === 'MEASUREMENT' ? (inputFormat === 'DIMENSIONS' ? 'cu ft' : unit) : null,
      explanation, relatedNeeds: splitList(needs), allowedValues: type === 'CATEGORY' ? splitList(values) : [], ...(safety !== null ? { safetyFlag: safety } : {}),
    }),
    onSuccess: onDone,
  })
  const shared = initial?.sharedWith?.length ? initial.sharedWith : null
  return (
    <form className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-ink-100" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      {shared && <p className="col-span-2 text-xs text-amber-800 bg-amber-50 rounded px-2 py-1">This definition is shared with {shared.join(', ')}: an edit changes it there too (public pages change only when each node is republished).</p>}
      <label><span className="label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></label>
      <label><span className="label">Type</span>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as LeverType)}>
          {(Object.keys(TYPE_LABEL) as LeverType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select></label>
      {type === 'MEASUREMENT' && (
        <>
          <label><span className="label">Input</span>
            <select className="input" value={inputFormat} onChange={(e) => setInputFormat(e.target.value as LeverInputFormat)}>
              <option value="SINGLE">One number</option>
              <option value="DIMENSIONS">L × W × H in inches (volume in cu ft is computed)</option>
            </select></label>
          <label><span className="label">Unit (values are converted to it)</span>
            <select className="input" value={inputFormat === 'DIMENSIONS' ? 'cu ft' : unit} disabled={inputFormat === 'DIMENSIONS'} onChange={(e) => setUnit(e.target.value)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select></label>
        </>
      )}
      <label className="col-span-2"><span className="label">One-line explanation</span><input className="input" value={explanation} onChange={(e) => setExplanation(e.target.value)} required minLength={10} maxLength={200} /></label>
      <label><span className="label">Related needs (comma separated)</span><input className="input" value={needs} onChange={(e) => setNeeds(e.target.value)} /></label>
      {type === 'CATEGORY' && <label><span className="label">Allowed values (comma separated)</span><input className="input" value={values} onChange={(e) => setValues(e.target.value)} /></label>}
      <label className="col-span-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={safety ?? initial?.safety ?? false} disabled={initial?.safety === true} onChange={(e) => setSafety(e.target.checked)} />
        Safety lever (its values are reviewed one by one; cannot be undone){initial?.safety ? ' · already a safety lever here' : ''}
      </label>
      <div className="col-span-2 flex items-center gap-2">
        <button className="btn-primary" disabled={save.isPending}>Save</button>
        {save.isError && <span role="alert" className="text-sm text-red-700">{apiError(save.error)}</span>}
      </div>
    </form>
  )
}

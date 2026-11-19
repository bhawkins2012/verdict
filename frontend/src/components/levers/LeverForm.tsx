// The lever edit/add form, shared by the publish board cards and "Add a lever by hand".
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { apiError } from '../../lib/levers'
import { AdminLever, LeverInputFormat, LeverType } from '../../types/levers'

export const TYPE_LABEL: Record<LeverType, string> = {
  MEASUREMENT: 'Measurement', CATEGORY: 'Category', COMPATIBILITY_LIST: 'Compatibility list', BOOLEAN: 'Yes / no',
}

export interface LeverBody {
  name: string; type: LeverType; inputFormat: LeverInputFormat; unit: string | null; explanation: string
  relatedNeeds: string[]; allowedValues: string[]
}

const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

export function LeverForm({ initial, onSave, onDone }: { initial?: Partial<AdminLever>; onSave: (b: LeverBody) => Promise<unknown>; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<LeverType>(initial?.type ?? 'MEASUREMENT')
  const [inputFormat, setInputFormat] = useState<LeverInputFormat>(initial?.inputFormat ?? 'SINGLE')
  const [unit, setUnit] = useState(initial?.unit ?? '')
  const [explanation, setExplanation] = useState(initial?.explanation ?? '')
  const [needs, setNeeds] = useState((initial?.relatedNeeds ?? []).join(', '))
  const [values, setValues] = useState((initial?.allowedValues ?? []).join(', '))
  const save = useMutation({
    mutationFn: () => onSave({
      name, type, inputFormat: type === 'MEASUREMENT' ? inputFormat : 'SINGLE',
      unit: type === 'MEASUREMENT' ? (inputFormat === 'DIMENSIONS' ? 'cu ft' : unit.trim() || null) : null,
      explanation, relatedNeeds: splitList(needs), allowedValues: type === 'CATEGORY' ? splitList(values) : [],
    }),
    onSuccess: onDone,
  })
  return (
    <form className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-ink-100" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
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
              <option value="DIMENSIONS">Folded L × W × H in inches (volume in cu ft is computed)</option>
            </select></label>
          <label><span className="label">Unit</span>
            <input className="input" value={inputFormat === 'DIMENSIONS' ? 'cu ft' : unit} disabled={inputFormat === 'DIMENSIONS'} onChange={(e) => setUnit(e.target.value)} required maxLength={20} /></label>
        </>
      )}
      <label className="col-span-2"><span className="label">One-line explanation</span><input className="input" value={explanation} onChange={(e) => setExplanation(e.target.value)} required minLength={10} maxLength={200} /></label>
      <label><span className="label">Related needs (comma separated)</span><input className="input" value={needs} onChange={(e) => setNeeds(e.target.value)} /></label>
      {type === 'CATEGORY' && <label><span className="label">Allowed values (comma separated)</span><input className="input" value={values} onChange={(e) => setValues(e.target.value)} /></label>}
      <div className="col-span-2 flex items-center gap-2">
        <button className="btn-primary" disabled={save.isPending}>Save</button>
        {save.isError && <span role="alert" className="text-sm text-red-700">{apiError(save.error)}</span>}
      </div>
    </form>
  )
}

import type { TrackerDefinition, TrackerValue } from '../../domain/trackers/types'

export function TrackerEntryFields({ tracker, values, setValue }: {
  tracker: TrackerDefinition
  values: Record<string, TrackerValue>
  setValue: (key: string, value: TrackerValue | undefined) => void
}) {
  return <div className="today-entry-fields">
    {tracker.metrics.map((metric) => {
      const value = values[metric.id]
      if (metric.valueType === 'boolean') return <label className="form-check today-check" key={metric.id}><input type="checkbox" checked={value === true} onChange={(event) => setValue(metric.id, event.target.checked)} /> <span>{metric.name}</span></label>
      if (metric.valueType === 'checklist') return <fieldset className="today-checklist" key={metric.id}><legend>{metric.name}</legend>{metric.checklistItems?.slice().sort((a, b) => a.position - b.position).map((item) => <label className="form-check today-check" key={item.id}><input type="checkbox" checked={typeof value === 'object' && value !== null && !Array.isArray(value) && value[item.id] === true} onChange={(event) => {
        const current = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, TrackerValue> : {}
        setValue(metric.id, { ...current, [item.id]: event.target.checked })
      }} /> <span>{item.label}</span></label>)}</fieldset>
      return <label className="form-field" key={metric.id}><span>{metric.name}{metric.unit ? <em> · {metric.unit}</em> : null}</span><input className="auth-input" type="number" inputMode="decimal" min="0" step={metric.precision?.increment ?? (metric.valueType === 'duration' ? '1' : 'any')} placeholder={metric.unit ? `Enter ${metric.unit}` : 'Enter amount'} value={typeof value === 'number' ? value : ''} onChange={(event) => setValue(metric.id, event.target.value === '' ? undefined : Number(event.target.value))} /></label>
    })}
    {tracker.customFields.slice().sort((a, b) => a.position - b.position).map((field) => <CustomField key={field.id} field={field} value={values[`field:${field.id}`]} setValue={(value) => setValue(`field:${field.id}`, value)} />)}
  </div>
}

function CustomField({ field, value, setValue }: {
  field: TrackerDefinition['customFields'][number]
  value: TrackerValue | undefined
  setValue: (value: TrackerValue | undefined) => void
}) {
  const label = <span>{field.name}{field.required ? <em> · required</em> : <em> · optional</em>}</span>
  if (field.type === 'boolean') return <label className="form-check today-check"><input type="checkbox" checked={value === true} onChange={(event) => setValue(event.target.checked)} /> {field.name}{field.required && <em> · required</em>}</label>
  if (field.type === 'multi-select') return <fieldset className="today-checklist"><legend>{field.name}{field.required ? ' · required' : ''}</legend>{field.options?.map((option) => {
    const selected = Array.isArray(value) && value.includes(option)
    return <label className="form-check today-check" key={option}><input type="checkbox" checked={selected} onChange={(event) => setValue(event.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value.filter((item) => item !== option) : []))} /> <span>{option}</span></label>
  })}</fieldset>
  const select = field.type === 'single-select'
  const multiline = field.type === 'long-text'
  const type = field.type === 'integer' || field.type === 'decimal' || field.type === 'duration' || field.type === 'rating' || field.type === 'quantity' ? 'number' : field.type === 'date' || field.type === 'time' ? field.type : field.type === 'url' ? 'url' : 'text'
  const textValue = typeof value === 'string' ? value : ''
  const numberValue = typeof value === 'number' ? value : ''
  return <label className="form-field"><span>{label}{field.unit ? <em> · {field.unit}</em> : null}</span>{select ? <select className="auth-input" value={textValue} onChange={(event) => setValue(event.target.value || undefined)}><option value="">Choose…</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : multiline ? <textarea className="auth-input tracker-textarea" value={textValue} onChange={(event) => setValue(event.target.value || undefined)} /> : <input className="auth-input" type={type} step={field.type === 'integer' || field.type === 'rating' || field.type === 'duration' ? '1' : 'any'} value={type === 'number' ? numberValue : textValue} onChange={(event) => setValue(type === 'number' ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value || undefined)} />}</label>
}

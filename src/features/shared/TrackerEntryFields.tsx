import { useState } from 'react'
import { NumericStepperInput } from '../../components/ui/NumericStepperInput'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus } from '../../domain/trackers/activityStatus'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { getTargetProgress } from '../../domain/trackers/planning'
import type { TrackerDefinition, TrackerEntry, TrackerValue } from '../../domain/trackers/types'

export function TrackerEntryFields({ tracker, values, setValue, date, today = date, holidays, onInputValidityChange, expectedAmounts, expectedLabels }: {
  tracker: TrackerDefinition
  values: Record<string, TrackerValue>
  setValue: (key: string, value: TrackerValue | undefined) => void
  date?: string
  today?: string
  holidays?: ReadonlySet<string>
  onInputValidityChange?: (key: string, valid: boolean) => void
  expectedAmounts?: Readonly<Record<string, number>>
  expectedLabels?: Readonly<Record<string, string>>
}) {
  const [invalidInputs, setInvalidInputs] = useState<Set<string>>(() => new Set())
  function reportInputValidity(key: string, valid: boolean) {
    setInvalidInputs((current) => {
      const next = new Set(current)
      if (valid) next.delete(key); else next.add(key)
      return next
    })
    onInputValidityChange?.(key, valid)
  }
  return <>
    <div className="today-entry-fields">
      {tracker.metrics.map((metric) => {
        const value = values[metric.id]
        if (metric.valueType === 'boolean') return <BooleanChoice key={metric.id} id={metric.id} label={metric.name} value={value} setValue={(next) => setValue(metric.id, next)} />
        if (metric.valueType === 'checklist') return <fieldset className="today-checklist" key={metric.id}><legend>{metric.name}</legend>{metric.checklistItems?.slice().sort((a, b) => a.position - b.position).map((item) => <label className="form-check today-check" key={item.id}><input type="checkbox" checked={typeof value === 'object' && value !== null && !Array.isArray(value) && value[item.id] === true} onChange={(event) => {
          const current = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, TrackerValue> : {}
          setValue(metric.id, { ...current, [item.id]: event.target.checked })
        }} /> <span>{item.label}</span></label>)}</fieldset>
        const configuredTarget = tracker.goalPlanning?.mode === 'cumulative-deadline'
          ? (date ? tracker.goalPlanning.allocations?.[metric.id]?.[date] : undefined) ?? metric.thresholds?.target
          : tracker.goalPlanning?.mode === 'daily-recurring'
            ? tracker.goalPlanning.dailyTargets[metric.id] ?? metric.thresholds?.target
            : metric.thresholds?.target
        const step = metric.precision?.increment ?? 1
        const target = expectedAmounts?.[metric.id] ?? configuredTarget
        const targetLabel = expectedLabels?.[metric.id] ?? (tracker.goalPlanning?.mode === 'daily-recurring' ? 'daily target' : 'target')
        return <div className="form-field numeric-measure-field" key={metric.id}>
          <label htmlFor={`entry-${metric.id}`}><span>{metric.name}{metric.unit ? <em> · {metric.unit}</em> : null}</span></label>
          <NumericStepperInput id={`entry-${metric.id}`} label={metric.name} step={step} placeholder={metric.unit ? `Enter ${metric.unit}` : 'Enter amount'} value={typeof value === 'number' ? value : undefined} onChange={(next) => setValue(metric.id, next)} onValidityChange={(valid) => reportInputValidity(metric.id, valid)} />
          {!invalidInputs.has(metric.id) && typeof value === 'number' && target !== undefined && <TargetFeedback value={value} target={target} direction={metric.thresholds?.direction ?? 'increase'} unit={metric.unit} targetLabel={targetLabel} />}
        </div>
      })}
      {tracker.customFields.slice().sort((a, b) => a.position - b.position).map((field) => <CustomField key={field.id} field={field} value={values[`field:${field.id}`]} setValue={(value) => setValue(`field:${field.id}`, value)} onValidityChange={(valid) => reportInputValidity(`field:${field.id}`, valid)} />)}
    </div>
    {invalidInputs.size === 0 && date && tracker.metrics.some((metric) => {
      const value = values[metric.id]
      return value !== undefined && value !== null && value !== ''
    }) && <DraftStatusPreview tracker={tracker} values={values} date={date} today={today ?? date} holidays={holidays} />}
  </>
}

function BooleanChoice({ id, label, value, setValue, required = false }: {
  id: string
  label: string
  value: TrackerValue | undefined
  setValue: (value: TrackerValue) => void
  required?: boolean
}) {
  return <fieldset className="boolean-choice-field form-field" aria-describedby={`${id}-answer-hint`}>
    <legend>{label}{required && <em> · required</em>}</legend>
    <span className="sr-only" id={`${id}-answer-hint`}>{value === undefined ? 'Choose Not done or Done to record an answer.' : `Selected: ${value === true ? 'Done' : 'Not done'}.`}</span>
    <div className="boolean-choice" role="group" aria-label={label}>
      <button type="button" aria-pressed={value === false} className={value === false ? 'selected' : ''} onClick={() => setValue(false)}>Not done</button>
      <button type="button" aria-pressed={value === true} className={value === true ? 'selected' : ''} onClick={() => setValue(true)}>Done</button>
    </div>
  </fieldset>
}

function TargetFeedback({ value, target, direction, unit, targetLabel }: { value: number; target: number; direction: 'increase' | 'decrease'; unit?: string; targetLabel: string }) {
  const labelUnit = unit ? ` ${unit}` : ''
  const progress = getTargetProgress(value, target, direction)
  if (progress.state === 'reached') return <small className="numeric-target-feedback">Target reached · {targetLabel} {formatTrackerNumber(target)}{labelUnit}</small>
  if (direction === 'decrease') return <small className="numeric-target-feedback">{progress.state === 'remaining' ? `${formatTrackerNumber(progress.amount)}${labelUnit} above target` : `${formatTrackerNumber(progress.amount)}${labelUnit} below target`} · {targetLabel} {formatTrackerNumber(target)}{labelUnit}</small>
  if (progress.state === 'exceeded') return <small className="numeric-target-feedback">Target exceeded by {formatTrackerNumber(progress.amount)}{labelUnit}</small>
  return <small className="numeric-target-feedback">{formatTrackerNumber(progress.amount)}{labelUnit} remaining · {targetLabel} {formatTrackerNumber(target)}{labelUnit}</small>
}

function DraftStatusPreview({ tracker, values, date, today, holidays }: {
  tracker: TrackerDefinition
  values: Record<string, TrackerValue>
  date: string
  today: string
  holidays?: ReadonlySet<string>
}) {
  const draftEntry: TrackerEntry = {
    id: 'unsaved-checkin-preview', trackerId: tracker.id, date, outcome: 'recorded', values, note: '',
    createdAt: '', updatedAt: '', deletedAt: null,
  }
  const status = getTrackerActivityStatus({ tracker, entry: draftEntry, date, today, holidays })
  return <p className={`checkin-draft-preview status-${status}`} role="status">Unsaved preview · {ACTIVITY_STATUS_PRESENTATION[status].label}</p>
}

function CustomField({ field, value, setValue, onValidityChange }: {
  field: TrackerDefinition['customFields'][number]
  value: TrackerValue | undefined
  setValue: (value: TrackerValue | undefined) => void
  onValidityChange?: (valid: boolean) => void
}) {
  if (field.type === 'boolean') return <BooleanChoice id={`field-${field.id}`} label={field.name} value={value} setValue={(next) => setValue(next)} required={field.required} />
  if (field.type === 'multi-select') return <fieldset className="today-checklist"><legend>{field.name}{field.required ? ' · required' : ''}</legend>{field.options?.map((option) => {
    const selected = Array.isArray(value) && value.includes(option)
    return <label className="form-check today-check" key={option}><input type="checkbox" checked={selected} onChange={(event) => setValue(event.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value.filter((item) => item !== option) : []))} /> <span>{option}</span></label>
  })}</fieldset>
  const select = field.type === 'single-select'
  const multiline = field.type === 'long-text'
  const numericTypes = ['integer', 'decimal', 'duration', 'rating', 'quantity']
  const numeric = numericTypes.includes(field.type)
  const type = field.type === 'date' || field.type === 'time' ? field.type : field.type === 'url' ? 'url' : 'text'
  const textValue = typeof value === 'string' ? value : ''
  const numberValue = typeof value === 'number' ? value : undefined
  const numericStep = field.type === 'decimal' ? 0.1 : 1
  return <div className="form-field">
    <label htmlFor={`field-${field.id}`}><span>{field.name}{field.required ? <em> · required</em> : <em> · optional</em>}{field.unit ? <em> · {field.unit}</em> : null}</span></label>
    {select ? <select id={`field-${field.id}`} className="auth-input" value={textValue} onChange={(event) => setValue(event.target.value || undefined)}><option value="">Choose…</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
      : multiline ? <textarea id={`field-${field.id}`} className="auth-input tracker-textarea" value={textValue} onChange={(event) => setValue(event.target.value || undefined)} />
        : numeric ? <NumericStepperInput id={`field-${field.id}`} label={field.name} step={numericStep} min={-Number.MAX_VALUE} value={numberValue} onChange={setValue} onValidityChange={onValidityChange} />
          : <input id={`field-${field.id}`} className="auth-input" type={type} value={textValue} onChange={(event) => setValue(event.target.value || undefined)} />}
  </div>
}

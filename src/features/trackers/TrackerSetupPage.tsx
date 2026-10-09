import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { trackerDefinitionSchema } from '../../domain/trackers/schema'
import type { TrackerDefinition, TrackerKind } from '../../domain/trackers/types'
import { trackerSetupSchema } from './trackerSetupSchema'

type FormValues = { name: string; description: string; kind: TrackerKind; schedule: string; startDate: string; deadline: string; metricName: string; unit: string; target: string }

function todayLocal(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function defaultValues(tracker?: TrackerDefinition): FormValues {
  const metric = tracker?.metrics[0]
  const schedule = tracker?.schedule.kind === 'weekdays' ? 'weekdays'
    : tracker?.schedule.kind === 'none' ? 'none'
      : tracker?.schedule.kind === 'times-per-week' && tracker.schedule.count === 3 ? 'three-times-weekly' : 'every-day'
  return {
    name: tracker?.name ?? '', description: tracker?.description ?? '', kind: tracker?.kind ?? 'habit', schedule,
    startDate: tracker?.startDate ?? todayLocal(), deadline: tracker?.deadline ?? '',
    metricName: metric?.name ?? (tracker?.kind === 'habit' ? 'Completed' : 'Progress'),
    unit: metric?.unit ?? '', target: String(metric?.thresholds?.target ?? 1),
  }
}

export function TrackerSetupPage() {
  const { trackerId } = useParams()
  const navigate = useNavigate()
  const [existing, setExisting] = useState<TrackerDefinition>()
  const [values, setValues] = useState<FormValues>(() => defaultValues())
  const [loading, setLoading] = useState(Boolean(trackerId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!trackerId) return
    let current = true
    localRepository.getTracker(trackerId).then((tracker) => {
      if (!current) return
      if (!tracker) setError('This tracker could not be found on this device.')
      else {
        setExisting(tracker)
        setValues(defaultValues(tracker))
      }
    }).catch(() => current && setError('Could not open this tracker from local storage.'))
      .finally(() => current && setLoading(false))
    return () => { current = false }
  }, [trackerId])

  function update(field: keyof FormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: '' }))
  }

  function changeKind(value: string) {
    if (existing) return
    const kind = value as TrackerKind
    setValues((current) => ({
      ...current,
      kind,
      metricName: current.kind === 'habit' && kind !== 'habit' ? 'Progress' : current.kind !== 'habit' && kind === 'habit' ? 'Completed' : current.metricName,
    }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const parsed = trackerSetupSchema.safeParse(values)
    if (!parsed.success) {
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])))
      return
    }
    setSaving(true)
    try {
      const form = parsed.data
      const now = new Date().toISOString()
      const id = existing?.id ?? crypto.randomUUID()
      const metricId = existing?.metrics[0]?.id ?? crypto.randomUUID()
      const kind = existing?.kind ?? form.kind
      const metric = kind === 'habit'
        ? { id: metricId, name: form.metricName, valueType: 'boolean' as const }
        : { id: metricId, name: form.metricName, valueType: 'quantity' as const, unit: form.unit.trim(), thresholds: { direction: 'increase' as const, target: Number(form.target), streakQualification: 'any-recorded-value' as const } }
      const schedule: TrackerDefinition['schedule'] = form.schedule === 'weekdays' ? { kind: 'weekdays' }
        : form.schedule === 'none' ? { kind: 'none' }
          : form.schedule === 'three-times-weekly' ? { kind: 'times-per-week', count: 3 }
            : { kind: 'every-day' }
      const candidate: TrackerDefinition = {
        ...(existing ?? {} as TrackerDefinition),
        schemaVersion: 1, id, name: form.name, description: form.description.trim(), kind,
        status: existing?.status ?? 'active', categoryId: existing?.categoryId ?? null,
        tags: existing?.tags ?? [], icon: existing?.icon ?? '', accent: existing?.accent ?? '#315e46',
        schedule, startDate: form.startDate || undefined, deadline: form.deadline || undefined,
        metrics: existing?.metrics.length ? [metric, ...existing.metrics.slice(1)] : [metric],
        qualificationRule: existing?.qualificationRule ?? (kind === 'habit'
          ? { kind: 'comparison', metricId, operator: 'equals', value: true }
          : { kind: 'threshold', metricId, level: 'target' }),
        customFields: existing?.customFields ?? [], milestones: existing?.milestones ?? [],
        createdAt: existing?.createdAt ?? now, updatedAt: now, archivedAt: existing?.archivedAt ?? null, deletedAt: null,
      }
      const checked = trackerDefinitionSchema.safeParse(candidate)
      if (!checked.success) {
        setError(checked.error.issues[0]?.message ?? 'Check the tracker details and try again.')
        return
      }
      const result = await localRepository.saveTracker(checked.data as TrackerDefinition)
      navigate('/trackers', { replace: true, state: { savedTracker: result.id } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this tracker locally.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section className="tracker-page"><p role="status">Loading tracker…</p></section>

  return (
    <section className="tracker-page" aria-labelledby="tracker-setup-title">
      <PageHeader headingId="tracker-setup-title" eyebrow="BUILD YOUR PRACTICE" title={existing ? 'Edit tracker' : 'New tracker'} description="Start with a clear intention. You can add more measures and success rules later." action={<Link className="button button-secondary button-medium" to="/trackers">Back to trackers</Link>} />
      <Surface className="tracker-form-card">
        <form className="tracker-form" onSubmit={submit} noValidate>
          {error && <div role="alert" className="form-alert">{error}</div>}
          <div className="form-grid">
            <label className="form-field form-field-wide">
              <span>What would you like to track?</span>
              <input autoFocus className="auth-input" maxLength={200} value={values.name} onChange={(event) => update('name', event.target.value)} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? 'tracker-name-error' : undefined} placeholder="e.g. Read more, launch my portfolio" />
              {fieldErrors.name && <small id="tracker-name-error" className="auth-error">{fieldErrors.name}</small>}
            </label>
            <label className="form-field">
              <span>Tracker type</span>
              <select className="auth-input" value={existing?.kind ?? values.kind} disabled={Boolean(existing)} onChange={(event) => changeKind(event.target.value)}>
                <option value="habit">Habit</option><option value="goal">Goal</option><option value="challenge">Challenge</option><option value="project">Project</option>
              </select>
              {existing && <small className="field-hint">Type is fixed after creation so existing progress keeps its meaning.</small>}
            </label>
            <label className="form-field">
              <span>Schedule</span>
              <select className="auth-input" value={values.schedule} onChange={(event) => update('schedule', event.target.value)}>
                <option value="every-day">Every day</option><option value="weekdays">Weekdays</option><option value="three-times-weekly">3 times per week</option><option value="none">No recurring schedule</option>
              </select>
            </label>
            <label className="form-field form-field-wide">
              <span>Description <em>optional</em></span>
              <textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Why does this matter to you?" />
            </label>
            <label className="form-field"><span>Start date</span><input className="auth-input" type="date" value={values.startDate} onChange={(event) => update('startDate', event.target.value)} /></label>
            <label className="form-field">
              <span>Deadline <em>optional</em></span>
              <input className="auth-input" type="date" value={values.deadline} onChange={(event) => update('deadline', event.target.value)} aria-invalid={Boolean(fieldErrors.deadline)} aria-describedby={fieldErrors.deadline ? 'tracker-deadline-error' : undefined} />
              {fieldErrors.deadline && <small id="tracker-deadline-error" className="auth-error">{fieldErrors.deadline}</small>}
            </label>
            <div className="form-field form-field-wide form-section-heading"><strong>First measure</strong><span>A simple starting point; you can expand it later.</span></div>
            <label className="form-field">
              <span>{(existing?.kind ?? values.kind) === 'habit' ? 'Completion label' : 'What is the measure?'}</span>
              <input className="auth-input" maxLength={120} value={values.metricName} onChange={(event) => update('metricName', event.target.value)} aria-invalid={Boolean(fieldErrors.metricName)} aria-describedby={fieldErrors.metricName ? 'tracker-metric-error' : undefined} />
              {fieldErrors.metricName && <small id="tracker-metric-error" className="auth-error">{fieldErrors.metricName}</small>}
            </label>
            {(existing?.kind ?? values.kind) !== 'habit' && <>
              <label className="form-field"><span>Unit</span><input className="auth-input" maxLength={40} value={values.unit} onChange={(event) => update('unit', event.target.value)} placeholder="pages, hours, sessions…" /></label>
              <label className="form-field">
                <span>Target</span>
                <input className="auth-input" type="number" min="0.01" step="any" value={values.target} onChange={(event) => update('target', event.target.value)} aria-invalid={Boolean(fieldErrors.target)} aria-describedby={fieldErrors.target ? 'tracker-target-error' : undefined} />
                {fieldErrors.target && <small id="tracker-target-error" className="auth-error">{fieldErrors.target}</small>}
              </label>
            </>}
          </div>
          <footer className="tracker-form-actions">
            <Button type="button" variant="secondary" onClick={() => navigate('/trackers')}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Create tracker'}</Button>
          </footer>
        </form>
      </Surface>
    </section>
  )
}

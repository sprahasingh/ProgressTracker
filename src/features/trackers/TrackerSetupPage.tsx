import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { localRepository } from '../../db/localRepository'
import { trackerDefinitionSchema } from '../../domain/trackers/schema'
import type { CustomFieldDefinition, GoalPlanningConfiguration, TrackerDefinition, TrackerKind, TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerRule } from '../../domain/trackers/types'
import { TrackerConfigurationEditor } from './TrackerConfigurationEditor'
import { GoalPlanningEditor } from './GoalPlanningEditor'
import { trackerSetupSchema } from './trackerSetupSchema'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { localCalendarDate } from '../shared/localDates'

type FormValues = { name: string; description: string; kind: TrackerKind; schedule: string; startDate: string; deadline: string }

type Configuration = { metrics: TrackerMetricDefinition[]; rule?: TrackerRule; customFields: CustomFieldDefinition[]; milestones: TrackerMilestoneDefinition[] }
const emptyGoalPlanning = (): GoalPlanningConfiguration => ({ mode: 'daily-recurring', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {} })

function starterMetric(kind: TrackerKind): TrackerMetricDefinition {
  const id = crypto.randomUUID()
  return kind === 'habit'
    ? { id, name: 'Completed', valueType: 'boolean' }
    : { id, name: 'Progress', valueType: 'quantity', unit: '', thresholds: { direction: 'increase', target: 1, streakQualification: 'any-recorded-value' } }
}

function starterRule(metric: TrackerMetricDefinition): TrackerRule {
  return metric.valueType === 'boolean'
    ? { kind: 'comparison', metricId: metric.id, operator: 'equals', value: true }
    : metric.thresholds?.target !== undefined
      ? { kind: 'threshold', metricId: metric.id, level: 'target' }
      : { kind: 'comparison', metricId: metric.id, operator: 'at-least', value: 1 }
}

function todayLocal(timeZone: string): string {
  return localCalendarDate(new Date(), timeZone)
}

function defaultValues(tracker?: TrackerDefinition, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): FormValues {
  const schedule = tracker?.schedule.kind === 'weekdays' ? 'weekdays'
    : tracker?.schedule.kind === 'none' ? 'none'
      : tracker?.schedule.kind === 'times-per-week' && tracker.schedule.count === 3 ? 'three-times-weekly' : 'every-day'
  return {
    name: tracker?.name ?? '', description: tracker?.description ?? '', kind: tracker?.kind ?? 'habit', schedule,
    startDate: tracker?.startDate ?? todayLocal(timeZone), deadline: tracker?.deadline ?? '',
  }
}

export function TrackerSetupPage() {
  const { timeZone } = useWorkspaceTimeZone()
  const { trackerId } = useParams()
  const navigate = useNavigate()
  const [existing, setExisting] = useState<TrackerDefinition>()
  const [values, setValues] = useState<FormValues>(() => defaultValues(undefined, timeZone))
  const [configuration, setConfiguration] = useState<Configuration>(() => {
    const metric = starterMetric('habit')
    return { metrics: [metric], rule: starterRule(metric), customFields: [], milestones: [] }
  })
  const [goalPlanning, setGoalPlanning] = useState<GoalPlanningConfiguration>(emptyGoalPlanning)
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
        setConfiguration({ metrics: tracker.metrics, rule: tracker.qualificationRule, customFields: tracker.customFields, milestones: tracker.milestones })
        setGoalPlanning(tracker.goalPlanning ?? emptyGoalPlanning())
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
    const previousKind = values.kind
    const kind = value as TrackerKind
    setValues((current) => ({
      ...current,
      kind,
    }))
    setConfiguration((current) => {
      if (current.metrics.length !== 1 || existing) return current
      const oldMetric = current.metrics[0]!
      const changed = previousKind === 'habit' && kind !== 'habit'
        ? { ...oldMetric, name: 'Progress', valueType: 'quantity' as const, unit: '', thresholds: { direction: 'increase' as const, target: 1, streakQualification: 'any-recorded-value' as const } }
        : previousKind !== 'habit' && kind === 'habit'
          ? { id: oldMetric.id, name: 'Completed', valueType: 'boolean' as const }
          : oldMetric
      const rule = starterRule(changed)
      return { ...current, metrics: [changed], rule }
    })
  }

  function changeMetrics(metrics: TrackerMetricDefinition[]) {
    const nextIds = new Set(metrics.map((metric) => metric.id))
    const invalidatedIds = configuration.metrics.filter((oldMetric) => {
      const replacement = metrics.find((metric) => metric.id === oldMetric.id)
      const hasPlanData = goalPlanning.progressSemantics[oldMetric.id] !== undefined ||
        goalPlanning.dailyTargets[oldMetric.id] !== undefined || goalPlanning.cumulativeTargets[oldMetric.id] !== undefined ||
        goalPlanning.allocations?.[oldMetric.id] !== undefined
      return hasPlanData && (!nextIds.has(oldMetric.id) || replacement?.valueType === 'boolean')
    }).map((metric) => metric.id)
    if (invalidatedIds.length && !window.confirm('Removing or changing this measure to yes/no will also remove its planning semantics and targets. Its saved check-in history remains unchanged. Continue?')) return
    if (invalidatedIds.length) {
      const nextPlanning = { ...goalPlanning, progressSemantics: { ...goalPlanning.progressSemantics }, dailyTargets: { ...goalPlanning.dailyTargets }, cumulativeTargets: { ...goalPlanning.cumulativeTargets }, allocations: { ...(goalPlanning.allocations ?? {}) } }
      for (const id of invalidatedIds) {
        delete nextPlanning.progressSemantics[id]
        delete nextPlanning.dailyTargets[id]
        delete nextPlanning.cumulativeTargets[id]
        delete nextPlanning.allocations[id]
      }
      setGoalPlanning(nextPlanning)
    }
    setConfiguration((current) => ({ ...current, metrics }))
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
      const kind = existing?.kind ?? form.kind
      const schedule: TrackerDefinition['schedule'] = form.schedule === 'weekdays' ? { kind: 'weekdays' }
        : form.schedule === 'none' ? { kind: 'none' }
            : form.schedule === 'three-times-weekly' ? { kind: 'times-per-week', count: 3 }
            : { kind: 'every-day' }
      const planWasConfigured = existing?.goalPlanning !== undefined || (!existing && kind === 'goal') || (
        existing?.schemaVersion === 1 && JSON.stringify(goalPlanning) !== JSON.stringify(emptyGoalPlanning())
      )
      const persistGoalPlanning = kind === 'goal' && planWasConfigured
      const candidate: TrackerDefinition = {
        ...(existing ?? {} as TrackerDefinition),
        schemaVersion: existing?.schemaVersion === 3 ? 3 : persistGoalPlanning ? 2 : existing?.schemaVersion ?? 1, id, name: form.name, description: form.description.trim(), kind,
        status: existing?.status ?? 'active', categoryId: existing?.categoryId ?? null,
        tags: existing?.tags ?? [], icon: existing?.icon ?? '', accent: existing?.accent ?? '#315e46',
        schedule, startDate: form.startDate || undefined, deadline: form.deadline || undefined,
        metrics: configuration.metrics,
        qualificationRule: configuration.rule,
        customFields: configuration.customFields,
        milestones: configuration.milestones,
        ...(persistGoalPlanning ? { goalPlanning } : {}),
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
      <PageHeader headingId="tracker-setup-title" eyebrow="BUILD YOUR PRACTICE" title={existing ? 'Edit tracker' : 'New tracker'} description="Set up your measures, milestones, planning targets, and the conditions that count as success." action={<Link className="button button-secondary button-medium" to="/trackers">Back to trackers</Link>} />
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
          </div>
          <TrackerConfigurationEditor
            metrics={configuration.metrics}
            onMetricsChange={changeMetrics}
            rule={configuration.rule}
            onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))}
            customFields={configuration.customFields}
            onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))}
            milestones={configuration.milestones}
            onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))}
          />
          {(existing?.kind ?? values.kind) === 'goal' && <GoalPlanningEditor metrics={configuration.metrics} planning={goalPlanning} onChange={setGoalPlanning} />}
          <footer className="tracker-form-actions">
            <Button type="button" variant="secondary" onClick={() => navigate('/trackers')}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Create tracker'}</Button>
          </footer>
        </form>
      </Surface>
    </section>
  )
}

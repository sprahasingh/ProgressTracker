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
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { isTrackerScheduledOccurrence } from '../../domain/trackers/planning'
import type { CalendarDate } from '../../db/models'

type FormValues = { name: string; description: string; kind: TrackerKind; schedule: string; startDate: string; deadline: string }

type Configuration = { metrics: TrackerMetricDefinition[]; rule?: TrackerRule; customFields: CustomFieldDefinition[]; milestones: TrackerMilestoneDefinition[] }
const emptyGoalPlanning = (): GoalPlanningConfiguration => ({ mode: 'daily-recurring', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {} })
const kindOptions: Array<{ kind: TrackerKind; title: string; description: string; icon: string }> = [
  { kind: 'habit', title: 'Habit', description: 'Build a repeatable daily or weekly rhythm.', icon: '↻' },
  { kind: 'goal', title: 'Goal', description: 'Reach a measurable outcome by a date.', icon: '◎' },
  { kind: 'challenge', title: 'Challenge', description: 'Take on a focused push with an end point.', icon: '⚡' },
  { kind: 'project', title: 'Project', description: 'Move a bigger piece of work forward.', icon: '◇' },
]

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

function todayLocal(timeZone: string): CalendarDate {
  return localCalendarDate(new Date(), timeZone)
}

function scheduleFromForm(value: string, existing?: TrackerDefinition): TrackerDefinition['schedule'] {
  if (value === 'weekdays') return { kind: 'weekdays' }
  if (value === 'three-times-weekly') return { kind: 'times-per-week', count: 3 }
  if (value === 'none') return { kind: 'none' }
  if (value === 'custom' && existing) return existing.schedule
  return { kind: 'every-day' }
}

function suggestedPace(amount: number, startDate: string, deadline: string, schedule: TrackerDefinition['schedule']): string | null {
  if (!Number.isFinite(amount) || amount <= 0 || deadline < startDate) return null
  const tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'deadline' | 'createdAt'> = { schedule, startDate: startDate as CalendarDate, deadline: deadline as CalendarDate, createdAt: `${startDate}T00:00:00.000Z` }
  let count = 0
  for (let date = startDate as CalendarDate; date <= deadline; date = shiftCalendarDate(date, 1)) {
    if (isTrackerScheduledOccurrence(tracker, date)) count += 1
  }
  if (count === 0) return null
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount / count)} per scheduled day`
}

function defaultValues(tracker?: TrackerDefinition, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): FormValues {
  const schedule = tracker?.schedule.kind === 'weekdays' ? 'weekdays'
    : tracker?.schedule.kind === 'none' ? 'none'
      : tracker?.schedule.kind === 'times-per-week' && tracker.schedule.count === 3 ? 'three-times-weekly'
        : tracker && tracker.schedule.kind !== 'every-day' ? 'custom' : 'every-day'
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
  const [goalAmount, setGoalAmount] = useState('')
  const [goalUnit, setGoalUnit] = useState('')
  const [savedTracker, setSavedTracker] = useState<TrackerDefinition | null>(null)
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
        const primaryMetric = tracker.metrics[0]
        const savedTarget = tracker.goalPlanning?.mode === 'daily-recurring'
          ? tracker.goalPlanning.dailyTargets[primaryMetric?.id ?? '']
          : tracker.goalPlanning?.cumulativeTargets[primaryMetric?.id ?? '']
        setGoalAmount(savedTarget === undefined ? String(primaryMetric?.thresholds?.target ?? '') : String(savedTarget))
        setGoalUnit(primaryMetric?.unit ?? '')
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
      schedule: kind === 'project' ? 'none' : kind === 'challenge' ? 'weekdays' : 'every-day',
      deadline: kind === 'goal' && !current.deadline ? shiftCalendarDate(todayLocal(timeZone), 30) : current.deadline,
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

  function updatePrimaryMetric(changes: Partial<TrackerMetricDefinition>) {
    const metric = configuration.metrics[0]
    if (!metric) return
    const updated = { ...metric, ...changes }
    setConfiguration((current) => ({ ...current, metrics: current.metrics.map((item, index) => index === 0 ? updated : item) }))
  }

  function updateTarget(value: string) {
    setGoalAmount(value)
    if (!existing || existing.goalPlanning || configuration.metrics[0]?.valueType === 'boolean') return
    const target = value === '' ? undefined : Number(value)
    updatePrimaryMetric({ thresholds: { ...(configuration.metrics[0]?.thresholds ?? { direction: 'increase', streakQualification: 'any-recorded-value' as const }), target } })
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
    const isNewPlannedGoal = !existing && values.kind === 'goal'
    const enteredGoalAmount = goalAmount === '' ? undefined : Number(goalAmount)
    const goalAmountInvalid = enteredGoalAmount === undefined || !Number.isFinite(enteredGoalAmount) || enteredGoalAmount <= 0 || enteredGoalAmount > Number.MAX_SAFE_INTEGER
    const goalUnitInvalid = !goalUnit.trim()
    const goalDeadlineInvalid = !parsed.data.deadline
    if (isNewPlannedGoal && (goalAmountInvalid || goalUnitInvalid || goalDeadlineInvalid)) {
      setFieldErrors((current) => ({
        ...current,
        ...(goalAmountInvalid ? { goalAmount: 'Enter a total greater than zero, such as 100.' } : {}),
        ...(goalUnitInvalid ? { goalUnit: 'Add what you are counting, such as problems or pages.' } : {}),
        ...(goalDeadlineInvalid ? { deadline: 'Choose a date to reach your goal.' } : {}),
      }))
      return
    }
    setSaving(true)
    try {
      const form = parsed.data
      const now = new Date().toISOString()
      const id = existing?.id ?? crypto.randomUUID()
      const kind = existing?.kind ?? form.kind
      const schedule = scheduleFromForm(form.schedule, existing)
      const submittedMetrics = configuration.metrics.map((metric, index) => index === 0 && (metric.valueType === 'quantity' || metric.valueType === 'duration') && (isNewPlannedGoal || existing?.kind === 'goal' && existing.goalPlanning || existing !== undefined)
        ? { ...metric, unit: goalUnit.trim() }
        : metric)
      let submittedPlanning = goalPlanning
      if (isNewPlannedGoal && enteredGoalAmount !== undefined && submittedMetrics[0]) {
        const metricId = submittedMetrics[0].id
        submittedPlanning = {
          ...emptyGoalPlanning(),
          mode: 'cumulative-deadline',
          progressSemantics: { [metricId]: 'incremental' },
          cumulativeTargets: { [metricId]: enteredGoalAmount },
        }
      } else if (existing?.kind === 'goal' && existing.goalPlanning && enteredGoalAmount !== undefined && submittedMetrics[0]) {
        const metricId = submittedMetrics[0].id
        submittedPlanning = existing.goalPlanning.mode === 'daily-recurring'
          ? { ...goalPlanning, dailyTargets: { ...goalPlanning.dailyTargets, [metricId]: enteredGoalAmount } }
          : { ...goalPlanning, cumulativeTargets: { ...goalPlanning.cumulativeTargets, [metricId]: enteredGoalAmount } }
      }
      const planWasConfigured = existing?.goalPlanning !== undefined || isNewPlannedGoal || (
        existing?.schemaVersion === 1 && JSON.stringify(goalPlanning) !== JSON.stringify(emptyGoalPlanning())
      )
      const persistGoalPlanning = kind === 'goal' && planWasConfigured
      const candidate: TrackerDefinition = {
        ...(existing ?? {} as TrackerDefinition),
        schemaVersion: existing?.schemaVersion === 3 ? 3 : persistGoalPlanning ? 2 : existing?.schemaVersion ?? 1, id, name: form.name, description: form.description.trim(), kind,
        status: existing?.status ?? 'active', categoryId: existing?.categoryId ?? null,
        tags: existing?.tags ?? [], icon: existing?.icon ?? '', accent: existing?.accent ?? '#315e46',
        schedule, startDate: form.startDate || undefined, deadline: form.deadline || undefined,
        metrics: submittedMetrics,
        qualificationRule: configuration.rule,
        customFields: configuration.customFields,
        milestones: configuration.milestones,
        ...(persistGoalPlanning ? { goalPlanning: submittedPlanning } : {}),
        createdAt: existing?.createdAt ?? now, updatedAt: now, archivedAt: existing?.archivedAt ?? null, deletedAt: null,
      }
      const checked = trackerDefinitionSchema.safeParse(candidate)
      if (!checked.success) {
        setError(checked.error.issues[0]?.message ?? 'Check the tracker details and try again.')
        return
      }
      const result = await localRepository.saveTracker(checked.data as TrackerDefinition)
      if (existing) navigate('/trackers', { replace: true, state: { savedTracker: result.id } })
      else setSavedTracker(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this tracker locally.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section className="tracker-page"><p role="status">Loading tracker…</p></section>

  if (savedTracker) {
    const goal = savedTracker.kind === 'goal'
    return <section className="tracker-page tracker-created-page" aria-labelledby="tracker-created-title">
      <PageHeader headingId="tracker-created-title" eyebrow="A GREAT START" title="You’re ready to begin" description={`${savedTracker.name} is saved on this device and ready for your next step.`} />
      <Surface className="tracker-created-card">
        <span className="tracker-created-mark" aria-hidden="true">✓</span>
        <div><span className="tracker-kind-chip">{kindOptions.find((item) => item.kind === savedTracker.kind)?.title}</span><h2>{savedTracker.name}</h2>
          {goal && savedTracker.goalPlanning && savedTracker.metrics[0] && <p>{savedTracker.goalPlanning.cumulativeTargets[savedTracker.metrics[0].id]} {savedTracker.metrics[0].unit} by {calendarDateLabel(savedTracker.deadline ?? '')}</p>}
        </div>
        <div className="tracker-created-actions">
          <Link className="button button-primary button-medium" to="/">{goal ? 'Record my first progress' : 'Record my first check-in'}</Link>
          <Link className="button button-secondary button-medium" to={goal ? '/goals' : '/trackers'}>{goal ? 'View my goal' : 'View my trackers'}</Link>
          <Link className="button button-quiet button-medium" to={`/trackers/${encodeURIComponent(savedTracker.id)}/edit`}>{goal ? 'Customize my plan' : 'Customize this tracker'}</Link>
        </div>
      </Surface>
    </section>
  }

  const selectedKind = existing?.kind ?? values.kind
  const targetNumber = Number(goalAmount)
  const pace = selectedKind === 'goal' && !existing && goalAmount && values.deadline
    ? suggestedPace(targetNumber, values.startDate, values.deadline, scheduleFromForm(values.schedule, existing))
    : null
  const targetLabel = existing?.kind === 'goal' && existing.goalPlanning?.mode === 'daily-recurring' ? 'Target per scheduled day'
    : existing?.kind === 'goal' && existing.goalPlanning?.mode === 'cumulative-deadline' ? 'Total to reach'
      : 'Per check-in target'

  return (
    <section className="tracker-page" aria-labelledby="tracker-setup-title">
      <PageHeader headingId="tracker-setup-title" eyebrow={existing ? 'MAKE IT YOURS' : 'START WITH ONE SMALL STEP'} title={existing ? `Edit ${kindOptions.find((item) => item.kind === existing.kind)?.title.toLowerCase()}` : 'What would you like to do?'} description={existing ? 'Make the everyday changes here. Your saved check-ins stay as they are.' : 'Choose a starting point. You can change the details or add more later.'} action={<Link className="button button-secondary button-medium" to="/trackers">Back to trackers</Link>} />
      <Surface className="tracker-form-card">
        <form className="tracker-form" onSubmit={submit} noValidate>
          {error && <div role="alert" className="form-alert">{error}</div>}
          {!existing && <fieldset className="tracker-kind-picker"><legend>Choose a type</legend><div className="tracker-kind-options">{kindOptions.map((item) => <label key={item.kind} className={`tracker-kind-option${values.kind === item.kind ? ' selected' : ''}`}><input type="radio" name="tracker-kind" value={item.kind} checked={values.kind === item.kind} onChange={() => changeKind(item.kind)} /><span className="tracker-kind-option-icon" aria-hidden="true">{item.icon}</span><span><strong>{item.title}</strong><small>{item.description}</small></span></label>)}</div></fieldset>}
          {existing && <div className="editing-kind-note"><span className="tracker-kind-chip">{kindOptions.find((item) => item.kind === existing.kind)?.title}</span><p>{kindOptions.find((item) => item.kind === existing.kind)?.description} Type stays the same so saved progress keeps its meaning.</p></div>}
          <label className="form-field tracker-name-field"><span>{selectedKind === 'goal' ? 'What do you want to achieve?' : selectedKind === 'habit' ? 'What habit do you want to build?' : selectedKind === 'challenge' ? 'What challenge are you taking on?' : 'What project will you move forward?'}</span><input autoFocus className="auth-input" maxLength={200} value={values.name} onChange={(event) => update('name', event.target.value)} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? 'tracker-name-error' : undefined} placeholder={selectedKind === 'goal' ? 'e.g. Solve 100 DSA problems' : selectedKind === 'habit' ? 'e.g. Read every day' : selectedKind === 'challenge' ? 'e.g. 30-day writing challenge' : 'e.g. Launch my portfolio'} />{fieldErrors.name && <small id="tracker-name-error" className="auth-error">{fieldErrors.name}</small>}</label>
          {existing && <label className="form-field tracker-name-field"><span>Description <em>optional</em></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Add a note about why this matters to you." /></label>}
          {!existing && selectedKind === 'goal' && <section className="quick-measure goal-quick-fields" aria-labelledby="goal-target-heading">
            <div className="quick-measure-heading"><div><h2 id="goal-target-heading">What does reaching it look like?</h2><p>We’ll spread this total across your scheduled days and suggest a daily pace.</p></div><span className="quick-setup-badge">GOAL</span></div>
            <div className="goal-target-row"><label className="form-field"><span>Total amount</span><input className="auth-input" type="number" min="0.01" max={Number.MAX_SAFE_INTEGER} step="any" value={goalAmount} onChange={(event) => { setGoalAmount(event.target.value); setFieldErrors((current) => ({ ...current, goalAmount: '' })) }} placeholder="100" aria-invalid={Boolean(fieldErrors.goalAmount)} aria-describedby={fieldErrors.goalAmount ? 'goal-amount-error' : 'goal-amount-help'} /></label><label className="form-field"><span>What are you counting?</span><input className="auth-input" maxLength={40} value={goalUnit} onChange={(event) => { setGoalUnit(event.target.value); setFieldErrors((current) => ({ ...current, goalUnit: '' })) }} placeholder="problems" aria-invalid={Boolean(fieldErrors.goalUnit)} aria-describedby={fieldErrors.goalUnit ? 'goal-unit-error' : 'goal-unit-help'} /></label></div>
            <small id="goal-amount-help" className="field-hint">Use a number above zero. Your saved check-ins add to this total.</small>
            {fieldErrors.goalAmount && <small id="goal-amount-error" className="auth-error">{fieldErrors.goalAmount}</small>}{fieldErrors.goalUnit && <small id="goal-unit-error" className="auth-error">{fieldErrors.goalUnit}</small>}
            {pace ? <p className="goal-pace-suggestion"><span aria-hidden="true">✦</span> Suggested pace: about <strong>{pace}</strong> through your scheduled dates. Start small; you can adjust the plan any time.</p> : <p className="goal-pace-suggestion" role="status">Choose a target and deadline to see a suggested pace.</p>}
          </section>}
          {(selectedKind === 'habit' && !existing || existing) && <div className="form-grid tracker-quick-fields">
            {(!existing && selectedKind === 'habit' || existing) && <label className="form-field"><span>{selectedKind === 'habit' ? 'How often?' : 'Schedule'}</span><select className="auth-input" value={values.schedule} onChange={(event) => update('schedule', event.target.value)}><option value="every-day">Every day</option><option value="weekdays">Weekdays</option><option value="three-times-weekly">3 times a week</option><option value="none">No set days</option>{values.schedule === 'custom' && <option value="custom">Keep current custom schedule</option>}</select><small className="field-hint">Rest days stay neutral; only scheduled days count toward consistency.</small></label>}
            {(existing && configuration.metrics[0] && configuration.metrics[0].valueType !== 'boolean') && <>
              <label className="form-field"><span>{existing.kind === 'goal' && existing.goalPlanning ? targetLabel : 'Per check-in target'} <em>optional</em></span><input aria-label="Quick target" className="auth-input" type="number" min="0" step="any" value={goalAmount} onChange={(event) => updateTarget(event.target.value)} /><small className="field-hint">{existing.goalPlanning?.mode === 'cumulative-deadline' ? 'This is your total, separate from each individual check-in.' : existing.goalPlanning?.mode === 'daily-recurring' ? 'This is expected on each scheduled day.' : 'Changing this can reclassify past check-ins, but their saved values will not change.'}</small></label>
              {(configuration.metrics[0].valueType === 'quantity' || configuration.metrics[0].valueType === 'duration') && <label className="form-field"><span>Unit <em>optional</em></span><input className="auth-input" value={goalUnit} maxLength={40} onChange={(event) => setGoalUnit(event.target.value)} placeholder="pages, sessions, minutes" /></label>}
            </>}
            {!existing && selectedKind === 'challenge' && <label className="form-field"><span>Finish by <em>optional</em></span><input className="auth-input" type="date" value={values.deadline} onChange={(event) => update('deadline', event.target.value)} /></label>}
          </div>}
          {existing && <label className="form-field tracker-deadline-field"><span>Deadline <em>optional</em></span><input className="auth-input" type="date" value={values.deadline} onChange={(event) => update('deadline', event.target.value)} aria-invalid={Boolean(fieldErrors.deadline)} aria-describedby={fieldErrors.deadline ? 'tracker-deadline-error' : undefined} />{fieldErrors.deadline && <small id="tracker-deadline-error" className="auth-error">{fieldErrors.deadline}</small>}</label>}
          <details className="advanced-setup">
            <summary><span><strong>Advanced options</strong><small>More measures, reminders, milestones, and planning</small></span><span className="advanced-toggle" aria-hidden="true">＋</span></summary>
            <div className="advanced-setup-content">
              {!existing && <label className="form-field advanced-description"><span>Description <em>optional</em></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Why does this matter to you?" /></label>}
              <div className="form-grid advanced-dates"><label className="form-field"><span>Start date</span><input className="auth-input" type="date" value={values.startDate} onChange={(event) => update('startDate', event.target.value)} /></label>
                {!existing && selectedKind === 'project' && <label className="form-field"><span>Project deadline <em>optional</em></span><input className="auth-input" type="date" value={values.deadline} onChange={(event) => update('deadline', event.target.value)} /></label>}
                {(!existing && selectedKind === 'goal' || !existing && selectedKind === 'project' || existing && selectedKind !== 'habit') && <label className="form-field"><span>How often will you work on it?</span><select className="auth-input" value={values.schedule} onChange={(event) => update('schedule', event.target.value)}><option value="every-day">Every day</option><option value="weekdays">Weekdays</option><option value="three-times-weekly">3 times a week</option><option value="none">No set days</option>{values.schedule === 'custom' && <option value="custom">Keep current custom schedule</option>}</select></label>}</div>
              <details className="advanced-subsection"><summary>Measures and success levels</summary><TrackerConfigurationEditor section="metrics" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Success conditions</summary><TrackerConfigurationEditor section="rules" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Extra check-in details</summary><TrackerConfigurationEditor section="fields" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Milestones</summary><TrackerConfigurationEditor section="milestones" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              {selectedKind === 'goal' && <details className="advanced-subsection"><summary>Planning style and targets</summary><GoalPlanningEditor metrics={configuration.metrics} planning={goalPlanning} onChange={setGoalPlanning} /></details>}
            </div>
          </details>
          <footer className="tracker-form-actions">
            <Button type="button" variant="secondary" onClick={() => navigate('/trackers')}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Create tracker'}</Button>
          </footer>
        </form>
      </Surface>
    </section>
  )
}

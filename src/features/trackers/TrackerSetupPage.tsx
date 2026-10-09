import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { InfoButton } from '../../components/ui/InfoButton'
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
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import type { CalendarDate } from '../../db/models'

type FormValues = { name: string; description: string; kind: TrackerKind; schedule: string; startDate: string; deadline: string }

type Configuration = { metrics: TrackerMetricDefinition[]; rule?: TrackerRule; customFields: CustomFieldDefinition[]; milestones: TrackerMilestoneDefinition[] }
const emptyGoalPlanning = (): GoalPlanningConfiguration => ({ mode: 'daily-recurring', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {} })
const kindOptions: Array<{ kind: TrackerKind; title: string; description: string; icon: string }> = [
  { kind: 'habit', title: 'Habit', description: 'Build a regular routine.', icon: '↻' },
  { kind: 'goal', title: 'Goal', description: 'Work toward an outcome.', icon: '◎' },
  { kind: 'challenge', title: 'Challenge', description: 'Try a time-limited push.', icon: '⚡' },
  { kind: 'project', title: 'Project', description: 'Make progress on a bigger effort.', icon: '◇' },
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
  const [goalPlanOpen, setGoalPlanOpen] = useState(false)
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
      deadline: current.deadline,
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

  function chooseSimpleMeasure(valueType: 'boolean' | 'quantity') {
    const metric = configuration.metrics[0]
    if (!metric) return
    const updated: TrackerMetricDefinition = valueType === 'boolean'
      ? { id: metric.id, name: 'Completed', valueType: 'boolean' }
      : { id: metric.id, name: 'Progress', valueType: 'quantity', unit: '', thresholds: { direction: 'increase', target: 1, streakQualification: 'any-recorded-value' } }
    setConfiguration((current) => ({ ...current, metrics: [updated, ...current.metrics.slice(1)], rule: starterRule(updated) }))
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
    const isNewPlannedGoal = !existing && values.kind === 'goal' && Boolean(goalAmount) && configuration.metrics[0]?.valueType !== 'boolean'
    const enteredGoalAmount = goalAmount === '' ? undefined : Number(goalAmount)
    const goalAmountInvalid = enteredGoalAmount === undefined || !Number.isFinite(enteredGoalAmount) || enteredGoalAmount <= 0 || enteredGoalAmount > Number.MAX_SAFE_INTEGER
    if (isNewPlannedGoal && goalAmountInvalid) {
      setFieldErrors((current) => ({
        ...current,
        ...(goalAmountInvalid ? { goalAmount: 'Enter a total greater than zero, such as 100.' } : {}),
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
          mode: form.deadline ? 'cumulative-deadline' : 'daily-recurring',
          progressSemantics: form.deadline ? { [metricId]: 'incremental' } : {},
          ...(form.deadline ? { cumulativeTargets: { [metricId]: enteredGoalAmount } } : { dailyTargets: { [metricId]: enteredGoalAmount } }),
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
      const hasPrecisionConfiguration = submittedMetrics.some((metric) => metric.precision !== undefined)
      const hasV3Planning = Boolean(submittedPlanning.planningTimeZone || submittedPlanning.allocations)
      const schemaVersion: TrackerDefinition['schemaVersion'] = hasPrecisionConfiguration ? 4
        : hasV3Planning ? 3
          : persistGoalPlanning ? 2
            : existing && existing.schemaVersion < 4 ? existing.schemaVersion : 1
      const candidate: TrackerDefinition = {
        ...(existing ?? {} as TrackerDefinition),
        schemaVersion, id, name: form.name, description: form.description.trim(), kind,
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
        const allocationIncrementIssues = checked.error.issues.filter((issue) =>
          issue.path[0] === 'goalPlanning' && issue.path[1] === 'allocations'
          && issue.message.startsWith('Allocation must use increments of '),
        )
        const otherIssues = checked.error.issues.filter((issue) => !allocationIncrementIssues.includes(issue))
        const messages: string[] = []
        if (allocationIncrementIssues.length) {
          const metricIds = new Set(allocationIncrementIssues.map((issue) => String(issue.path[2] ?? '')))
          const conflicts = [...metricIds].map((metricId) => {
            const metric = submittedMetrics.find((item) => item.id === metricId)
            return metric ? `${metric.name} (increments of ${metric.precision?.increment})` : 'a measure'
          })
          messages.push(`Saved daily allocations for ${conflicts.join(', ')} do not match the selected precision. Update those allocation values or restore the previous precision before saving. Your goal total, allocations, and recorded progress have not changed.`)
        }
        messages.push(...otherIssues.map((issue) => issue.message).filter((message, index, all) => all.indexOf(message) === index))
        setError(messages.join(' ') || 'Check the tracker details and try again.')
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
          {goal && savedTracker.goalPlanning && savedTracker.metrics[0] && <p>{formatTrackerNumber(savedTracker.goalPlanning.cumulativeTargets[savedTracker.metrics[0].id] ?? 0)} {savedTracker.metrics[0].unit} by {calendarDateLabel(savedTracker.deadline ?? '')}</p>}
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
  return (
    <section className="tracker-page" aria-labelledby="tracker-setup-title">
      <PageHeader headingId="tracker-setup-title" eyebrow={existing ? 'MAKE IT YOURS' : 'START WITH ONE SMALL STEP'} title={existing ? `Edit ${kindOptions.find((item) => item.kind === existing.kind)?.title.toLowerCase()}` : 'Create a tracker'} description={existing ? 'Update your setup. Saved check-ins and history stay unchanged.' : 'Start with a name. Add more detail whenever you need it.'} action={<Link className="button button-secondary button-medium" to="/trackers">Back</Link>} />
      <Surface className="tracker-form-card">
        <form className="tracker-form" onSubmit={submit} noValidate>
          {error && <div role="alert" className="form-alert">{error}</div>}
          {!existing && <fieldset className="tracker-kind-picker"><legend>What do you want to track?</legend><div className="tracker-kind-options tracker-kind-options-primary">{kindOptions.slice(0, 2).map((item) => <label key={item.kind} className={`tracker-kind-option${values.kind === item.kind ? ' selected' : ''}`}><input type="radio" name="tracker-kind" value={item.kind} checked={values.kind === item.kind} onChange={() => changeKind(item.kind)} /><span className="tracker-kind-option-icon" aria-hidden="true">{item.icon}</span><span><strong>{item.title}</strong><small>{item.description}</small></span></label>)}</div><details className="other-tracker-types" open={values.kind === 'challenge' || values.kind === 'project'}><summary>Challenge or project?</summary><div className="tracker-kind-options">{kindOptions.slice(2).map((item) => <label key={item.kind} className={`tracker-kind-option${values.kind === item.kind ? ' selected' : ''}`}><input type="radio" name="tracker-kind" value={item.kind} checked={values.kind === item.kind} onChange={() => changeKind(item.kind)} /><span className="tracker-kind-option-icon" aria-hidden="true">{item.icon}</span><span><strong>{item.title}</strong><small>{item.description}</small></span></label>)}</div></details></fieldset>}
          {existing && <div className="editing-kind-note"><span className="tracker-kind-chip">{kindOptions.find((item) => item.kind === existing.kind)?.title}</span><p>{kindOptions.find((item) => item.kind === existing.kind)?.description} Type stays the same so saved progress keeps its meaning.</p></div>}
          <label className="form-field tracker-name-field"><span>{selectedKind === 'goal' ? 'What do you want to achieve?' : selectedKind === 'habit' ? 'What habit do you want to build?' : selectedKind === 'challenge' ? 'What challenge are you taking on?' : 'What project will you move forward?'} <InfoButton title="Name" summary="Use a short name that makes the next action obvious." description="This is the title shown on Today, your tracker list, goals, history, and dashboard. A concrete phrase such as “Read 10 pages” is easier to recognize than a broad intention." /></span><input aria-label={selectedKind === 'goal' ? 'What do you want to achieve?' : selectedKind === 'habit' ? 'What habit do you want to build?' : selectedKind === 'challenge' ? 'What challenge are you taking on?' : 'What project will you move forward?'} autoFocus className="auth-input" maxLength={200} value={values.name} onChange={(event) => update('name', event.target.value)} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? 'tracker-name-error' : undefined} placeholder={selectedKind === 'goal' ? 'e.g. Solve 100 DSA problems' : selectedKind === 'habit' ? 'e.g. Read every day' : selectedKind === 'challenge' ? 'e.g. 30-day writing challenge' : 'e.g. Launch my portfolio'} />{fieldErrors.name && <small id="tracker-name-error" className="auth-error">{fieldErrors.name}</small>}</label>
          {existing && <label className="form-field tracker-name-field"><span>Description <em>optional</em> <InfoButton title="Description" summary="Keep context or motivation close to the tracker." description="This optional note appears with the tracker setup. It does not affect success rules, schedules, targets, or saved check-in values." /></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Add a note about why this matters to you." /></label>}
          {!existing && <fieldset className="simple-measure-choice"><legend>How do you want to measure it?</legend><div className="simple-measure-options"><label><input type="radio" name="simple-measure" checked={configuration.metrics[0]?.valueType === 'boolean'} onChange={() => chooseSimpleMeasure('boolean')} /><span>Done or not yet</span></label><label><input type="radio" name="simple-measure" checked={configuration.metrics[0]?.valueType !== 'boolean'} onChange={() => chooseSimpleMeasure('quantity')} /><span>Number or amount</span></label></div></fieldset>}
          <div className="form-grid tracker-quick-fields"><label className="form-field"><span>{selectedKind === 'habit' ? 'How often?' : 'Work days'}</span><select aria-label={selectedKind === 'habit' ? 'How often?' : 'Work days'} className="auth-input" value={values.schedule} onChange={(event) => update('schedule', event.target.value)}><option value="every-day">Every day</option><option value="weekdays">Weekdays</option><option value="three-times-weekly">3 times a week</option><option value="none">No set days</option>{values.schedule === 'custom' && <option value="custom">Keep current schedule</option>}</select></label>
            {!existing && selectedKind === 'challenge' && <label className="form-field"><span>Finish by <em>optional</em></span><input aria-label="Finish by" className="auth-input" type="date" value={values.deadline} onChange={(event) => update('deadline', event.target.value)} /></label>}
          </div>
          {!existing && selectedKind === 'goal' && configuration.metrics[0]?.valueType !== 'boolean' && <details className="optional-goal-plan" open={goalPlanOpen || Boolean(fieldErrors.goalAmount)} onToggle={(event) => setGoalPlanOpen(event.currentTarget.open)}>
            <summary>Add a target or deadline <span>Optional</span></summary>
            <p>A target without a deadline becomes a daily goal. Add a deadline to track a total and get a suggested pace.</p>
            <div className="goal-target-row"><label className="form-field"><span>Target amount</span><input aria-label="Total amount" className="auth-input" type="number" min="0.01" max={Number.MAX_SAFE_INTEGER} step="any" value={goalAmount} onChange={(event) => { setGoalAmount(event.target.value); setFieldErrors((current) => ({ ...current, goalAmount: '' })) }} placeholder="100" aria-invalid={Boolean(fieldErrors.goalAmount)} aria-describedby={fieldErrors.goalAmount ? 'goal-amount-error' : undefined} />{fieldErrors.goalAmount && <small id="goal-amount-error" className="auth-error">{fieldErrors.goalAmount}</small>}</label><label className="form-field"><span>Unit <em>optional</em></span><input aria-label="What are you counting?" className="auth-input" maxLength={40} value={goalUnit} onChange={(event) => setGoalUnit(event.target.value)} placeholder="problems, pages, minutes" /></label><label className="form-field"><span>Deadline <em>optional</em></span><input aria-label="Goal deadline" className="auth-input" type="date" min={values.startDate} value={values.deadline} onChange={(event) => update('deadline', event.target.value)} /></label></div>
            {pace && <p className="goal-pace-suggestion">Suggested pace: about <strong>{pace}</strong> per scheduled day.</p>}
          </details>}
          {existing && (existing.kind !== 'habit' || Boolean(existing.deadline)) && <label className="form-field tracker-deadline-field"><span>Deadline <em>optional</em> <InfoButton title="Deadline" summary="Choose the date you want this goal or challenge to be completed." description="For example, a goal to solve 100 problems by October 31. Deadline status and cumulative pace use this calendar date in the planner’s time zone. Editing the date recalculates expected and remaining scheduled days; it does not erase historical progress." /></span><input className="auth-input" type="date" min={values.startDate} value={values.deadline} onChange={(event) => update('deadline', event.target.value)} aria-invalid={Boolean(fieldErrors.deadline)} aria-describedby={fieldErrors.deadline ? 'tracker-deadline-error' : undefined} />{fieldErrors.deadline && <small id="tracker-deadline-error" className="auth-error">{fieldErrors.deadline}</small>}</label>}
          <details className="advanced-setup">
            <summary><span><strong>More options</strong><small>Extra measures, targets, milestones, and details</small></span><span className="advanced-toggle" aria-hidden="true">＋</span></summary>
            <div className="advanced-setup-content">
            {!existing && <label className="form-field advanced-description"><span>Description <em>optional</em> <InfoButton title="Description" summary="Write the context that makes this tracker meaningful." description="This text is for your own reference and does not change how values, success rules, or progress are calculated." /></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Why does this matter to you?" /></label>}
              <div className="form-grid advanced-dates"><label className="form-field"><span>Start date</span><input aria-label="Start date" className="auth-input" type="date" value={values.startDate} onChange={(event) => update('startDate', event.target.value)} /></label>
                {!existing && selectedKind === 'project' && <label className="form-field"><span>Project deadline <em>optional</em> <InfoButton title="Project deadline" summary="Set a target date for completing this project." description="The deadline is a calendar date in your workspace time zone. It helps surface overdue status and supports planning calculations when a goal plan is configured." /></span><input className="auth-input" type="date" value={values.deadline} onChange={(event) => update('deadline', event.target.value)} /></label>}
              </div>
              <details className="advanced-subsection"><summary>Measures, precision & targets</summary><TrackerConfigurationEditor section="metrics" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Success rule</summary><TrackerConfigurationEditor section="rules" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Extra check-in details</summary><TrackerConfigurationEditor section="fields" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Milestones</summary><TrackerConfigurationEditor section="milestones" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              {selectedKind === 'goal' && <details className="advanced-subsection"><summary>Goal planning</summary><GoalPlanningEditor metrics={configuration.metrics} planning={goalPlanning} onChange={setGoalPlanning} /></details>}
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

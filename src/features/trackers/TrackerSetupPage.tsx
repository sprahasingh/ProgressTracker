import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { AppIcon, type AppIconName } from '../../components/ui/AppIcon'
import { InfoButton } from '../../components/ui/InfoButton'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { useToast } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import { trackerDefinitionSchema } from '../../domain/trackers/schema'
import type { CustomFieldDefinition, GoalPlanningConfiguration, TrackerDefinition, TrackerKind, TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerRule } from '../../domain/trackers/types'
import { TrackerConfigurationEditor } from './TrackerConfigurationEditor'
import { GoalPlanningEditor } from './GoalPlanningEditor'
import { trackerSetupSchema } from './trackerSetupSchema'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { isTrackerInActivePeriod, isTrackerScheduledOccurrence, trackerActiveStartDate } from '../../domain/trackers/planning'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { isSchemaV4WriteEnabled } from '../../domain/trackers/schemaVersionGate'
import type { CalendarDate } from '../../db/models'

type FormValues = { name: string; description: string; kind: TrackerKind; schedule: string; startDate: string; deadline: string; strictMode: boolean }

type Configuration = { metrics: TrackerMetricDefinition[]; rule?: TrackerRule; customFields: CustomFieldDefinition[]; milestones: TrackerMilestoneDefinition[] }
type HistoricalPeriodConfirmation = { count: number; dateRange: string; resolve: (keep: boolean) => void }
const emptyGoalPlanning = (): GoalPlanningConfiguration => ({ mode: 'daily-recurring', progressSemantics: {}, dailyTargets: {}, cumulativeTargets: {} })
const kindOptions: Array<{ kind: TrackerKind; title: string; description: string; icon: AppIconName }> = [
  { kind: 'habit', title: 'Habit', description: 'Build a regular routine.', icon: 'habit' },
  { kind: 'goal', title: 'Goal', description: 'Work toward an outcome.', icon: 'goal' },
  { kind: 'challenge', title: 'Challenge', description: 'Try a time-limited push.', icon: 'challenge' },
  { kind: 'project', title: 'Project', description: 'Make progress on a bigger effort.', icon: 'project' },
]

function TrackerKindOption({ item, selected, onChange }: {
  item: (typeof kindOptions)[number]
  selected: boolean
  onChange: (kind: TrackerKind) => void
}) {
  return <label className={`tracker-kind-option${selected ? ' selected' : ''}`}>
    <input type="radio" name="tracker-kind" value={item.kind} checked={selected} onChange={() => onChange(item.kind)} />
    <span className="tracker-kind-option-icon" aria-hidden="true"><AppIcon name={item.icon} /></span>
    <span className="tracker-kind-option-label"><strong>{item.title}</strong><small>{item.description}</small></span>
  </label>
}

function starterMetric(kind: TrackerKind): TrackerMetricDefinition {
  const id = crypto.randomUUID()
  return kind === 'habit'
    ? { id, name: 'Completed', valueType: 'boolean' }
    : { id, name: 'Progress', valueType: 'quantity', unit: '', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }
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

function readableValidationMessage(message: string): string {
  const minimumString = message.match(/^Too small: expected string to have >=(\d+) characters/i)
  if (minimumString) return Number(minimumString[1]) === 1 ? 'Enter a value for this field.' : `Enter at least ${minimumString[1]} characters.`
  const minimumNumber = message.match(/^Too small: expected number to be >=(-?[\d.]+)/i)
  if (minimumNumber) return `Enter a value of ${minimumNumber[1]} or greater.`
  const maximumNumber = message.match(/^Too big: expected number to be <=([\d.]+)/i)
  if (maximumNumber) return `Enter a value of ${maximumNumber[1]} or less.`
  return /^(Invalid input|Invalid discriminator|Expected |Unrecognized key|Too small:|Too big:|Invalid type:|Invalid value:)/i.test(message)
    ? 'Some tracker settings are invalid. Review the highlighted fields and try again.'
    : message
}

function inlineIssueMap(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const alreadyRenderedByForm = new Set(['name', 'startDate', 'deadline', 'goalAmount'])
  return Object.fromEntries(issues
    .filter((issue) => !alreadyRenderedByForm.has(String(issue.path[0] ?? '')))
    .map((issue) => [issue.path.join('.'), issue.message]))
}

function defaultValues(tracker?: TrackerDefinition, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): FormValues {
  const schedule = tracker?.schedule.kind === 'weekdays' ? 'weekdays'
    : tracker?.schedule.kind === 'none' ? 'none'
      : tracker?.schedule.kind === 'times-per-week' && tracker.schedule.count === 3 ? 'three-times-weekly'
        : tracker && tracker.schedule.kind !== 'every-day' ? 'custom' : 'every-day'
  return {
    name: tracker?.name ?? '', description: tracker?.description ?? '', kind: tracker?.kind ?? 'habit', schedule,
    startDate: tracker?.startDate ?? todayLocal(timeZone), deadline: tracker?.deadline ?? '', strictMode: tracker?.strictMode ?? false,
  }
}

export function TrackerSetupPage() {
  const { notify } = useToast()
  const { timeZone } = useWorkspaceTimeZone()
  const { trackerId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const returnToToday = (location.state as { returnTo?: unknown } | null)?.returnTo === 'today'
  const [existing, setExisting] = useState<TrackerDefinition>()
  const [metricsWithHistory, setMetricsWithHistory] = useState<string[]>([])
  const [values, setValues] = useState<FormValues>(() => defaultValues(undefined, timeZone))
  const [configuration, setConfiguration] = useState<Configuration>(() => {
    const metric = starterMetric('habit')
    return { metrics: [metric], rule: starterRule(metric), customFields: [], milestones: [] }
  })
  const [primaryQuantityBackup, setPrimaryQuantityBackup] = useState<TrackerMetricDefinition | null>(null)
  const [goalPlanning, setGoalPlanning] = useState<GoalPlanningConfiguration>(emptyGoalPlanning)
  const [goalAmount, setGoalAmount] = useState('')
  const [goalPlanOpen, setGoalPlanOpen] = useState(false)
  const [savedTracker, setSavedTracker] = useState<TrackerDefinition | null>(null)
  const [loading, setLoading] = useState(Boolean(trackerId))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [validationIssues, setValidationIssues] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [historicalPeriodConfirmation, setHistoricalPeriodConfirmation] = useState<HistoricalPeriodConfirmation | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const advancedSetupRef = useRef<HTMLDetailsElement>(null)
  const allowNavigationRef = useRef(false)
  const currentHrefRef = useRef(window.location.href)

  useEffect(() => {
    currentHrefRef.current = window.location.href
  }, [location])

  useEffect(() => {
    const protectHistoryNavigation = (event: PopStateEvent) => {
      if (!dirty || saving || allowNavigationRef.current) return
      const destination = window.location.hash.startsWith('#/') ? window.location.hash.slice(1) : '/'
      const previousHref = currentHrefRef.current
      event.stopImmediatePropagation()
      window.history.pushState(window.history.state, '', previousHref)
      setPendingNavigation(() => () => navigate(destination))
      setConfirmDiscard(true)
    }
    window.addEventListener('popstate', protectHistoryNavigation, true)
    return () => window.removeEventListener('popstate', protectHistoryNavigation, true)
  }, [dirty, saving, navigate])

  useEffect(() => {
    const fields = [...document.querySelectorAll<HTMLElement>('[data-validation-path]')]
    const bindings = Object.entries(validationIssues).map(([path, message]) => ({
      path,
      message,
      field: fields.find((item) => item.dataset.validationPath === path && item.matches('input, select, textarea, button, [tabindex]'))
        ?? fields.find((item) => item.dataset.validationPath === path)
        ?? fields.find((item) => item.dataset.validationPath?.startsWith(`${path}.`)),
    })).filter((binding): binding is { path: string; message: string; field: HTMLElement } => Boolean(binding.field))
    for (const { path, message, field } of bindings) {
      const id = `validation-${path.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
      field.setAttribute('aria-invalid', 'true')
      field.setAttribute('aria-describedby', id)
      document.getElementById(id)?.remove()
      const description = document.createElement('small')
      description.id = id
      description.className = 'auth-error'
      description.setAttribute('role', 'alert')
      description.textContent = readableValidationMessage(message)
      field.insertAdjacentElement('afterend', description)
    }
    return () => {
      for (const { path, field } of bindings) {
        const id = `validation-${path.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`
        if (field.getAttribute('aria-describedby') === id) field.removeAttribute('aria-describedby')
        field.removeAttribute('aria-invalid')
        document.getElementById(id)?.remove()
      }
    }
  }, [validationIssues])

  useEffect(() => {
    if (!dirty || saving) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    const interceptLink = (event: MouseEvent) => {
      if (allowNavigationRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(target instanceof HTMLAnchorElement) || target.target || target.origin !== window.location.origin) return
      event.preventDefault()
      const destination = target.hash.startsWith('#/') ? target.hash.slice(1) : target.pathname + target.search + target.hash
      setPendingNavigation(() => () => navigate(destination))
      setConfirmDiscard(true)
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', interceptLink, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', interceptLink, true) }
  }, [dirty, saving, navigate])

  function discardAndLeave() {
    allowNavigationRef.current = true
    setDirty(false)
    setConfirmDiscard(false)
    if (pendingNavigation) pendingNavigation()
    else navigate('/trackers')
  }

  useEffect(() => {
    if (!trackerId) return
    let current = true
    Promise.all([localRepository.getTracker(trackerId), localRepository.listTrackerEntriesForTracker(trackerId)]).then(([tracker, entries]) => {
      if (!current) return
      if (!tracker) setError('This tracker could not be found on this device.')
      else {
        setExisting(tracker)
        setMetricsWithHistory(tracker.metrics.filter((metric) => entries.some((entry) => Object.hasOwn(entry.values, metric.id))).map((metric) => metric.id))
        setValues(defaultValues(tracker))
        setConfiguration({ metrics: tracker.metrics, rule: tracker.qualificationRule, customFields: tracker.customFields, milestones: tracker.milestones })
        setGoalPlanning(tracker.goalPlanning ?? emptyGoalPlanning())
        const primaryMetric = tracker.metrics[0]
        const savedTarget = tracker.goalPlanning?.mode === 'daily-recurring'
          ? tracker.goalPlanning.dailyTargets[primaryMetric?.id ?? '']
          : tracker.goalPlanning?.cumulativeTargets[primaryMetric?.id ?? '']
        setGoalAmount(savedTarget === undefined ? String(primaryMetric?.thresholds?.target ?? '') : String(savedTarget))
      }
    }).catch(() => current && setError('Could not open this tracker from local storage.'))
      .finally(() => current && setLoading(false))
    return () => { current = false }
  }, [trackerId])

  function update(field: keyof FormValues, value: FormValues[keyof FormValues]) {
    setValues((current) => ({ ...current, [field]: value }))
    if (field === 'deadline' && value === '' && goalPlanning.mode === 'cumulative-deadline') {
      setFieldErrors((current) => ({ ...current, deadline: 'Cumulative planning requires a deadline. Choose a date or change Planning mode to Daily recurring.' }))
      setGoalPlanOpen(true)
      advancedSetupRef.current?.setAttribute('open', '')
      return
    }
    setFieldErrors((current) => field === 'startDate' || field === 'deadline'
      ? { ...current, startDate: '', deadline: '' }
      : { ...current, [field]: '' })
  }

  function changeGoalPlanning(next: GoalPlanningConfiguration) {
    setGoalPlanning(next)
    if (next.mode === 'cumulative-deadline' && !values.deadline) {
      const message = 'Cumulative planning requires a deadline. Choose a date or change Planning mode to Daily recurring.'
      setFieldErrors((current) => ({ ...current, deadline: message }))
      setGoalPlanOpen(true)
      advancedSetupRef.current?.setAttribute('open', '')
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Goal deadline"], .tracker-deadline-field input')?.focus())
    } else {
      setFieldErrors((current) => current.deadline?.startsWith('Cumulative planning requires') ? { ...current, deadline: '' } : current)
    }
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
        ? { ...oldMetric, name: 'Progress', valueType: 'quantity' as const, unit: '', thresholds: { direction: 'increase' as const, streakQualification: 'any-recorded-value' as const } }
        : previousKind !== 'habit' && kind === 'habit'
          ? { id: oldMetric.id, name: 'Completed', valueType: 'boolean' as const }
          : oldMetric
      const rule = starterRule(changed)
      return { ...current, metrics: [changed], rule }
    })
    setPrimaryQuantityBackup(null)
  }

  function chooseSimpleMeasure(valueType: 'boolean' | 'quantity') {
    const metric = configuration.metrics[0]
    if (!metric || metric.valueType === valueType) return
    if (valueType === 'boolean' && metric.valueType === 'quantity') setPrimaryQuantityBackup(metric)
    const restored = valueType === 'quantity' && primaryQuantityBackup?.id === metric.id ? primaryQuantityBackup : undefined
    const defaultName = metric.name === 'Completed' || metric.name === 'Progress'
      ? valueType === 'boolean' ? 'Completed' : 'Progress'
      : metric.name
    const updated: TrackerMetricDefinition = valueType === 'boolean'
      ? { id: metric.id, name: defaultName, valueType: 'boolean' }
      : restored ? { ...restored, name: defaultName }
        : { id: metric.id, name: defaultName, valueType: 'quantity', unit: '', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }
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

  function requestRemoveMetric(metricId: string) {
    const metric = configuration.metrics.find((item) => item.id === metricId)
    if (!metric) return
    const usesRule = (rule?: TrackerRule): boolean => !rule ? false : rule.kind === 'threshold' || rule.kind === 'comparison'
      ? rule.metricId === metricId
      : rule.operands.some(usesRule)
    const hasPlan = [goalPlanning.progressSemantics, goalPlanning.dailyTargets, goalPlanning.cumulativeTargets, goalPlanning.allocations].some((map) => Boolean(map?.[metricId]))
    const hasMilestone = configuration.milestones.some((item) => item.metricId === metricId)
    if (usesRule(configuration.rule) || hasPlan || hasMilestone) {
      const dependencies = [usesRule(configuration.rule) && 'success rule', hasPlan && 'goal plan', hasMilestone && 'milestone'].filter(Boolean).join(', ')
      notify({ kind: 'error', title: 'Resolve measure references first', description: `“${metric.name}” is used by ${dependencies}. Update those settings before removing or retiring this measure.`, duration: 0, dedupeKey: `measure-reference:${metricId}` })
      return
    }
    const hasHistory = metricsWithHistory.includes(metricId)
    if (hasHistory && !window.confirm(`Retire “${metric.name}”? Retired measures won't appear in new check-ins, but their previous entries will remain available in History.`)) return
    const activeCount = configuration.metrics.filter((item) => item.retiredAt === undefined).length
    if (activeCount <= 1 && metric.retiredAt === undefined) {
      notify({ kind: 'error', title: 'Keep one active measure', description: 'A tracker needs at least one active measure for future check-ins.', duration: 0, dedupeKey: 'last-active-measure' })
      return
    }
    if (hasHistory) {
      changeMetrics(configuration.metrics.map((item) => item.id === metricId ? { ...item, retiredAt: new Date().toISOString() } : item))
      return
    }
    changeMetrics(configuration.metrics.filter((item) => item.id !== metricId))
  }

  function updateStarterTarget(raw: string) {
    const target = raw === '' ? undefined : Number(raw)
    setConfiguration((current) => ({
      ...current,
      metrics: current.metrics.map((metric, index) => {
        if (index !== 0) return metric
        const previous = metric.thresholds ?? { direction: 'increase' as const, streakQualification: 'any-recorded-value' as const }
        const withoutTarget = { ...previous }
        delete withoutTarget.target
        const streakQualification = previous.streakQualification === 'target' && target === undefined
          ? previous.minimum === undefined ? 'any-recorded-value' as const : 'minimum' as const
          : previous.streakQualification === 'minimum' && previous.minimum === undefined
            ? 'any-recorded-value' as const : previous.streakQualification
        return { ...metric, thresholds: { ...withoutTarget, streakQualification, ...(target === undefined ? {} : { target }) } }
      }),
    }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    setError('')
    const parsed = trackerSetupSchema.safeParse(values)
    if (!parsed.success) {
      const issues = parsed.error.issues
      setValidationIssues(inlineIssueMap(issues))
      setFieldErrors(Object.fromEntries(issues.map((issue) => [String(issue.path[0]), issue.message])))
      const message = issues[0]?.message ?? 'Check the highlighted tracker details.'
      notify({ kind: 'error', title: 'Check the tracker details', description: message, duration: 0, dedupeKey: 'tracker-form-validation' })
      if (issues.some((issue) => issue.path[0] === 'deadline') && values.kind === 'goal' && !existing) setGoalPlanOpen(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const field = issues[0]?.path[0]
        const target = field === 'name' ? document.querySelector<HTMLInputElement>('[aria-label^="What "]')
          : field === 'startDate' ? document.querySelector<HTMLInputElement>('[aria-label="Start date"]')
            : field === 'deadline' ? document.querySelector<HTMLInputElement>('[aria-label="Goal deadline"], .tracker-deadline-field input') : null
        target?.focus(); target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      }))
      return
    }
    if (existing && (existing.strictMode ?? false) !== parsed.data.strictMode) {
      const message = parsed.data.strictMode
        ? 'Enabling Strict Mode will recalculate this tracker’s streak using every calendar day, including past holidays and rest days. Your recorded progress will not be deleted.'
        : 'Switching to Standard Mode will recalculate this tracker’s streak using scheduled days, with holidays and rest days preserving continuity. Your recorded progress will not be deleted.'
      if (!window.confirm(message)) return
    }
    if (existing && parsed.data.startDate) {
      const nextPeriod = { ...existing, startDate: parsed.data.startDate, deadline: parsed.data.deadline || undefined }
      const narrowsStart = trackerActiveStartDate(nextPeriod, timeZone) > trackerActiveStartDate(existing, timeZone)
      const narrowsDeadline = Boolean(nextPeriod.deadline && (!existing.deadline || nextPeriod.deadline < existing.deadline))
      if (narrowsStart || narrowsDeadline) {
        let excludedEntries: Awaited<ReturnType<typeof localRepository.listTrackerEntriesForTracker>>
        try {
          const entries = await localRepository.listTrackerEntriesForTracker(existing.id)
          excludedEntries = entries.filter((entry) => isTrackerInActivePeriod(existing, entry.date, timeZone) && !isTrackerInActivePeriod(nextPeriod, entry.date, timeZone))
        } catch {
          const message = 'Could not verify saved check-ins against the new tracker period. Nothing was saved; please try again.'
          setError(message)
          notify({ kind: 'error', title: 'Could not verify check-ins', description: message, duration: 0, dedupeKey: 'tracker-form-validation' })
          return
        }
        if (excludedEntries.length > 0) {
          const affectedDates = excludedEntries.map((entry) => entry.date).sort()
          const firstAffectedDate = affectedDates[0] ?? 'unknown date'
          const lastAffectedDate = affectedDates.at(-1) ?? firstAffectedDate
          const affectedRange = firstAffectedDate === lastAffectedDate
            ? firstAffectedDate
            : `${firstAffectedDate}–${lastAffectedDate}`
          const keepHistoricalEntries = await new Promise<boolean>((resolve) => {
            setHistoricalPeriodConfirmation({ count: excludedEntries.length, dateRange: affectedRange, resolve })
          })
          if (!keepHistoricalEntries) return
        }
      }
    }
    const isNewPlannedGoal = !existing && values.kind === 'goal' && Boolean(goalAmount) && configuration.metrics[0]?.valueType !== 'boolean'
    const enteredGoalAmount = goalAmount === '' ? undefined : Number(goalAmount)
    const goalAmountInvalid = enteredGoalAmount === undefined || !Number.isFinite(enteredGoalAmount) || enteredGoalAmount <= 0 || enteredGoalAmount > Number.MAX_SAFE_INTEGER
    if (isNewPlannedGoal && goalAmountInvalid) {
      const message = 'Enter a total greater than zero, such as 100.'
      setFieldErrors((current) => ({
        ...current,
        ...(goalAmountInvalid ? { goalAmount: message } : {}),
      }))
      notify({ kind: 'error', title: 'Check the goal target', description: message, duration: 0, dedupeKey: 'tracker-form-validation' })
      requestAnimationFrame(() => { setGoalPlanOpen(true); const field = document.querySelector<HTMLInputElement>('[aria-label="Total amount"]'); field?.focus(); field?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }) })
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
        ? { ...metric, unit: metric.unit?.trim() }
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
        strictMode: form.strictMode,
        qualificationRule: configuration.rule,
        customFields: configuration.customFields,
        milestones: configuration.milestones,
        ...(persistGoalPlanning ? { goalPlanning: submittedPlanning } : {}),
        createdAt: existing?.createdAt ?? now, updatedAt: now, archivedAt: existing?.archivedAt ?? null, deletedAt: null,
      }
      const checked = trackerDefinitionSchema.safeParse(candidate)
      if (!checked.success) {
        setValidationIssues(inlineIssueMap(checked.error.issues))
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
        messages.push(...otherIssues.map((issue) => readableValidationMessage(issue.message)).filter((message, index, all) => all.indexOf(message) === index))
        const message = messages.join(' ') || 'Check the tracker details and try again.'
        setError(message)
        const firstIssue = checked.error.issues[0]
        if (firstIssue?.path[0] === 'deadline') {
          setFieldErrors((current) => ({ ...current, deadline: firstIssue.message }))
          setGoalPlanOpen(true)
        }
        notify({ kind: 'error', title: 'Tracker details need attention', description: messages[0] ?? 'Check the highlighted tracker details.', duration: 0, dedupeKey: 'tracker-form-validation' })
        advancedSetupRef.current?.setAttribute('open', '')
        const issuePath = firstIssue?.path[0]
        const sectionLabel = issuePath === 'metrics' ? 'Measures, precision & targets'
          : issuePath === 'goalPlanning' ? 'Goal planning'
            : issuePath === 'customFields' ? 'Extra check-in details'
              : issuePath === 'milestones' ? 'Milestones'
                : issuePath === 'qualificationRule' ? 'Success rule' : undefined
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const details = advancedSetupRef.current
        if (!details) return
        const section = sectionLabel ? [...details.querySelectorAll<HTMLDetailsElement>('.advanced-subsection')].find((item) => item.querySelector('summary')?.textContent?.includes(sectionLabel)) : undefined
        if (section) section.open = true
        const exactPath = checked.error.issues[0]?.path.join('.')
        const candidates = [...document.querySelectorAll<HTMLElement>('[data-validation-path]')]
        const exact = exactPath ? candidates.find((item) => item.dataset.validationPath === exactPath && item.matches('input, select, textarea, button, [tabindex]'))
          ?? candidates.find((item) => item.dataset.validationPath === exactPath)
          ?? candidates.find((item) => item.dataset.validationPath?.startsWith(`${exactPath}.`)) : undefined
        const target = exact?.matches('input, select, textarea, button, [tabindex]') ? exact
          : exact?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')
            ?? section?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')
        target?.focus(); target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      }))
        return
      }
      const result = await localRepository.saveTracker(checked.data as TrackerDefinition)
      allowNavigationRef.current = true
      setDirty(false)
      notify({ kind: 'success', title: existing ? 'Tracker updated' : 'Tracker created', description: returnToToday && !existing ? 'Your new tracker is ready. Your progress is saved on this device.' : existing ? 'Your changes were saved on this device.' : 'Your new tracker was saved on this device.', dedupeKey: `tracker:${result.id}` })
      if (existing) {
        navigate('/trackers', { replace: true, state: { savedTracker: result.id } })
      }
      else if (returnToToday) {
        navigate('/', { replace: true })
      }
      else setSavedTracker(result)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : ''
      const recoverableMessage = /measure type|retired measure|saved check-ins|active measure/i.test(detail) ? detail : 'Your changes were not saved. Please try again.'
      setError(recoverableMessage)
      notify({ kind: 'error', title: existing ? 'Couldn’t update tracker' : 'Couldn’t create tracker', description: recoverableMessage, duration: 0, dedupeKey: existing?.id ? `tracker:${existing.id}` : `tracker-create:${values.name}` })
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
        <span className="tracker-created-mark" aria-hidden="true"><AppIcon name="check" /></span>
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
    <section className="tracker-page tracker-setup-page" aria-labelledby="tracker-setup-title">
      <PageHeader headingId="tracker-setup-title" eyebrow={existing ? 'MAKE IT YOURS' : undefined} title={existing ? `Edit ${kindOptions.find((item) => item.kind === existing.kind)?.title.toLowerCase()}` : 'Create a tracker'} description={existing ? 'Update your setup. Saved check-in dates and values stay unchanged; results may recalculate from these settings.' : undefined} />
      <Surface className="tracker-form-card">
        <form className="tracker-form tracker-setup-form" onSubmit={submit} onChangeCapture={(event) => {
          setDirty(true)
          const target = event.target
          if (target instanceof HTMLElement) {
            const path = target.dataset.validationPath
            if (path) setValidationIssues((current) => Object.fromEntries(Object.entries(current).filter(([issuePath]) => issuePath !== path && !issuePath.startsWith(`${path}.`))))
          }
        }} onClickCapture={(event) => { const target = event.target; if (target instanceof HTMLButtonElement && target.type !== 'submit' && !target.hasAttribute('data-discard-trigger') && !target.closest('.info-button, [data-ignore-dirty]')) setDirty(true) }} noValidate>
          {error && <div role="alert" className="form-alert">{error}</div>}
          {!existing && <fieldset className="tracker-kind-picker"><legend>What do you want to track?</legend><div className="tracker-kind-options tracker-kind-options-primary">{kindOptions.slice(0, 2).map((item) => <TrackerKindOption key={item.kind} item={item} selected={values.kind === item.kind} onChange={changeKind} />)}</div><details className="other-tracker-types"><summary>Challenge or project?</summary><div className="tracker-kind-options">{kindOptions.slice(2).map((item) => <TrackerKindOption key={item.kind} item={item} selected={values.kind === item.kind} onChange={changeKind} />)}</div></details></fieldset>}
          {existing && <div className="editing-kind-note"><span className="tracker-kind-chip">{kindOptions.find((item) => item.kind === existing.kind)?.title}</span><p>{kindOptions.find((item) => item.kind === existing.kind)?.description} Type stays the same so saved progress keeps its meaning.</p></div>}
          <label className="form-field tracker-name-field"><span>{selectedKind === 'goal' ? 'What do you want to achieve?' : selectedKind === 'habit' ? 'What habit do you want to build?' : selectedKind === 'challenge' ? 'What challenge are you taking on?' : 'What project will you move forward?'}</span><input data-validation-path="name" aria-label={selectedKind === 'goal' ? 'What do you want to achieve?' : selectedKind === 'habit' ? 'What habit do you want to build?' : selectedKind === 'challenge' ? 'What challenge are you taking on?' : 'What project will you move forward?'} className="auth-input" maxLength={200} value={values.name} onChange={(event) => update('name', event.target.value)} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? 'tracker-name-error' : undefined} placeholder={selectedKind === 'goal' ? 'e.g. Solve 100 DSA problems' : selectedKind === 'habit' ? 'e.g. Read every day' : selectedKind === 'challenge' ? 'e.g. 30-day writing challenge' : 'e.g. Launch my portfolio'} />{fieldErrors.name && <small id="tracker-name-error" className="auth-error">{fieldErrors.name}</small>}</label>
          {existing && <label className="form-field tracker-name-field"><span>Description <em>optional</em> <InfoButton title="Description" summary="Keep context or motivation close to the tracker." description="This optional note appears with the tracker setup. It does not affect success rules, schedules, targets, or saved check-in values." /></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Add a note about why this matters to you." /></label>}
          {!existing && <fieldset className="simple-measure-choice"><legend>How do you want to measure it?</legend><div className="simple-measure-options"><label><input type="radio" name="simple-measure" checked={configuration.metrics[0]?.valueType === 'boolean'} onChange={() => chooseSimpleMeasure('boolean')} /><span>Done or not yet</span></label><label><input type="radio" name="simple-measure" checked={configuration.metrics[0]?.valueType !== 'boolean'} onChange={() => chooseSimpleMeasure('quantity')} /><span>Number or amount</span></label></div></fieldset>}
          <div className="form-grid tracker-quick-fields"><label className="form-field"><span>Start date</span><input data-validation-path="startDate" aria-label="Start date" className="auth-input" type="date" max={values.deadline || undefined} value={values.startDate} onChange={(event) => update('startDate', event.target.value)} aria-invalid={Boolean(fieldErrors.startDate)} aria-describedby={fieldErrors.startDate ? 'tracker-start-date-error' : undefined} />{fieldErrors.startDate && <small id="tracker-start-date-error" className="auth-error">{fieldErrors.startDate}</small>}</label></div>
          {!existing && configuration.metrics[0]?.valueType !== 'boolean' && <section className="simple-numeric-settings" aria-label="Numeric measure settings">
            <label className="form-field"><span>Unit <em>optional</em></span><input aria-label="Numeric measure unit" className="auth-input" value={configuration.metrics[0]?.unit ?? ''} onChange={(event) => setConfiguration((current) => ({ ...current, metrics: current.metrics.map((metric, index) => index === 0 ? { ...metric, unit: event.target.value } : metric) }))} placeholder="pages, minutes, sessions" /></label>
            <label className="form-field"><span>Target per check-in <em>optional</em></span><input aria-label="Per-check-in target" className="auth-input" type="number" min="0" step={configuration.metrics[0]?.precision?.increment ?? 'any'} value={configuration.metrics[0]?.thresholds?.target ?? ''} onChange={(event) => updateStarterTarget(event.target.value)} placeholder="e.g. 1" /></label>
            <label className="form-field"><span>Precision</span><select aria-label="Numeric precision" className="auth-input" value={configuration.metrics[0]?.precision ? String(configuration.metrics[0].precision.decimalPlaces) : ''} disabled={!isSchemaV4WriteEnabled()} onChange={(event) => { const places = event.target.value === '' ? undefined : Number(event.target.value) as 0 | 1 | 2; setConfiguration((current) => ({ ...current, metrics: current.metrics.map((metric, index) => index === 0 ? { ...metric, precision: places === undefined ? undefined : { decimalPlaces: places, increment: places === 0 ? 1 : places === 1 ? 0.1 : 0.01 } } : metric) })) }}><option value="">Standard</option><option value="0">Whole numbers</option><option value="1">One decimal place</option><option value="2">Up to two decimals</option></select></label>
            {!isSchemaV4WriteEnabled() && <small className="field-hint">Precision settings are unavailable in this build until the numeric precision schema is enabled.</small>}
          </section>}
          {!existing && selectedKind === 'goal' && configuration.metrics[0]?.valueType !== 'boolean' && <details className="optional-goal-plan" open={goalPlanOpen || Boolean(fieldErrors.goalAmount)} onToggle={(event) => setGoalPlanOpen(event.currentTarget.open)}>
            <summary>Add a target or deadline <span>Optional</span></summary>
            <p>A target without a deadline becomes a daily goal. Add a deadline to track a total and get a suggested pace.</p>
            <div className="goal-target-row"><label className="form-field"><span>Target amount {configuration.metrics[0]?.unit ? <em>· {configuration.metrics[0].unit}</em> : null}</span><input aria-label="Total amount" className="auth-input" type="number" min="0.01" max={Number.MAX_SAFE_INTEGER} step="any" value={goalAmount} onChange={(event) => { setGoalAmount(event.target.value); setFieldErrors((current) => ({ ...current, goalAmount: '' })) }} placeholder="100" aria-invalid={Boolean(fieldErrors.goalAmount)} aria-describedby={fieldErrors.goalAmount ? 'goal-amount-error' : undefined} />{fieldErrors.goalAmount && <small id="goal-amount-error" className="auth-error">{fieldErrors.goalAmount}</small>}</label><label className="form-field"><span>Deadline <em>optional</em></span><input data-validation-path="deadline" aria-label="Goal deadline" className="auth-input" type="date" min={values.startDate} value={values.deadline} onChange={(event) => update('deadline', event.target.value)} aria-invalid={Boolean(fieldErrors.deadline)} aria-describedby={fieldErrors.deadline ? 'tracker-deadline-error' : undefined} />{fieldErrors.deadline && <small id="tracker-deadline-error" className="auth-error">{fieldErrors.deadline}</small>}</label></div>
            {pace && <p className="goal-pace-suggestion">Suggested pace: about <strong>{pace}</strong> per scheduled day.</p>}
          </details>}
          {existing && (existing.kind !== 'habit' || Boolean(existing.deadline)) && <label className="form-field tracker-deadline-field"><span>Deadline {goalPlanning.mode === 'cumulative-deadline' ? <em>required for cumulative planning</em> : <em>optional</em>} <InfoButton title="Deadline" summary="Choose the date you want this goal or challenge to be completed." description="For example, a goal to solve 100 problems by October 31. Deadline status and cumulative pace use this calendar date in the planner’s time zone. Editing the date recalculates expected and remaining scheduled days; it does not erase historical progress." /></span><input data-validation-path="deadline" className="auth-input" type="date" min={values.startDate} value={values.deadline} onChange={(event) => update('deadline', event.target.value)} aria-invalid={Boolean(fieldErrors.deadline)} aria-describedby={fieldErrors.deadline ? 'tracker-deadline-error' : undefined} />{fieldErrors.deadline && <small id="tracker-deadline-error" className="auth-error">{fieldErrors.deadline}</small>}</label>}
          <details className="advanced-setup" ref={advancedSetupRef}>
            <summary><span><strong>More options</strong><small>Extra measures, targets, milestones, and details</small></span><span className="advanced-toggle" aria-hidden="true">＋</span></summary>
            <div className="advanced-setup-content">
            {!existing && <label className="form-field advanced-description"><span>Description <em>optional</em> <InfoButton title="Description" summary="Write the context that makes this tracker meaningful." description="This text is for your own reference and does not change how values, success rules, or progress are calculated." /></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Why does this matter to you?" /></label>}
              <details className="advanced-subsection"><summary>Schedule & holidays</summary><div className="form-grid advanced-dates"><label className="form-field"><span>{selectedKind === 'habit' ? 'How often?' : 'Work days'}</span><select aria-label={selectedKind === 'habit' ? 'How often?' : 'Work days'} className="auth-input" value={values.schedule} onChange={(event) => update('schedule', event.target.value)}><option value="every-day">Every day</option><option value="weekdays">Weekdays</option><option value="three-times-weekly">3 times a week</option><option value="none">No set days</option>{values.schedule === 'custom' && <option value="custom">Keep current schedule</option>}</select></label>
                {!existing && selectedKind === 'challenge' && <label className="form-field"><span>Finish by <em>optional</em></span><input data-validation-path="deadline" aria-label="Finish by" className="auth-input" type="date" min={values.startDate} value={values.deadline} onChange={(event) => update('deadline', event.target.value)} /></label>}
                {!existing && selectedKind === 'project' && <label className="form-field"><span>Project deadline <em>optional</em></span><input data-validation-path="deadline" aria-label="Project deadline" className="auth-input" type="date" min={values.startDate} value={values.deadline} onChange={(event) => update('deadline', event.target.value)} /></label>}
                <label className="strict-mode-option"><input type="checkbox" checked={values.strictMode} onChange={(event) => update('strictMode', event.target.checked)} /><span><strong>Strict Mode</strong><small>Require a qualifying check-in on every calendar day. Holidays and rest days do not preserve your streak.</small></span><InfoButton title="Strict Mode" summary="Every calendar day becomes a streak opportunity, including weekdays, weekends, rest days, and holidays." description="A day qualifies only when progress meets this tracker’s configured streak rule. Partial progress counts if it meets that rule; a lower partial result breaks the streak after the day ends. Changing this setting recalculates current and longest streaks from past entries without changing them. Today remains open until it ends. Voluntary check-ins on rest days or holidays can keep the streak without changing the schedule or holiday." /></label>
                <p className="field-hint form-field-wide">Workspace holidays and excluded days are applied automatically.</p>
              </div></details>
              <details className="advanced-subsection"><summary>Measures, precision & targets</summary><TrackerConfigurationEditor section="metrics" firstMetricTypeMode={existing ? 'locked' : 'setup'} persistedMetricIds={existing?.metrics.map((metric) => metric.id)} metricsWithHistory={metricsWithHistory} onRemoveMetric={requestRemoveMetric} planning={goalPlanning} metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Success rule</summary><TrackerConfigurationEditor section="rules" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Extra check-in details</summary><TrackerConfigurationEditor section="fields" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Milestones</summary><TrackerConfigurationEditor section="milestones" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              {selectedKind === 'goal' && <details data-ai-capability="goals.planning" className="advanced-subsection"><summary>Goal planning{goalPlanning.mode === 'cumulative-deadline' ? ' · deadline required' : ''}</summary><GoalPlanningEditor metrics={configuration.metrics} planning={goalPlanning} onChange={changeGoalPlanning} /></details>}
            </div>
          </details>
          <footer className="tracker-form-actions">
            <Button data-ai-capability={existing ? 'trackers.measure_configuration' : 'trackers.create'} type="submit" disabled={saving}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Create tracker'}</Button>
            <Button type="button" variant="quiet" data-discard-trigger onClick={() => { if (!dirty) navigate('/trackers'); else { setPendingNavigation(null); setConfirmDiscard(true) } }}>Cancel</Button>
          </footer>
        </form>
      </Surface>
      {confirmDiscard && <div className="tracker-discard-backdrop" role="presentation"><section className="tracker-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description"><h2 id="discard-title">Discard unsaved changes?</h2><p id="discard-description">Your tracker setup will be lost if you leave now.</p><div><Button type="button" variant="quiet" onClick={() => { setConfirmDiscard(false); setPendingNavigation(null) }}>Keep editing</Button><Button type="button" variant="destructive" onClick={discardAndLeave}>Discard changes</Button></div></section></div>}
      {historicalPeriodConfirmation && <div className="tracker-discard-backdrop" role="presentation"><section className="tracker-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="historical-period-title" aria-describedby="historical-period-description"><h2 id="historical-period-title">Keep historical check-ins?</h2><p id="historical-period-description">Changing the tracker period will place {historicalPeriodConfirmation.count} existing check-in{historicalPeriodConfirmation.count === 1 ? '' : 's'} outside the active tracking period ({historicalPeriodConfirmation.dateRange}). Their dates and values will remain in History, but they will not count toward current-period streaks, completion rates, or goal progress.</p><div><Button type="button" variant="quiet" onClick={() => { const resolve = historicalPeriodConfirmation.resolve; setHistoricalPeriodConfirmation(null); resolve(false) }}>Cancel changes</Button><Button type="button" onClick={() => { const resolve = historicalPeriodConfirmation.resolve; setHistoricalPeriodConfirmation(null); resolve(true) }}>Keep historical entries</Button></div></section></div>}
    </section>
  )
}

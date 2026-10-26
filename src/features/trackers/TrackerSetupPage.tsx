import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { AppIcon, type AppIconName } from '../../components/ui/AppIcon'
import { InfoButton } from '../../components/ui/InfoButton'
import { PageHeader } from '../../components/ui/PageHeader'
import { Surface } from '../../components/ui/Surface'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { useToast } from '../../components/ui/ToastProvider'
import { localRepository } from '../../db/localRepository'
import { trackerDefinitionSchema } from '../../domain/trackers/schema'
import type { CustomFieldDefinition, GoalPlanningConfiguration, TrackerDefinition, TrackerKind, TrackerMetricDefinition, TrackerMilestoneDefinition, TrackerRule, TrackerSchedulingMode } from '../../domain/trackers/types'
import { trackerEvaluationChanged, versionTrackerRuleChange, type RuleApplicationMode } from '../../domain/trackers/ruleVersions'
import { currentRuleDependencyIssue, historicalRuleDependencyIssue } from '../../domain/trackers/historicalDependencies'
import { TrackerConfigurationEditor } from './TrackerConfigurationEditor'
import { GoalPlanningEditor } from './GoalPlanningEditor'
import { trackerSetupSchema } from './trackerSetupSchema'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { calendarDateLabel, localCalendarDate, shiftCalendarDate } from '../shared/localDates'
import { isTrackerInActivePeriod, trackerActiveStartDate } from '../../domain/trackers/planning'
import { formatTrackerNumber } from '../../domain/trackers/formatNumber'
import { isUnsupportedSchemaFailure, reportTrackerWriteDiagnostic } from '../../utils/trackerWriteDiagnostics'
import { isSchemaV4WriteEnabled, isSchemaV6WriteEnabled, isSchemaV7WriteEnabled, isSchemaV8WriteEnabled, isSchemaV9WriteEnabled, isSchemaV10WriteEnabled, isTrackerEditHistorySyncGuardEnabled } from '../../domain/trackers/schemaVersionGate'
import { deriveSchedulingDeadline, inclusiveCalendarDays, trackerScheduleLabel, trackerScheduling, countScheduledActivityDays } from '../../domain/trackers/scheduling'
import type { CalendarDate } from '../../db/models'

type FormValues = { name: string; description: string; kind: TrackerKind; schedule: string; customWeekdays: number[]; startDate: string; deadline: string; schedulingMode: TrackerSchedulingMode; effectiveDays: string; effectiveDayCounting: 'planned-activity-days' | 'all-non-holiday-days'; strictMode: boolean }

type Configuration = { metrics: TrackerMetricDefinition[]; rule?: TrackerRule; streakRuleMode: TrackerDefinition['streakRuleMode'] | 'legacy'; streakRule?: TrackerRule; customFields: CustomFieldDefinition[]; milestones: TrackerMilestoneDefinition[] }
type HistoricalPeriodConfirmation = { count: number; dateRange: string; resolve: (keep: boolean) => void }
type PendingRuleChange = { candidate: TrackerDefinition; mode: RuleApplicationMode; historyStartDate: string; today: CalendarDate; latestCheckInDate: CalendarDate | null; structural: boolean; allHistoryAvailable: boolean; allHistoryReason: string | null }
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
    ? { id, name: 'Status', valueType: 'boolean' }
    : { id, name: 'Progress', valueType: 'quantity', unit: '', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }
}

function defaultMeasureName(valueType: TrackerMetricDefinition['valueType']): string {
  return valueType === 'boolean' ? 'Status' : valueType === 'duration' ? 'Time Spent' : valueType === 'checklist' ? 'Items' : 'Progress'
}

function starterRule(metric: TrackerMetricDefinition): TrackerRule {
  return metric.valueType === 'boolean'
    ? { kind: 'comparison', metricId: metric.id, operator: 'equals', value: true }
    : metric.thresholds?.target !== undefined
      ? { kind: 'threshold', metricId: metric.id, level: 'target' }
      : { kind: 'comparison', metricId: metric.id, operator: 'at-least', value: 1 }
}

function rebaseMetricRule(rule: TrackerRule | undefined, metric: TrackerMetricDefinition): TrackerRule | undefined {
  if (!rule) return undefined
  if (rule.kind === 'threshold' || rule.kind === 'comparison') return rule.metricId === metric.id ? starterRule(metric) : rule
  return { ...rule, operands: rule.operands.map((operand) => rebaseMetricRule(operand, metric)!) }
}

function todayLocal(timeZone: string): CalendarDate {
  return localCalendarDate(new Date(), timeZone)
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item
  return JSON.stringify(sort(value))
}

function stableCustomFieldConfiguration(fields: TrackerDefinition['customFields']): string {
  return stableJson([...fields]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((field) => Object.fromEntries(Object.entries(field).filter(([key]) => key !== 'position'))))
}

const weekdayChoices = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]] as const
const weekendsPreferredDays = [0, 6]

function scheduleFromForm(value: string, existing?: TrackerDefinition, customWeekdays: readonly number[] = []): TrackerDefinition['schedule'] {
  if (value === 'every-day') return { kind: 'every-day' }
  if (value === 'weekdays') return { kind: 'weekdays' }
  if (value === 'weekends') return { kind: 'selected-weekdays', weekdays: weekendsPreferredDays }
  if (value === 'custom-days') return { kind: 'selected-weekdays', weekdays: [...new Set(customWeekdays)].sort((a, b) => a - b) }
  if (value === 'none') return { kind: 'none' }
  if (value === 'keep-current' && existing) return existing.schedule
  return { kind: 'every-day' }
}

function suggestedPace(amount: number, startDate: string, deadline: string, tracker: Pick<TrackerDefinition, 'schedule' | 'startDate' | 'createdAt' | 'goalPlanning'>, holidays: ReadonlySet<string>, timeZone: string): string | null {
  if (!Number.isFinite(amount) || amount <= 0 || deadline < startDate) return null
  const count = countScheduledActivityDays({ tracker, startDate, endDate: deadline, holidays, timeZone })
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

function isWeekendSchedule(schedule: TrackerDefinition['schedule']): boolean {
  if (schedule.kind === 'selected-weekdays') return schedule.weekdays.length === 2 && weekendsPreferredDays.every((day) => schedule.weekdays.includes(day))
  return schedule.kind === 'times-per-week' && schedule.count === 2 && schedule.preferredWeekdays?.length === 2 && weekendsPreferredDays.every((day) => schedule.preferredWeekdays!.includes(day))
}

function inlineIssueMap(issues: readonly { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const alreadyRenderedByForm = new Set(['name', 'startDate', 'deadline', 'goalAmount', 'schedule'])
  return Object.fromEntries(issues
    .filter((issue) => !alreadyRenderedByForm.has(String(issue.path[0] ?? '')))
    .map((issue) => [issue.path.join('.'), issue.message]))
}

function defaultValues(tracker?: TrackerDefinition, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): FormValues {
  const schedule = tracker?.schedule.kind === 'weekdays' ? 'weekdays'
    : tracker?.schedule.kind === 'none' ? 'none'
      : tracker && isWeekendSchedule(tracker.schedule) ? 'weekends'
        : tracker?.schedule.kind === 'selected-weekdays' ? 'custom-days'
          : tracker && tracker.schedule.kind !== 'every-day' ? 'keep-current' : 'every-day'
  const customWeekdays = tracker?.schedule.kind === 'selected-weekdays' ? [...tracker.schedule.weekdays]
    : tracker?.schedule.kind === 'weekdays' ? [1, 2, 3, 4, 5]
      : tracker?.schedule.kind === 'every-day' ? [0, 1, 2, 3, 4, 5, 6]
        : tracker?.schedule.kind === 'times-per-week' ? [...(tracker.schedule.preferredWeekdays ?? [])]
          : tracker ? [] : [0, 1, 2, 3, 4, 5, 6]
  return {
    name: tracker?.name ?? '', description: tracker?.description ?? '', kind: tracker?.kind ?? 'habit', schedule, customWeekdays,
    startDate: tracker ? trackerActiveStartDate(tracker, timeZone) : todayLocal(timeZone), deadline: tracker?.deadline ?? '',
    schedulingMode: tracker ? trackerScheduling(tracker).mode : 'ongoing', effectiveDays: String(tracker?.scheduling?.effectiveDays ?? ''), effectiveDayCounting: tracker ? tracker.scheduling?.effectiveDayCounting ?? 'all-non-holiday-days' : 'planned-activity-days', strictMode: tracker?.strictMode ?? false,
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
  const [archivedStatusAfterSave, setArchivedStatusAfterSave] = useState<'archived' | 'active'>('archived')
  const [metricsWithHistory, setMetricsWithHistory] = useState<string[]>([])
  const [customFieldsWithHistory, setCustomFieldsWithHistory] = useState<string[]>([])
  const [values, setValues] = useState<FormValues>(() => defaultValues(undefined, timeZone))
  const [scheduleTouched, setScheduleTouched] = useState(false)
  const [holidayDates, setHolidayDates] = useState<string[]>([])
  const [schedulingTouched, setSchedulingTouched] = useState(false)
  const [configuration, setConfiguration] = useState<Configuration>(() => {
    const metric = starterMetric('habit')
    return { metrics: [metric], rule: starterRule(metric), streakRuleMode: 'same-as-success', customFields: [], milestones: [] }
  })
  const [primaryQuantityBackup, setPrimaryQuantityBackup] = useState<TrackerMetricDefinition | null>(null)
  const [primaryMeasureNameCustomized, setPrimaryMeasureNameCustomized] = useState(false)
  const [goalPlanning, setGoalPlanning] = useState<GoalPlanningConfiguration>(emptyGoalPlanning)
  const [goalAmount, setGoalAmount] = useState('')
  const [planningEditorTouched, setPlanningEditorTouched] = useState(false)
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
  const [pendingRuleChange, setPendingRuleChange] = useState<PendingRuleChange | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const advancedSetupRef = useRef<HTMLDetailsElement>(null)
  const allowNavigationRef = useRef(false)
  const currentHrefRef = useRef(window.location.href)
  const projectedDeadline = (() => {
    if (values.schedulingMode !== 'effective' || !/^\d+$/.test(values.effectiveDays) || Number(values.effectiveDays) < 1 || !values.startDate) return ''
    try {
      return deriveSchedulingDeadline({
        tracker: { ...(existing ?? {} as TrackerDefinition), schedule: scheduleFromForm(values.schedule, existing, values.customWeekdays), startDate: values.startDate, createdAt: existing?.createdAt ?? `${values.startDate}T12:00:00.000Z`, scheduling: { mode: 'effective', effectiveDays: Number(values.effectiveDays), effectiveDayCounting: values.schedule === 'none' ? 'all-non-holiday-days' : ((isSchemaV7WriteEnabled() || existing?.schemaVersion === 7) ? values.effectiveDayCounting : 'all-non-holiday-days'), planningTimeZone: timeZone }, deadline: undefined },
        holidays: new Set(holidayDates), timeZone,
      }) ?? ''
    } catch { return '' }
  })()
  const selectedDeadline = values.schedulingMode === 'effective' ? projectedDeadline : values.schedulingMode === 'calendar' ? values.deadline : ''
  const projectedAutoDays = selectedDeadline
    ? countScheduledActivityDays({ tracker: { ...(existing ?? {} as TrackerDefinition), schedule: scheduleFromForm(values.schedule, existing, values.customWeekdays), startDate: values.startDate, createdAt: existing?.createdAt ?? `${values.startDate}T12:00:00.000Z`, deadline: selectedDeadline }, startDate: values.startDate, endDate: selectedDeadline, holidays: new Set(holidayDates), timeZone })
    : 0

  useEffect(() => {
    void localRepository.listAccountHolidays().then((holidays) => setHolidayDates(holidays.map((holiday) => holiday.date))).catch(() => setHolidayDates([]))
  }, [])

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
    Promise.all([localRepository.getTracker(trackerId), localRepository.listTrackerHistoricalValueKeys(trackerId)]).then(([tracker, historicalValueKeys]) => {
      if (!current) return
      if (!tracker) setError('This tracker could not be found on this device.')
      else {
        setExisting(tracker)
        setArchivedStatusAfterSave('archived')
        setMetricsWithHistory(tracker.metrics.filter((metric) => historicalValueKeys.includes(metric.id)).map((metric) => metric.id))
        setCustomFieldsWithHistory(tracker.customFields.filter((field) => historicalValueKeys.includes(`field:${field.id}`)).map((field) => field.id))
        setValues(defaultValues(tracker))
        setConfiguration({ metrics: tracker.metrics, rule: tracker.qualificationRule, streakRuleMode: tracker.streakRuleMode ?? 'legacy', streakRule: tracker.streakRule, customFields: tracker.customFields, milestones: tracker.milestones })
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
    if (field === 'schedule') setScheduleTouched(true)
    if (field === 'schedule' || field === 'customWeekdays') setValidationIssues((current) => Object.fromEntries(Object.entries(current).filter(([path]) => path !== 'schedule' && path !== 'customWeekdays')))
    setValues((current) => ({ ...current, [field]: value }))
    if (field === 'deadline' && value === '' && goalPlanning.mode === 'cumulative-deadline' && values.schedulingMode !== 'effective') {
      setFieldErrors((current) => ({ ...current, deadline: 'Cumulative planning requires a projected deadline. Choose Calendar Days or Effective Days scheduling.' }))
      setGoalPlanOpen(true)
      advancedSetupRef.current?.setAttribute('open', '')
      return
    }
    setFieldErrors((current) => field === 'startDate' || field === 'deadline'
      ? { ...current, startDate: '', deadline: '' }
      : field === 'customWeekdays' ? { ...current, customWeekdays: '', schedule: '' }
      : { ...current, [field]: '' })
  }

  function changeGoalPlanning(next: GoalPlanningConfiguration) {
    setPlanningEditorTouched(true)
    const primaryMetric = configuration.metrics[0]
    let synchronized = next
    if (!existing && values.kind === 'goal' && primaryMetric && primaryMetric.valueType !== 'boolean') {
      const targets = next.mode === 'cumulative-deadline' ? { ...next.cumulativeTargets } : { ...next.dailyTargets }
      const shortcutTarget = goalAmount === '' ? undefined : Number(goalAmount)
      const target = targets[primaryMetric.id] ?? (Number.isFinite(shortcutTarget) && shortcutTarget! > 0 ? shortcutTarget : undefined)
      if (target !== undefined) {
        targets[primaryMetric.id] = target
        synchronized = next.mode === 'cumulative-deadline'
          ? { ...next, progressSemantics: { ...next.progressSemantics, [primaryMetric.id]: 'incremental' }, cumulativeTargets: targets }
          : { ...next, dailyTargets: targets }
        setGoalAmount(String(target))
      }
    }
    setGoalPlanning(synchronized)
    if (synchronized.mode === 'cumulative-deadline' && !selectedDeadline) {
      const message = 'Cumulative planning requires a projected deadline. Choose Calendar Days or Effective Days scheduling.'
      setFieldErrors((current) => ({ ...current, deadline: message }))
      setGoalPlanOpen(true)
      advancedSetupRef.current?.setAttribute('open', '')
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Goal deadline"], .tracker-deadline-field input')?.focus())
    } else {
      setFieldErrors((current) => current.deadline?.startsWith('Cumulative planning requires') ? { ...current, deadline: '' } : current)
    }
  }

  function changeGoalAmount(raw: string) {
    setGoalAmount(raw)
    setFieldErrors((current) => ({ ...current, goalAmount: '' }))
    if (!planningEditorTouched || existing) return
    const metric = configuration.metrics[0]
    if (!metric || metric.valueType === 'boolean') return
    const targetMap = goalPlanning.mode === 'cumulative-deadline' ? 'cumulativeTargets' : 'dailyTargets'
    setGoalPlanning((current) => {
      const targets = { ...current[targetMap] }
      if (raw === '') delete targets[metric.id]
      else targets[metric.id] = Number(raw)
      return current.mode === 'cumulative-deadline'
        ? { ...current, progressSemantics: { ...current.progressSemantics, [metric.id]: 'incremental' }, cumulativeTargets: targets }
        : { ...current, dailyTargets: targets }
    })
  }

  function changeKind(value: string) {
    if (existing) return
    const previousKind = values.kind
    const kind = value as TrackerKind
    setValues((current) => ({
      ...current,
      kind,
      // New tracker types all begin with Daily. Once the user chooses a
      // recurrence, changing the kind must preserve that explicit choice.
      schedule: scheduleTouched ? current.schedule : 'every-day',
      deadline: current.deadline,
    }))
    setConfiguration((current) => {
      if (current.metrics.length !== 1 || existing) return current
      const oldMetric = current.metrics[0]!
      const nextType = kind === 'habit' ? 'boolean' as const : 'quantity' as const
      const changed = previousKind === 'habit' && kind !== 'habit'
        ? { ...oldMetric, name: primaryMeasureNameCustomized ? oldMetric.name : defaultMeasureName(nextType), valueType: nextType, unit: '', thresholds: { direction: 'increase' as const, streakQualification: 'any-recorded-value' as const } }
        : previousKind !== 'habit' && kind === 'habit'
          ? { id: oldMetric.id, name: primaryMeasureNameCustomized ? oldMetric.name : defaultMeasureName(nextType), valueType: nextType }
          : oldMetric
      const rule = starterRule(changed)
      return { ...current, metrics: [changed], rule, ...(current.streakRuleMode === 'custom' ? { streakRule: rebaseMetricRule(current.streakRule, changed) } : {}) }
    })
    setPrimaryQuantityBackup(null)
  }

  function chooseSimpleMeasure(valueType: TrackerMetricDefinition['valueType']) {
    const metric = configuration.metrics[0]
    if (!metric || metric.valueType === valueType) return
    if (valueType === 'boolean' && ['quantity', 'duration'].includes(metric.valueType)) setPrimaryQuantityBackup(metric)
    const restored = (valueType === 'quantity' || valueType === 'duration') && primaryQuantityBackup?.id === metric.id ? primaryQuantityBackup : undefined
    const defaultName = primaryMeasureNameCustomized ? metric.name : defaultMeasureName(valueType)
    const updated: TrackerMetricDefinition = valueType === 'boolean'
      ? { id: metric.id, name: defaultName, valueType: 'boolean' }
      : valueType === 'checklist'
        ? { id: metric.id, name: defaultName, valueType, thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' }, checklistItems: [{ id: crypto.randomUUID(), label: 'Step 1', position: 0 }] }
        : restored ? { ...restored, name: defaultName, valueType, unit: restored.unit ?? '' }
          : { id: metric.id, name: defaultName, valueType, unit: '', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }
    setConfiguration((current) => ({
      ...current,
      metrics: [updated, ...current.metrics.slice(1)],
      rule: rebaseMetricRule(current.rule, updated) ?? starterRule(updated),
      ...(current.streakRuleMode === 'custom' ? { streakRule: rebaseMetricRule(current.streakRule, updated) ?? starterRule(updated) } : {}),
    }))
  }

  function changeStreakRuleMode(mode: TrackerDefinition['streakRuleMode'] | 'legacy') {
    setConfiguration((current) => ({
      ...current,
      streakRuleMode: mode,
      ...(mode === 'custom' && !current.streakRule ? { streakRule: current.rule ?? (current.metrics[0] ? starterRule(current.metrics[0]) : undefined) } : {}),
    }))
  }

  function changeMetrics(metrics: TrackerMetricDefinition[]) {
    const nextIds = new Set(metrics.map((metric) => metric.id))
    const invalidatedIds = configuration.metrics.filter((oldMetric) => {
      const replacement = metrics.find((metric) => metric.id === oldMetric.id)
      const hasPlanData = goalPlanning.progressSemantics[oldMetric.id] !== undefined ||
        goalPlanning.dailyTargets[oldMetric.id] !== undefined || goalPlanning.cumulativeTargets[oldMetric.id] !== undefined ||
        goalPlanning.allocations?.[oldMetric.id] !== undefined || goalPlanning.manualAllocations?.[oldMetric.id] !== undefined
      return hasPlanData && (!nextIds.has(oldMetric.id) || replacement?.valueType === 'boolean')
    }).map((metric) => metric.id)
    if (invalidatedIds.length && !window.confirm('Removing or changing this measure to Done / Not Done will also remove its planning semantics and targets. Its saved check-in history remains unchanged. Continue?')) return
    if (invalidatedIds.length) {
      const nextPlanning = { ...goalPlanning, progressSemantics: { ...goalPlanning.progressSemantics }, dailyTargets: { ...goalPlanning.dailyTargets }, cumulativeTargets: { ...goalPlanning.cumulativeTargets }, allocations: { ...(goalPlanning.allocations ?? {}) }, manualAllocations: { ...(goalPlanning.manualAllocations ?? {}) } }
      for (const id of invalidatedIds) {
        delete nextPlanning.progressSemantics[id]
        delete nextPlanning.dailyTargets[id]
        delete nextPlanning.cumulativeTargets[id]
        delete nextPlanning.allocations[id]
        delete nextPlanning.manualAllocations[id]
      }
      setGoalPlanning(nextPlanning)
    }
    setConfiguration((current) => ({ ...current, metrics }))
  }

  function markPrimaryMeasureNameCustomized(metricId: string) {
    if (!existing && configuration.metrics[0]?.id === metricId) setPrimaryMeasureNameCustomized(true)
  }

  function requestRemoveMetric(metricId: string) {
    const metric = configuration.metrics.find((item) => item.id === metricId)
    if (!metric) return
    const usesRule = (rule?: TrackerRule): boolean => !rule ? false : rule.kind === 'threshold' || rule.kind === 'comparison'
      ? rule.metricId === metricId
      : rule.operands.some(usesRule)
    const hasPlan = [goalPlanning.progressSemantics, goalPlanning.dailyTargets, goalPlanning.cumulativeTargets, goalPlanning.allocations, goalPlanning.manualAllocations].some((map) => Boolean(map?.[metricId]))
    const hasMilestone = configuration.milestones.some((item) => item.metricId === metricId)
    if (usesRule(configuration.rule) || usesRule(configuration.streakRule) || hasPlan || hasMilestone) {
      const dependencies = [usesRule(configuration.rule) && 'success rule', usesRule(configuration.streakRule) && 'streak rule', hasPlan && 'goal plan', hasMilestone && 'milestone'].filter(Boolean).join(', ')
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
            : field === 'deadline' ? document.querySelector<HTMLInputElement>('[aria-label="Goal deadline"], .tracker-deadline-field input')
              : field === 'schedule' ? document.querySelector<HTMLSelectElement>('[aria-label="Activity schedule"]') : null
        target?.focus(); target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      }))
      return
    }
    if (parsed.data.schedulingMode === 'effective' && !projectedDeadline) {
      const message = 'This schedule cannot provide the requested number of eligible dates. Change the schedule or target.'
      setFieldErrors((current) => ({ ...current, effectiveDays: message }))
      setError(message)
      return
    }
    const wantsMilestoneV9 = configuration.milestones.some((item) => item.type !== undefined) || existing?.schemaVersion === 9
    const wantsStreakRuleV8 = configuration.streakRuleMode !== 'legacy' || existing?.schemaVersion === 8 || existing?.streakRuleMode !== undefined
    if (wantsStreakRuleV8 && !isSchemaV8WriteEnabled()) {
      reportTrackerWriteDiagnostic({ category: 'unsupported-schema-version', phase: 'editor-validation', schemaVersion: 8 })
      const message = 'Streak rules require the schema v8 migration and VITE_ENABLE_TRACKER_SCHEMA_V8 in this production build. No tracker changes were saved.'
      setError(message)
      notify({ kind: 'error', title: 'Streak rules are not writable yet', description: message, duration: 0, dedupeKey: 'tracker-schema-v8' })
      return
    }
    if (wantsMilestoneV9 && !isSchemaV9WriteEnabled()) {
      reportTrackerWriteDiagnostic({ category: 'unsupported-schema-version', phase: 'editor-validation', schemaVersion: 9 })
      const message = 'Typed milestones need the schema v9 migration and VITE_ENABLE_TRACKER_SCHEMA_V9 in this production build. No tracker changes were saved.'
      setError(message)
      notify({ kind: 'error', title: 'Typed milestones are not writable yet', description: message, duration: 0, dedupeKey: 'tracker-schema-v9' })
      return
    }
    if (existing && parsed.data.startDate) {
      const nextPeriod = { ...existing, startDate: parsed.data.startDate, deadline: selectedDeadline || undefined }
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
    let writePhase: 'editor-validation' | 'local-save' = 'editor-validation'
    try {
      const form = parsed.data
      const now = new Date().toISOString()
      const id = existing?.id ?? crypto.randomUUID()
      const kind = existing?.kind ?? form.kind
      const schedule = scheduleFromForm(form.schedule, existing, form.customWeekdays)
      const wantsMilestoneV9 = configuration.milestones.some((item) => item.type !== undefined) || existing?.schemaVersion === 9
      const wantsStreakRuleV8 = configuration.streakRuleMode !== 'legacy' || existing?.schemaVersion === 8 || existing?.streakRuleMode !== undefined
      const method = form.schedule === 'none' ? 'all-non-holiday-days' : ((isSchemaV7WriteEnabled() || wantsStreakRuleV8 || wantsMilestoneV9) ? form.effectiveDayCounting : 'all-non-holiday-days')
      const scheduling = { mode: form.schedulingMode, ...(form.schedulingMode === 'effective' ? { effectiveDays: Number(form.effectiveDays), ...((isSchemaV7WriteEnabled() || existing?.schemaVersion === 7 || wantsStreakRuleV8 || wantsMilestoneV9) ? { effectiveDayCounting: method } : {}), planningTimeZone: timeZone } : {}) } as const
      const effectiveDeadline = form.schedulingMode === 'calendar' ? form.deadline || undefined
        : form.schedulingMode === 'effective' ? projectedDeadline || undefined : undefined
      const submittedMetrics = configuration.metrics.map((metric, index) => index === 0 && (metric.valueType === 'quantity' || metric.valueType === 'duration') && (isNewPlannedGoal || existing?.kind === 'goal' && existing.goalPlanning || existing !== undefined)
        ? { ...metric, unit: metric.unit?.trim() }
        : metric)
      let submittedPlanning = { ...goalPlanning }
      if (isNewPlannedGoal && enteredGoalAmount !== undefined && submittedMetrics[0] && !planningEditorTouched) {
        const metricId = submittedMetrics[0].id
        submittedPlanning = {
          ...emptyGoalPlanning(),
          mode: form.deadline ? 'cumulative-deadline' : 'daily-recurring',
          progressSemantics: form.deadline ? { [metricId]: 'incremental' } : {},
          ...(form.deadline ? { cumulativeTargets: { [metricId]: enteredGoalAmount } } : { dailyTargets: { [metricId]: enteredGoalAmount } }),
        }
      } else if (values.kind === 'goal' && !existing && planningEditorTouched) {
        submittedPlanning = goalPlanning
      } else if (existing?.kind === 'goal' && existing.goalPlanning && enteredGoalAmount !== undefined && submittedMetrics[0]) {
        const metricId = submittedMetrics[0].id
        submittedPlanning = existing.goalPlanning.mode === 'daily-recurring'
          ? { ...goalPlanning, dailyTargets: { ...goalPlanning.dailyTargets, [metricId]: enteredGoalAmount } }
          : { ...goalPlanning, cumulativeTargets: { ...goalPlanning.cumulativeTargets, [metricId]: enteredGoalAmount } }
      }
      const hasPlanningTargets = Object.keys(submittedPlanning.dailyTargets).length > 0 || Object.keys(submittedPlanning.cumulativeTargets).length > 0
      const planWasConfigured = existing?.goalPlanning !== undefined || isNewPlannedGoal || (!existing && values.kind === 'goal' && planningEditorTouched && hasPlanningTargets) || (
        existing?.schemaVersion === 1 && JSON.stringify(goalPlanning) !== JSON.stringify(emptyGoalPlanning())
      )
      const persistGoalPlanning = kind === 'goal' && planWasConfigured
      const hasPrecisionConfiguration = submittedMetrics.some((metric) => metric.precision !== undefined)
      if (submittedPlanning.mode !== 'cumulative-deadline' && submittedPlanning.manualAllocations) {
        submittedPlanning.allocations = { ...(submittedPlanning.allocations ?? {}), ...submittedPlanning.manualAllocations }
        delete submittedPlanning.manualAllocations
      }
      const hasManualAllocations = submittedPlanning.mode === 'cumulative-deadline' && submittedPlanning.manualAllocations !== undefined
      const hasV3Planning = Boolean(submittedPlanning.planningTimeZone || submittedPlanning.allocations || submittedPlanning.manualAllocations)
      const legacySchemaVersion = Math.max(
        hasManualAllocations ? 5 : 1,
        hasPrecisionConfiguration ? 4 : 1,
        hasV3Planning ? 3 : 1,
        persistGoalPlanning ? 2 : 1,
        existing?.schemaVersion ?? 1,
      ) as TrackerDefinition['schemaVersion']
      const wantsV7 = wantsStreakRuleV8 || wantsMilestoneV9 || form.schedulingMode === 'effective' && (isSchemaV7WriteEnabled() || existing?.schemaVersion === 7)
      const persistScheduling = wantsMilestoneV9 || wantsStreakRuleV8 || isSchemaV6WriteEnabled() && (schedulingTouched || (existing?.schemaVersion ?? 0) >= 6 || wantsV7)
      const targetSchemaVersion: TrackerDefinition['schemaVersion'] = wantsMilestoneV9 ? 9 : wantsStreakRuleV8 ? 8 : wantsV7 && persistScheduling ? 7 : persistScheduling ? 6 : legacySchemaVersion
      const schemaVersion = Math.max(existing?.schemaVersion ?? 1, targetSchemaVersion) as TrackerDefinition['schemaVersion']
      const candidateBase: Partial<TrackerDefinition> = existing ? { ...existing } : {}
      if (configuration.streakRuleMode !== 'custom') delete candidateBase.streakRule
      const candidate: TrackerDefinition = {
        ...candidateBase,
        schemaVersion, id, name: form.name, description: form.description.trim(), kind,
        status: existing?.status === 'archived' && archivedStatusAfterSave === 'active' ? 'active' : existing?.status ?? 'active', categoryId: existing?.categoryId ?? null,
        tags: existing?.tags ?? [], icon: existing?.icon ?? '', accent: existing?.accent ?? '#315e46',
        schedule,
        startDate: form.startDate || undefined,
        deadline: effectiveDeadline,
        ...(persistScheduling ? { scheduling } : {}),
        metrics: submittedMetrics,
        strictMode: form.strictMode,
        qualificationRule: configuration.rule,
        ...(wantsStreakRuleV8 ? { streakRuleMode: configuration.streakRuleMode === 'legacy' ? 'same-as-success' as const : configuration.streakRuleMode, ...(configuration.streakRuleMode === 'custom' ? { streakRule: configuration.streakRule } : {}) } : {}),
        customFields: configuration.customFields,
        milestones: configuration.milestones,
        ...(persistGoalPlanning ? { goalPlanning: submittedPlanning } : {}),
        createdAt: existing?.createdAt ?? now, updatedAt: now, archivedAt: existing?.status === 'archived' && archivedStatusAfterSave === 'archived' ? existing.archivedAt : null, deletedAt: null,
      }
      const evaluationChanged = Boolean(existing && trackerEvaluationChanged(existing, candidate, timeZone))
      const measureConfigurationChanged = Boolean(existing && stableJson(existing.metrics) !== stableJson(candidate.metrics))
      const historyPolicyChangeNeeded = evaluationChanged || measureConfigurationChanged
      // A schema v10 draft cannot satisfy the stored-history/head invariant
      // until its version list is rebuilt after the user chooses how to apply
      // the edit. Validate changed evaluation fields against the v9 shape,
      // which contains the same tracker settings without that history invariant.
      const validationCandidate = existing?.schemaVersion === 10 && historyPolicyChangeNeeded
        ? { ...candidate, schemaVersion: 9 as const, ruleVersions: undefined }
        : candidate
      const checked = trackerDefinitionSchema.safeParse(validationCandidate)
      if (!checked.success) {
        reportTrackerWriteDiagnostic({ category: 'invalid-tracker-definition', phase: 'editor-validation', schemaVersion: candidate.schemaVersion })
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
      if (existing && stableCustomFieldConfiguration(existing.customFields) !== stableCustomFieldConfiguration(checked.data.customFields)) {
        const message = 'Custom-field definitions cannot be edited because their historical availability is not saved.'
        setError(message)
        return
      }
      if (existing && historyPolicyChangeNeeded) {
        const currentDependencyIssue = currentRuleDependencyIssue(checked.data as TrackerDefinition)
        if (currentDependencyIssue) {
          setError(`${currentDependencyIssue} Restore the measure or choose a currently available measure.`)
          return
        }
        if (!isTrackerEditHistorySyncGuardEnabled()) {
          const message = 'Safe tracker history edits need migrations 20261119000100_tracker_edit_sync_guards.sql and 20261125000100_tracker_threshold_history_edits.sql, plus VITE_ENABLE_TRACKER_EDIT_SYNC_GUARDS=true in this production build. No tracker changes were saved.'
          setError(message)
          notify({ kind: 'error', title: 'Safe tracker history edits are not enabled yet', description: message, duration: 0, dedupeKey: 'tracker-edit-sync-guards' })
          return
        }
        if (!isSchemaV10WriteEnabled()) {
          reportTrackerWriteDiagnostic({ category: 'unsupported-schema-version', phase: 'editor-validation', schemaVersion: 10 })
          const message = 'Versioned tracker rules need the schema v10 migration and VITE_ENABLE_TRACKER_SCHEMA_V10 in this production build. No tracker changes were saved.'
          setError(message)
          notify({ kind: 'error', title: 'Historical rule versions are not writable yet', description: message, duration: 0, dedupeKey: 'tracker-schema-v10' })
          return
        }
        const earliestStart = [trackerActiveStartDate(existing, timeZone), trackerActiveStartDate(checked.data, timeZone)].sort()[0]!
        const today = todayLocal(timeZone)
        const history = await localRepository.listTrackerEntriesForTracker(existing.id)
        const latestCheckInDate = history.reduce<CalendarDate | null>((latest, entry) => latest === null || entry.date > latest ? entry.date as CalendarDate : latest, null)
        // Thresholds are evaluation rules, not measure structure. Allow them
        // through the existing v10 history policy while retaining the guard
        // for identity, value type, units, precision, and checklist meaning.
        const metricStructure = (tracker: TrackerDefinition) => tracker.metrics.map(({ thresholds: _thresholds, ...metric }) => metric)
        const structural = stableJson(metricStructure(existing)) !== stableJson(metricStructure(checked.data as TrackerDefinition))
          || stableCustomFieldConfiguration(existing.customFields) !== stableCustomFieldConfiguration(checked.data.customFields)
        const milestonesChanged = stableJson(existing.milestones) !== stableJson(checked.data.milestones)
        if (milestonesChanged) {
          setError('Milestone requirements cannot be edited because historical milestone results are not versioned.')
          return
        }
        if (existing.kind === 'goal' && stableJson(existing.goalPlanning ?? null) !== stableJson(checked.data.goalPlanning ?? null)) {
          setError('Goal plans cannot be edited because historical goal progress is not versioned.')
          return
        }
        // Historical recalculation is deliberately limited to rule-only edits
        // with a value for every measure used by the new rules on every saved day.
        const ruleOnly = stableJson([existing.schedule, trackerActiveStartDate(existing, timeZone), existing.deadline, existing.scheduling ?? trackerScheduling(existing), metricStructure(existing)])
          === stableJson([checked.data.schedule, trackerActiveStartDate(checked.data as TrackerDefinition, timeZone), checked.data.deadline, checked.data.scheduling ?? trackerScheduling(checked.data as TrackerDefinition), metricStructure(checked.data as TrackerDefinition)])
        const requiredHistoricalMeasures = new Set([...existing.metrics, ...checked.data.metrics].map((metric) => metric.id))
        const allHistoryAvailable = ruleOnly && !structural && !milestonesChanged
          && (latestCheckInDate === null || latestCheckInDate <= today)
          && history.every((entry) => entry.outcome !== 'recorded'
            || [...requiredHistoricalMeasures].every((metricId) => Object.hasOwn(entry.values, metricId)))
        const dependencyIssue = historicalRuleDependencyIssue(existing, checked.data as TrackerDefinition, earliestStart)
        const addedMeasure = checked.data.metrics.some((metric) => !existing.metrics.some((current) => current.id === metric.id))
        const allHistoryReason = dependencyIssue ?? (latestCheckInDate !== null && latestCheckInDate > today
          ? 'A future-dated check-in must remain ahead of the new rule boundary.' : structural
          ? addedMeasure ? 'This measure wasn’t available for earlier check-ins.' : 'Historical measure settings can’t be verified.'
          : !allHistoryAvailable ? 'Historical check-ins are missing inputs needed to evaluate this rule.' : null)
        const todayConflict = latestCheckInDate !== null && (latestCheckInDate > today || structural && latestCheckInDate >= today)
        setPendingRuleChange({ candidate: checked.data as TrackerDefinition, mode: todayConflict ? 'after-last-check-in' : 'apply-from-today', historyStartDate: earliestStart, today, latestCheckInDate, structural, allHistoryAvailable: allHistoryAvailable && !dependencyIssue, allHistoryReason })
        return
      }
      writePhase = 'local-save'
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
      reportTrackerWriteDiagnostic({
        category: isUnsupportedSchemaFailure(cause) ? 'unsupported-schema-version' : writePhase === 'local-save' ? 'local-persistence-failure' : 'invalid-tracker-definition',
        phase: writePhase,
        ...(existing ? { schemaVersion: existing.schemaVersion } : {}),
      })
      const recoverableMessage = /measure type|retired measure|saved check-ins|active measure|milestone requirements|custom-field definitions|goal plans/i.test(detail) ? detail : 'Your changes were not saved. Please try again.'
      setError(recoverableMessage)
      notify({ kind: 'error', title: existing ? 'Couldn’t update tracker' : 'Couldn’t create tracker', description: recoverableMessage, duration: 0, dedupeKey: existing?.id ? `tracker:${existing.id}` : `tracker-create:${values.name}` })
    } finally {
      setSaving(false)
    }
  }

  async function confirmVersionedSave() {
    if (!pendingRuleChange || !existing || saving) return
    if (!isSchemaV10WriteEnabled()) {
      setError('Versioned tracker rules are disabled until the schema v10 migration is applied and verified.')
      return
    }
    setSaving(true)
    setError('')
    let writePhase: 'version-construction' | 'local-save' = 'version-construction'
    let writeSchemaVersion: number | undefined
    try {
      const candidate = pendingRuleChange.candidate
      const latestEntries = await localRepository.listTrackerEntriesForTracker(existing.id)
      const latestNow = latestEntries.reduce<CalendarDate | null>((latest, entry) => latest === null || entry.date > latest ? entry.date as CalendarDate : latest, null)
      const todayNow = todayLocal(timeZone)
      if (latestNow !== pendingRuleChange.latestCheckInDate || todayNow !== pendingRuleChange.today) {
        setPendingRuleChange({ ...pendingRuleChange, today: todayNow, latestCheckInDate: latestNow, mode: latestNow !== null && (latestNow > todayNow || pendingRuleChange.structural && latestNow >= todayNow) ? 'after-last-check-in' : 'apply-from-today' })
        setError(latestNow !== pendingRuleChange.latestCheckInDate
          ? 'A check-in was saved while you were choosing this date. Review and confirm the updated effective date before saving.'
          : 'The workspace calendar date changed while you were choosing this option. Review and confirm the updated date before saving.')
        return
      }
      const inferredScheduling = candidate.scheduling ?? trackerScheduling(candidate)
      const currentScheduling = inferredScheduling.mode === 'effective'
        ? {
            ...inferredScheduling,
            effectiveDayCounting: inferredScheduling.effectiveDayCounting ?? existing.scheduling?.effectiveDayCounting ?? 'all-non-holiday-days',
            planningTimeZone: inferredScheduling.planningTimeZone ?? timeZone,
          }
        : inferredScheduling
      const versionReadyCandidate = { ...candidate, schemaVersion: 10 as const, scheduling: currentScheduling }
      const historyStartDate = [
        trackerActiveStartDate(existing, timeZone),
        trackerActiveStartDate(versionReadyCandidate, timeZone),
        pendingRuleChange.historyStartDate,
      ].sort()[0]!
      const effectiveFrom = pendingRuleChange.mode === 'after-last-check-in'
        ? pendingRuleChange.latestCheckInDate ? shiftCalendarDate(pendingRuleChange.latestCheckInDate, 1) : pendingRuleChange.today
        : pendingRuleChange.today
      const versioned = versionTrackerRuleChange({
        before: existing,
        after: versionReadyCandidate,
        application: pendingRuleChange.mode,
        today: todayLocal(timeZone),
        historyStartDate,
        effectiveFrom,
        recordedAt: new Date().toISOString(),
      })
      writeSchemaVersion = versioned.schemaVersion
      const checked = trackerDefinitionSchema.safeParse(versioned)
      if (!checked.success) {
        reportTrackerWriteDiagnostic({ category: 'invalid-tracker-definition', phase: 'version-construction', schemaVersion: versioned.schemaVersion })
        const message = checked.error.issues[0]?.message ?? 'The versioned tracker configuration is invalid.'
        setError(message)
        notify({ kind: 'error', title: 'Tracker details need attention', description: message, duration: 0, dedupeKey: 'tracker-form-validation' })
        return
      }
      writePhase = 'local-save'
      const result = await localRepository.saveTracker(checked.data as TrackerDefinition)
      setPendingRuleChange(null)
      allowNavigationRef.current = true
      setDirty(false)
      notify({ kind: 'success', title: 'Tracker updated', description: 'Your changes were saved on this device. Progression will be confirmed when sync completes.', dedupeKey: `tracker:${result.id}` })
      navigate('/trackers', { replace: true, state: { savedTracker: result.id } })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : ''
      reportTrackerWriteDiagnostic({
        category: isUnsupportedSchemaFailure(cause) ? 'unsupported-schema-version' : writePhase === 'local-save' ? 'local-persistence-failure' : 'invalid-tracker-definition',
        phase: writePhase,
        ...(writeSchemaVersion ? { schemaVersion: writeSchemaVersion } : {}),
      })
      const recoverableMessage = /measure type|retired measure|saved check-ins|active measure|milestone requirements|custom-field definitions|goal plans|conflict|schema v10/i.test(detail) ? detail : 'Your changes were not saved. Please try again.'
      setError(recoverableMessage)
      notify({ kind: 'error', title: 'Couldn’t update tracker', description: recoverableMessage, duration: 0, dedupeKey: `tracker:${existing.id}` })
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
  const milestoneContext = { kind: selectedKind, metrics: configuration.metrics, schedule: scheduleFromForm(values.schedule, existing, values.customWeekdays), strictMode: values.strictMode, scheduling: { mode: values.schedulingMode }, deadline: selectedDeadline }
  const typedMilestonesNeedV9 = configuration.milestones.some((item) => item.type !== undefined) || existing?.schemaVersion === 9
  const milestoneV9WriteBlocked = typedMilestonesNeedV9 && !isSchemaV9WriteEnabled()
  const ruleV10WriteBlocked = existing?.schemaVersion === 10 && !isSchemaV10WriteEnabled()
  const streakV8WriteBlocked = (configuration.streakRuleMode !== 'legacy' || existing?.schemaVersion === 8) && !isSchemaV8WriteEnabled()
  const saveBlockReason = ruleV10WriteBlocked
    ? 'Saving this tracker needs schema v10 enabled for this production build.'
    : milestoneV9WriteBlocked
      ? 'Saving these milestones needs schema v9 enabled for this production build.'
      : streakV8WriteBlocked ? 'Saving this streak rule needs schema v8 enabled for this production build.' : null
  const applyTodayUnavailable = pendingRuleChange?.latestCheckInDate !== null && pendingRuleChange !== null && (
    pendingRuleChange.latestCheckInDate > pendingRuleChange.today
    || pendingRuleChange.structural && pendingRuleChange.latestCheckInDate >= pendingRuleChange.today
  )
  const applyTodayUnavailableReason = pendingRuleChange?.latestCheckInDate && pendingRuleChange.latestCheckInDate > pendingRuleChange.today
    ? 'Unavailable: a future-dated check-in exists.'
    : pendingRuleChange?.structural && pendingRuleChange.latestCheckInDate === pendingRuleChange.today
      ? 'Unavailable: a check-in exists today. Structural changes start after it.'
      : 'Unavailable: a saved check-in conflicts with today’s effective date.'
  const sameEffectiveDateGroups = pendingRuleChange ? (() => {
    const afterLastDate = pendingRuleChange.latestCheckInDate ? shiftCalendarDate(pendingRuleChange.latestCheckInDate, 1) : pendingRuleChange.today
    const options = [
      ...(!applyTodayUnavailable ? [{ label: 'Apply from today', date: pendingRuleChange.today }] : []),
      { label: 'After the last check-in', date: afterLastDate },
      ...(pendingRuleChange.allHistoryAvailable ? [{ label: 'Apply to all history', date: pendingRuleChange.historyStartDate }] : []),
    ]
    const byDate = new Map<string, string[]>()
    for (const option of options) byDate.set(option.date, [...(byDate.get(option.date) ?? []), option.label])
    return [...byDate.values()].filter((labels) => labels.length > 1)
  })() : []
  const targetNumber = Number(goalAmount)
  const hasShortcutTarget = Boolean(goalAmount) && Number.isFinite(targetNumber) && targetNumber > 0
  let planningForEditor = goalPlanning
  if (!existing && selectedKind === 'goal' && !planningEditorTouched && hasShortcutTarget && configuration.metrics[0]?.valueType !== 'boolean') {
    const metricId = configuration.metrics[0]!.id
    planningForEditor = selectedDeadline
      ? { ...goalPlanning, mode: 'cumulative-deadline', progressSemantics: { ...goalPlanning.progressSemantics, [metricId]: 'incremental' }, cumulativeTargets: { ...goalPlanning.cumulativeTargets, [metricId]: targetNumber } }
      : { ...goalPlanning, mode: 'daily-recurring', dailyTargets: { ...goalPlanning.dailyTargets, [metricId]: targetNumber } }
  }
  const pace = selectedKind === 'goal' && !existing && goalAmount && selectedDeadline
    ? suggestedPace(targetNumber, values.startDate, selectedDeadline, { schedule: scheduleFromForm(values.schedule, existing, values.customWeekdays), startDate: values.startDate, createdAt: `${values.startDate}T00:00:00.000Z` }, new Set(holidayDates), timeZone)
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
          {existing?.status === 'archived' && <fieldset className="tracker-status-after-save"><legend>Tracker status after saving</legend><label><input type="radio" name="archived-status-after-save" value="archived" checked={archivedStatusAfterSave === 'archived'} onChange={() => setArchivedStatusAfterSave('archived')} /><span>Keep archived</span></label><label><input type="radio" name="archived-status-after-save" value="active" checked={archivedStatusAfterSave === 'active'} onChange={() => setArchivedStatusAfterSave('active')} /><span>Move to active</span></label></fieldset>}
          <label className="form-field tracker-name-field"><span>{selectedKind === 'goal' ? 'What do you want to achieve?' : selectedKind === 'habit' ? 'What habit do you want to build?' : selectedKind === 'challenge' ? 'What challenge are you taking on?' : 'What project will you move forward?'}</span><input data-validation-path="name" aria-label={selectedKind === 'goal' ? 'What do you want to achieve?' : selectedKind === 'habit' ? 'What habit do you want to build?' : selectedKind === 'challenge' ? 'What challenge are you taking on?' : 'What project will you move forward?'} className="auth-input" maxLength={200} value={values.name} onChange={(event) => update('name', event.target.value)} aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? 'tracker-name-error' : undefined} placeholder={selectedKind === 'goal' ? 'e.g. Solve 100 DSA problems' : selectedKind === 'habit' ? 'e.g. Read every day' : selectedKind === 'challenge' ? 'e.g. 30-day writing challenge' : 'e.g. Launch my portfolio'} />{fieldErrors.name && <small id="tracker-name-error" className="auth-error">{fieldErrors.name}</small>}</label>
          {existing && <label className="form-field tracker-name-field"><span>Description <em>optional</em> <InfoButton title="Description" summary="Keep context or motivation close to the tracker." description="This optional note appears with the tracker setup. It does not affect success rules, schedules, targets, or saved check-in values." /></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Add a note about why this matters to you." /></label>}
          {!existing && <label className="form-field primary-measure-type"><span>How do you want to measure it?</span><select aria-label="Measure 1 value type" className="auth-input" value={configuration.metrics[0]?.valueType ?? 'boolean'} onChange={(event) => chooseSimpleMeasure(event.target.value as TrackerMetricDefinition['valueType'])}><option value="boolean">Done / Not Done</option><option value="quantity">Quantity</option><option value="duration">Duration</option><option value="checklist">Checklist</option></select></label>}
          <div className="form-grid tracker-quick-fields">
            <label className="form-field"><span>Start date</span><input data-validation-path="startDate" aria-label="Start date" className="auth-input" type="date" max={values.schedulingMode === 'calendar' ? values.deadline || undefined : undefined} value={values.startDate} onChange={(event) => update('startDate', event.target.value)} aria-invalid={Boolean(fieldErrors.startDate)} aria-describedby={fieldErrors.startDate ? 'tracker-start-date-error' : undefined} />{fieldErrors.startDate && <small id="tracker-start-date-error" className="auth-error">{fieldErrors.startDate}</small>}</label>
            <label className="form-field"><span>Duration</span><select aria-label="Schedule duration" className="auth-input" data-validation-path="schedulingMode" value={values.schedulingMode} disabled={!isSchemaV6WriteEnabled()} onChange={(event) => { setSchedulingTouched(true); update('schedulingMode', event.target.value as TrackerSchedulingMode); setValues((current) => ({ ...current, schedulingMode: event.target.value as TrackerSchedulingMode, deadline: event.target.value === 'ongoing' ? '' : current.deadline })) }}>
              <option value="calendar">Calendar Days</option><option value="effective">Effective Days</option><option value="ongoing">Ongoing</option>
            </select></label>
            {!isSchemaV6WriteEnabled() && <small className="field-hint form-field-wide">Scheduling modes need the schema v6 deployment before they can be changed.</small>}
            {values.schedulingMode === 'calendar' && <label className="form-field"><span>Deadline</span><input data-validation-path="deadline" aria-label="Tracker deadline" className="auth-input" type="date" min={values.startDate} value={values.deadline} onChange={(event) => update('deadline', event.target.value)} aria-invalid={Boolean(fieldErrors.deadline)} aria-describedby={fieldErrors.deadline ? 'tracker-deadline-error' : undefined} />{fieldErrors.deadline && <small id="tracker-deadline-error" className="auth-error">{fieldErrors.deadline}</small>}</label>}
            {values.schedulingMode === 'effective' && <>
              <label className="form-field"><span>Target effective days</span><input data-validation-path="effectiveDays" aria-label="Target effective days" className="auth-input" type="number" min="1" max="100000" step="1" value={values.effectiveDays} onChange={(event) => update('effectiveDays', event.target.value)} aria-invalid={Boolean(fieldErrors.effectiveDays)} aria-describedby={fieldErrors.effectiveDays ? 'effective-days-error' : undefined} />{fieldErrors.effectiveDays && <small id="effective-days-error" className="auth-error">{fieldErrors.effectiveDays}</small>}</label>
              <p className="field-hint form-field-wide">Marked holidays are excluded from this duration.</p>
              <p className="goal-planning-note form-field-wide" role="status">{projectedDeadline ? <>Projected deadline: <strong>{calendarDateLabel(projectedDeadline)}</strong> · {inclusiveCalendarDays(values.startDate, projectedDeadline)} calendar days.</> : 'No eligible dates found for this target.'}</p>
            </>}
            {values.schedulingMode === 'calendar' && values.deadline && <p className="field-hint form-field-wide">Ends on your selected date, regardless of holidays. {inclusiveCalendarDays(values.startDate, values.deadline)} inclusive calendar days.</p>}
            {values.schedulingMode === 'ongoing' && <p className="field-hint form-field-wide">Track this without a fixed end date or duration.</p>}
            {values.kind === 'goal' && planningForEditor.mode === 'cumulative-deadline' && selectedDeadline && <p className={`field-hint form-field-wide${projectedAutoDays === 0 ? ' auth-error' : ''}`} role={projectedAutoDays === 0 ? 'status' : undefined}>{projectedAutoDays === 0 ? values.schedule === 'none' ? 'No Recurrence has no Auto planning days. Record flexible progress without a scheduled daily workload.' : 'No scheduled workdays fall inside this duration. Choose an activity schedule with workdays or adjust the duration.' : `Goal Auto planning can use ${projectedAutoDays} scheduled, non-holiday workdays inside this duration.`}</p>}
          </div>
          {!existing && configuration.metrics[0]?.valueType !== 'boolean' && <section className="simple-numeric-settings" aria-label="Numeric measure settings">
            <label className="form-field"><span>Unit <em>optional</em></span><input aria-label="Numeric measure unit" className="auth-input" value={configuration.metrics[0]?.unit ?? ''} onChange={(event) => setConfiguration((current) => ({ ...current, metrics: current.metrics.map((metric, index) => index === 0 ? { ...metric, unit: event.target.value } : metric) }))} placeholder="pages, minutes, sessions" /></label>
            <label className="form-field"><span>Target per check-in <em>optional</em></span><input aria-label="Per-check-in target" className="auth-input" type="number" min="0" step={configuration.metrics[0]?.precision?.increment ?? 'any'} value={configuration.metrics[0]?.thresholds?.target ?? ''} onChange={(event) => updateStarterTarget(event.target.value)} placeholder="e.g. 1" /></label>
            <label className="form-field"><span>Precision</span><select aria-label="Numeric precision" className="auth-input" value={configuration.metrics[0]?.precision ? String(configuration.metrics[0].precision.decimalPlaces) : ''} disabled={!isSchemaV4WriteEnabled()} onChange={(event) => { const places = event.target.value === '' ? undefined : Number(event.target.value) as 0 | 1 | 2; setConfiguration((current) => ({ ...current, metrics: current.metrics.map((metric, index) => index === 0 ? { ...metric, precision: places === undefined ? undefined : { decimalPlaces: places, increment: places === 0 ? 1 : places === 1 ? 0.1 : 0.01 } } : metric) })) }}><option value="">Standard</option><option value="0">Whole numbers</option><option value="1">One decimal place</option><option value="2">Up to two decimals</option></select></label>
            {!isSchemaV4WriteEnabled() && <small className="field-hint">Precision settings are unavailable in this build until the numeric precision schema is enabled.</small>}
          </section>}
          {!existing && selectedKind === 'goal' && configuration.metrics[0]?.valueType !== 'boolean' && <details className="optional-goal-plan" open={goalPlanOpen || Boolean(fieldErrors.goalAmount)} onToggle={(event) => setGoalPlanOpen(event.currentTarget.open)}>
            <summary>Add a target <span>Optional</span></summary>
            <p>Set a target per scheduled day, or use the schedule above to choose when a total is due. Advanced planning uses this target for the primary measure.</p>
            <div className="goal-target-row"><label className="form-field"><span>{planningForEditor.mode === 'cumulative-deadline' ? 'Total by deadline' : 'Daily target'} {configuration.metrics[0]?.unit ? <em>· {configuration.metrics[0].unit}</em> : null}</span><input aria-label="Total amount" className="auth-input" type="number" min="0.01" max={Number.MAX_SAFE_INTEGER} step="any" value={goalAmount} onChange={(event) => changeGoalAmount(event.target.value)} placeholder="100" aria-invalid={Boolean(fieldErrors.goalAmount)} aria-describedby={fieldErrors.goalAmount ? 'goal-amount-error' : undefined} />{fieldErrors.goalAmount && <small id="goal-amount-error" className="auth-error">{fieldErrors.goalAmount}</small>}</label></div>
            {pace && <p className="goal-pace-suggestion">Suggested pace: about <strong>{pace}</strong> per scheduled day.</p>}
          </details>}
          <details className="advanced-setup" ref={advancedSetupRef}>
            <summary><span><strong>More options</strong><small>Extra measures, targets, milestones, and details</small></span><span className="advanced-toggle" aria-hidden="true">＋</span></summary>
            <div className="advanced-setup-content">
            {!existing && <label className="form-field advanced-description"><span>Description <em>optional</em> <InfoButton title="Description" summary="Write the context that makes this tracker meaningful." description="This text is for your own reference and does not change how values, success rules, or progress are calculated." /></span><textarea className="auth-input tracker-textarea" maxLength={2000} value={values.description} onChange={(event) => update('description', event.target.value)} placeholder="Why does this matter to you?" /></label>}
              <details className="advanced-subsection"><summary>Activity schedule & holidays</summary><p className="field-hint">Choose when activity is expected.</p><div className="form-grid advanced-dates"><label className="form-field"><span>Activity schedule</span><select data-validation-path="schedule" aria-label="Activity schedule" className="auth-input" value={values.schedule} onChange={(event) => update('schedule', event.target.value)} aria-invalid={Boolean(fieldErrors.schedule)} aria-describedby={fieldErrors.schedule ? 'tracker-schedule-error' : undefined}><option value="every-day">Daily</option><option value="weekdays">Weekdays</option><option value="weekends">Weekends</option><option value="custom-days">Custom Days</option><option value="none">No Recurrence</option>{values.schedule === 'keep-current' && existing && <option value="keep-current">Keep current · {trackerScheduleLabel(existing.schedule)}</option>}</select>{fieldErrors.schedule && <small id="tracker-schedule-error" className="auth-error">{fieldErrors.schedule === 'Select at least one day, or choose No Recurrence.' ? fieldErrors.schedule : readableValidationMessage(fieldErrors.schedule)}</small>}</label>
                {values.schedulingMode === 'effective' && <fieldset className="effective-day-counting" aria-label="How should your days be counted?"><legend>How should your days be counted? <InfoButton title="Effective Days counting" summary="Example: 100 Effective Days with Weekdays" content={<><h3>Example: 100 Effective Days with Weekdays</h3><p><strong>Planned activity days:</strong> Only Monday–Friday count. Weekends pause the count.</p><p><strong>Include rest days:</strong> Monday–Sunday count, even though activity is expected only on weekdays.</p><p>Marked holidays don't count. Missed check-ins don't extend the duration.</p></>} /></legend>{values.schedule === 'none' ? <small>No Recurrence has no planned activity days. Effective Days count non-holiday dates.</small> : <div className="effective-day-counting-options"><label><input type="radio" name="effective-day-counting" value="planned-activity-days" checked={values.effectiveDayCounting === 'planned-activity-days'} disabled={!isSchemaV7WriteEnabled()} onChange={() => update('effectiveDayCounting', 'planned-activity-days')} /><span>Only planned activity days</span></label><label><input type="radio" name="effective-day-counting" value="all-non-holiday-days" checked={values.effectiveDayCounting === 'all-non-holiday-days'} disabled={!isSchemaV7WriteEnabled()} onChange={() => update('effectiveDayCounting', 'all-non-holiday-days')} /><span>Include rest days too</span></label></div>}{projectedDeadline && values.effectiveDays && <small>{values.effectiveDayCounting === 'planned-activity-days' && values.schedule !== 'none' && isSchemaV7WriteEnabled() ? `${values.effectiveDays} planned activity days` : `${values.effectiveDays} non-holiday days`} · Ends {calendarDateLabel(projectedDeadline)}</small>}{!isSchemaV7WriteEnabled() && <small>Counting method changes are unavailable until schema v7 is enabled for this build.</small>}</fieldset>}
                {values.schedule === 'custom-days' && <fieldset className="custom-weekday-picker" data-validation-path="customWeekdays" aria-label="Custom recurrence days"><legend>Select activity days</legend><div>{weekdayChoices.map(([label, day]) => <button key={day} type="button" className="custom-weekday-chip" aria-pressed={values.customWeekdays.includes(day)} onClick={() => update('customWeekdays', values.customWeekdays.includes(day) ? values.customWeekdays.filter((current) => current !== day) : [...values.customWeekdays, day].sort((a, b) => a - b))}>{label}</button>)}</div>{values.customWeekdays.length === 0 && <small className="field-hint" role="status">Select at least one day, or choose No Recurrence.</small>}</fieldset>}
                <label className="strict-mode-option"><input type="checkbox" checked={values.strictMode} onChange={(event) => update('strictMode', event.target.checked)} /><span><strong>Strict Mode</strong><small>Require a qualifying check-in on every calendar day. Holidays and rest days do not preserve your streak.</small></span><InfoButton title="Strict Mode" summary="Every calendar day becomes a streak opportunity, including weekdays, weekends, rest days, and holidays." description="A day qualifies only when progress meets this tracker’s configured streak rule. Partial progress counts if it meets that rule; a lower partial result breaks the streak after the day ends. Changing this setting recalculates current and longest streaks from past entries without changing them. Today remains open until it ends. Voluntary check-ins on rest days or holidays can keep the streak without changing the schedule or holiday." /></label>
                <p className="field-hint form-field-wide">Marked holidays pause scheduled activity expectations and Goal Auto allocations. Recorded work remains saved.</p>
              </div></details>
              <details className="advanced-subsection"><summary>Measures, precision & targets</summary><TrackerConfigurationEditor section="metrics" firstMetricTypeMode={existing ? 'locked' : 'setup'} persistedMetricIds={existing?.metrics.map((metric) => metric.id)} metricsWithHistory={metricsWithHistory} onRemoveMetric={requestRemoveMetric} onMetricNameEdit={markPrimaryMeasureNameCustomized} planning={goalPlanning} metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} streakRuleMode={configuration.streakRuleMode} streakRule={configuration.streakRule} onStreakRuleModeChange={changeStreakRuleMode} onStreakRuleChange={(streakRule) => setConfiguration((current) => ({ ...current, streakRule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Success rule</summary><TrackerConfigurationEditor section="rules" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} streakRuleMode={configuration.streakRuleMode} streakRule={configuration.streakRule} onStreakRuleModeChange={changeStreakRuleMode} onStreakRuleChange={(streakRule) => setConfiguration((current) => ({ ...current, streakRule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection"><summary>Streak rule</summary><TrackerConfigurationEditor section="streak-rules" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} streakRuleMode={configuration.streakRuleMode} streakRule={configuration.streakRule} onStreakRuleModeChange={changeStreakRuleMode} onStreakRuleChange={(streakRule) => setConfiguration((current) => ({ ...current, streakRule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              {(configuration.streakRuleMode !== 'legacy' || existing?.schemaVersion === 8) && !isSchemaV8WriteEnabled() && <p className="field-hint" role="note">Streak rules need the schema v8 migration and production flag before these changes can be saved.</p>}
              <details className="advanced-subsection"><summary>Extra check-in details</summary><TrackerConfigurationEditor section="fields" metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} customFieldsWithHistory={customFieldsWithHistory} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
              <details className="advanced-subsection" data-ai-capability="goals.milestones"><summary>Milestones</summary>{milestoneV9WriteBlocked && <p className="field-hint" role="note">Typed milestones need the schema v9 migration and VITE_ENABLE_TRACKER_SCHEMA_V9 before they can be saved in production.</p>}<TrackerConfigurationEditor section="milestones" milestoneContext={milestoneContext} metrics={configuration.metrics} onMetricsChange={changeMetrics} rule={configuration.rule} onRuleChange={(rule) => setConfiguration((current) => ({ ...current, rule }))} customFields={configuration.customFields} onCustomFieldsChange={(customFields) => setConfiguration((current) => ({ ...current, customFields }))} milestones={configuration.milestones} onMilestonesChange={(milestones) => setConfiguration((current) => ({ ...current, milestones }))} /></details>
            </div>
          </details>
          {selectedKind === 'goal' && <details data-ai-capability="goals.planning" className="goal-plan-setup" open={existing?.kind === 'goal'}><summary><span><strong>Plan targets and pace</strong><small>Choose a daily target or a total to reach by a deadline</small></span><span className="advanced-toggle" aria-hidden="true">＋</span></summary><GoalPlanningEditor metrics={configuration.metrics} planning={planningForEditor} deadline={selectedDeadline} onChange={changeGoalPlanning} /></details>}
          <footer className="tracker-form-actions">
            <Button data-ai-capability={existing ? 'trackers.measure_configuration' : 'trackers.create'} type="submit" aria-describedby={saveBlockReason ? 'tracker-save-block-reason' : undefined} disabled={saving || Boolean(saveBlockReason)}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Create tracker'}</Button>
            <Button type="button" variant="quiet" data-discard-trigger onClick={() => { if (!dirty) navigate('/trackers'); else { setPendingNavigation(null); setConfirmDiscard(true) } }}>Cancel</Button>
            {saveBlockReason && <small className="field-hint form-field-wide" id="tracker-save-block-reason" role="note">{saveBlockReason}</small>}
          </footer>
        </form>
      </Surface>
      {pendingRuleChange && <ConfirmActionDialog
        className="tracker-rule-application-dialog"
        backdropClassName="tracker-rule-application-backdrop"
        showCloseButton
        dismissOnBackdrop
        title="How should your tracker changes apply?"
        description={pendingRuleChange.mode === 'recalculate-all-history'
          ? 'This will reevaluate every saved check-in using the new thresholds and rules. Recorded values and notes stay unchanged. Progression awards may be added or reversed.'
          : 'Choose when the saved thresholds and rules take effect. Earlier check-ins keep their existing evaluation, dates, values, and notes.'}
        actionLabel={pendingRuleChange.mode === 'apply-from-today' ? 'Apply from today'
          : pendingRuleChange.mode === 'after-last-check-in' ? 'After the last check-in' : 'Apply to all history'}
        actionDisabled={saving}
        cancelDisabled={saving}
        onCancel={() => { if (!saving) { setPendingRuleChange(null); setError('') } }}
        onConfirm={() => { void confirmVersionedSave() }}
      >
        <fieldset className="tracker-rule-application-options" disabled={saving}>
          <legend>Choose how to apply these changes</legend>
          <label className="tracker-history-option">
            <input type="radio" name="rule-application" value="apply-from-today" aria-label={`Apply from today${!applyTodayUnavailable ? ' (recommended)' : ''}`} aria-describedby="apply-today-help" disabled={applyTodayUnavailable} checked={pendingRuleChange.mode === 'apply-from-today'} onChange={() => setPendingRuleChange((current) => current ? { ...current, mode: 'apply-from-today' } : current)} />
            <span className="tracker-history-option-copy"><span className="tracker-history-option-heading"><strong>Apply from today</strong>{!applyTodayUnavailable && <span className="tracker-history-recommended">Recommended</span>}</span><small id="apply-today-help">{applyTodayUnavailable ? applyTodayUnavailableReason : `Starts ${calendarDateLabel(pendingRuleChange.today)} (${timeZone}). Earlier dates keep their saved configuration.`}</small></span>
          </label>
          <label className="tracker-history-option">
            <input type="radio" name="rule-application" value="after-last-check-in" aria-label="After the last check-in" aria-describedby="after-check-in-help" checked={pendingRuleChange.mode === 'after-last-check-in'} onChange={() => setPendingRuleChange((current) => current ? { ...current, mode: 'after-last-check-in' } : current)} />
            <span className="tracker-history-option-copy"><span className="tracker-history-option-heading"><strong>After the last check-in</strong></span><small id="after-check-in-help">Starts {calendarDateLabel(pendingRuleChange.latestCheckInDate ? shiftCalendarDate(pendingRuleChange.latestCheckInDate, 1) : pendingRuleChange.today)} ({timeZone}).</small></span>
          </label>
          <label className="tracker-history-option">
            <input type="radio" name="rule-application" value="recalculate-all-history" aria-label="Apply to all history" aria-describedby="all-history-help" disabled={!pendingRuleChange.allHistoryAvailable} checked={pendingRuleChange.mode === 'recalculate-all-history'} onChange={() => setPendingRuleChange((current) => current ? { ...current, mode: 'recalculate-all-history' } : current)} />
            <span className="tracker-history-option-copy"><span className="tracker-history-option-heading"><strong>Apply to all history</strong>{!pendingRuleChange.allHistoryAvailable && <InfoButton compact label="Why is Apply to all history unavailable?" title="Why is this unavailable?" description="We can't safely verify how these changes would affect earlier check-ins. This safeguard protects your recorded progress and achievements. You can still apply changes from today or after your last check-in." content={<><p className="info-dialog-description">We can't safely verify how these changes would affect earlier check-ins. This safeguard protects your recorded progress and achievements. You can still apply changes from today or after your last check-in.</p>{pendingRuleChange.allHistoryReason && <p className="tracker-history-specific-reason">{pendingRuleChange.allHistoryReason}</p>}</>} />}</span><small id="all-history-help">{pendingRuleChange.allHistoryAvailable ? `Recalculate saved results beginning ${calendarDateLabel(pendingRuleChange.historyStartDate)} (${timeZone}).` : 'Unavailable to protect your existing history.'}</small></span>
          </label>
        </fieldset>
        {sameEffectiveDateGroups.map((labels) => <p key={labels.join('-')} className="field-hint tracker-history-date-equivalence" role="status">{labels.join(' and ')} have the same effective date.</p>)}
        {pendingRuleChange.mode !== 'apply-from-today' && <p className="field-hint tracker-history-deferred-note" role="note">Starting earlier requires removing conflicting check-ins through the normal check-in workflow.</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}
      </ConfirmActionDialog>}
      {confirmDiscard && <div className="modal-backdrop tracker-discard-backdrop" role="presentation"><section className="tracker-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-description"><h2 id="discard-title">Discard unsaved changes?</h2><p id="discard-description">Your tracker setup will be lost if you leave now.</p><div><Button type="button" variant="quiet" onClick={() => { setConfirmDiscard(false); setPendingNavigation(null) }}>Keep editing</Button><Button type="button" variant="destructive" onClick={discardAndLeave}>Discard changes</Button></div></section></div>}
      {historicalPeriodConfirmation && <div className="modal-backdrop tracker-discard-backdrop" role="presentation"><section className="tracker-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="historical-period-title" aria-describedby="historical-period-description"><h2 id="historical-period-title">Keep historical check-ins?</h2><p id="historical-period-description">Changing the tracker period will place {historicalPeriodConfirmation.count} existing check-in{historicalPeriodConfirmation.count === 1 ? '' : 's'} outside the active tracking period ({historicalPeriodConfirmation.dateRange}). Their dates and values will remain in History, but they will not count toward current-period streaks, completion rates, or goal progress.</p><div><Button type="button" variant="quiet" onClick={() => { const resolve = historicalPeriodConfirmation.resolve; setHistoricalPeriodConfirmation(null); resolve(false) }}>Cancel changes</Button><Button type="button" onClick={() => { const resolve = historicalPeriodConfirmation.resolve; setHistoricalPeriodConfirmation(null); resolve(true) }}>Keep historical entries</Button></div></section></div>}
    </section>
  )
}

import type { TrackerDefinition, TrackerEntry } from './types'
import { calculateCumulativeMetricPlan, isTrackerScheduledOccurrence } from './planning'

export type AllocationPreviewDay = { date: string; eligible: boolean; amount: number | null; holiday?: boolean }
export type CumulativeAllocationPreview = {
  metricId: string
  totalTarget: number
  actualProgress: number
  remainingTarget: number
  eligibleDayCount: number
  days: AllocationPreviewDay[]
}
export type AllocationPreviewTotals = {
  plannedTotal: number
  shortfall: number
  overAllocation: number
}

/** Builds an in-memory proposal; callers must not persist its day allocations. */
export function createCumulativeAllocationPreview(input: {
  tracker: TrackerDefinition
  entries: readonly TrackerEntry[]
  metricId: string
  totalTarget: number
  asOfDate: string
  startDate: string
  holidays?: ReadonlySet<string>
}): CumulativeAllocationPreview {
  const progress = calculateCumulativeMetricPlan({
    ...input,
    progressSemantics: input.tracker.goalPlanning?.progressSemantics[input.metricId] ?? 'snapshot',
    holidays: input.holidays,
  })
  const metric = input.tracker.metrics.find((item) => item.id === input.metricId)
  if (!metric || metric.valueType === 'boolean') throw new RangeError('Allocation previews require a numeric or checklist metric.')

  const startDate = input.startDate > input.asOfDate ? input.startDate : input.asOfDate
  const days: AllocationPreviewDay[] = []
  if (startDate <= input.tracker.deadline!) {
    for (let time = dateNumber(startDate); time <= dateNumber(input.tracker.deadline!); time += DAY_MS) {
      const date = new Date(time).toISOString().slice(0, 10)
      const holiday = input.holidays?.has(date) ?? false
      days.push({ date, eligible: isTrackerScheduledOccurrence(input.tracker, date) && !holiday, amount: null, ...(holiday ? { holiday: true } : {}) })
    }
  }

  const eligible = days.filter((day) => day.eligible)
  const allocations = distributeTarget(progress.remainingWork, eligible.length, metric.valueType === 'checklist', metric.precision?.increment)
  let allocationIndex = 0
  for (const day of days) {
    if (day.eligible) day.amount = allocations[allocationIndex++] ?? 0
  }

  return {
    metricId: input.metricId,
    totalTarget: input.totalTarget,
    actualProgress: progress.actualProgress,
    remainingTarget: progress.remainingWork,
    eligibleDayCount: eligible.length,
    days,
  }
}

/** Allocates evenly, rounding down to at least hundredths and keeping the exact remainder on the final date. */
export function distributeTarget(remainingTarget: number, dayCount: number, integerUnits = false, increment?: number): number[] {
  if (!Number.isFinite(remainingTarget) || remainingTarget < 0 || remainingTarget > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Remaining target must be a finite nonnegative number.')
  }
  if (!Number.isInteger(dayCount) || dayCount < 0) throw new RangeError('Eligible day count must be a nonnegative integer.')
  if (dayCount === 0 || remainingTarget === 0) return Array.from({ length: dayCount }, () => 0)
  const unit = integerUnits ? 1 : increment
  if (unit !== undefined) {
    if (!Number.isFinite(unit) || unit <= 0) throw new RangeError('Allocation increment must be finite and positive.')
    const scaled = remainingTarget / unit
    const nearest = Math.round(scaled)
    const tolerance = Math.max(1, Math.abs(scaled)) * Number.EPSILON * 8
    if (integerUnits && Math.abs(scaled - nearest) > tolerance) throw new RangeError('Remaining target must use a whole item count.')
    // Recorded progress may predate the current precision setting. Preserve it as-is;
    // suggest the next permitted plan increment and report the visible over-allocation.
    const units = Math.abs(scaled - nearest) <= tolerance ? nearest : Math.ceil(scaled)
    if (!Number.isSafeInteger(units)) throw new RangeError('Target is too large for precise allocation.')
    const base = Math.floor(units / dayCount)
    const remainder = units % dayCount
    return Array.from({ length: dayCount }, (_, index) => (base + (index < remainder ? 1 : 0)) * unit)
  }
  let divisor = integerUnits ? 1 : 10 ** Math.min(15, Math.max(2, decimalPlaces(remainingTarget)))
  if (remainingTarget > Number.MAX_SAFE_INTEGER / divisor) divisor = 1
  const roundedBase = Math.floor((remainingTarget / dayCount) * divisor) / divisor
  const allocations = Array.from({ length: dayCount }, (_, index) => index === dayCount - 1
    ? Math.round((remainingTarget - roundedBase * (dayCount - 1)) * divisor) / divisor
    : roundedBase)
  return allocations
}

export function summarizeAllocations(remainingTarget: number, allocations: readonly number[]): AllocationPreviewTotals {
  if (!Number.isFinite(remainingTarget) || remainingTarget < 0 || allocations.some((amount) => !Number.isFinite(amount) || amount < 0)) {
    throw new RangeError('Preview allocations must be finite and nonnegative.')
  }
  const plannedTotal = allocations.reduce((sum, amount) => sum + amount, 0)
  const rawDifference = remainingTarget - plannedTotal
  const tolerance = Math.max(1, remainingTarget, plannedTotal) * Number.EPSILON * 4
  const difference = Math.abs(rawDifference) <= tolerance ? 0 : rawDifference
  return { plannedTotal, shortfall: Math.max(0, difference), overAllocation: Math.max(0, -difference) }
}

function decimalPlaces(value: number): number {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e')
  const exponent = Number(exponentText ?? 0)
  const fractionalDigits = coefficient?.split('.')[1]?.length ?? 0
  return Math.max(0, fractionalDigits - exponent)
}

const DAY_MS = 86_400_000
function dateNumber(value: string): number {
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid calendar date: ${value}`)
  return time
}

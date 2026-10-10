import type { TrackerDefinition, TrackerEntry } from './types'
import { calculateCumulativeMetricPlan, isTrackerScheduledOccurrence, latestEntriesByDate, trackerActiveStartDate } from './planning'

export type AllocationPreviewDay = { date: string; eligible: boolean; amount: number | null; holiday?: boolean; closed?: boolean }
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
  timeZone?: string
}): CumulativeAllocationPreview {
  const progress = calculateCumulativeMetricPlan({
    ...input,
    progressSemantics: input.tracker.goalPlanning?.progressSemantics[input.metricId] ?? 'snapshot',
    holidays: input.holidays,
    timeZone: input.timeZone,
  })
  const metric = input.tracker.metrics.find((item) => item.id === input.metricId)
  if (!metric || metric.valueType === 'boolean') throw new RangeError('Allocation previews require a numeric or checklist metric.')

  const activeStartDate = [input.startDate, trackerActiveStartDate(input.tracker, input.timeZone)].sort().at(-1)!
  const startDate = activeStartDate > input.asOfDate ? activeStartDate : input.asOfDate
  const latestEntries = latestEntriesByDate(input.tracker, input.entries)
  const todayClosed = latestEntries.has(input.asOfDate)
  const days: AllocationPreviewDay[] = []
  if (startDate <= input.tracker.deadline!) {
    for (let time = dateNumber(startDate); time <= dateNumber(input.tracker.deadline!); time += DAY_MS) {
      const date = new Date(time).toISOString().slice(0, 10)
      const holiday = input.holidays?.has(date) ?? false
      const closed = date === input.asOfDate && todayClosed
      days.push({ date, eligible: isTrackerScheduledOccurrence(input.tracker, date, input.timeZone) && !holiday && !closed, amount: null, ...(holiday ? { holiday: true } : {}), ...(closed ? { closed: true } : {}) })
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

/** Distributes the smallest allowed increments from the earliest eligible dates. */
export function distributeTarget(remainingTarget: number, dayCount: number, integerUnits = false, increment?: number): number[] {
  if (!Number.isFinite(remainingTarget) || remainingTarget < 0 || remainingTarget > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Remaining target must be a finite nonnegative number.')
  }
  if (!Number.isInteger(dayCount) || dayCount < 0) throw new RangeError('Eligible day count must be a nonnegative integer.')
  if (dayCount === 0 || remainingTarget === 0) return Array.from({ length: dayCount }, () => 0)
  const unit = integerUnits ? 1 : increment
  if (unit !== undefined && (!Number.isFinite(unit) || unit <= 0)) throw new RangeError('Allocation increment must be finite and positive.')
  const scale = Math.min(15, Math.max(unit === undefined ? 2 : 0, decimalPlaces(remainingTarget), unit === undefined ? 0 : decimalPlaces(unit)))
  const factor = 10 ** scale
  const targetUnits = decimalToScaledInteger(remainingTarget, scale)
  const incrementUnits = unit === undefined ? 1n : decimalToScaledInteger(unit, scale)
  if (integerUnits && targetUnits % incrementUnits !== 0n) throw new RangeError('Remaining target must use a whole item count.')
  // Legacy progress can be finer than the current precision. Keep that progress
  // intact and allocate the next allowed increment; the preview reports the small
  // over-allocation instead of rounding recorded work.
  const incrementCount = (targetUnits + incrementUnits - 1n) / incrementUnits
  const quotient = incrementCount / BigInt(dayCount)
  const remainder = incrementCount % BigInt(dayCount)
  return Array.from({ length: dayCount }, (_, index) => {
    const count = quotient + (BigInt(index) < remainder ? 1n : 0n)
    return Number(count * incrementUnits) / factor
  })
}

function decimalToScaledInteger(value: number, scale: number): bigint {
  const [coefficient = '0', exponentText] = value.toString().toLowerCase().split('e')
  const exponent = Number(exponentText ?? 0)
  const negative = coefficient.startsWith('-')
  const unsigned = negative ? coefficient.slice(1) : coefficient
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const digits = BigInt(`${whole}${fraction}` || '0') * (negative ? -1n : 1n)
  const valueScale = fraction.length - exponent
  if (valueScale <= scale) return digits * 10n ** BigInt(scale - valueScale)
  const divisor = 10n ** BigInt(valueScale - scale)
  const quotient = digits / divisor
  const remainder = digits % divisor
  return quotient + (remainder * 2n >= divisor ? 1n : 0n)
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

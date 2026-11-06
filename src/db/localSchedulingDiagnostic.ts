import { db } from './database'
import type { StoredTrackerDefinition } from './models'
import { deriveSchedulingDeadline, schedulingMode } from '../domain/trackers/scheduling'

export type LocalSchedulingDiagnostic = {
  generatedAt: string
  readOnly: true
  database: { label: 'account-scoped ProgressTracker database'; version: number; accountScopeVerified: true }
  stores: Record<string, 'read' | 'unavailable'>
  rawWorkspaceTimeZone: string | null
  workspaceTimeZoneUsed: string
  cloudReference: 'reported-production-configuration'
  accountHolidays: Array<{ date: unknown; deletedAt: unknown }>
  invalidAccountHolidayDateCount: number
  trackerHolidays: Array<{ trackerId: unknown; date: unknown; deletedAt: unknown }>
  cloudHolidayComparison: Array<{ date: string; cloudDeleted: boolean; localPresent: boolean; localDeleted: boolean | null; status: 'matches' | 'differs' | 'missing-locally' }>
  cloudTrackersMissingLocally: string[]
  trackers: Array<{
    trackerId: string
    name: string
    rawStored: {
      schemaVersion: unknown
      status: unknown
      deletedAt: unknown
      startDate: unknown
      createdAt: unknown
      savedDeadline: unknown
      scheduling: unknown
      recurrence: unknown
      ruleVersions: unknown
    }
    validation: string[]
    calculated: { mode: string; deadline: string | undefined } | null
    cloudComparison: { status: 'matches' | 'differs' | 'reference-unavailable'; differences: string[] }
    failure?: { operation: string; errorName: string; errorMessage: string; stackLocation: string | null }
  }>
}

type RawRecord = Record<string, unknown>
type CloudReference = {
  name: string
  startDate?: string
  deadline?: string
  mode: 'ongoing' | 'effective'
  effectiveDays?: number
  effectiveDayCounting?: string
  planningTimeZone?: string
  recurrence: Record<string, unknown>
}

const cloudReferences: CloudReference[] = [
  { name: '1 Hour MERN Daily', mode: 'ongoing', recurrence: { kind: 'every-day' } },
  { name: '2 Problems Of CP - 31 Daily', mode: 'ongoing', recurrence: { kind: 'every-day' } },
  {
    name: '92 Day DSA', startDate: '2026-10-29', deadline: '2027-01-28', mode: 'effective',
    effectiveDays: 92, effectiveDayCounting: 'planned-activity-days', planningTimeZone: 'Asia/Calcutta',
    recurrence: { kind: 'every-day' },
  },
]

const knownCloudAccountHolidays = [
  { date: '2026-11-05', deleted: false },
  { date: '2026-10-10', deleted: true },
  { date: '2026-10-11', deleted: true },
]

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read request failed.'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB read transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB read transaction was aborted.'))
  })
}

function validCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1) return false
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year!, month! - 1, day!)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
}

function recordValidation(record: RawRecord): string[] {
  const issues: string[] = []
  const schedule = record.schedule
  const scheduling = record.scheduling
  const mode = scheduling && typeof scheduling === 'object' ? (scheduling as RawRecord).mode : undefined
  const effectiveDays = scheduling && typeof scheduling === 'object' ? (scheduling as RawRecord).effectiveDays : undefined
  if (record.startDate !== undefined && !validCalendarDate(record.startDate)) issues.push('startDate is not a valid YYYY-MM-DD calendar date')
  if (!record.startDate && typeof record.createdAt !== 'string') issues.push('startDate is absent and createdAt is unavailable for fallback')
  if (typeof record.createdAt === 'string' && !Number.isFinite(Date.parse(record.createdAt))) issues.push('createdAt is invalid for the start-date fallback')
  if (mode !== undefined && !['effective', 'calendar', 'ongoing'].includes(String(mode))) issues.push('scheduling mode is unrecognized')
  if (mode === 'effective' && (!Number.isInteger(effectiveDays) || (effectiveDays as number) < 1 || (effectiveDays as number) > 100_000)) {
    issues.push('effectiveDays is missing or outside the supported positive integer range 1–100000')
  }
  if (scheduling && typeof scheduling === 'object' && (scheduling as RawRecord).planningTimeZone !== undefined) {
    const zone = (scheduling as RawRecord).planningTimeZone
    try {
      if (typeof zone !== 'string' || !zone || typeof Intl !== 'undefined' && !Intl.DateTimeFormat('en', { timeZone: zone })) issues.push('planning time zone is not recognized by this browser runtime')
    } catch { issues.push('planning time zone is not recognized by this browser runtime') }
  }
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) issues.push('recurrence schedule is missing or malformed')
  else {
    const value = schedule as RawRecord
    const kind = value.kind
    if (!['none', 'every-day', 'weekdays', 'selected-weekdays', 'every-n-days', 'times-per-week', 'times-per-month', 'specific-dates', 'once'].includes(String(kind))) issues.push('recurrence kind is unrecognized')
    if (kind === 'selected-weekdays' && (!Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6))) issues.push('selected weekdays are missing or malformed')
    if (kind === 'every-n-days' && (!Number.isInteger(value.interval) || (value.interval as number) < 1)) issues.push('every-n-days interval is missing or invalid')
    if (kind === 'times-per-week' && (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 7)) issues.push('times-per-week count is missing or invalid')
    if (kind === 'times-per-month' && (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 31)) issues.push('times-per-month count is missing or invalid')
    if (kind === 'specific-dates' && (!Array.isArray(value.dates) || value.dates.length === 0 || value.dates.some((date) => !validCalendarDate(date)))) issues.push('specific dates are empty or include an invalid date')
    if (kind === 'once' && !validCalendarDate(value.date)) issues.push('once date is missing or invalid')
  }
  if (Array.isArray(record.ruleVersions)) {
    for (const version of record.ruleVersions) {
      if (!version || typeof version !== 'object' || Array.isArray(version)) {
        issues.push('a historical rule version is not an object')
        continue
      }
      const evaluation = (version as RawRecord).evaluation
      if (!validCalendarDate((version as RawRecord).effectiveFrom)) issues.push('a historical rule version has an invalid effectiveFrom date')
      if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) issues.push('a historical rule version has no evaluation object')
      else {
        const historicalStart = (evaluation as RawRecord).startDate
        const historicalDeadline = (evaluation as RawRecord).deadline
        if (historicalStart != null && !validCalendarDate(historicalStart)) issues.push('a historical evaluation start date is invalid')
        if (historicalDeadline != null && !validCalendarDate(historicalDeadline)) issues.push('a historical evaluation deadline is invalid')
      }
    }
  } else if (record.ruleVersions != null) issues.push('historical rule versions are malformed')
  return issues
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 400)
}

function safeStackLocation(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null
  const frames = error.stack.split('\n').slice(1)
  for (const frame of frames) {
    const match = frame.match(/([A-Za-z0-9_.-]+\.(?:tsx?|jsx?):\d+:\d+)/)
    if (match) return match[1]!
  }
  return null
}

function safeScheduling(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null
  const item = value as RawRecord
  const safeField = (field: string) => {
    const fieldValue = item[field]
    return fieldValue === null || ['string', 'number', 'boolean'].includes(typeof fieldValue) ? fieldValue : '[malformed value]'
  }
  return {
    ...(item.mode !== undefined ? { mode: safeField('mode') } : {}),
    ...(item.effectiveDays !== undefined ? { effectiveDays: safeField('effectiveDays') } : {}),
    ...(item.effectiveDayCounting !== undefined ? { effectiveDayCounting: safeField('effectiveDayCounting') } : {}),
    ...(item.planningTimeZone !== undefined ? { planningTimeZone: safeField('planningTimeZone') } : {}),
  }
}

function safeScalar(value: unknown): unknown {
  return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)
    ? value ?? null
    : '[malformed value]'
}

function safeRecurrence(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null
  const item = value as RawRecord
  const allowed = ['kind', 'weekdays', 'interval', 'count', 'preferredWeekdays', 'dates', 'date']
  const result = Object.fromEntries(allowed.filter((key) => item[key] !== undefined).map((key) => {
    const field = item[key]
    if (Array.isArray(field)) return [key, field.slice(0, 1000).map((entry) => ['string', 'number', 'boolean'].includes(typeof entry) || entry === null ? entry : '[malformed item]')]
    return [key, field === null || ['string', 'number', 'boolean'].includes(typeof field) ? field : '[malformed value]']
  }))
  const truncated = Object.fromEntries(allowed.filter((key) => Array.isArray(item[key]) && (item[key] as unknown[]).length > 1000).map((key) => [key, (item[key] as unknown[]).length - 1000]))
  return Object.keys(truncated).length ? { ...result, omittedArrayItems: truncated } : result
}

function cloudComparison(record: RawRecord): LocalSchedulingDiagnostic['trackers'][number]['cloudComparison'] {
  const name = typeof record.name === 'string' ? record.name : ''
  const reference = cloudReferences.find((item) => item.name === name)
  if (!reference) return { status: 'reference-unavailable', differences: [] }
  const scheduling = record.scheduling && typeof record.scheduling === 'object' ? record.scheduling as RawRecord : {}
  const mode = scheduling.mode ?? (record.deadline ? 'calendar' : 'ongoing')
  const differences: string[] = []
  const compare = (field: string, local: unknown, expected: unknown) => {
    if (expected === undefined) return
    try {
      if (JSON.stringify(local ?? null) !== JSON.stringify(expected)) differences.push(field)
    } catch { differences.push(`${field} (not safely serializable)`) }
  }
  compare('startDate', record.startDate, reference.startDate)
  compare('savedDeadline', record.deadline, reference.deadline)
  compare('scheduling.mode', mode, reference.mode)
  compare('scheduling.effectiveDays', scheduling.effectiveDays, reference.effectiveDays)
  compare('scheduling.effectiveDayCounting', scheduling.effectiveDayCounting ?? (reference.mode === 'effective' ? 'all-non-holiday-days' : undefined), reference.effectiveDayCounting)
  compare('scheduling.planningTimeZone', scheduling.planningTimeZone, reference.planningTimeZone)
  compare('schedule', record.schedule, reference.recurrence)
  return { status: differences.length ? 'differs' : 'matches', differences }
}

/** Reads only an already-open, account-scoped IndexedDB connection; it never opens or upgrades a database. */
export async function inspectLocalScheduling(userId: string): Promise<LocalSchedulingDiagnostic> {
  const database = db
  const expectedName = `ProgressTracker:account:${encodeURIComponent(userId)}`
  if (!database.isOpen() || database.name !== expectedName) throw new Error('The matching account database is not already open. No database was opened or changed.')
  const idb = database.backendDB()
  const requiredStores = ['trackers', 'workspaceMetadata']
  if (requiredStores.some((name) => !idb.objectStoreNames.contains(name))) throw new Error('The open account database is missing a required diagnostic store. No upgrade was attempted.')
  const availableStores = ['trackers', 'accountHolidays', 'trackerHolidays', 'settings', 'workspaceMetadata']
    .filter((name) => idb.objectStoreNames.contains(name))
  const transaction = idb.transaction(availableStores, 'readonly')
  const done = transactionComplete(transaction)
  const trackersRequest = requestResult(transaction.objectStore('trackers').getAll()) as Promise<unknown[]>
  const workspaceRequest = requestResult(transaction.objectStore('workspaceMetadata').get('workspace')) as Promise<RawRecord | undefined>
  const accountHolidaysRequest = availableStores.includes('accountHolidays')
    ? requestResult(transaction.objectStore('accountHolidays').getAll()) as Promise<RawRecord[]>
    : Promise.resolve([])
  const trackerHolidaysRequest = availableStores.includes('trackerHolidays')
    ? requestResult(transaction.objectStore('trackerHolidays').getAll()) as Promise<RawRecord[]>
    : Promise.resolve([])
  const settingsRequest = availableStores.includes('settings')
    ? requestResult(transaction.objectStore('settings').get('general')) as Promise<RawRecord | undefined>
    : Promise.resolve(undefined)
  const [rawTrackers, workspace, rawAccountHolidays, rawTrackerHolidays, settings] = await Promise.all([
    trackersRequest, workspaceRequest, accountHolidaysRequest, trackerHolidaysRequest, settingsRequest, done,
  ]).then(([trackers, metadata, accountHolidays, trackerHolidays, appSettings]) => [trackers, metadata, accountHolidays, trackerHolidays, appSettings] as const)
  if (db !== database || !database.isOpen() || database.name !== expectedName || workspace?.userId !== userId) {
    throw new Error('The active local account changed during inspection. No diagnostic data was returned.')
  }

  const rawSettingsZone = typeof settings?.timezone === 'string' ? settings.timezone : null
  const deviceZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : 'UTC'
  let workspaceTimeZone = rawSettingsZone || deviceZone
  try { new Intl.DateTimeFormat('en', { timeZone: workspaceTimeZone }) } catch { workspaceTimeZone = deviceZone }
  const activeAccountHolidays = new Set(rawAccountHolidays.filter((holiday) => holiday.deletedAt === null).map((holiday) => holiday.date).filter((date): date is string => typeof date === 'string'))
  const trackers = rawTrackers.map((value): LocalSchedulingDiagnostic['trackers'][number] => {
    const record = value && typeof value === 'object' ? value as RawRecord : {}
    const trackerId = typeof record.id === 'string' ? record.id : '[missing tracker id]'
    const name = typeof record.name === 'string' ? record.name : '[unnamed tracker]'
    const rawStored: LocalSchedulingDiagnostic['trackers'][number]['rawStored'] = {
      schemaVersion: safeScalar(record.schemaVersion),
      status: safeScalar(record.status),
      deletedAt: safeScalar(record.deletedAt),
      startDate: safeScalar(record.startDate),
      createdAt: safeScalar(record.createdAt),
      savedDeadline: safeScalar(record.deadline),
      scheduling: safeScheduling(record.scheduling),
      recurrence: safeRecurrence(record.schedule),
      ruleVersions: Array.isArray(record.ruleVersions) ? {
        versions: record.ruleVersions.slice(0, 1000).map((version) => {
        if (!version || typeof version !== 'object') return version ?? null
        const item = version as RawRecord
        const evaluation = item.evaluation && typeof item.evaluation === 'object' ? item.evaluation as RawRecord : {}
        return { id: safeScalar(item.id), effectiveFrom: safeScalar(item.effectiveFrom), revision: safeScalar(item.revision), evaluation: {
          startDate: safeScalar(evaluation.startDate), deadline: safeScalar(evaluation.deadline),
          scheduling: safeScheduling(evaluation.scheduling), schedule: safeRecurrence(evaluation.schedule),
        } }
        }),
        omittedCount: Math.max(0, record.ruleVersions.length - 1000),
      } : record.ruleVersions == null ? null : { invalidType: typeof record.ruleVersions },
    }
    const result: LocalSchedulingDiagnostic['trackers'][number] = {
      trackerId, name, rawStored, validation: recordValidation(record), calculated: null,
      cloudComparison: cloudComparison(record),
    }
    try {
      const tracker = record as unknown as StoredTrackerDefinition
      const mode = schedulingMode(tracker)
      if (mode === 'effective' && !availableStores.includes('accountHolidays')) {
        result.failure = {
          operation: 'localRepository.listTrackers.deriveSchedulingDeadline',
          errorName: 'DiagnosticInputUnavailable',
          errorMessage: 'The account holiday store is unavailable; effective deadline calculation was skipped.',
          stackLocation: null,
        }
        return result
      }
      const deadline = deriveSchedulingDeadline({
        tracker,
        holidays: activeAccountHolidays,
        timeZone: tracker.scheduling?.planningTimeZone ?? workspaceTimeZone,
      })
      result.calculated = { mode, deadline }
    } catch (error) {
      result.failure = {
        operation: 'localRepository.listTrackers.deriveSchedulingDeadline',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: safeMessage(error),
        stackLocation: safeStackLocation(error),
      }
    }
    return result
  })

  const holidayCompare = knownCloudAccountHolidays.map((expected) => {
    const local = rawAccountHolidays.find((holiday) => holiday.date === expected.date)
    const localDeleted = local ? local.deletedAt !== null : null
    return {
      date: expected.date, cloudDeleted: expected.deleted, localPresent: Boolean(local), localDeleted,
      status: !local ? 'missing-locally' as const : localDeleted === expected.deleted ? 'matches' as const : 'differs' as const,
    }
  })
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    database: { label: 'account-scoped ProgressTracker database', version: idb.version, accountScopeVerified: true },
    stores: Object.fromEntries(['trackers', 'workspaceMetadata', 'accountHolidays', 'trackerHolidays', 'settings'].map((name) => [name, availableStores.includes(name) ? 'read' : 'unavailable'])) as LocalSchedulingDiagnostic['stores'],
    rawWorkspaceTimeZone: rawSettingsZone,
    workspaceTimeZoneUsed: workspaceTimeZone,
    cloudReference: 'reported-production-configuration',
    accountHolidays: rawAccountHolidays.map(({ date, deletedAt }) => ({ date: safeScalar(date), deletedAt: safeScalar(deletedAt) })),
    invalidAccountHolidayDateCount: rawAccountHolidays.filter(({ date }) => !validCalendarDate(date)).length,
    trackerHolidays: rawTrackerHolidays.map(({ trackerId, date, deletedAt }) => ({ trackerId: safeScalar(trackerId), date: safeScalar(date), deletedAt: safeScalar(deletedAt) })),
    cloudHolidayComparison: holidayCompare,
    cloudTrackersMissingLocally: cloudReferences.filter((reference) => !trackers.some((tracker) => tracker.name === reference.name)).map(({ name }) => name),
    trackers,
  }
}

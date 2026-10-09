/**
 * The domain schemas store UTC ISO 8601 strings with a trailing `Z`. PostgreSQL
 * and PostgREST may serialize timestamptz as either ISO with an offset or
 * `YYYY-MM-DD HH:mm:ss[.fraction]+HH[:MM]`. Normalize those representations
 * only at the sync boundary, preserving the represented instant and fraction.
 */
export function normalizeSyncTimestamp(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value

  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/i.exec(value)
  if (!match) throw new Error(`Invalid ISO datetime at ${field}.`)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fraction = match[7] ?? ''
  const offsetSign = match[9] === '-' ? -1 : 1
  const offsetHour = Number(match[10] ?? 0)
  const offsetMinute = Number(match[11] ?? 0)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`Invalid ISO datetime at ${field}.`)
  }

  // setUTCFullYear avoids Date.UTC's special handling of years 0000–0099.
  const local = new Date(0)
  local.setUTCFullYear(year, month - 1, day)
  local.setUTCHours(hour, minute, second, 0)
  const offsetMilliseconds = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000
  const utc = new Date(local.getTime() - offsetMilliseconds)
  const utcYear = utc.getUTCFullYear()
  if (utcYear < 0 || utcYear > 9999) throw new Error(`Invalid ISO datetime at ${field}.`)

  const pad = (part: number, width = 2) => String(part).padStart(width, '0')
  return `${pad(utcYear, 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}${fraction}Z`
}

function normalizeFields(value: unknown, fields: readonly string[], nullableFields: readonly string[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const normalized = { ...value } as Record<string, unknown>
  for (const field of fields) normalized[field] = normalizeSyncTimestamp(normalized[field], field)
  for (const field of nullableFields) {
    if (normalized[field] !== null) normalized[field] = normalizeSyncTimestamp(normalized[field], field)
  }
  return normalized
}

export function normalizeTrackerTimestamps(value: unknown): unknown {
  return normalizeFields(value, ['createdAt', 'updatedAt'], ['archivedAt', 'deletedAt'])
}

export function normalizeTrackerEntryTimestamps(value: unknown): unknown {
  return normalizeFields(value, ['createdAt', 'updatedAt'], ['deletedAt'])
}

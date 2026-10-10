import type { TrackerDefinition, TrackerEntry } from '../domain/trackers/types'

export type CalendarDate = `${number}-${number}-${number}`

/** Persisted generic domain rows introduced by the non-destructive Dexie v3 upgrade. */
export type StoredTrackerDefinition = TrackerDefinition
export type StoredTrackerEntry = TrackerEntry

export type CategorySchedule =
  | { kind: 'every-day' }
  | { kind: 'weekdays' }
  | { kind: 'selected-weekdays'; weekdays: number[] }
  | { kind: 'times-per-week'; count: number; preferredWeekdays?: number[] }

export type Category = {
  id: string
  name: string
  icon: string
  description?: string
  accent: string
  schedule: CategorySchedule
  position: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  deletedAt: string | null
}

export type DailyEntryStatus = 'completed' | 'skipped'

export type DailyEntry = {
  id: string
  categoryId: string
  date: CalendarDate
  status: DailyEntryStatus
  note: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type DailyJournal = {
  id: string
  date: CalendarDate
  body: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type GoalStatus = 'active' | 'paused' | 'completed' | 'archived'

export type Goal = {
  id: string
  title: string
  description: string
  categoryId: string | null
  startDate: CalendarDate
  targetDate: CalendarDate
  status: GoalStatus
  completedAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type GoalMetric = {
  id: string
  goalId: string
  name: string
  unit: string
  target: number
  weight: number | null
  position: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** Progress values are immutable snapshots; the latest snapshot is the current value. */
export type GoalProgressLog = {
  id: string
  metricId: string
  date: CalendarDate
  value: number
  recordedAt: string
  updatedAt: string
  deletedAt: string | null
  note?: string
}

export type AppSettings = {
  id: 'general'
  timezone: string
  appearance: 'light' | 'dark' | 'system'
  backupReminderDays: number | null
  updatedAt: string
}

export type HolidayReason = 'travel' | 'exam' | 'personal' | 'other'
/** One account-wide holiday per calendar date. Dates are local calendar dates in the workspace time zone. */
export type AccountHoliday = {
  id: string
  date: CalendarDate
  reason: HolidayReason | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type SyncEntity = 'category' | 'daily-entry' | 'daily-journal' | 'goal' | 'goal-metric' | 'goal-progress' | 'settings' | 'tracker' | 'tracker_entry' | 'account_holiday'
export type SyncOperation = {
  id: string
  ownerUserId: string | null
  entity: SyncEntity
  entityId: string
  operation: 'upsert'
  expectedRevision: number | null
  payload?: StoredTrackerDefinition | StoredTrackerEntry | AccountHoliday
  createdAt: string
  attempts: number
  status: 'pending' | 'conflict'
  lastError: string | null
}

export type SyncRecordState = { key: string; ownerUserId: string; entity: 'tracker' | 'tracker_entry' | 'account_holiday'; entityId: string; serverRevision: number }
export type SyncConflict = { id: string; ownerUserId: string; entity: 'tracker' | 'tracker_entry' | 'account_holiday'; entityId: string; localPayload: StoredTrackerDefinition | StoredTrackerEntry | AccountHoliday; remoteRecord: Record<string, unknown> | null; detectedAt: string }
export type PermanentDeletionRequest = { id: string; ownerUserId: string; trackerId: string; requestedAt: string; status: 'pending' | 'conflict' | 'failed'; lastError: string | null }
export type PermanentDeletionLedgerEntry = { key: string; ownerUserId: string; trackerId: string; permanentlyDeletedAt: string }
export type TrackerVerification = { trackerId: string; status: 'pending-server-check' }
export type AppNotification = {
  id: string
  identity: string
  kind: 'pending' | 'overdue' | 'motivation' | 'achievement' | 'holiday' | 'info'
  title: string
  body: string
  href: string
  createdAt: string
  readAt: string | null
}

export type DailyEntryDraft = Pick<DailyEntry, 'categoryId' | 'date' | 'status' | 'note'>
export type DailyJournalDraft = Pick<DailyJournal, 'date' | 'body'>

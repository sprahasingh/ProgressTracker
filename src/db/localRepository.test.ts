import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateWorkspace, db, queueSyncMutation } from './database'
import { localRepository } from './localRepository'
import { calendarDateInTimeZone } from './calendarDate'
import { subscribeToWorkspaceMutations } from './workspaceMutationEvents'
import type { StoredTrackerDefinition } from './models'
import { versionTrackerRuleChange } from '../domain/trackers/ruleVersions'

const tracker: StoredTrackerDefinition = {
  schemaVersion: 1, id: 'local-event-tracker', name: 'Local event test', description: '', kind: 'habit', status: 'active', categoryId: null,
  tags: [], icon: '', accent: '', schedule: { kind: 'every-day' }, metrics: [], customFields: [], milestones: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
}
const plannedGoal: StoredTrackerDefinition = {
  ...tracker, id: 'local-planned-goal', kind: 'goal', schemaVersion: 2,
  metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', minimum: 2, target: 5, stretch: 8, streakQualification: 'minimum' } }],
  goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 3 }, cumulativeTargets: { pages: 100 } },
  deadline: '2026-12-31',
}

afterEach(async () => {
  vi.unstubAllEnvs()
  db.close()
  await db.delete()
})

describe('workspace mutation notifications', () => {
  it('stores tracker-specific holidays offline, syncs them, and excludes Strict Mode trackers', async () => {
    const owner = 'tracker-holiday-offline-owner'
    await activateWorkspace(owner)
    await localRepository.saveTracker({ ...tracker, id: 'holiday-standard' })
    await localRepository.saveTracker({ ...tracker, id: 'holiday-strict', strictMode: true })
    const saved = await localRepository.saveTrackerHoliday('holiday-standard', '2026-01-05')
    expect(saved).toMatchObject({ trackerId: 'holiday-standard', date: '2026-01-05', deletedAt: null })
    await expect(localRepository.listTrackerHolidays()).resolves.toEqual([saved])
    await expect(db.syncOperations.where('ownerUserId').equals(owner).toArray()).resolves.toContainEqual(expect.objectContaining({ entity: 'tracker_holiday', entityId: saved.id, status: 'pending' }))
    await expect(localRepository.saveTrackerHoliday('holiday-strict', '2026-01-05')).rejects.toThrow(/Strict Mode/)
    await expect(localRepository.setTrackerHolidaySelections([{ date: '2026-01-05', trackerIds: ['holiday-strict'] }])).rejects.toThrow(/Strict Mode/)
    await localRepository.removeTrackerHoliday('holiday-standard', '2026-01-05')
    await expect(localRepository.listTrackerHolidays()).resolves.toEqual([])
    await expect(localRepository.listTrackerHolidays(undefined, undefined, true)).resolves.toContainEqual(expect.objectContaining({ id: saved.id, deletedAt: expect.any(String) }))
  })

  it('removes configured selected holidays when their tracker changes to Strict Mode', async () => {
    const owner = 'tracker-holiday-mode-change-owner'
    await activateWorkspace(owner)
    await localRepository.saveTracker({ ...tracker, id: 'mode-changing-tracker' })
    const holiday = await localRepository.saveTrackerHoliday('mode-changing-tracker', '2026-01-06')

    await localRepository.saveTracker({ ...tracker, id: 'mode-changing-tracker', strictMode: true })

    await expect(localRepository.listTrackerHolidays()).resolves.toEqual([])
    await expect(db.trackerHolidays.get(holiday.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals([owner, 'tracker_holiday', holiday.id]).first()).resolves.toMatchObject({ status: 'pending', payload: { deletedAt: expect.any(String) } })
    await expect(localRepository.setTrackerHolidaySelections([{ date: holiday.date, trackerIds: ['mode-changing-tracker'] }])).rejects.toThrow(/Strict Mode/)
  })

  it('rejects all-history rule edits when a referenced measure was introduced later, preserving local history', async () => {
    const ownerUserId = 'historical-dependency-owner'
    await activateWorkspace(ownerUserId)
    const base = {
      ...tracker, id: 'historical-dependency-local', schemaVersion: 10 as const,
      startDate: '2026-01-01',
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      scheduling: { mode: 'ongoing' as const },
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
      streakRuleMode: 'same-as-success' as const,
      ruleVersions: [{ id: 'baseline', effectiveFrom: '2026-01-01', revision: 1, application: 'baseline' as const,
        recordedAt: '2026-01-01T00:00:00.000Z', evaluation: {
          schedule: { kind: 'every-day' as const }, startDate: '2026-01-01', deadline: null, scheduling: { mode: 'ongoing' as const },
          metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
          qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
          streakRuleMode: 'same-as-success' as const, streakRule: null, strictMode: false,
        } }],
    }
    await localRepository.saveTracker(base)
    await localRepository.saveTrackerEntry({ trackerId: base.id, date: '2026-01-02', outcome: 'recorded', values: { done: true }, note: 'retain' })
    const added = { id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages' }
    const structural = versionTrackerRuleChange({
      before: base, after: { ...base, metrics: [...base.metrics, added] }, application: 'apply-from-today',
      today: '2026-01-03', historyStartDate: '2026-01-01', effectiveFrom: '2026-01-03', recordedAt: '2026-01-03T00:00:00Z',
    }) as StoredTrackerDefinition
    await localRepository.saveTracker(structural)
    const recalculated = versionTrackerRuleChange({
      before: structural,
      after: { ...structural, qualificationRule: { kind: 'comparison', metricId: 'pages', operator: 'at-least', value: 1 } },
      application: 'recalculate-all-history', today: '2026-01-04', historyStartDate: '2026-01-01', recordedAt: '2026-01-04T00:00:00Z',
    }) as StoredTrackerDefinition

    await expect(localRepository.saveTracker(recalculated)).rejects.toThrow(/measure was unavailable during part of the selected period/i)
    await expect(localRepository.getTracker(base.id)).resolves.toMatchObject({ ruleVersions: structural.ruleVersions, metrics: structural.metrics })
    await expect(localRepository.getTrackerEntry(base.id, '2026-01-02')).resolves.toMatchObject({ values: { done: true }, note: 'retain' })
    await expect(db.syncOperations.where('ownerUserId').equals(ownerUserId).toArray()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'tracker_entry', entityId: expect.any(String), status: 'pending', payload: expect.objectContaining({ values: { done: true }, note: 'retain' }) }),
    ]))
  })

  it('rejects all-history when a historical check-in lacks an active measure value', async () => {
    await activateWorkspace('missing-historical-measure-input-owner')
    const baseline: StoredTrackerDefinition = {
      ...tracker, id: 'missing-historical-measure-input', schemaVersion: 10, startDate: '2026-01-01',
      scheduling: { mode: 'ongoing' },
      metrics: [
        { id: 'done', name: 'Done', valueType: 'boolean' },
        { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' },
      ],
      qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
      streakRuleMode: 'same-as-success',
      ruleVersions: [{ id: 'baseline-missing-input', effectiveFrom: '2026-01-01', revision: 1, application: 'baseline', recordedAt: '2026-01-01T00:00:00.000Z', evaluation: {
        schedule: { kind: 'every-day' }, startDate: '2026-01-01', deadline: null, scheduling: { mode: 'ongoing' },
        metrics: [
          { id: 'done', name: 'Done', valueType: 'boolean' },
          { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' },
        ],
        qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
        streakRuleMode: 'same-as-success', streakRule: null, strictMode: false,
      } }],
    }
    await localRepository.saveTracker(baseline)
    await localRepository.saveTrackerEntry({ trackerId: baseline.id, date: '2026-01-02', outcome: 'recorded', values: { done: true }, note: 'No pages value was saved' })
    const recalculated = versionTrackerRuleChange({
      before: baseline,
      after: { ...baseline, qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: false } },
      application: 'recalculate-all-history', today: '2026-01-04', historyStartDate: '2026-01-01', recordedAt: '2026-01-04T00:00:00Z',
    }) as StoredTrackerDefinition

    await expect(localRepository.saveTracker(recalculated)).rejects.toThrow(/all-history recalculation is unsafe/i)
    await expect(localRepository.getTracker(baseline.id)).resolves.toMatchObject({ ruleVersions: baseline.ruleVersions })
    await expect(localRepository.getTrackerEntry(baseline.id, '2026-01-02')).resolves.toMatchObject({ values: { done: true }, note: 'No pages value was saved' })
  })

  it('rejects a newly effective rule referencing a retired measure in local persistence', async () => {
    await activateWorkspace('retired-rule-dependency-owner')
    const baseline: StoredTrackerDefinition = {
      ...tracker, id: 'retired-rule-dependency', schemaVersion: 10, startDate: '2026-01-01',
      scheduling: { mode: 'ongoing' },
      metrics: [
        { id: 'done', name: 'Done', valueType: 'boolean' },
        { id: 'extra', name: 'Extra', valueType: 'boolean' },
      ],
      qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
      streakRuleMode: 'same-as-success',
      ruleVersions: [{ id: 'baseline-retired-rule', effectiveFrom: '2026-01-01', revision: 1, application: 'baseline', recordedAt: '2026-01-01T00:00:00.000Z', evaluation: {
        schedule: { kind: 'every-day' }, startDate: '2026-01-01', deadline: null, scheduling: { mode: 'ongoing' },
        metrics: [
          { id: 'done', name: 'Done', valueType: 'boolean' },
          { id: 'extra', name: 'Extra', valueType: 'boolean' },
        ],
        qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
        streakRuleMode: 'same-as-success', streakRule: null, strictMode: false,
      } }],
    }
    await localRepository.saveTracker(baseline)
    const retired = { ...baseline, metrics: [{ ...baseline.metrics[0]!, retiredAt: '2026-01-03T00:00:00.000Z' }, baseline.metrics[1]!], strictMode: true }
    const versioned = versionTrackerRuleChange({
      before: baseline, after: retired, application: 'apply-from-today', today: '2026-01-03',
      historyStartDate: '2026-01-01', recordedAt: '2026-01-03T00:00:00Z',
    }) as StoredTrackerDefinition

    await expect(localRepository.saveTracker(versioned)).rejects.toThrow(/rule depends on a measure that is no longer available/i)
    await expect(localRepository.getTracker(baseline.id)).resolves.toMatchObject({ metrics: baseline.metrics, ruleVersions: baseline.ruleVersions })
  })

  it('allows a compatible rule-only version to start today when today already has a check-in', async () => {
    await activateWorkspace('rule-edit-with-today-checkin')
    await localRepository.setTimeZone('Asia/Kolkata', 'rule-edit-with-today-checkin')
    const today = calendarDateInTimeZone(new Date(), 'Asia/Kolkata')
    const existing: StoredTrackerDefinition = {
      ...tracker,
      id: 'rule-edit-today-checkin',
      schemaVersion: 9,
      scheduling: { mode: 'ongoing' },
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
      qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
    }
    await localRepository.saveTracker(existing)
    await localRepository.saveTrackerEntry({ trackerId: existing.id, date: today, outcome: 'recorded', values: { done: true }, note: 'Keep this check-in' })
    const versioned = versionTrackerRuleChange({
      before: existing,
      after: { ...existing, strictMode: true },
      application: 'apply-from-today',
      today,
      historyStartDate: '2026-01-01',
      recordedAt: new Date().toISOString(),
    }) as StoredTrackerDefinition
    versioned.schemaVersion = 10

    await expect(localRepository.saveTracker(versioned)).resolves.toMatchObject({ ruleVersions: [{ effectiveFrom: '2026-01-01' }, { effectiveFrom: today, historyPolicy: 'apply-from-today' }] })
    await expect(localRepository.getTrackerEntry(existing.id, today)).resolves.toMatchObject({ values: { done: true }, note: 'Keep this check-in' })
  })

  it('does not save milestone requirement edits on an existing tracker without historical milestone versions', async () => {
    const existing = { ...tracker, milestones: [{ id: 'step', title: 'Step', description: '', position: 0 }] }
    await localRepository.saveTracker(existing)
    await expect(localRepository.saveTracker({ ...existing, milestones: [{ ...existing.milestones[0]!, title: 'Changed requirement' }] }))
      .rejects.toThrow(/milestone requirements cannot be edited because historical milestone results are not versioned/i)
    await expect(localRepository.getTracker(existing.id)).resolves.toMatchObject({ milestones: [{ title: 'Step' }] })
  })

  it('rejects future check-ins against the saved workspace timezone while allowing that timezone’s current day', async () => {
    await activateWorkspace('future-checkin-timezone-owner')
    await localRepository.setTimeZone('Asia/Kolkata', 'future-checkin-timezone-owner')
    const definition = { ...tracker, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }] }
    await localRepository.saveTracker(definition)
    const today = calendarDateInTimeZone(new Date(), 'Asia/Kolkata')
    const nextDate = new Date(`${today}T00:00:00.000Z`)
    nextDate.setUTCDate(nextDate.getUTCDate() + 1)
    const futureDate = nextDate.toISOString().slice(0, 10)

    await expect(localRepository.saveTrackerEntry({ trackerId: definition.id, date: futureDate, outcome: 'recorded', values: { done: true }, note: '' }))
      .rejects.toThrow('You can only record check-ins for today or earlier.')
    await expect(localRepository.saveTrackerEntry({ trackerId: definition.id, date: today, outcome: 'recorded', values: { done: true }, note: '' }))
      .resolves.toMatchObject({ date: today })
  })

  it('keeps archived history readable but prevents check-in edits until unarchived', async () => {
    await activateWorkspace('archive-edit-owner')
    const definition = { ...tracker, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }] }
    await localRepository.saveTracker(definition)
    const entry = await localRepository.saveTrackerEntry({ trackerId: definition.id, date: '2026-10-10', outcome: 'recorded', values: { done: true }, note: 'preserved' })

    await localRepository.archiveTracker(definition.id)

    await expect(localRepository.listTrackers(true)).resolves.toMatchObject([{ status: 'archived' }])
    await expect(localRepository.getTrackerEntry(definition.id, '2026-10-10')).resolves.toMatchObject({ id: entry.id, values: { done: true }, note: 'preserved' })
    await expect(localRepository.saveTrackerEntry({ trackerId: definition.id, date: entry.date, outcome: 'recorded', values: { done: false }, note: 'should not overwrite' })).rejects.toThrow(/not available for check-ins/)
    await expect(db.trackerEntries.get(entry.id)).resolves.toMatchObject({ values: { done: true }, note: 'preserved' })

    await localRepository.unarchiveTracker(definition.id)
    await localRepository.saveTrackerEntry({ trackerId: definition.id, date: entry.date, outcome: 'recorded', values: { done: false }, note: 'edited after restore' })
    await expect(db.trackerEntries.get(entry.id)).resolves.toMatchObject({ id: entry.id, values: { done: false }, note: 'edited after restore' })
  })

  it('keeps retired measure definitions and old values while rejecting type changes to saved IDs', async () => {
    await activateWorkspace('retired-measure-owner')
    const original: StoredTrackerDefinition = { ...tracker, metrics: [
      { id: 'focus', name: 'Focus', valueType: 'quantity', unit: 'minutes' },
      { id: 'done', name: 'Done', valueType: 'boolean' },
    ] }
    await localRepository.saveTracker(original)
    const entry = await localRepository.saveTrackerEntry({ trackerId: original.id, date: '2026-10-10', outcome: 'recorded', values: { focus: 30, done: true }, note: '' })
    const retired = { ...original, metrics: [{ ...original.metrics[0]!, retiredAt: '2026-10-11T00:00:00.000Z' }, original.metrics[1]!] }
    await localRepository.saveTracker(retired)
    await expect(localRepository.listTrackerEntriesForTracker(original.id)).resolves.toMatchObject([{ id: entry.id, values: { focus: 30, done: true } }])
    await expect(localRepository.saveTracker({ ...retired, metrics: [{ ...retired.metrics[0]!, valueType: 'duration' }, retired.metrics[1]!] })).rejects.toThrow(/measure type.*can’t be changed/i)
    await expect(localRepository.saveTracker({ ...retired, metrics: [retired.metrics[1]!] })).rejects.toThrow(/original definition/i)
    const extended = { ...retired, metrics: [...retired.metrics, { id: 'new', name: 'New', valueType: 'quantity' as const }] }
    await expect(localRepository.saveTracker(extended)).resolves.toMatchObject({ metrics: [{ retiredAt: expect.any(String) }, {}, { id: 'new' }] })
  })

  it('rejects changing an existing measure type when no check-in is visible locally', async () => {
    await activateWorkspace('measure-type-without-local-history-owner')
    const original: StoredTrackerDefinition = { ...tracker, metrics: [
      { id: 'hours', name: 'Hours', valueType: 'quantity', unit: 'Hours' },
    ] }
    await localRepository.saveTracker(original)
    const queuedBefore = await db.syncOperations.toArray()

    await expect(localRepository.saveTracker({ ...original, metrics: [{ ...original.metrics[0]!, valueType: 'duration' }] }))
      .rejects.toThrow(/measure type.*can’t be changed for an existing measure/i)

    await expect(localRepository.getTracker(original.id)).resolves.toMatchObject({ metrics: [{ id: 'hours', valueType: 'quantity', unit: 'Hours' }] })
    await expect(db.syncOperations.toArray()).resolves.toEqual(queuedBefore)
  })

  it('preserves custom-field meaning and historical values by blocking definition edits', async () => {
    await activateWorkspace('historical-custom-field-owner')
    const original: StoredTrackerDefinition = { ...tracker,
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
      customFields: [{ id: 'mood', name: 'Mood', type: 'single-select', required: false, position: 0, options: ['Focused', 'Tired'] }],
    }
    await localRepository.saveTracker(original)
    const entry = await localRepository.saveTrackerEntry({ trackerId: original.id, date: '2026-10-10', outcome: 'recorded', values: { done: true, 'field:mood': 'Focused' }, note: 'Before retirement' })

    await expect(localRepository.saveTracker({ ...original, customFields: [{ ...original.customFields[0]!, name: 'Energy' }] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await expect(localRepository.saveTracker({ ...original, customFields: [] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await expect(localRepository.saveTracker({ ...original, customFields: [{ ...original.customFields[0]!, options: ['Calm', 'Tired'] }] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await expect(localRepository.saveTracker({ ...original, customFields: [{ ...original.customFields[0]!, required: true }] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)

    const retired = { ...original, customFields: [{ ...original.customFields[0]!, retiredAt: '2026-10-11T00:00:00.000Z' }] }
    await expect(localRepository.saveTracker(retired)).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await localRepository.saveTrackerEntry({ trackerId: original.id, date: entry.date, outcome: 'recorded', values: { done: false, 'field:mood': 'Focused' }, note: 'Other historical detail edited' })
    await expect(localRepository.getTrackerEntry(original.id, '2026-10-10')).resolves.toMatchObject({ values: { done: false, 'field:mood': 'Focused' }, note: 'Other historical detail edited' })
    await expect(localRepository.saveTrackerEntry({ trackerId: original.id, date: entry.date, outcome: 'recorded', values: { done: false, 'field:mood': 'Tired' }, note: '' })).resolves.toMatchObject({ values: { 'field:mood': 'Tired' } })
    await expect(localRepository.getTracker(original.id)).resolves.toMatchObject({ customFields: [{ id: 'mood', name: 'Mood', options: ['Focused', 'Tired'] }] })
  })

  it('blocks custom-field definition changes when historical availability is not recorded', async () => {
    const today = calendarDateInTimeZone(new Date(), 'UTC')
    const legacy: StoredTrackerDefinition = {
      ...tracker,
      id: 'v10-custom-field-history-boundary',
      schemaVersion: 9,
      schedule: { kind: 'every-day' },
      scheduling: { mode: 'ongoing' },
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
      qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
      customFields: [{ id: 'mood', name: 'Mood', type: 'single-select', required: false, position: 0, options: ['Focused', 'Tired'] }],
    }
    const versioned = versionTrackerRuleChange({
      before: legacy,
      after: legacy,
      application: 'apply-from-today',
      today,
      historyStartDate: '2026-01-01',
      recordedAt: new Date().toISOString(),
    }) as StoredTrackerDefinition
    await localRepository.saveTracker(versioned)

    await expect(localRepository.saveTracker({ ...versioned, customFields: [
      ...versioned.customFields,
      { id: 'energy', name: 'Energy', type: 'text', required: false, position: 1 },
    ] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await expect(localRepository.saveTracker({ ...versioned, customFields: [
      { ...versioned.customFields[0]!, retiredAt: new Date().toISOString() },
    ] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await expect(localRepository.saveTracker({ ...versioned, customFields: [
      { ...versioned.customFields[0]!, options: ['Calm', 'Tired'] },
    ] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await expect(localRepository.saveTracker({ ...versioned, customFields: [
      { ...versioned.customFields[0]!, position: 3 },
    ] })).resolves.toMatchObject({ customFields: [{ id: 'mood', position: 3 }] })
  })

  it('keeps deleted-entry values as historical definitions for edit guards', async () => {
    await activateWorkspace('deleted-entry-definition-owner')
    const definition: StoredTrackerDefinition = { ...tracker,
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
      customFields: [{ id: 'mood', name: 'Mood', type: 'text', required: false, position: 0 }],
    }
    await localRepository.saveTracker(definition)
    const entry = await localRepository.saveTrackerEntry({ trackerId: definition.id, date: '2026-10-10', outcome: 'recorded', values: { done: true, 'field:mood': 'Focused' }, note: '' })
    await localRepository.deleteTrackerEntry(definition.id, '2026-10-10')

    await expect(localRepository.listTrackerHistoricalValueKeys(definition.id)).resolves.toEqual(expect.arrayContaining(['done', 'field:mood']))
    await expect(localRepository.saveTracker({ ...definition, customFields: [{ ...definition.customFields[0]!, name: 'Energy' }] })).rejects.toThrow(/custom-field definitions cannot be edited because their historical availability is not saved/i)
    await expect(db.trackerEntries.get(entry.id)).resolves.toMatchObject({ deletedAt: expect.any(String), values: { 'field:mood': 'Focused' } })
  })

  it('keeps notification preferences and custom messages isolated per account workspace', async () => {
    await activateWorkspace('notification-prefs-a')
    await localRepository.saveNotificationPreferences({ enabled: true, daily_enabled: true, daily_times: ['09:00'], overdue_enabled: false, overdue_times: ['10:00'], remind_partial: false, motivation_mode: 'off', motivation_times: ['18:00'], motivation_weekdays: [1], timezone: 'Asia/Kolkata', quiet_start: null, quiet_end: null, allow_overdue_during_quiet: false, daily_limit: 4, motivation_daily_limit: 1, tracker_ids: null })
    await localRepository.saveCustomMotivationMessage({ id: 'message-a', message: 'Keep going', enabled: true, deleted: false })
    await activateWorkspace('notification-prefs-b')
    await expect(localRepository.getNotificationPreferences()).resolves.toBeUndefined()
    await expect(localRepository.listCustomMotivationMessages()).resolves.toEqual([])
    await activateWorkspace('notification-prefs-a')
    await expect(localRepository.getNotificationPreferences()).resolves.toMatchObject({ enabled: true, timezone: 'Asia/Kolkata' })
    await expect(localRepository.listCustomMotivationMessages()).resolves.toMatchObject([{ id: 'message-a', message: 'Keep going' }])
  })

  it('upserts notification identities and preserves unread state on replacement', async () => {
    await activateWorkspace('notification-owner')
    const original = await localRepository.putAppNotification({ identity: 'daily-reminder:2026-10-10:16:00', kind: 'pending', title: '2 check-ins waiting', body: 'Review today', href: '/' })
    await localRepository.markAppNotificationRead(original.id)
    const replacement = await localRepository.putAppNotification({ identity: original.identity, kind: 'pending', title: '1 check-in waiting', body: 'Updated after progress', href: '/?focus=t1' })
    expect(replacement.id).toBe(original.id)
    expect(replacement.readAt).toEqual(expect.any(String))
    expect(await localRepository.listAppNotifications()).toHaveLength(1)
    await localRepository.markAllAppNotificationsRead()
    expect(await localRepository.listAppNotifications()).toMatchObject([{ readAt: expect.any(String) }])
    await activateWorkspace('notification-owner-b')
    await expect(localRepository.listAppNotifications()).resolves.toEqual([])
  })

  it('restores an archived tracker and queues the active state for synchronization', async () => {
    await activateWorkspace('archive-owner')
    await localRepository.saveTracker({ ...tracker, status: 'archived', archivedAt: '2026-10-01T12:00:00.000Z' })

    await expect(localRepository.unarchiveTracker(tracker.id)).resolves.toMatchObject({ status: 'active', archivedAt: null })
    await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ status: 'active', archivedAt: null })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['archive-owner', 'tracker', tracker.id]).first()).resolves.toMatchObject({ payload: { status: 'active', archivedAt: null } })
  })

  it('keeps account holidays isolated and atomically queues upsert, removal, and restoration', async () => {
    await activateWorkspace('holiday-account-a')
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-10', '2026-10-11'], 'travel')
    expect(holiday).toMatchObject({ date: '2026-10-10', reason: 'travel', deletedAt: null })
    expect(await db.accountHolidays.count()).toBe(2)
    expect(await db.syncOperations.where('ownerUserId').equals('holiday-account-a').count()).toBe(2)
    await localRepository.removeAccountHoliday('2026-10-10')
    await expect(db.accountHolidays.get(holiday!.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['holiday-account-a', 'account_holiday', holiday!.id]).first()).resolves.toMatchObject({ payload: { deletedAt: expect.any(String) } })
    await localRepository.restoreAccountHoliday('2026-10-10')
    await expect(db.accountHolidays.get(holiday!.id)).resolves.toMatchObject({ deletedAt: null, reason: 'travel' })
    await activateWorkspace('holiday-account-b')
    await expect(localRepository.listAccountHolidays()).resolves.toEqual([])
  })

  it('edits an account holiday date and reason in place and queues one revisioned sync mutation', async () => {
    await activateWorkspace('holiday-edit-owner')
    await localRepository.saveTracker(plannedGoal)
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-10'], 'travel')
    if (!holiday) throw new Error('Holiday was not saved.')
    const work = await localRepository.saveTrackerEntry({ trackerId: plannedGoal.id, date: '2026-10-10', outcome: 'recorded', values: { pages: 8 }, note: 'historical work' })
    await db.syncRecords.put({ key: `account_holiday:${holiday.id}`, ownerUserId: 'holiday-edit-owner', entity: 'account_holiday', entityId: holiday.id, serverRevision: 3 })

    const updated = await localRepository.updateAccountHoliday(holiday.id, '2026-10-12', 'exam')

    expect(updated).toMatchObject({ id: holiday.id, date: '2026-10-12', reason: 'exam', deletedAt: null })
    await expect(db.accountHolidays.count()).resolves.toBe(1)
    await expect(db.accountHolidays.get(holiday.id)).resolves.toMatchObject({ id: holiday.id, date: '2026-10-12', reason: 'exam' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['holiday-edit-owner', 'account_holiday', holiday.id]).first()).resolves.toMatchObject({ expectedRevision: 3, payload: { id: holiday.id, date: '2026-10-12', reason: 'exam' } })
    await expect(localRepository.getTrackerEntry(plannedGoal.id, '2026-10-10')).resolves.toEqual(work)
  })

  it('converts a historical global holiday to selected scope atomically while preserving its check-in', async () => {
    await activateWorkspace('holiday-scope-owner')
    await localRepository.saveTracker({ ...plannedGoal, id: 'holiday-scope-tracker' })
    const [global] = await localRepository.saveAccountHolidays(['2026-10-10'], 'travel')
    if (!global) throw new Error('Holiday was not saved.')
    const work = await localRepository.saveTrackerEntry({ trackerId: 'holiday-scope-tracker', date: '2026-10-10', outcome: 'recorded', values: { pages: 8 }, note: 'kept' })

    await localRepository.convertHolidayScope({ source: { scope: 'global', id: global.id }, date: global.date, scope: 'selected', reason: global.reason, trackerIds: ['holiday-scope-tracker'] })

    await expect(db.accountHolidays.get(global.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(localRepository.listTrackerHolidays()).resolves.toEqual([expect.objectContaining({ trackerId: 'holiday-scope-tracker', date: global.date, deletedAt: null })])
    await expect(localRepository.getTrackerEntry('holiday-scope-tracker', global.date)).resolves.toEqual(work)
    const scopedOperations = (await db.syncOperations.where('ownerUserId').equals('holiday-scope-owner').toArray()).filter((operation) => operation.entity === 'account_holiday' || operation.entity === 'tracker_holiday')
    expect(scopedOperations.map((operation) => operation.holidayScopeConversion?.role).sort()).toEqual(['source', 'target'])
    expect(new Set(scopedOperations.map((operation) => operation.holidayScopeConversion?.id)).size).toBe(1)
  })

  it('converts a historical selected holiday to global scope without changing recorded work', async () => {
    await activateWorkspace('holiday-scope-owner')
    await localRepository.saveTracker({ ...plannedGoal, id: 'holiday-scope-tracker' })
    const selected = await localRepository.saveTrackerHoliday('holiday-scope-tracker', '2026-10-10')
    const work = await localRepository.saveTrackerEntry({ trackerId: 'holiday-scope-tracker', date: selected.date, outcome: 'recorded', values: { pages: 8 }, note: 'kept' })

    await localRepository.convertHolidayScope({ source: { scope: 'selected', date: selected.date }, date: selected.date, scope: 'global', reason: 'travel', trackerIds: [] })

    await expect(db.trackerHolidays.get(selected.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(localRepository.listAccountHolidays()).resolves.toEqual([expect.objectContaining({ date: selected.date, reason: 'travel', deletedAt: null })])
    await expect(localRepository.getTrackerEntry('holiday-scope-tracker', selected.date)).resolves.toEqual(work)
    const scopedOperations = (await db.syncOperations.where('ownerUserId').equals('holiday-scope-owner').toArray()).filter((operation) => operation.entity === 'account_holiday' || operation.entity === 'tracker_holiday')
    expect(scopedOperations.map((operation) => operation.holidayScopeConversion?.role).sort()).toEqual(['source', 'target'])
    expect(new Set(scopedOperations.map((operation) => operation.holidayScopeConversion?.id)).size).toBe(1)
  })

  it('rejects an occupied holiday date without changing the source holiday', async () => {
    await activateWorkspace('holiday-duplicate-owner')
    const [first, second] = await localRepository.saveAccountHolidays(['2026-10-10', '2026-10-11'], 'travel')
    if (!first || !second) throw new Error('Holidays were not saved.')
    await expect(localRepository.updateAccountHoliday(first.id, second.date, 'exam')).rejects.toThrow('A holiday record already exists on that date.')
    await expect(db.accountHolidays.get(first.id)).resolves.toMatchObject({ date: first.date, reason: 'travel' })
  })

  it('queues account holiday permanent deletion idempotently and keeps the tombstone until server confirmation', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    await activateWorkspace('holiday-delete-owner')
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-14'], 'exam')
    if (!holiday) throw new Error('Holiday was not saved.')
    await localRepository.removeAccountHoliday(holiday.date)

    await expect(localRepository.requestPermanentHolidayDeletion(holiday.date)).resolves.toBe('queued')
    await expect(localRepository.requestPermanentHolidayDeletion(holiday.date)).resolves.toBe('queued')
    await expect(db.accountHolidays.get(holiday.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })
    await expect(db.holidayPermanentDeletionRequests.where('[ownerUserId+holidayId]').equals(['holiday-delete-owner', holiday.id]).count()).resolves.toBe(1)
    await activateWorkspace('holiday-delete-other-owner')
    await expect(localRepository.listPermanentHolidayDeletionRequests('holiday-delete-other-owner')).resolves.toEqual([])
  })

  it('permanently removes a guest holiday only after the local action is explicitly requested', async () => {
    vi.stubEnv('VITE_ENABLE_HOLIDAY_PERMANENT_DELETION', 'true')
    await activateWorkspace(null)
    const [holiday] = await localRepository.saveAccountHolidays(['2026-10-15'], null)
    if (!holiday) throw new Error('Holiday was not saved.')
    await localRepository.removeAccountHoliday(holiday.date)
    await expect(db.accountHolidays.get(holiday.id)).resolves.toMatchObject({ deletedAt: expect.any(String) })

    await expect(localRepository.requestPermanentHolidayDeletion(holiday.date)).resolves.toBe('deleted')
    await expect(db.accountHolidays.get(holiday.id)).resolves.toBeUndefined()
  })

  it('persists version 2 planning configuration unchanged in IndexedDB and its account outbox', async () => {
    await activateWorkspace('planning-account')
    await localRepository.saveTracker(plannedGoal)

    await expect(db.trackers.get(plannedGoal.id)).resolves.toMatchObject({
      schemaVersion: 2,
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { pages: 'incremental' }, dailyTargets: { pages: 3 }, cumulativeTargets: { pages: 100 } },
      metrics: [{ thresholds: { minimum: 2, target: 5, stretch: 8 } }],
    })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['planning-account', 'tracker', plannedGoal.id]).first()).resolves.toMatchObject({
      payload: { schemaVersion: 2, goalPlanning: { cumulativeTargets: { pages: 100 } } },
    })
  })

  it('atomically persists v3 allocations, timezone, and the matching sync outbox payload', async () => {
    await activateWorkspace('planning-v3-account')
    const v3: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 3,
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'Asia/Kolkata', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await localRepository.saveTracker(v3)
    await expect(db.trackers.get(v3.id)).resolves.toMatchObject({ schemaVersion: 3, goalPlanning: v3.goalPlanning })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['planning-v3-account', 'tracker', v3.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 3, goalPlanning: v3.goalPlanning } })
  })

  it('persists only manual v5 dates alongside a conflict-safe tracker sync payload', async () => {
    await activateWorkspace('planning-v5-account')
    const v5: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 5,
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'Asia/Kolkata', allocations: {}, manualAllocations: { pages: { '2026-10-09': 30 } } },
    }
    await localRepository.saveTracker(v5)
    await expect(db.trackers.get(v5.id)).resolves.toMatchObject({ schemaVersion: 5, goalPlanning: { manualAllocations: { pages: { '2026-10-09': 30 } } } })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['planning-v5-account', 'tracker', v5.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 5, goalPlanning: { allocations: {}, manualAllocations: { pages: { '2026-10-09': 30 } } } } })
  })

  it('round-trips v6 scheduling and resolves its deadline again whenever holidays change', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', 'true')
    await activateWorkspace('scheduling-v6-account')
    const effective: StoredTrackerDefinition = {
      ...tracker, id: 'effective-habit', schemaVersion: 6, startDate: '2026-11-01', schedule: { kind: 'weekdays' }, deadline: '2026-11-30',
      scheduling: { mode: 'effective', effectiveDays: 30, planningTimeZone: 'UTC' },
    }
    await localRepository.saveTracker(effective)
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ schemaVersion: 6, scheduling: effective.scheduling, deadline: '2026-11-30' })
    await localRepository.saveAccountHolidays(['2026-11-08', '2026-11-15'], null)
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ deadline: '2026-12-02' })
    await localRepository.removeAccountHoliday('2026-11-08')
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ deadline: '2026-12-01' })
    await localRepository.removeAccountHoliday('2026-11-15')
    expect(await localRepository.listTrackers()).toMatchObject([{ id: effective.id, deadline: '2026-11-30', scheduling: effective.scheduling }])
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['scheduling-v6-account', 'tracker', effective.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 6, scheduling: effective.scheduling } })
  })

  it('round-trips v7 counting settings locally and recalculates planned-day deadlines on holiday changes', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', 'true')
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', 'true')
    await activateWorkspace('scheduling-v7-account')
    const effective: StoredTrackerDefinition = {
      ...tracker, id: 'planned-effective-habit', schemaVersion: 7, startDate: '2026-11-01', schedule: { kind: 'weekdays' }, deadline: '2026-12-11',
      scheduling: { mode: 'effective', effectiveDays: 30, effectiveDayCounting: 'planned-activity-days', planningTimeZone: 'UTC' },
    }
    await localRepository.saveTracker(effective)
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ schemaVersion: 7, scheduling: effective.scheduling, deadline: '2026-12-11' })
    await localRepository.saveAccountHolidays(['2026-11-02'], null)
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ deadline: '2026-12-14', scheduling: { effectiveDayCounting: 'planned-activity-days' } })
    await localRepository.removeAccountHoliday('2026-11-02')
    expect(await localRepository.getTracker(effective.id)).toMatchObject({ deadline: '2026-12-11' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['scheduling-v7-account', 'tracker', effective.id]).first()).resolves.toMatchObject({ payload: { schemaVersion: 7, scheduling: effective.scheduling } })
  })

  it('does not queue schema v6 trackers in production while the readiness flag is off', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', '')
    await activateWorkspace('scheduling-v6-disabled-account')
    const effective: StoredTrackerDefinition = {
      ...tracker, id: 'disabled-effective-habit', schemaVersion: 6, startDate: '2026-10-12', deadline: '2026-10-14',
      scheduling: { mode: 'effective', effectiveDays: 3, planningTimeZone: 'UTC' },
    }
    await expect(queueSyncMutation(db, 'scheduling-v6-disabled-account', 'tracker', effective)).rejects.toThrow(/Schema v6 scheduling local and cloud writes are disabled/)
    await expect(db.syncOperations.count()).resolves.toBe(0)
  })

  it('blocks local v3 persistence in production when migration readiness is not enabled', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V3', '')
    await activateWorkspace(null)
    const v3: StoredTrackerDefinition = {
      ...plannedGoal, schemaVersion: 3,
      goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: { '2026-10-09': 4 } } },
    }
    await expect(localRepository.saveTracker(v3)).rejects.toThrow(/disabled until the hosted migration/)
    await expect(db.trackers.get(v3.id)).resolves.toBeUndefined()
    await expect(db.syncOperations.count()).resolves.toBe(0)
  })

  it('preserves a tracker conflict instead of silently replacing its pending operation with a plan edit', async () => {
    await activateWorkspace('planning-conflict-account')
    await localRepository.saveTracker(plannedGoal)
    const operation = await db.syncOperations.where('ownerUserId').equals('planning-conflict-account').first()
    await db.syncConflicts.put({ id: operation!.id, ownerUserId: 'planning-conflict-account', entity: 'tracker', entityId: plannedGoal.id, localPayload: plannedGoal, remoteRecord: null, detectedAt: new Date().toISOString() })
    const v3 = { ...plannedGoal, schemaVersion: 3 as const, goalPlanning: { ...plannedGoal.goalPlanning!, planningTimeZone: 'UTC', allocations: { pages: { '2026-10-09': 2 } } } }
    await expect(localRepository.saveTracker(v3)).rejects.toThrow(/Resolve this tracker’s cloud conflict/)
    await expect(db.trackers.get(plannedGoal.id)).resolves.toMatchObject({ schemaVersion: 2 })
    await expect(db.syncConflicts.get(operation!.id)).resolves.toBeDefined()
  })

  it('publishes an account owner only after its local record and outbox transaction commits', async () => {
    await activateWorkspace('mutation-account')
    const owners: Array<string | null> = []
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => owners.push(ownerId))
    try {
      await localRepository.saveTracker(tracker)
      expect(owners).toEqual(['mutation-account'])
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: tracker.name })
      await expect(db.syncOperations.where('ownerUserId').equals('mutation-account').count()).resolves.toBe(1)
    } finally {
      unsubscribe()
    }
  })

  it('publishes guest workspace edits for local views without treating them as account sync', async () => {
    await activateWorkspace(null)
    const owners: Array<string | null> = []
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => owners.push(ownerId))
    try {
      await localRepository.saveTracker(tracker)
      expect(owners).toEqual([null])
      await expect(db.trackers.get(tracker.id)).resolves.toMatchObject({ name: tracker.name })
    } finally {
      unsubscribe()
    }
  })

  it('publishes check-in and tombstone edits for the account that owns the workspace', async () => {
    await activateWorkspace('entry-owner')
    await localRepository.saveTracker(tracker)
    const owners: Array<string | null> = []
    const unsubscribe = subscribeToWorkspaceMutations((ownerId) => owners.push(ownerId))
    try {
      await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-09', outcome: 'skipped', values: {}, note: 'rest day' })
      await localRepository.deleteTrackerEntry(tracker.id, '2026-10-09')
      expect(owners).toEqual(['entry-owner', 'entry-owner'])
      await expect(db.trackerEntries.where('[trackerId+date]').equals([tracker.id, '2026-10-09']).first()).resolves.toMatchObject({ deletedAt: expect.any(String) })
      await expect(db.syncOperations.where('ownerUserId').equals('entry-owner').count()).resolves.toBe(2)
    } finally {
      unsubscribe()
    }
  })

  it('revives a cleared date when the user records it again without creating a duplicate row', async () => {
    await localRepository.saveTracker(tracker)
    const first = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-09', outcome: 'recorded', values: {}, note: 'first' })
    await localRepository.deleteTrackerEntry(tracker.id, '2026-10-09')
    await expect(localRepository.getTrackerEntry(tracker.id, '2026-10-09')).resolves.toBeUndefined()
    const second = await localRepository.saveTrackerEntry({ trackerId: tracker.id, date: '2026-10-09', outcome: 'recorded', values: {}, note: 'corrected' })
    expect(second).toMatchObject({ id: first.id, deletedAt: null, note: 'corrected' })
    await expect(db.trackerEntries.where('[trackerId+date]').equals([tracker.id, '2026-10-09']).count()).resolves.toBe(1)
  })
})

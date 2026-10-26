import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus } from './activityStatus'
import { versionTrackerRuleChange } from './ruleVersions'
import { localCalendarDate } from '../../features/shared/localDates'
import tokens from '../../styles/tokens.css?raw'
import styles from '../../styles.css?raw'

const baseTracker: TrackerDefinition = {
  schemaVersion: 1, id: 'status-tracker', name: 'Study', description: '', kind: 'habit', status: 'active',
  categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' },
  metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
  qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
  customFields: [], milestones: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', archivedAt: null, deletedAt: null,
}
const entry = (date: string, done: boolean, deletedAt: string | null = null): TrackerEntry => ({
  id: `entry-${date}`, trackerId: baseTracker.id, date, outcome: 'recorded', values: { done }, note: '',
  createdAt: `${date}T09:00:00Z`, updatedAt: `${date}T09:00:00Z`, deletedAt,
})
const skipped = (date: string): TrackerEntry => ({ ...entry(date, false), outcome: 'skipped', values: {} })
const state = (date: string, overrides: Partial<TrackerDefinition> = {}, saved?: TrackerEntry, holidays?: string[], today = '2026-10-10', trackerHolidays?: string[]) => getTrackerActivityStatus({
  tracker: { ...baseTracker, ...overrides }, entry: saved, date, today, holidays: new Set(holidays), trackerHolidays: new Set(trackerHolidays),
})
function contrast(hexA: string, hexB: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((channel) => parseInt(channel, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  }
  const [lighter, darker] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

describe('shared activity status rules', () => {
  it('uses explicit activity precedence without changing recorded history', () => {
    expect(state('2026-10-10')).toBe('pending')
    expect(state('2026-10-12')).toBe('upcoming')
    expect(state('2026-10-09')).toBe('missed')
    expect(state('2026-10-09', {}, entry('2026-10-09', true))).toBe('completed')
    expect(state('2026-10-09', {}, entry('2026-10-09', false))).toBe('no-progress')
    expect(state('2026-10-10', {}, skipped('2026-10-10'))).toBe('skipped')
    expect(state('2026-10-09', {}, skipped('2026-10-09'))).toBe('skipped')
    expect(state('2026-10-09', {}, entry('2026-10-09', true), ['2026-10-09'])).toBe('completed')
    expect(state('2026-10-10', {}, entry('2026-10-10', false))).toBe('no-progress')
  })

  it('keeps rest and inactive dates neutral while retaining saved historical outcomes', () => {
    expect(state('2026-10-10', { schedule: { kind: 'none' } })).toBe('rest-day')
    expect(state('2026-10-09', { status: 'paused' })).toBe('inactive')
    expect(state('2026-10-09', { schedule: { kind: 'none' } }, skipped('2026-10-09'))).toBe('skipped')
    expect(state('2026-10-09', { schedule: { kind: 'none' } }, entry('2026-10-09', true))).toBe('completed')
    expect(state('2026-10-09', { status: 'archived' }, entry('2026-10-09', true))).toBe('completed')
    expect(state('2026-10-09', {}, entry('2026-10-09', true, '2026-10-11T00:00:00Z'))).toBe('missed')
  })

  it('requires Strict Mode holidays and rest days while Standard Mode holidays and rest days stay neutral', () => {
    const strict = { strictMode: true }
    expect(state('2026-10-09', {}, undefined, ['2026-10-09'])).toBe('holiday')
    expect(state('2026-10-09', strict, undefined, ['2026-10-09'])).toBe('missed')
    expect(state('2026-10-10', strict, undefined, ['2026-10-10'])).toBe('pending')
    expect(state('2026-10-09', { ...strict, schedule: { kind: 'none' } })).toBe('missed')
    expect(state('2026-10-12', strict)).toBe('upcoming')
    expect(state('2026-10-10', { ...strict, schedule: { kind: 'none' } })).toBe('pending')
    expect(state('2026-10-09', { schedule: { kind: 'none' } })).toBe('rest-day')
    expect(state('2026-10-09', strict, undefined, undefined, '2026-10-10', ['2026-10-09'])).toBe('missed')
  })

  it('keeps a Standard holiday until positive work is recorded, then shows the actual outcome', () => {
    const holiday = ['2026-10-09']
    expect(state('2026-10-09', {}, undefined, holiday)).toBe('holiday')
    expect(state('2026-10-09', {}, entry('2026-10-09', false), holiday)).toBe('holiday')
    expect(state('2026-10-09', {}, skipped('2026-10-09'), holiday)).toBe('holiday')
    expect(state('2026-10-09', {}, entry('2026-10-09', true), holiday)).toBe('completed')
    const quantitative = { metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const, thresholds: { direction: 'increase' as const, minimum: 2, target: 5, streakQualification: 'minimum' as const } }], qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const } }
    const positivePartial = { ...entry('2026-10-09', false), values: { pages: 1 } }
    expect(state('2026-10-09', quantitative, positivePartial, holiday)).toBe('partial')
    expect(state('2026-10-09', { strictMode: true }, undefined, holiday)).toBe('missed')
  })

  it('honors explicit holiday treatment over the amount of recorded progress', () => {
    const holiday = ['2026-10-09']
    expect(state('2026-10-09', {}, { ...entry('2026-10-09', true), holidayTreatment: 'keep-holiday' }, holiday)).toBe('holiday')
    expect(state('2026-10-09', {}, { ...entry('2026-10-09', false), holidayTreatment: 'keep-holiday' }, holiday)).toBe('holiday')
    expect(state('2026-10-09', {}, { ...entry('2026-10-09', true), holidayTreatment: 'count-normal' }, holiday)).toBe('completed')
    expect(state('2026-10-09', {}, { ...entry('2026-10-09', false), holidayTreatment: 'count-normal' }, holiday)).toBe('no-progress')
    expect(state('2026-10-09', {}, { ...entry('2026-10-09', true), holidayTreatment: 'keep-holiday' })).toBe('completed')
    expect(state('2026-10-09', { strictMode: true }, { ...entry('2026-10-09', true), holidayTreatment: 'keep-holiday' }, holiday)).toBe('completed')
  })

  it('distinguishes positive partial progress from zero while honoring explicit success rules', () => {
    const quantityTracker = {
      ...baseTracker,
      metrics: [{ id: 'sessions', name: 'Sessions', valueType: 'quantity' as const, thresholds: { direction: 'increase' as const, target: 3, streakQualification: 'target' as const } }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'sessions', level: 'target' as const },
    }
    const quantityEntry = (value: number): TrackerEntry => ({ ...entry('2026-10-09', true), values: { sessions: value } })
    expect(state('2026-10-09', quantityTracker, quantityEntry(0))).toBe('no-progress')
    expect(state('2026-10-09', quantityTracker, quantityEntry(2))).toBe('partial')
    expect(state('2026-10-09', quantityTracker, quantityEntry(3))).toBe('completed')
    const explicitZeroRule = { ...quantityTracker, qualificationRule: { kind: 'threshold' as const, metricId: 'sessions', level: 'minimum' as const }, metrics: [{ ...quantityTracker.metrics[0]!, thresholds: { direction: 'decrease' as const, minimum: 0, streakQualification: 'minimum' as const } }] }
    expect(state('2026-10-09', explicitZeroRule, quantityEntry(0))).toBe('completed')
  })

  it('classifies an older entry with the date-effective measure after that measure is retired', () => {
    const before: TrackerDefinition = {
      ...baseTracker,
      schemaVersion: 9,
      metrics: [{ id: 'hours', name: 'Progress', valueType: 'quantity', unit: 'Hours', thresholds: { direction: 'increase', target: 3, streakQualification: 'target' } }],
      qualificationRule: { kind: 'threshold', metricId: 'hours', level: 'target' },
      startDate: '2026-10-01',
    }
    const after: TrackerDefinition = {
      ...before,
      schemaVersion: 10,
      metrics: [
        { id: 'hours', name: 'Progress', valueType: 'quantity', unit: 'Hours', retiredAt: '2026-10-10', thresholds: { direction: 'increase', target: 3, streakQualification: 'target' } },
        { id: 'sessions', name: 'Sessions', valueType: 'quantity', thresholds: { direction: 'increase', target: 1, streakQualification: 'target' } },
      ],
      qualificationRule: { kind: 'threshold', metricId: 'sessions', level: 'target' },
    }
    const versioned = versionTrackerRuleChange({
      before,
      after,
      application: 'apply-from-today',
      today: '2026-10-10',
      historyStartDate: '2026-10-01',
      recordedAt: '2026-10-10T12:00:00Z',
    })
    const saved: TrackerEntry = { ...entry('2026-10-09', true), values: { hours: 2 } }

    expect(state('2026-10-09', versioned, saved, undefined, '2026-10-10')).toBe('partial')
    expect(saved.values).toEqual({ hours: 2 })
  })

  it('marks saved records outside the inclusive start/deadline window as historical', () => {
    expect(state('2026-10-09', { startDate: '2026-10-10' }, entry('2026-10-09', true))).toBe('historical')
    expect(state('2026-10-09', { startDate: '2026-10-08' }, entry('2026-10-09', true))).toBe('completed')
    expect(state('2026-10-11', { deadline: '2026-10-10' }, entry('2026-10-11', true))).toBe('historical')
    expect(state('2026-10-09', { startDate: '2026-10-10' })).toBe('outside-period')
    const bounded = { startDate: '2026-10-08', deadline: '2026-10-10' }
    expect(state('2026-10-07', bounded)).toBe('outside-period')
    expect(state('2026-10-08', bounded)).toBe('missed')
    expect(state('2026-10-10', bounded)).toBe('pending')
    expect(state('2026-10-11', bounded)).toBe('outside-period')
  })

  it('stops applying holidays after archival while retaining saved records as historical', () => {
    const archived = { status: 'archived' as const, archivedAt: '2026-10-10T12:00:00.000Z' }
    expect(state('2026-10-11', archived, undefined, ['2026-10-11'])).toBe('inactive')
    expect(state('2026-10-11', archived, entry('2026-10-11', true), ['2026-10-11'])).toBe('historical')
  })

  it('classifies today, future, and elapsed opportunities across month and year boundaries', () => {
    expect(state('2026-12-31', {}, undefined, undefined, '2027-01-01')).toBe('missed')
    expect(state('2027-01-01', {}, undefined, undefined, '2026-12-31')).toBe('upcoming')
    expect(state('2027-01-01', {}, entry('2027-01-01', false), undefined, '2026-12-31')).toBe('no-progress')
    expect(state('2027-01-01', {}, undefined, ['2027-01-01'], '2026-12-31')).toBe('holiday')
    expect(state('2027-01-01', { schedule: { kind: 'none' } }, undefined, undefined, '2026-12-31')).toBe('rest-day')
  })

  it('keeps schedule, period, holiday, entry outcome, and lifecycle facts distinct', () => {
    const rest = { schedule: { kind: 'none' } } as const
    const strict = { strictMode: true }
    expect(state('2026-10-08', { createdAt: '2026-10-10T00:00:00Z' })).toBe('outside-period')
    expect(state('2026-10-11', { deadline: '2026-10-10' })).toBe('outside-period')
    expect(state('2026-10-10', rest)).toBe('rest-day')
    expect(state('2026-10-10', rest, entry('2026-10-10', true))).toBe('completed')
    expect(state('2026-10-10', rest, skipped('2026-10-10'))).toBe('skipped')
    expect(state('2026-10-09', { ...strict, ...rest })).toBe('missed')
    expect(state('2026-10-09', strict, undefined, ['2026-10-09'])).toBe('missed')
    expect(state('2026-10-09', strict, entry('2026-10-09', true), ['2026-10-09'])).toBe('completed')
    expect(state('2026-10-09', strict, skipped('2026-10-09'), ['2026-10-09'])).toBe('skipped')
    expect(state('2026-10-10', {}, undefined, ['2026-10-10'])).toBe('holiday')
    expect(state('2026-10-08', { startDate: '2026-10-10' }, undefined, ['2026-10-08'])).toBe('outside-period')
    expect(state('2026-10-12', {}, entry('2026-10-12', false))).toBe('no-progress')
    expect(state('2026-10-09', { status: 'archived' })).toBe('inactive')
    expect(state('2026-10-09', {}, entry('2026-10-09', true, '2026-10-11T00:00:00Z'))).toBe('missed')
  })

  it('uses workspace-local dates across timezone and daylight-saving boundaries', () => {
    const lateUtc = new Date('2026-10-09T23:30:00.000Z')
    const tokyoToday = localCalendarDate(lateUtc, 'Asia/Tokyo')
    expect(tokyoToday).toBe('2026-10-10')
    expect(state('2026-10-10', {}, undefined, undefined, tokyoToday)).toBe('pending')
    expect(state('2026-10-09', {}, undefined, undefined, tokyoToday)).toBe('missed')

    const beforeSpringForward = localCalendarDate(new Date('2026-03-08T04:30:00.000Z'), 'America/New_York')
    const afterSpringForward = localCalendarDate(new Date('2026-03-08T07:30:00.000Z'), 'America/New_York')
    expect(beforeSpringForward).toBe('2026-03-07')
    expect(afterSpringForward).toBe('2026-03-08')
    const yearStart = { createdAt: '2026-01-01T00:00:00.000Z' }
    expect(state('2026-03-08', yearStart, undefined, undefined, beforeSpringForward)).toBe('upcoming')
    expect(state('2026-03-08', yearStart, undefined, undefined, afterSpringForward)).toBe('pending')
  })

  it('centralizes the required semantic labels, icons, hues, and light/dark token values', () => {
    expect(Object.fromEntries(Object.entries(ACTIVITY_STATUS_PRESENTATION).map(([key, value]) => [key, value.label]))).toMatchObject({
      pending: 'Pending', upcoming: 'Upcoming', completed: 'Completed', partial: 'Partial', 'no-progress': 'No progress', historical: 'Historical entry', 'outside-period': 'Outside period', missed: 'Missed', skipped: 'Skipped', holiday: 'Holiday', 'rest-day': 'Rest day', inactive: 'Tracker inactive', 'no-trackers': 'No active trackers', unscheduled: 'Rest day',
    })
    expect(ACTIVITY_STATUS_PRESENTATION.pending.colorToken).toBe('--status-pending')
    expect(ACTIVITY_STATUS_PRESENTATION.completed.colorToken).toBe('--status-completed')
    expect(ACTIVITY_STATUS_PRESENTATION.partial.colorToken).toBe('--status-partial')
    expect(ACTIVITY_STATUS_PRESENTATION.holiday.colorToken).toBe('--status-holiday')
    expect(ACTIVITY_STATUS_PRESENTATION.missed.colorToken).toBe('--status-missed')
    const lightTokenBlock = tokens.split("[data-theme='dark']")[0]!
    const darkTokenBlock = tokens.split("[data-theme='dark']")[1]!
    const expected = {
      pending: { light: ['#555b65', '#f3f4f6', '#e5e7eb'], dark: ['#a1a1aa', '#27272a', '#3f3f46'] },
      completed: { light: ['#1e6539', '#e8f8ed', '#bce6c9'], dark: ['#b7e5c4', '#3c5544', '#53705a'] },
      partial: { light: ['#80500c', '#fff5de', '#f2ddaf'], dark: ['#eed6ab', '#594c37', '#756347'] },
      missed: { light: ['#9f3039', '#fff0f1', '#f4c8cc'], dark: ['#efb9b9', '#5b3f43', '#775359'] },
      holiday: { light: ['#7952b3', '#f5efff', '#dfcef5'], dark: ['#d7c4ee', '#51435f', '#6c5980'] },
      rest: { light: ['#4e67b8', '#eef2ff', '#cdd7fa'], dark: ['#c4d0f1', '#404c67', '#576787'] },
    } as const
    for (const [status, palettes] of Object.entries(expected)) {
      for (const [theme, block] of [['light', lightTokenBlock], ['dark', darkTokenBlock]] as const) {
        const [foreground, surface, border] = palettes[theme]
        expect(block).toContain(`--status-${status}: ${foreground}`)
        expect(block).toContain(`--status-${status}-ink: ${foreground}`)
        expect(block).toContain(`--status-${status}-surface: ${surface}`)
        expect(block).toContain(`--status-${status}-border: ${border}`)
        expect(contrast(surface, foreground)).toBeGreaterThanOrEqual(3)
        if (theme === 'light') expect(contrast(surface, foreground), `${status} light normal text`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // All six status hues retain at least 3:1 contrast; light normal text uses the stricter WCAG AA threshold.
    expect(tokens).toContain('--status-neutral-surface: #f5f5f4')
    expect(tokens).toContain('--status-rest-surface: #eef2ff')
    expect(styles).toMatch(/\.status-pending\s*\{[^}]*--status-bg:\s*var\(--status-pending-surface\)[^}]*--status-stroke:\s*var\(--status-pending-border\)/s)
    expect(styles).toMatch(/\.week-rhythm-day\.holiday\s*\{[^}]*var\(--status-holiday-surface\)/s)
    expect(styles).toMatch(/\.week-rhythm-day\.rest\s*\{[^}]*var\(--status-rest-surface\)/s)
    expect(styles).toMatch(/\.calendar-legend\s*\{[^}]*display:\s*grid/s)
    expect(styles).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.calendar-legend\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
  })
})

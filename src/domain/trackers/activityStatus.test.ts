import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus } from './activityStatus'
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
const state = (date: string, overrides: Partial<TrackerDefinition> = {}, saved?: TrackerEntry, holidays?: string[], today = '2026-10-10') => getTrackerActivityStatus({
  tracker: { ...baseTracker, ...overrides }, entry: saved, date, today, holidays: new Set(holidays),
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
    expect(state('2026-10-12')).toBe('pending')
    expect(state('2026-10-09')).toBe('missed')
    expect(state('2026-10-09', {}, entry('2026-10-09', true))).toBe('completed')
    expect(state('2026-10-09', {}, entry('2026-10-09', false))).toBe('partial')
    expect(state('2026-10-10', {}, skipped('2026-10-10'))).toBe('missed')
    expect(state('2026-10-09', {}, skipped('2026-10-09'))).toBe('missed')
    expect(state('2026-10-09', {}, entry('2026-10-09', true), ['2026-10-09'])).toBe('holiday')
    expect(state('2026-10-10', {}, entry('2026-10-10', false))).toBe('pending')
  })

  it('keeps rest and inactive dates neutral while retaining saved historical outcomes', () => {
    expect(state('2026-10-10', { schedule: { kind: 'none' } })).toBe('unscheduled')
    expect(state('2026-10-09', { status: 'paused' })).toBe('unscheduled')
    expect(state('2026-10-09', { schedule: { kind: 'none' } }, skipped('2026-10-09'))).toBe('unscheduled')
    expect(state('2026-10-09', { status: 'archived' }, entry('2026-10-09', true))).toBe('completed')
    expect(state('2026-10-09', {}, entry('2026-10-09', true, '2026-10-11T00:00:00Z'))).toBe('missed')
  })

  it('keeps future dates pending and elapsed dates missed across month and year boundaries', () => {
    expect(state('2026-12-31', {}, undefined, undefined, '2027-01-01')).toBe('missed')
    expect(state('2027-01-01', {}, undefined, undefined, '2026-12-31')).toBe('pending')
    expect(state('2027-01-01', {}, entry('2027-01-01', false), undefined, '2026-12-31')).toBe('partial')
    expect(state('2027-01-01', {}, undefined, ['2027-01-01'], '2026-12-31')).toBe('holiday')
    expect(state('2027-01-01', { schedule: { kind: 'none' } }, undefined, undefined, '2026-12-31')).toBe('unscheduled')
  })

  it('centralizes the required semantic labels, icons, hues, and light/dark token values', () => {
    expect(Object.fromEntries(Object.entries(ACTIVITY_STATUS_PRESENTATION).map(([key, value]) => [key, value.label]))).toMatchObject({
      pending: 'Pending', completed: 'Completed', partial: 'Partially completed', missed: 'Missed', holiday: 'Holiday', unscheduled: 'Rest day',
    })
    expect(ACTIVITY_STATUS_PRESENTATION.pending.colorToken).toBe('--status-pending')
    expect(ACTIVITY_STATUS_PRESENTATION.completed.colorToken).toBe('--status-completed')
    expect(ACTIVITY_STATUS_PRESENTATION.partial.colorToken).toBe('--status-partial')
    expect(ACTIVITY_STATUS_PRESENTATION.holiday.colorToken).toBe('--status-holiday')
    expect(ACTIVITY_STATUS_PRESENTATION.missed.colorToken).toBe('--status-missed')
    const expectedLight = {
      pending: ['#64748b', '#e8eef5'], completed: ['#16a34a', '#dcfce7'], partial: ['#b45309', '#fef3c7'],
      missed: ['#dc2626', '#fee2e2'], holiday: ['#7c3aed', '#ede9fe'], rest: ['#6366f1', '#e0e7ff'], neutral: ['#78716c', '#f5f5f4'],
    }
    for (const [name, [foreground, surface]] of Object.entries(expectedLight)) {
      expect(tokens).toContain(`--status-${name}: ${foreground}`)
      expect(tokens).toContain(`--status-${name}-surface: ${surface}`)
    }
    const lightTokenBlock = tokens.split("[data-theme='dark']")[0]!
    const darkTokenBlock = tokens.split("[data-theme='dark']")[1]!
    for (const status of ['pending', 'completed', 'partial', 'holiday', 'missed', 'rest', 'neutral']) {
      const lightForeground = lightTokenBlock.match(new RegExp(`--status-${status}: (#[0-9a-f]{6})`))?.[1]
      const darkForeground = darkTokenBlock.match(new RegExp(`--status-${status}: (#[0-9a-f]{6})`))?.[1]
      for (const block of [lightTokenBlock, darkTokenBlock]) {
        const surface = block.match(new RegExp(`--status-${status}-surface: (#[0-9a-f]{6})`))?.[1]
        const ink = block.match(new RegExp(`--status-${status}-ink: (#[0-9a-f]{6})`))?.[1]
        expect(surface && ink ? contrast(surface, ink) : 0).toBeGreaterThanOrEqual(4.5)
        const foreground = block.match(new RegExp(`--status-${status}: (#[0-9a-f]{6})`))?.[1]
        expect(surface && foreground ? contrast(surface, foreground) : 0).toBeGreaterThanOrEqual(3)
        expect(block).toMatch(new RegExp(`--status-${status}-border: #[0-9a-f]{6}`))
      }
      expect(lightForeground).toBe(expectedLight[status as keyof typeof expectedLight][0])
      expect(darkForeground).toBeTruthy()
    }
    expect(tokens).toContain('--status-rest-surface: #e0e7ff')
    expect(tokens).toContain('--status-neutral-surface: #f5f5f4')
    expect(styles).toMatch(/\.status-pending\s*\{[^}]*--status-bg:\s*var\(--status-pending-surface\)[^}]*--status-stroke:\s*var\(--status-pending-border\)/s)
    expect(styles).toMatch(/\.week-rhythm-day\.holiday\s*\{[^}]*var\(--status-holiday-surface\)/s)
    expect(styles).toMatch(/\.week-rhythm-day\.rest\s*\{[^}]*var\(--status-rest-surface\)/s)
    expect(styles).toMatch(/\.calendar-legend\s*\{[^}]*display:\s*grid/s)
    expect(styles).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.calendar-legend\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
  })
})

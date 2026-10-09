import { describe, expect, it } from 'vitest'
import type { TrackerDefinition, TrackerEntry } from './types'
import { ACTIVITY_STATUS_PRESENTATION, getTrackerActivityStatus } from './activityStatus'
import tokens from '../../styles/tokens.css?raw'

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
const state = (date: string, overrides: Partial<TrackerDefinition> = {}, saved?: TrackerEntry, holidays?: string[]) => getTrackerActivityStatus({
  tracker: { ...baseTracker, ...overrides }, entry: saved, date, today: '2026-10-10', holidays: new Set(holidays),
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
    expect(state('2026-10-10', {}, skipped('2026-10-10'))).toBe('skipped')
    expect(state('2026-10-09', {}, skipped('2026-10-09'))).toBe('missed')
    expect(state('2026-10-09', {}, entry('2026-10-09', true), ['2026-10-09'])).toBe('holiday')
  })

  it('keeps rest and inactive dates neutral while retaining saved historical outcomes', () => {
    expect(state('2026-10-10', { schedule: { kind: 'none' } })).toBe('unscheduled')
    expect(state('2026-10-09', { status: 'paused' })).toBe('unscheduled')
    expect(state('2026-10-09', { status: 'archived' }, entry('2026-10-09', true))).toBe('completed')
    expect(state('2026-10-09', {}, entry('2026-10-09', true, '2026-10-11T00:00:00Z'))).toBe('missed')
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
    for (const [name, light, dark] of [
      ['pending', '#eab308', '#facc15'], ['completed', '#22c55e', '#4ade80'], ['partial', '#f97316', '#fb923c'],
      ['holiday', '#8b5cf6', '#a78bfa'], ['missed', '#ef4444', '#f87171'],
    ]) {
      expect(tokens).toContain(`--status-${name}: ${light}`)
      expect(tokens).toContain(`--status-${name}: ${dark}`)
    }
    const lightTokenBlock = tokens.split("[data-theme='dark']")[0]!
    const darkTokenBlock = tokens.split("[data-theme='dark']")[1]!
    for (const status of ['pending', 'completed', 'partial', 'holiday', 'missed']) {
      for (const block of [lightTokenBlock, darkTokenBlock]) {
        const surface = block.match(new RegExp(`--status-${status}-surface: (#[0-9a-f]{6})`))?.[1]
        const ink = block.match(new RegExp(`--status-${status}-ink: (#[0-9a-f]{6})`))?.[1]
        expect(surface && ink ? contrast(surface, ink) : 0).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

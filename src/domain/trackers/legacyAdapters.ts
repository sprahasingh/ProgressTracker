import type { Category, DailyEntry } from '../../db/models'
import type { TrackerDefinition, TrackerEntry } from './types'

/** Read-only adapter; callers retain and persist the original Dexie records. */
export function categoryToTracker(category: Category): TrackerDefinition {
  return {
    schemaVersion: 1,
    id: category.id,
    name: category.name,
    description: category.description ?? '',
    kind: 'habit',
    status: category.deletedAt ? 'archived' : category.archivedAt ? 'archived' : 'active',
    categoryId: category.id,
    tags: [],
    icon: category.icon ?? '',
    accent: category.accent ?? '',
    schedule: category.schedule ?? { kind: 'every-day' },
    metrics: [{ id: category.id, name: 'Completed', valueType: 'boolean' }],
    qualificationRule: { kind: 'comparison', metricId: category.id, operator: 'equals', value: true },
    customFields: [],
    milestones: [],
    createdAt: category.createdAt ?? category.updatedAt ?? new Date(0).toISOString(),
    updatedAt: category.updatedAt ?? category.createdAt ?? new Date(0).toISOString(),
    archivedAt: category.archivedAt ?? null,
    deletedAt: category.deletedAt ?? null,
  }
}

/** Converts a legacy row without changing its primary key or stored representation. */
export function dailyEntryToTrackerEntry(entry: DailyEntry): TrackerEntry {
  return {
    id: entry.id,
    trackerId: entry.categoryId,
    date: entry.date,
    outcome: entry.status === 'skipped' ? 'skipped' : 'recorded',
    values: entry.status === 'completed' ? { [entry.categoryId]: true } : {},
    note: entry.note ?? '',
    createdAt: entry.createdAt ?? entry.updatedAt ?? new Date(0).toISOString(),
    updatedAt: entry.updatedAt ?? entry.createdAt ?? new Date(0).toISOString(),
    deletedAt: entry.deletedAt ?? null,
  }
}

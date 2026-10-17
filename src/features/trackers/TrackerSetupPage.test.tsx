import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { activateWorkspace, db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { TrackerSetupPage } from './TrackerSetupPage'
import { ToastProvider } from '../../components/ui/ToastProvider'
import styles from '../../styles.css?raw'
import { trackerEvaluationSnapshot } from '../../domain/trackers/ruleVersions'
import { qualifiesForStreak } from '../../domain/trackers/progression'
import { evaluateTrackerEntry } from '../../domain/trackers/planning'
import type { TrackerDefinition, TrackerKind } from '../../domain/trackers/types'

const { navigation, routeParams } = vi.hoisted(() => ({ navigation: vi.fn(), routeParams: { trackerId: undefined as string | undefined } }))

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigation, useParams: () => routeParams }
})

vi.mock('../settings/WorkspaceTimeZone', () => ({ useWorkspaceTimeZone: () => ({ timeZone: 'Asia/Calcutta' }) }))

afterEach(async () => {
  cleanup()
  vi.unstubAllEnvs()
  routeParams.trackerId = undefined
  await db.delete()
})

function renderSetup(path = '/trackers/new') {
  routeParams.trackerId = path.includes('/edit') ? path.split('/')[2] : undefined
  navigation.mockClear()
  return render(<ToastProvider><MemoryRouter><TrackerSetupPage /></MemoryRouter></ToastProvider>)
}

function precisePlannedGoal(id: string, decimalPlaces: 0 | 1 | 2, increment: number, allocations: Record<string, number>) {
  return {
    schemaVersion: 4 as const, id, name: 'Precision plan', description: '', kind: 'goal' as const, status: 'active' as const,
    categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const }, startDate: '2026-01-05', deadline: '2026-01-06',
    metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages', precision: { decimalPlaces, increment }, thresholds: { direction: 'increase' as const, target: 1, streakQualification: 'target' as const } }],
    qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const }, customFields: [], milestones: [],
    goalPlanning: { mode: 'cumulative-deadline' as const, progressSemantics: { pages: 'incremental' as const }, dailyTargets: {}, cumulativeTargets: { pages: 10 }, planningTimeZone: 'UTC', allocations: { pages: allocations } },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
  }
}

function datedTracker(id: string, kind: TrackerKind, startDate = '2026-01-05', deadline: string | null = '2100-01-01'): TrackerDefinition {
  return {
    schemaVersion: 1, id, name: 'Date range tracker', description: '', kind, status: 'active', categoryId: null,
    tags: [], icon: '', accent: '', schedule: kind === 'project' ? { kind: 'none' } : { kind: 'every-day' },
    startDate, deadline: deadline ?? undefined, metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }],
    qualificationRule: { kind: 'comparison', metricId: 'done', operator: 'equals', value: true },
    customFields: [], milestones: [{ id: 'milestone-1', title: 'First step', description: '', position: 0 }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
  }
}

function legacyV6Tracker(id: string): TrackerDefinition {
  return {
    schemaVersion: 6, id, name: '100 Days Of MERN', description: '', kind: 'challenge', status: 'active',
    categoryId: null, tags: [], icon: '', accent: '#315e46', schedule: { kind: 'every-day' },
    startDate: '2026-10-16', deadline: '2027-01-23',
    scheduling: { mode: 'effective', effectiveDays: 100, planningTimeZone: 'Asia/Calcutta' },
    metrics: [{
      id: 'progress', name: 'Progress', valueType: 'quantity', unit: 'Hours',
      precision: { decimalPlaces: 1, increment: 0.5 },
      thresholds: { direction: 'increase', minimum: 1, target: 1.5, stretch: 2, streakQualification: 'any-recorded-value' },
    }],
    qualificationRule: { kind: 'threshold', metricId: 'progress', level: 'minimum' },
    customFields: [], milestones: [], strictMode: false,
    createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z', archivedAt: null, deletedAt: null,
  }
}

describe('tracker setup flow', () => {
  it('edits a production-shaped schema-v6 tracker with a soft-deleted skipped entry and preserves its legacy rule path', async () => {
    const existing = legacyV6Tracker('legacy-v6-tombstone-rule-edit')
    await localRepository.saveTracker(existing)
    const tombstone = {
      id: 'legacy-v6-deleted-skip', trackerId: existing.id, date: '2026-10-16' as const, outcome: 'skipped' as const,
      values: {}, note: '', createdAt: '2026-10-16T16:00:00.000Z', updatedAt: '2026-10-16T16:00:00.000Z',
      deletedAt: '2026-10-16T16:04:23.431Z',
    }
    await db.trackerEntries.put(tombstone)
    const timeZone = 'Asia/Calcutta'
    const todayParts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
    const today = `${todayParts.find((part) => part.type === 'year')!.value}-${todayParts.find((part) => part.type === 'month')!.value}-${todayParts.find((part) => part.type === 'day')!.value}`
    const historicalEntry = {
      id: 'legacy-v6-partial-progress', trackerId: existing.id, date: '2026-10-16' as const, outcome: 'recorded' as const,
      values: { progress: 0.5 }, note: '', createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T10:00:00.000Z', deletedAt: null,
    }

    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(screen.getByText('Streak rule', { selector: 'summary' }))
    const streakSection = screen.getByRole('region', { name: 'Streak rule' })
    await user.selectOptions(within(streakSection).getByRole('combobox', { name: 'Streak rule mode' }), 'custom')
    await user.selectOptions(streakSection.querySelector<HTMLSelectElement>('.rule-leaf-controls select:not([aria-label])')!, 'target')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'How should your new rules apply?' })
    expect(within(dialog).getByRole('radio', { name: /Apply from today \(recommended\)/ })).toBeChecked()
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ schemaVersion: 6 })
    await user.click(within(dialog).getByRole('button', { name: 'Apply from today' }))

    const saved = await localRepository.getTracker(existing.id)
    expect(saved).toMatchObject({
      schemaVersion: 10,
      scheduling: { mode: 'effective', effectiveDays: 100, effectiveDayCounting: 'all-non-holiday-days', planningTimeZone: timeZone },
      metrics: [{ id: 'progress', thresholds: { streakQualification: 'any-recorded-value' } }],
      qualificationRule: existing.qualificationRule,
      streakRuleMode: 'custom',
      streakRule: { kind: 'threshold', metricId: 'progress', level: 'target' },
      ruleVersions: [
        { effectiveFrom: '2026-10-16', revision: 1, application: 'baseline' },
        { effectiveFrom: today, revision: 2, application: 'apply-from-today' },
      ],
    })
    const prior = saved!.ruleVersions![0]!.evaluation
    expect(prior.streakRuleMode).toBeNull()
    expect(prior.streakRule).toBeNull()
    expect(prior.scheduling).not.toHaveProperty('effectiveDayCounting')
    expect(evaluateTrackerEntry(saved!, historicalEntry).qualified).toBe(false)
    expect(qualifiesForStreak(saved!, historicalEntry)).toBe(true)
    expect(await db.trackerEntries.get(tombstone.id)).toEqual(tombstone)
  })

  it('keeps an archived tracker archived when edited and saved without status changes', async () => {
    const archived = { ...datedTracker('keep-archived', 'habit'), status: 'archived' as const, archivedAt: '2026-10-02T00:00:00.000Z' }
    await localRepository.saveTracker(archived)
    const user = userEvent.setup()
    renderSetup(`/trackers/${archived.id}/edit`)
    expect(await screen.findByRole('group', { name: 'Tracker status after saving' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Keep archived' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Move to active' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(archived.id)).toMatchObject({ status: 'archived', archivedAt: archived.archivedAt }))
  })

  it('keeps the inferred creation date when an older tracker has no saved start date', async () => {
    const existing = datedTracker('legacy-inferred-start', 'habit')
    delete existing.startDate
    await localRepository.saveTracker(existing)
    await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-01-02', outcome: 'recorded', values: { done: true }, note: 'Before this edit' })
    const confirm = vi.spyOn(window, 'confirm')
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)

    expect(await screen.findByLabelText('Start date')).toHaveValue('2026-01-01')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ startDate: '2026-01-01' }))
    expect(confirm).not.toHaveBeenCalled()
    await expect(localRepository.getTrackerEntry(existing.id, '2026-01-02')).resolves.toMatchObject({ values: { done: true }, note: 'Before this edit' })
    confirm.mockRestore()
  })

  it('saves reactivation with tracker edits in one offline sync operation', async () => {
    await activateWorkspace('archive-edit-owner')
    const activeTracker = datedTracker('reactivate-archived', 'habit')
    await localRepository.saveTracker(activeTracker)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: activeTracker.id, date: '2026-10-03', outcome: 'recorded', values: { done: true }, note: 'History stays' })
    const archived = await localRepository.archiveTracker(activeTracker.id)
    if (!archived) throw new Error('Tracker did not archive.')
    const user = userEvent.setup()
    renderSetup(`/trackers/${archived.id}/edit`)
    await screen.findByRole('group', { name: 'Tracker status after saving' })
    await user.click(screen.getByRole('radio', { name: 'Move to active' }))
    await user.clear(screen.getByRole('textbox', { name: 'What habit do you want to build?' }))
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Active again')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(async () => expect(await localRepository.getTracker(archived.id)).toMatchObject({ id: archived.id, name: 'Active again', status: 'active', archivedAt: null }))
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['archive-edit-owner', 'tracker', archived.id]).first()).resolves.toMatchObject({ payload: { status: 'active', archivedAt: null, name: 'Active again' } })
    await expect(localRepository.getTrackerEntry(archived.id, '2026-10-03')).resolves.toMatchObject({ id: savedEntry.id, values: { done: true }, note: 'History stays' })
  })

  it('does not reactivate an archived tracker after validation failure or discard', async () => {
    const archived = { ...datedTracker('failed-reactivation', 'habit'), status: 'archived' as const, archivedAt: '2026-10-02T00:00:00.000Z' }
    await localRepository.saveTracker(archived)
    const user = userEvent.setup()
    renderSetup(`/trackers/${archived.id}/edit`)
    await screen.findByRole('group', { name: 'Tracker status after saving' })
    await user.click(screen.getByRole('radio', { name: 'Move to active' }))
    const name = screen.getByRole('textbox', { name: 'What habit do you want to build?' })
    await user.clear(name)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert', { name: 'Check the tracker details' })).toBeInTheDocument()
    await expect(localRepository.getTracker(archived.id)).resolves.toMatchObject({ status: 'archived', archivedAt: archived.archivedAt })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    await expect(localRepository.getTracker(archived.id)).resolves.toMatchObject({ status: 'archived', archivedAt: archived.archivedAt })
  })

  it('uses the shared icon radio cards and keeps the additional types collapsed until requested', async () => {
    const user = userEvent.setup()
    renderSetup()

    const picker = screen.getByRole('group', { name: 'What do you want to track?' })
    const additionalTypes = screen.getByText('Challenge or project?').closest('details')!
    expect(additionalTypes).not.toHaveAttribute('open')
    expect(within(picker).getByRole('radio', { name: /Habit/ })).toBeChecked()
    expect(within(picker).getByRole('radio', { name: /Goal/ })).not.toBeChecked()
    for (const icon of ['habit', 'goal']) expect(picker.querySelector(`[data-icon="${icon}"]`)).toBeInTheDocument()
    expect(styles).toContain('.tracker-kind-option.selected::after')
    expect(styles).toContain('.tracker-kind-option:focus-within')
    expect(styles).toContain('clip-path: inset(50%)')
    expect(styles).toContain('.tracker-setup-form .tracker-kind-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }')
    expect(styles).not.toContain('.tracker-setup-form .tracker-kind-option-icon { display: none; }')
    expect(styles).toContain('text-overflow: ellipsis; white-space: nowrap;')

    const habitRadio = within(picker).getByRole('radio', { name: /Habit/ })
    habitRadio.focus()
    await user.keyboard('{ArrowRight}')
    expect(within(picker).getByRole('radio', { name: /Goal/ })).toBeChecked()
    expect(additionalTypes).not.toHaveAttribute('open')

    await user.click(screen.getByText('Challenge or project?'))
    for (const icon of ['challenge', 'project']) expect(additionalTypes.querySelector(`[data-icon="${icon}"]`)).toBeInTheDocument()
    await user.click(within(additionalTypes).getByRole('radio', { name: /Challenge/ }))
    expect(within(additionalTypes).getByRole('radio', { name: /Challenge/ })).toBeChecked()
    await user.click(within(additionalTypes).getByRole('radio', { name: /Project/ }))
    expect(within(additionalTypes).getByRole('radio', { name: /Project/ })).toBeChecked()
    expect(additionalTypes).toHaveAttribute('open')
  })

  it('requires a useful name before saving', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('alert', { name: 'Check the tracker details' })).toHaveTextContent('Enter a name for this tracker.')
    expect(screen.getByText('Enter a name for this tracker.', { selector: 'small' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'What habit do you want to build?' })).toHaveFocus())
    expect(await localRepository.listTrackers()).toHaveLength(0)
  })

  it('associates advanced validation feedback with the exact invalid control', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Write daily')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Extra check-in details'))
    await user.click(screen.getByRole('button', { name: /Add field/ }))
    const fieldName = document.querySelector<HTMLInputElement>('[data-validation-path="customFields.0.name"]')!
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    await waitFor(() => expect(fieldName).toHaveAttribute('aria-invalid', 'true'))
    const describedBy = fieldName.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveAttribute('role', 'alert')
    expect(document.getElementById(describedBy!)).toHaveTextContent('Enter a value for this field.')
  })

  it('asks before discarding a modified tracker form and lets the user keep editing', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Write daily')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByRole('textbox', { name: 'What habit do you want to build?' })).toHaveValue('Write daily')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(navigation).toHaveBeenCalledWith('/trackers')
  })

  it('guards a modified form when browser history changes the hash', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Write daily')
    window.history.pushState({}, '', `${window.location.pathname}${window.location.search}#/trackers`)
    fireEvent.popState(window, { state: {} })
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument()
    expect(navigation).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(navigation).toHaveBeenCalledWith('/trackers')
  })

  it('creates a habit with a daily default and offers an immediate check-in', async () => {
    const user = userEvent.setup()
    renderSetup()
    const name = screen.getByRole('textbox', { name: 'What habit do you want to build?' })
    expect(name).not.toHaveFocus()
    await user.type(name, 'Read every day')
    expect(screen.getByLabelText('Start date').getAttribute('value') ?? (screen.getByLabelText('Start date') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(screen.getByRole('combobox', { name: 'Activity schedule' }).closest('.advanced-setup')).not.toHaveAttribute('open')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Activity schedule & holidays'))
    expect(screen.getByRole('combobox', { name: 'Activity schedule' })).toHaveValue('every-day')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ }, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Record my first check-in' })).toHaveAttribute('href', '/')
    expect(await localRepository.listTrackers()).toMatchObject([{ kind: 'habit', name: 'Read every day', schedule: { kind: 'every-day' }, metrics: [{ valueType: 'boolean' }] }])
  })

  it('keeps Daily as the default when selecting each new tracker type', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Activity schedule & holidays'))
    const schedule = screen.getByRole('combobox', { name: 'Activity schedule' })
    expect(schedule).toHaveValue('every-day')

    await user.click(screen.getByRole('radio', { name: /Habit/ }))
    expect(schedule).toHaveValue('every-day')
    await user.click(screen.getByText('Challenge or project?'))
    await user.click(screen.getByRole('radio', { name: /Challenge/ }))
    expect(schedule).toHaveValue('every-day')
    await user.click(screen.getByRole('radio', { name: /Project/ }))
    expect(schedule).toHaveValue('every-day')
  })

  it('preserves a recurrence explicitly chosen before changing tracker type', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Activity schedule & holidays'))
    const schedule = screen.getByRole('combobox', { name: 'Activity schedule' })
    await user.selectOptions(schedule, 'weekdays')
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    expect(schedule).toHaveValue('weekdays')
    await user.click(screen.getByText('Challenge or project?'))
    await user.click(screen.getByRole('radio', { name: /Project/ }))
    expect(schedule).toHaveValue('weekdays')
  })

  it('saves a Saturday-only Custom Days recurrence without converting it to a weekday preset', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Weekend study')
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Activity schedule & holidays'))
    const schedule = screen.getByRole('combobox', { name: 'Activity schedule' })
    await user.selectOptions(schedule, 'custom-days')
    expect(screen.getByRole('button', { name: 'Sat' })).toHaveAttribute('aria-pressed', 'true')
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sun']) await user.click(screen.getByRole('button', { name: day }))
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ schedule: { kind: 'selected-weekdays', weekdays: [6] } }])
  })

  it('saves the Weekends preset as Saturday and Sunday recurrence', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Weekend walks')
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Activity schedule & holidays'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Activity schedule' }), 'weekends')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ schedule: { kind: 'selected-weekdays', weekdays: [0, 6] } }])
  })

  it('rejects an empty Custom Days selection and keeps No Recurrence distinct', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Flexible activity')
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Activity schedule & holidays'))
    const schedule = screen.getByRole('combobox', { name: 'Activity schedule' })
    await user.selectOptions(schedule, 'custom-days')
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) await user.click(screen.getByRole('button', { name: day }))
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findAllByText('Select at least one day, or choose No Recurrence.', { selector: 'small' })).toHaveLength(2)
    expect(await localRepository.listTrackers()).toHaveLength(0)
    await user.selectOptions(schedule, 'none')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ schedule: { kind: 'none' } }])
  })

  it('defaults Strict Mode off and persists it on newly created trackers when enabled', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Daily practice')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Activity schedule & holidays'))
    const strictMode = screen.getByRole('checkbox', { name: /Strict Mode/ })
    expect(strictMode).not.toBeChecked()
    await user.click(strictMode)
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ strictMode: true }])
  })

  it('offers prospective, retrospective, and cancel choices for an evaluation change while preserving form values', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'strict-history', name: 'Read', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' as const },
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'done', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/strict-history/edit')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Activity schedule & holidays'))
    await user.click(await screen.findByRole('checkbox', { name: /Strict Mode/ }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'How should your new rules apply?' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Apply from today \(recommended\)/ })).toBeChecked()
    expect(screen.getByText(/including any activity already recorded today/)).toBeInTheDocument()
    expect(await localRepository.getTracker(existing.id)).not.toHaveProperty('strictMode')
    const ruleDialog = screen.getByRole('alertdialog', { name: 'How should your new rules apply?' })
    await user.click(within(ruleDialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('checkbox', { name: /Strict Mode/ })).toBeChecked()
    expect(await localRepository.getTracker(existing.id)).not.toHaveProperty('strictMode')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(screen.getByRole('radio', { name: /Recalculate all history/ }))
    await user.click(screen.getByRole('button', { name: 'Recalculate all history' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ schemaVersion: 10, strictMode: true, ruleVersions: [{ application: 'recalculate-all-history' }] }))
  })

  it('offers compact numeric unit, target, and precision controls and saves them', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Read pages')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure 1 value type' }), 'quantity')
    expect(screen.getByRole('region', { name: 'Numeric measure settings' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Numeric measure unit' }), 'pages')
    await user.clear(screen.getByRole('spinbutton', { name: 'Per-check-in target' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Per-check-in target' }), '5')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Numeric precision' }), '1')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ schemaVersion: 8, streakRuleMode: 'same-as-success', metrics: [{ valueType: 'quantity', unit: 'pages', precision: { decimalPlaces: 1, increment: 0.1 }, thresholds: { target: 5 } }] }])
  })

  it('opens the history choice before validating a changed schema v10 rule head', async () => {
    const base: TrackerDefinition = {
      ...datedTracker('edit-v10-history-again', 'habit', '2026-01-05', null),
      scheduling: { mode: 'ongoing' },
      metrics: [{
        id: 'sessions', name: 'Sessions', valueType: 'quantity', unit: 'sessions',
        thresholds: { direction: 'increase', minimum: 1, target: 5, streakQualification: 'minimum' },
      }],
      qualificationRule: { kind: 'comparison', metricId: 'sessions', operator: 'at-least', value: 3 },
      streakRuleMode: 'same-as-success', strictMode: false,
    }
    const existing: TrackerDefinition = {
      ...base,
      schemaVersion: 10,
      ruleVersions: [{
        id: 'v10-baseline', effectiveFrom: '2026-01-05', revision: 1, application: 'baseline',
        recordedAt: '2026-01-05T00:00:00.000Z', evaluation: trackerEvaluationSnapshot(base),
      }],
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(screen.getByText('Success rule', { selector: 'summary' }))
    const successRule = screen.getByRole('region', { name: 'Success rule' })
    await user.clear(within(successRule).getByRole('spinbutton', { name: 'Value' }))
    await user.type(within(successRule).getByRole('spinbutton', { name: 'Value' }), '5')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'How should your new rules apply?' })
    expect(within(dialog).getByRole('radio', { name: /Apply from today/ })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: /Recalculate all history/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Recalculate all history' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({
      schemaVersion: 10,
      qualificationRule: { value: 5 },
      ruleVersions: [{ application: 'recalculate-all-history', effectiveFrom: '2026-01-05' }],
    }))
  })

  it.each([
    ['boolean', 'Yes / no'],
    ['quantity', 'Quantity'],
    ['duration', 'Duration'],
    ['checklist', 'Checklist'],
  ] as const)('creates a tracker with %s as its primary measure type', async (valueType, _label) => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), `Primary ${valueType}`)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure 1 value type' }), valueType)
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ metrics: [{ valueType }] }])
  })

  it('offers all four primary types and keeps independent type choices available in advanced configuration', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Read daily')
    const primaryType = screen.getByRole('combobox', { name: 'Measure 1 value type' })
    expect(within(primaryType).getAllByRole('option').map((option) => option.textContent)).toEqual(['Yes / no', 'Quantity', 'Duration', 'Checklist'])
    await user.selectOptions(primaryType, 'quantity')
    await user.type(screen.getByRole('textbox', { name: 'Numeric measure unit' }), 'pages')
    await user.type(screen.getByRole('spinbutton', { name: 'Per-check-in target' }), '5')
    await user.selectOptions(primaryType, 'boolean')
    await user.selectOptions(primaryType, 'quantity')
    expect(screen.getByRole('textbox', { name: 'Numeric measure unit' })).toHaveValue('pages')
    expect(screen.getByRole('spinbutton', { name: 'Per-check-in target' })).toHaveValue(5)
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    expect(screen.getByRole('combobox', { name: 'Measure 1 value type' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '＋ Add measure' }))
    const secondaryType = screen.getByRole('combobox', { name: 'Measure 2 value type' })
    expect(within(secondaryType).getAllByRole('option').map((option) => option.textContent)).toEqual(['Yes / no', 'Quantity', 'Duration', 'Checklist'])
    await user.selectOptions(secondaryType, 'checklist')
    expect(secondaryType).toHaveValue('checklist')
    expect(screen.getByLabelText('Checklist item 1')).toBeInTheDocument()
  })

  it('locks the type of every existing measure while allowing a type choice for a newly added measure', async () => {
    const existing = datedTracker('locked-measures', 'habit')
    existing.metrics.push({ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } })
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Measures, precision & targets'))
    expect(screen.getAllByText('Existing measures keep this type. Retire it and add a measure to change value type.')).toHaveLength(2)
    expect(screen.queryByRole('combobox', { name: 'Measure 2 value type' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '＋ Add measure' }))
    const newType = screen.getByRole('combobox', { name: 'Measure 3 value type' })
    await user.selectOptions(newType, 'boolean')
    expect(newType).toHaveValue('boolean')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ metrics: [{ id: 'done', valueType: 'boolean' }, { id: 'pages', valueType: 'quantity' }, { valueType: 'boolean' }] }))
  })

  it('locks checklist item editing when saved values use the checklist definition', async () => {
    const existing = datedTracker('checklist-history-lock', 'habit')
    existing.metrics = [{ id: 'routine', name: 'Routine', valueType: 'checklist', checklistItems: [
      { id: 'read', label: 'Read', position: 0 }, { id: 'review', label: 'Review', position: 1 },
    ] }]
    existing.qualificationRule = undefined
    await localRepository.saveTracker(existing)
    await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-10-10', outcome: 'recorded', values: { routine: { read: true, review: false } }, note: '' })

    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    expect(screen.getByRole('textbox', { name: 'Checklist item 1' })).toBeDisabled()
    expect(screen.getAllByRole('button', { name: 'Remove' }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: '＋ Add checklist item' })).toBeDisabled()
    expect(screen.getByText(/Saved checklist values keep these item IDs and labels/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ metrics: [{ checklistItems: [{ id: 'read', label: 'Read' }, { id: 'review', label: 'Review' }] }] }))
  })

  it('locks a historical custom field and retires it while preserving its saved value', async () => {
    const existing = datedTracker('custom-field-history-lock', 'habit')
    existing.customFields = [{ id: 'mood', name: 'Mood', type: 'single-select', required: false, position: 0, options: ['Focused', 'Tired'] }]
    await localRepository.saveTracker(existing)
    await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-10-10', outcome: 'recorded', values: { done: true, 'field:mood': 'Focused' }, note: '' })

    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(screen.getByText('Extra check-in details'))
    expect(screen.getByRole('textbox', { name: 'Field name' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Field type' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: /Options/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Required/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Retire field' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Retire field' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ customFields: [{ id: 'mood', name: 'Mood', retiredAt: expect.any(String) }] }))
    await expect(localRepository.getTrackerEntry(existing.id, '2026-10-10')).resolves.toMatchObject({ values: { 'field:mood': 'Focused' } })
  })

  it('saves a custom Streak Rule independently from the Success Rule', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.type(screen.getByRole('textbox', { name: 'What habit do you want to build?' }), 'Practice problems')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure 1 value type' }), 'quantity')
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Streak rule', { selector: 'summary' }))
    const streakSection = screen.getByRole('region', { name: 'Streak rule' })
    await user.selectOptions(within(streakSection).getByRole('combobox', { name: 'Streak rule mode' }), 'custom')
    await user.clear(within(streakSection).getByRole('spinbutton'))
    await user.type(within(streakSection).getByRole('spinbutton'), '1')

    await user.click(screen.getByText('Success rule', { selector: 'summary' }))
    const successSection = screen.getByRole('region', { name: 'Success rule' })
    await user.clear(within(successSection).getByRole('spinbutton'))
    await user.type(within(successSection).getByRole('spinbutton'), '5')
    expect(within(streakSection).getByText(/Streak summary: Progress ≥ 1/)).toBeInTheDocument()
    expect(within(successSection).getByText(/Success summary: Progress ≥ 5/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{
      schemaVersion: 8,
      streakRuleMode: 'custom',
      qualificationRule: { kind: 'comparison', value: 5 },
      streakRule: { kind: 'comparison', value: 1 },
    }])
  })

  it('keeps an existing v7 tracker on its legacy streak behavior until the user changes it', async () => {
    const existing = {
      ...datedTracker('legacy-streak-rule', 'habit'),
      schemaVersion: 7 as const,
      scheduling: { mode: 'ongoing' as const },
      deadline: undefined,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ schemaVersion: 7 }))
    expect(await localRepository.getTracker(existing.id)).not.toHaveProperty('streakRuleMode')
  })

  it('removes a saved custom streak rule when switching an existing tracker back to Success Rule', async () => {
    const existing = {
      ...datedTracker('streak-cure-existing-rule', 'habit', '2026-01-05', null),
      schemaVersion: 8 as const,
      scheduling: { mode: 'ongoing' as const },
      metrics: [{
        id: 'sessions', name: 'Sessions', valueType: 'quantity' as const, unit: 'sessions',
        thresholds: { direction: 'increase' as const, minimum: 1, target: 5, streakQualification: 'target' as const },
      }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'sessions', level: 'target' as const },
      streakRuleMode: 'custom' as const,
      streakRule: { kind: 'comparison' as const, metricId: 'sessions', operator: 'at-least' as const, value: 1 },
    }
    await localRepository.saveTracker(existing)
    const savedEntry = await localRepository.saveTrackerEntry({
      trackerId: existing.id, date: '2026-10-15', outcome: 'recorded', values: { sessions: 3 }, note: 'Historical progress stays intact',
    })
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(screen.getByText('Streak rule', { selector: 'summary' }))
    const streakSection = screen.getByRole('region', { name: 'Streak rule' })
    await user.selectOptions(within(streakSection).getByRole('combobox', { name: 'Streak rule mode' }), 'same-as-success')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(await screen.findByRole('button', { name: 'Apply from today' }))

    await waitFor(async () => {
      const saved = await localRepository.getTracker(existing.id)
      expect(saved).toMatchObject({ schemaVersion: 10, streakRuleMode: 'same-as-success' })
      expect(saved?.ruleVersions?.map((version) => version.application)).toEqual(['baseline', 'apply-from-today'])
    })
    expect(await localRepository.getTracker(existing.id)).not.toHaveProperty('streakRule')
    await expect(localRepository.getTrackerEntry(existing.id, '2026-10-15')).resolves.toMatchObject({ id: savedEntry.id, values: { sessions: 3 }, note: savedEntry.note })
  })

  it('preserves a custom Streak Rule when only basic tracker details change', async () => {
    const existing = {
      ...datedTracker('streak-cure-unrelated-edit', 'habit', '2026-01-05', null),
      schemaVersion: 8 as const,
      scheduling: { mode: 'ongoing' as const },
      metrics: [{
        id: 'sessions', name: 'Sessions', valueType: 'quantity' as const, unit: 'sessions',
        thresholds: { direction: 'increase' as const, minimum: 1, target: 5, streakQualification: 'target' as const },
      }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'sessions', level: 'target' as const },
      streakRuleMode: 'custom' as const,
      streakRule: { kind: 'comparison' as const, metricId: 'sessions', operator: 'at-least' as const, value: 2 },
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    const name = await screen.findByRole('textbox', { name: 'What habit do you want to build?' })
    await user.clear(name)
    await user.type(name, 'Streak Cure renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({
      name: 'Streak Cure renamed',
      schemaVersion: 8,
      streakRuleMode: 'custom',
      streakRule: existing.streakRule,
      qualificationRule: existing.qualificationRule,
      metrics: existing.metrics,
      scheduling: existing.scheduling,
    }))
  })

  it('retires a saved measure with history after confirmation and keeps its original definition', async () => {
    const existing = datedTracker('retire-measure-flow', 'habit')
    existing.metrics.push({ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' })
    await localRepository.saveTracker(existing)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-10-10', outcome: 'recorded', values: { done: true, pages: 12 }, note: 'Keep this value' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Measures, precision & targets'))
    const retireButtons = await screen.findAllByRole('button', { name: 'Retire measure' })
    await user.click(retireButtons.find((button) => !button.hasAttribute('disabled'))!)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Retired measures won't appear in new check-ins"))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ metrics: [{ id: 'done' }, { id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', retiredAt: expect.any(String) }] }))
    await expect(localRepository.getTrackerEntry(existing.id, '2026-10-10')).resolves.toMatchObject({ id: savedEntry.id, values: { pages: 12 }, note: 'Keep this value' })
    confirm.mockRestore()
  })

  it('keeps unrelated success rules when removing an unreferenced measure', async () => {
    const existing = datedTracker('remove-unreferenced-measure', 'habit')
    existing.metrics.push({ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages' })
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Measures, precision & targets'))
    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    await user.click(removeButtons.find((button) => !button.hasAttribute('disabled'))!)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ metrics: [{ id: 'done' }], qualificationRule: { kind: 'comparison', metricId: 'done', value: true } }))
  })

  it.each([320, 360, 390, 430])('keeps the essential setup controls and compact action footer available at %ipx', async (width) => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.dispatchEvent(new Event('resize'))
    renderSetup()
    expect(screen.getByRole('textbox', { name: 'What habit do you want to build?' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Measure 1 value type' })).toHaveValue('boolean')
    expect(screen.getByLabelText('Start date')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create tracker' })).toBeInTheDocument()
    expect(styles).toContain('@media (max-width: 360px)')
    expect(styles).toContain('bottom: calc(64px + env(safe-area-inset-bottom, 0px))')
    expect(styles).toContain('white-space: normal;')
    expect(styles).toContain('overflow-wrap: normal;')
    expect(styles).toContain('.section-header-container { min-width: 0; container-type: inline-size; }')
    expect(styles).toMatch(/@container\s*\(max-width:\s*360px\)/)
    expect(styles).not.toContain('.configuration-heading > div:first-child { flex-basis: 100%;')
    cleanup()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  })

  it('creates a cumulative goal when an optional target and deadline are added', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', 'true')
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', 'true')
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V8', 'true')
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Solve DSA problems')
    await user.type(screen.getByRole('textbox', { name: 'Numeric measure unit' }), 'problems')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Schedule duration' }), 'calendar')
    await user.click(screen.getByText('Add a target'))
    await user.type(screen.getByRole('spinbutton', { name: 'Total amount' }), '100')
    expect(screen.getByLabelText('Tracker deadline')).toBeVisible()
    await user.type(screen.getByLabelText('Tracker deadline'), '2099-12-31')
    expect(screen.getByRole('spinbutton', { name: 'Total amount' })).toHaveValue(100)
    expect(screen.getByText(/Suggested pace:/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('link', { name: 'Record my first progress' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'View my goal' })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('link', { name: 'Customize my plan' })).toHaveAttribute('href', expect.stringMatching(/\/trackers\/.*\/edit/))
    const [saved] = await localRepository.listTrackers()
    expect(saved).toMatchObject({
      schemaVersion: 8, streakRuleMode: 'same-as-success', kind: 'goal', name: 'Solve DSA problems', schedule: { kind: 'every-day' }, scheduling: { mode: 'calendar' },
      goalPlanning: { mode: 'cumulative-deadline', progressSemantics: { [saved!.metrics[0]!.id]: 'incremental' }, cumulativeTargets: { [saved!.metrics[0]!.id]: 100 } },
      metrics: [{ name: 'Progress', valueType: 'quantity', unit: 'problems', thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }],
    })
    expect(saved?.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }, 30_000)

  it('keeps the Effective Days deadline independent from the Goal activity schedule', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', 'true')
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Read a book')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Schedule duration' }), 'effective')
    await user.type(screen.getByRole('spinbutton', { name: 'Target effective days' }), '30')
    const before = screen.getByRole('status').textContent
    expect(before).toContain('Projected deadline:')
    expect(screen.getByText(/Marked holidays are excluded from this duration/)).toBeInTheDocument()
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Activity schedule & holidays'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Activity schedule' }), 'weekdays')
    expect(screen.getByRole('status').textContent).toBe(before)
    expect(screen.getByText(/Choose when activity is expected/)).toBeInTheDocument()
  })

  it('previews both Effective Days counting methods and opens the compact accessible example', async () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V6', 'true')
    vi.stubEnv('VITE_ENABLE_TRACKER_SCHEMA_V7', 'true')
    const user = userEvent.setup()
    renderSetup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Schedule duration' }), 'effective')
    await user.clear(screen.getByLabelText('Start date'))
    await user.type(screen.getByLabelText('Start date'), '2026-11-01')
    await user.type(screen.getByRole('spinbutton', { name: 'Target effective days' }), '3')
    await user.click(screen.getByText('More options'))
    await user.click(await screen.findByText('Activity schedule & holidays'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Activity schedule' }), 'weekdays')
    const planned = screen.getByRole('radio', { name: 'Only planned activity days' })
    const allDates = screen.getByRole('radio', { name: 'Include rest days too' })
    expect(planned).toBeChecked()
    const before = screen.getByText(/3 planned activity days · Ends/).textContent
    await user.click(allDates)
    expect(allDates).toBeChecked()
    expect(screen.getByText(/3 non-holiday days · Ends/).textContent).not.toBe(before)
    await user.click(screen.getByRole('button', { name: 'More about Effective Days counting' }))
    expect(await screen.findByText('Example: 100 Effective Days with Weekdays')).toBeInTheDocument()
    expect(screen.getByText(/Marked holidays don't count. Missed check-ins don't extend the duration./)).toBeInTheDocument()
  })

  it('keeps goal planning directly available and persists its January 21, 2027 deadline', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Complete 100 practice problems')
    await user.type(screen.getByRole('textbox', { name: 'Numeric measure unit' }), 'problems')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Schedule duration' }), 'calendar')
    await user.click(screen.getByText('Add a target'))
    await user.type(screen.getByRole('spinbutton', { name: 'Total amount' }), '100')
    await user.type(screen.getByLabelText('Tracker deadline'), '2027-01-21')
    await user.click(screen.getByText('Plan targets and pace'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Planning mode' }), 'cumulative-deadline')

    expect(screen.getByLabelText('Tracker deadline')).toHaveValue('2027-01-21')
    expect(screen.getByText('Jan 21, 2027')).toBeInTheDocument()
    expect(screen.queryByText(/Cumulative mode needs a deadline/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    const saved = (await localRepository.listTrackers()).find((tracker) => tracker.name === 'Complete 100 practice problems')
    expect(saved?.deadline).toBe('2027-01-21')
    expect(saved?.goalPlanning).toMatchObject({ mode: 'cumulative-deadline', cumulativeTargets: { [saved!.metrics[0]!.id]: 100 }, progressSemantics: { [saved!.metrics[0]!.id]: 'incremental' } })
  }, 30_000)

  it('allows a simple name-only goal without forcing planning details', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: /Goal/ }))
    await user.type(screen.getByRole('textbox', { name: 'What do you want to achieve?' }), 'Read books')
    expect(screen.getByRole('combobox', { name: 'Measure 1 value type' })).toHaveValue('quantity')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))
    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    expect(await localRepository.listTrackers()).toMatchObject([{ schemaVersion: 8, streakRuleMode: 'same-as-success', kind: 'goal', name: 'Read books', metrics: [{ thresholds: { direction: 'increase', streakQualification: 'any-recorded-value' } }] }])
    expect((await localRepository.listTrackers())[0]?.metrics[0]?.thresholds?.target).toBeUndefined()
  })

  it('keeps complex measures, nested rules, custom fields, and milestones behind targeted disclosures', async () => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByText('Challenge or project?'))
    await user.click(screen.getByRole('radio', { name: /Project/ }))
    await user.type(screen.getByRole('textbox', { name: 'What project will you move forward?' }), 'Build a portfolio')
    const advanced = screen.getByText('More options').closest('details')
    expect(advanced).not.toHaveAttribute('open')
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.click(screen.getByRole('button', { name: '＋ Add measure' }))
    const measureNames = screen.getAllByRole('textbox').filter((input) => input.getAttribute('aria-label') === 'Name')
    await user.clear(measureNames[1]!)
    await user.type(measureNames[1]!, 'Focus time')
    expect(measureNames[1]).toHaveValue('Focus time')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Measure 2 value type' }), 'quantity')

    const successDisclosure = screen.getByText('Success rule', { selector: 'summary' }).closest('details')!
    await user.click(screen.getByText('Success rule', { selector: 'summary' }))
    expect(successDisclosure).toHaveAttribute('open')
    expect(screen.queryByRole('heading', { name: 'Success rule' })).not.toBeInTheDocument()
    const ruleKinds = screen.getAllByRole('combobox', { name: 'Success condition type' })
    expect(within(ruleKinds[0]!).queryByRole('option', { name: 'Achievement threshold' })).not.toBeInTheDocument()
    await user.selectOptions(ruleKinds[0]!, 'all')
    const nestedRuleKinds = screen.getAllByRole('combobox', { name: 'Success condition type' })
    await user.selectOptions(nestedRuleKinds[1]!, 'any')

    await user.click(screen.getByText('Extra check-in details'))
    await user.click(screen.getByRole('button', { name: '＋ Add field' }))
    await user.type(screen.getByRole('textbox', { name: 'Field name' }), 'Mood')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field type' }), 'single-select')
    const optionInput = screen.getByRole('region', { name: 'Custom fields' }).querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(optionInput, { target: { value: 'Focused\nTired' } })
    expect(optionInput).toHaveValue('Focused\nTired')
    const milestoneDisclosure = screen.getByText('Milestones', { selector: 'summary' }).closest('details')!
    await user.click(screen.getByText('Milestones', { selector: 'summary' }))
    expect(milestoneDisclosure).toHaveAttribute('open')
    expect(screen.queryByRole('heading', { name: 'Milestones' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '＋ Add milestone' }))
    expect(milestoneDisclosure).toHaveAttribute('open')
    const milestoneCard = screen.getByRole('region', { name: 'Milestones' }).querySelector('.milestone-editor-card') as HTMLElement
    const milestoneTitle = milestoneCard.querySelector('input') as HTMLInputElement
    await user.type(milestoneTitle, 'Publish first case study')
    expect(milestoneTitle).toHaveValue('Publish first case study')
    await user.type(within(milestoneCard).getByRole('spinbutton'), '1')
    await user.click(screen.getByRole('button', { name: 'Create tracker' }))

    expect(await screen.findByRole('heading', { name: /You’re ready to begin/ })).toBeInTheDocument()
    const [saved] = await localRepository.listTrackers()
    expect(saved?.metrics).toHaveLength(2)
    expect(saved?.metrics[1]).toMatchObject({ name: 'Focus time', valueType: 'quantity' })
    expect(saved?.qualificationRule).toMatchObject({ kind: 'all', operands: [{ kind: 'any', operands: [expect.any(Object), expect.any(Object)] }, expect.any(Object)] })
    expect(saved?.customFields).toMatchObject([{ name: 'Mood', type: 'single-select', options: ['Focused', 'Tired'] }])
    expect(saved?.schemaVersion).toBe(9)
    expect(saved?.milestones).toMatchObject([{ title: 'Publish first case study', type: 'cumulative-quantity', targetValue: 1 }])
  }, 10_000)

  it('edits an existing habit without changing its identity, kind, or schema version', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'edit-tracker', name: 'Old name', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const },
      metrics: [{ id: 'habit-metric', name: 'Completed', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'habit-metric', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/edit-tracker/edit')
    const name = await screen.findByRole('textbox', { name: 'What habit do you want to build?' })
    await user.clear(name)
    await user.type(name, 'Updated name')
    expect(screen.getByText('More options').closest('details')).not.toHaveAttribute('open')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(navigation).toHaveBeenCalledWith('/trackers', expect.any(Object)))
    const saved = await localRepository.getTracker(existing.id)
    expect(saved).toMatchObject({ id: existing.id, name: 'Updated name', createdAt: existing.createdAt, schemaVersion: 1, kind: 'habit' })
  })

  it.each(['habit', 'goal', 'challenge', 'project'] as const)('saves a forward future start date for %s without a type-specific restriction', async (kind) => {
    const existing = datedTracker(`future-${kind}`, kind, '2026-01-05', null)
    await localRepository.saveTracker(existing)
    renderSetup(`/trackers/${existing.id}/edit`)
    const start = await screen.findByLabelText('Start date')
    fireEvent.change(start, { target: { value: '2099-12-31' } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(await screen.findByRole('button', { name: 'Apply from today' }))

    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ startDate: '2099-12-31', kind }))
    expect((await localRepository.getTracker(existing.id))?.deadline).toBeUndefined()
  })

  it.each(['habit', 'goal', 'challenge', 'project'] as const)('saves a backward start date for %s', async (kind) => {
    const existing = datedTracker(`past-${kind}`, kind)
    await localRepository.saveTracker(existing)
    renderSetup(`/trackers/${existing.id}/edit`)
    fireEvent.change(await screen.findByLabelText('Start date'), { target: { value: '2025-12-31' } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(await screen.findByRole('button', { name: 'Apply from today' }))

    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ startDate: '2025-12-31', kind }))
  })

  it('explains a start date after the deadline and keeps the tracker unchanged', async () => {
    const existing = datedTracker('invalid-date-range', 'goal', '2026-01-05', '2026-01-10')
    await localRepository.saveTracker(existing)
    renderSetup(`/trackers/${existing.id}/edit`)
    const start = await screen.findByLabelText('Start date')
    expect(start).toHaveAttribute('type', 'date')
    expect(start).toHaveAttribute('max', '2026-01-10')
    fireEvent.change(start, { target: { value: '2026-01-11' } })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(/Start date must be on or before the deadline/, { selector: 'small' })).toBeInTheDocument()
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ startDate: '2026-01-05', deadline: '2026-01-10' })
  })

  it('confirms forward edits that exclude saved activity while preserving check-ins and milestones', async () => {
    const existing = datedTracker('history-date-range', 'goal', '2026-01-05')
    await localRepository.saveTracker(existing)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-01-05', outcome: 'recorded', values: { done: true }, note: 'Keep this history' })
    const nextSavedEntry = await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-01-06', outcome: 'recorded', values: { done: false }, note: 'Keep this too' })
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    fireEvent.change(await screen.findByLabelText('Start date'), { target: { value: '2026-01-07' } })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const confirmation = await screen.findByRole('alertdialog', { name: 'Keep historical check-ins?' })
    expect(confirmation).toHaveTextContent('2 existing check-ins')
    expect(confirmation).toHaveTextContent('2026-01-05–2026-01-06')
    expect(confirmation).toHaveTextContent('Their dates and values will remain in History')
    await user.click(within(confirmation).getByRole('button', { name: 'Cancel changes' }))
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ startDate: '2026-01-05', milestones: [{ id: 'milestone-1', title: 'First step' }] })
    expect(await db.trackerEntries.get(savedEntry.id)).toMatchObject({ date: '2026-01-05', values: { done: true }, note: 'Keep this history' })
    expect(await db.trackerEntries.get(nextSavedEntry.id)).toMatchObject({ date: '2026-01-06', values: { done: false }, note: 'Keep this too' })

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(await screen.findByRole('button', { name: 'Keep historical entries' }))
    await user.click(await screen.findByRole('button', { name: 'Apply from today' }))
    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({ startDate: '2026-01-07' }))
    expect(await db.trackerEntries.get(savedEntry.id)).toMatchObject({ date: '2026-01-05', values: { done: true } })
    expect(await db.trackerEntries.get(nextSavedEntry.id)).toMatchObject({ date: '2026-01-06', values: { done: false } })
  })

  it('confirms a deadline moved earlier when it excludes saved check-ins', async () => {
    const existing = datedTracker('deadline-history-range', 'goal', '2026-01-05', '2026-01-10')
    await localRepository.saveTracker(existing)
    const affected = await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-01-10', outcome: 'recorded', values: { done: true }, note: 'Keep after deadline edit' })
    renderSetup(`/trackers/${existing.id}/edit`)
    await screen.findByText('Edit goal')
    const deadlineInput = screen.getByLabelText('Tracker deadline') as HTMLInputElement
    expect(deadlineInput).toHaveValue('2026-01-10')
    fireEvent.change(deadlineInput, { target: { value: '2026-01-09' } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const confirmation = await screen.findByRole('alertdialog', { name: 'Keep historical check-ins?' })
    expect(confirmation).toHaveTextContent('1 existing check-in')
    expect(confirmation).toHaveTextContent('2026-01-10')
    await user.click(within(confirmation).getByRole('button', { name: 'Cancel changes' }))
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ deadline: '2026-01-10' })
    expect(await db.trackerEntries.get(affected.id)).toMatchObject({ date: '2026-01-10', values: { done: true }, note: 'Keep after deadline edit' })
  })

  it('preserves saved goal allocations and recorded progress when the new start moves past a planned date', async () => {
    const existing = precisePlannedGoal('goal-start-allocation-history', 0, 1, { '2026-01-05': 3, '2026-01-06': 4 })
    await db.open()
    await db.workspaceMetadata.put({ key: 'workspace', userId: 'start-date-owner' })
    await localRepository.saveTracker(existing)
    const savedEntry = await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-01-05', outcome: 'recorded', values: { pages: 2 }, note: 'Actual progress' })
    renderSetup(`/trackers/${existing.id}/edit`)
    fireEvent.change(await screen.findByLabelText('Start date'), { target: { value: '2026-01-06' } })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alertdialog', { name: 'Keep historical check-ins?' })).toHaveTextContent('1 existing check-in')
    await user.click(screen.getByRole('button', { name: 'Keep historical entries' }))
    await user.click(await screen.findByRole('button', { name: 'Apply from today' }))

    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({
      startDate: '2026-01-06', goalPlanning: { allocations: { pages: { '2026-01-05': 3, '2026-01-06': 4 } } },
    }))
    expect(await db.trackerEntries.get(savedEntry.id)).toMatchObject({ date: '2026-01-05', values: { pages: 2 }, note: 'Actual progress' })
    await expect(db.syncOperations.where('[ownerUserId+entity+entityId]').equals(['start-date-owner', 'tracker', existing.id]).first()).resolves.toMatchObject({
      payload: { startDate: '2026-01-06', goalPlanning: { allocations: { pages: { '2026-01-05': 3, '2026-01-06': 4 } } } },
    })
  })

  it.each([320, 1280])('keeps the native date controls available at %ipx', async (width) => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    const existing = datedTracker(`date-picker-${width}`, 'goal', '2026-01-05', '2026-01-10')
    await localRepository.saveTracker(existing)
    renderSetup(`/trackers/${existing.id}/edit`)
    expect(await screen.findByLabelText('Start date')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('Start date')).toHaveAttribute('max', '2026-01-10')
    const deadline = screen.getByLabelText('Tracker deadline')
    expect(deadline).toHaveAttribute('type', 'date')
    expect(deadline).toHaveAttribute('min', '2026-01-05')
    cleanup()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  })

  it.each([
    { kind: 'challenge' as const, deadlineLabel: 'Tracker deadline' },
    { kind: 'project' as const, deadlineLabel: 'Tracker deadline' },
  ])('sets the $kind creation deadline picker minimum to the chosen start date', async ({ kind, deadlineLabel }) => {
    const user = userEvent.setup()
    renderSetup()
    await user.click(screen.getByRole('radio', { name: new RegExp(kind, 'i') }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Schedule duration' }), 'calendar')
    await user.click(await screen.findByText('More options'))
    await user.click(await screen.findByText('Activity schedule & holidays'))
    const start = screen.getByLabelText('Start date')
    const deadline = screen.getByLabelText(deadlineLabel)
    expect(deadline).toHaveAttribute('type', 'date')
    expect(deadline).toHaveAttribute('min', (start as HTMLInputElement).value)
  })

  it('keeps a legacy goal per-check-in target when editing it', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'legacy-goal', name: 'Read pages', description: '', kind: 'goal' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' as const },
      startDate: '2026-01-01', deadline: '2026-02-01',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity' as const, unit: 'pages', thresholds: { direction: 'increase' as const, target: 10, streakQualification: 'target' as const } }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'pages', level: 'target' as const },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/legacy-goal/edit')
    await user.click(await screen.findByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    const target = screen.getByText(/Target threshold/).closest('label')!.querySelector('input')!
    await user.clear(target)
    await user.type(target, '12')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await user.click(await screen.findByRole('button', { name: 'Apply from today' }))
    await waitFor(() => expect(navigation).toHaveBeenCalled())
    const saved = await localRepository.getTracker(existing.id)
    expect(saved).toMatchObject({ schemaVersion: 10, metrics: [{ thresholds: { target: 12 } }] })
    expect(saved?.ruleVersions?.map((version) => version.application)).toEqual(['baseline', 'apply-from-today'])
  })

  it('sets the least restrictive valid increment for selected precision and saves the v4 definition', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'precision-goal', name: 'Solve problems', description: '', kind: 'goal' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'weekdays' as const },
      startDate: '2026-01-01', deadline: '2026-02-01',
      metrics: [{ id: 'problems', name: 'Problems', valueType: 'quantity' as const, unit: 'problems', thresholds: { direction: 'increase' as const, target: 1.2, streakQualification: 'target' as const } }],
      qualificationRule: { kind: 'threshold' as const, metricId: 'problems', level: 'target' as const },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/precision-goal/edit')
    await screen.findByRole('textbox', { name: 'What do you want to achieve?' })
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Problems recording precision' }), '1')
    expect(screen.getByRole('combobox', { name: 'Problems allowed increment' })).toHaveValue('0.1')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(navigation).toHaveBeenCalled())
    expect(await localRepository.getTracker(existing.id)).toMatchObject({
      schemaVersion: 4,
      metrics: [{ precision: { decimalPlaces: 1, increment: 0.1 }, thresholds: { target: 1.2 } }],
    })
  })

  it.each([
    { from: 0 as const, fromIncrement: 1, to: 1 as const, toIncrement: 0.1, allocations: { '2026-01-05': 3, '2026-01-06': 4 } },
    { from: 0 as const, fromIncrement: 1, to: 2 as const, toIncrement: 0.01, allocations: { '2026-01-05': 3, '2026-01-06': 4 } },
    { from: 2 as const, fromIncrement: 0.01, to: 1 as const, toIncrement: 0.1, allocations: { '2026-01-05': 3.2, '2026-01-06': 4.5 } },
    { from: 2 as const, fromIncrement: 0.01, to: 0 as const, toIncrement: 1, allocations: { '2026-01-05': 3, '2026-01-06': 4 } },
  ])('changes precision $from to $to and preserves compatible saved allocations', async ({ from, fromIncrement, to, toIncrement, allocations }) => {
    const existing = precisePlannedGoal(`precision-${from}-${to}`, from, fromIncrement, allocations)
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await screen.findByRole('textbox', { name: 'What do you want to achieve?' })
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Pages recording precision' }), String(to))
    expect(screen.getByRole('combobox', { name: 'Pages allowed increment' })).toHaveValue(String(toIncrement))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(async () => expect(await localRepository.getTracker(existing.id)).toMatchObject({
      schemaVersion: 4, metrics: [{ precision: { decimalPlaces: to, increment: toIncrement } }],
      goalPlanning: { cumulativeTargets: { pages: 10 }, allocations: { pages: allocations } },
    }))
  })

  it('blocks a precision decrease that conflicts with saved allocations without changing the goal or progress', async () => {
    const existing = precisePlannedGoal('precision-incompatible-plan', 2, 0.01, { '2026-01-05': 1.25, '2026-01-06': 2.35 })
    await localRepository.saveTracker(existing)
    const progress = await localRepository.saveTrackerEntry({ trackerId: existing.id, date: '2026-01-05', outcome: 'recorded', values: { pages: 1.23 }, note: 'saved progress' })
    const user = userEvent.setup()
    renderSetup(`/trackers/${existing.id}/edit`)
    await screen.findByRole('textbox', { name: 'What do you want to achieve?' })
    await user.click(screen.getByText('More options'))
    await user.click(screen.getByText('Measures, precision & targets'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Pages recording precision' }), '1')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const alert = await screen.findByRole('alert', { name: 'Tracker details need attention' })
    expect(alert).toHaveTextContent('Saved daily allocations for Pages (increments of 0.1) do not match the selected precision.')
    expect(alert).toHaveTextContent('Your goal total, allocations, and recorded progress have not changed.')
    expect(alert).not.toHaveTextContent('2026-01-05')
    await expect(localRepository.getTracker(existing.id)).resolves.toMatchObject({
      schemaVersion: 4, metrics: [{ precision: { decimalPlaces: 2, increment: 0.01 } }],
      goalPlanning: { cumulativeTargets: { pages: 10 }, allocations: { pages: { '2026-01-05': 1.25, '2026-01-06': 2.35 } } },
    })
    await expect(db.trackerEntries.get(progress.id)).resolves.toMatchObject({ values: { pages: 1.23 }, note: 'saved progress' })
  })

  it('preserves a custom existing schedule when other settings are edited', async () => {
    const existing = {
      schemaVersion: 1 as const, id: 'custom-schedule', name: 'Flexible', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-n-days' as const, interval: 2 },
      metrics: [{ id: 'habit', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'habit', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(existing)
    const user = userEvent.setup()
    renderSetup('/trackers/custom-schedule/edit')
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(navigation).toHaveBeenCalled())
    expect(await localRepository.getTracker(existing.id)).toMatchObject({ schedule: { kind: 'every-n-days', interval: 2 } })
  })

  it('archives without deleting and can still list the archived tracker', async () => {
    const tracker = {
      schemaVersion: 1 as const, id: 'archive-tracker', name: 'Keep this history', description: '', kind: 'habit' as const,
      status: 'active' as const, categoryId: null, tags: [], icon: '', accent: '', schedule: { kind: 'every-day' as const },
      metrics: [{ id: 'archive-metric', name: 'Done', valueType: 'boolean' as const }],
      qualificationRule: { kind: 'comparison' as const, metricId: 'archive-metric', operator: 'equals' as const, value: true },
      customFields: [], milestones: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    await localRepository.archiveTracker(tracker.id)

    expect(await localRepository.listTrackers()).toHaveLength(0)
    expect(await localRepository.listTrackers(true)).toMatchObject([{ id: tracker.id, status: 'archived', archivedAt: expect.any(String) }])
  })
})

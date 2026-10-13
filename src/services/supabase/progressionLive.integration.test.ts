import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { activateWorkspace, db } from '../../db/database'
import { localRepository } from '../../db/localRepository'
import { localCalendarDate, shiftCalendarDate } from '../../features/shared/localDates'
import { getSupabaseClient } from './client'
import { getAchievementHistory, getConfirmedXp, getEarnedAndLockedBadges, getProvisionalXp } from './progressionRepository'
import { synchronizeWorkspace } from './syncEngine'
import type { StoredTrackerDefinition, StoredTrackerEntry } from '../../db/models'

const environment = (globalThis as typeof globalThis & { process: { env: Record<string, string | undefined> } }).process.env
const url = environment.SUPABASE_URL
const anonKey = environment.SUPABASE_ANON_KEY
const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY
const databaseContainer = environment.SUPABASE_DB_CONTAINER
const enabled = environment.RUN_PROGRESS_TRACKER_LOCAL_INTEGRATION === 'true'
const execFileAsync = promisify(execFile)

function serverEntryPayload(entry: StoredTrackerEntry) {
  return { id: entry.id, tracker_id: entry.trackerId, entry_date: entry.date, outcome: entry.outcome, entry_values: entry.values, note: entry.note, created_at: entry.createdAt, updated_at: entry.updatedAt, deleted_at: entry.deletedAt }
}

async function queryLocalDatabase(sql: string): Promise<string> {
  if (!databaseContainer) throw new Error('The local PostgreSQL container was not provided to the integration runner.')
  const result = await execFileAsync('docker', ['exec', databaseContainer, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', sql], { timeout: 10_000 })
  return result.stdout.trim()
}

async function overlapPostgresTransactions(userId: string, statements: [string, string], role: 'authenticated' | 'postgres' = 'authenticated'): Promise<[string, string]> {
  if (!databaseContainer) throw new Error('The local PostgreSQL container was not provided to the integration runner.')
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1
  const controller = spawn('docker', ['exec', '-i', databaseContainer, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres'])
  let controllerOutput = ''
  let controllerError = ''
  controller.stdout.setEncoding('utf8').on('data', (chunk: string) => { controllerOutput += chunk })
  controller.stderr.setEncoding('utf8').on('data', (chunk: string) => { controllerError += chunk })
  const waitForMarker = async (marker: string, timeoutMs = 5_000) => {
    const started = Date.now()
    while (!controllerOutput.includes(marker)) {
      if (controller.exitCode !== null) throw new Error(`PostgreSQL barrier controller exited early: ${controllerError}`)
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for the PostgreSQL barrier ${marker}. ${controllerError}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  controller.stdin.write(`SELECT pg_advisory_lock(${lockKey}::bigint);\n\\echo BARRIER_HELD\n`)
  const wrap = (statement: string) => `BEGIN; SELECT pg_advisory_xact_lock_shared(${lockKey}::bigint); ${role === 'authenticated' ? `SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '${userId}';` : ''} ${statement} COMMIT;`
  let sessions: Promise<string>[] = []
  try {
    await waitForMarker('BARRIER_HELD')
    sessions = statements.map(async (statement) => {
      const result = await execFileAsync('docker', ['exec', databaseContainer!, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', wrap(statement)], { timeout: 10_000 })
      return result.stdout.trim()
    })
    const waitQuery = `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock_shared(${lockKey}%';`
    const started = Date.now()
    while (Number(await queryLocalDatabase(waitQuery)) < 2) {
      if (Date.now() - started > 5_000) throw new Error('Both PostgreSQL sessions did not reach the controlled transaction barrier in time.')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    controller.stdin.write(`SELECT pg_advisory_unlock(${lockKey}::bigint);\n\\echo BARRIER_RELEASED\n`)
    await waitForMarker('BARRIER_RELEASED')
    return await Promise.all(sessions) as [string, string]
  } finally {
    if (controller.exitCode === null) {
      controller.stdin.write('\\q\n')
      controller.kill('SIGTERM')
    }
  }
}

const suite = describe.skipIf(!enabled)('live local Supabase progression synchronization', () => {
  let admin: SupabaseClient | undefined
  let client: SupabaseClient | undefined
  let userId: string | undefined

  afterAll(async () => {
    if (userId && admin) await admin.auth.admin.deleteUser(userId)
    db.close()
    await db.delete()
    await activateWorkspace(null)
  })

  it('reconciles local provisional XP through real API uploads, retries, corrections, conflicts, and rejection', async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(anonKey).toBeTruthy()
    expect(serviceRoleKey).toBeTruthy()

    admin = createClient(url!, serviceRoleKey!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'progression-live-admin' } })
    const suffix = crypto.randomUUID()
    const email = `progression-integration-${suffix}@example.test`
    const password = `LocalOnly-${suffix}-Aa9!`
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (createError || !created.user) throw new Error(`Could not create disposable local test user: ${createError?.message ?? 'missing user'}`)
    userId = created.user.id

    client = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'progression-live-login' } })
    const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password })
    if (signInError || !signedIn.session) throw new Error(`Could not sign in disposable local test user: ${signInError?.message ?? 'missing session'}`)
    const configuredClient = getSupabaseClient()
    if (!configuredClient) throw new Error('The application Supabase client is not configured for the local integration test.')
    await configuredClient.auth.setSession({ access_token: signedIn.session.access_token, refresh_token: signedIn.session.refresh_token })
    await activateWorkspace(userId)

    const now = new Date().toISOString()
    const trackerId = crypto.randomUUID()
    const tracker: StoredTrackerDefinition = {
      schemaVersion: 1, id: trackerId, name: 'Integration habit', description: '', kind: 'habit', status: 'active',
      categoryId: null, tags: [], icon: 'repeat', accent: 'apricot', schedule: { kind: 'every-day' },
      metrics: [{ id: 'done', name: 'Done', valueType: 'boolean' }], customFields: [], milestones: [],
      createdAt: now, updatedAt: now, archivedAt: null, deletedAt: null,
    }
    await localRepository.saveTracker(tracker)
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0, conflicts: 0 })

    const today = localCalendarDate(new Date(), 'UTC')
    const yesterday = shiftCalendarDate(today, -1)
    const draft = (date: string, value: boolean, note = '') => ({ trackerId, date, outcome: 'recorded' as const, values: { done: value }, note })
    await localRepository.saveTrackerEntry(draft(today, false, 'first offline edit'))
    await localRepository.saveTrackerEntry(draft(today, true, 'final offline edit'))
    const provisionalBeforeSync = await getProvisionalXp(userId, today)
    expect(provisionalBeforeSync).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringMatching(/^check-in:/), xpDelta: 10 }),
      expect.objectContaining({ id: `perfect-day:${today}`, xpDelta: 20 }),
    ]))
    expect(await getConfirmedXp(userId)).toBe(0)

    const queued = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', (await localRepository.getTrackerEntry(trackerId, today))!.id]).first()
    expect(queued?.status).toBe('pending')
    const syncResult = await synchronizeWorkspace(userId, client)
    expect(syncResult).toMatchObject({ uploaded: 1, failed: 0, conflicts: 0 })
    const confirmed = await getConfirmedXp(userId)
    expect(confirmed).toBe(30)
    expect(await getProvisionalXp(userId, today)).toEqual([])

    const entry = (await localRepository.getTrackerEntry(trackerId, today))!
    const duplicateRetry = await client.rpc('apply_tracker_sync_operation', {
      p_expected_user_id: userId,
      p_operation_id: queued!.id,
      p_entity: 'tracker_entry',
      p_expected_revision: queued!.expectedRevision,
      p_record: { id: entry.id, tracker_id: trackerId, entry_date: today, outcome: entry.outcome, entry_values: entry.values, note: entry.note, created_at: entry.createdAt, updated_at: entry.updatedAt, deleted_at: entry.deletedAt },
    })
    expect(duplicateRetry.error).toBeNull()
    expect(duplicateRetry.data).toMatchObject({ status: 'applied' })
    expect(await getConfirmedXp(userId)).toBe(confirmed)

    await localRepository.saveTrackerEntry(draft(today, false, 'historical correction'))
    expect(await getProvisionalXp(userId, today)).toEqual([])
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    expect(await getConfirmedXp(userId)).toBe(0)
    expect(await getEarnedAndLockedBadges(userId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ achievementId: 'first-step', earned: false }),
      expect.objectContaining({ achievementId: 'perfect-day', earned: false }),
    ]))
    expect(await getAchievementHistory(userId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ achievementId: 'first-step', eventType: 'revoked' }),
      expect.objectContaining({ achievementId: 'perfect-day', eventType: 'revoked' }),
    ]))

    await localRepository.saveTrackerEntry(draft(today, true, 'requalified'))
    const session = (await client.auth.getSession()).data.session!
    const unavailableRpcClient = createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'progression-live-interrupted' },
      global: { fetch: async (input, init) => {
        if (String(input).includes('/rpc/apply_tracker_sync_operation')) throw new TypeError('integration network interruption')
        return fetch(input, init)
      } },
    })
    await unavailableRpcClient.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
    await expect(synchronizeWorkspace(userId, unavailableRpcClient)).resolves.toMatchObject({ failed: 1, uploaded: 0 })
    const pendingAfterNetworkFailure = await getProvisionalXp(userId, today)
    expect(pendingAfterNetworkFailure).toEqual(expect.arrayContaining([expect.objectContaining({ xpDelta: 10 })]))
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    expect(await getConfirmedXp(userId)).toBe(30)
    expect(await getProvisionalXp(userId, today)).toEqual([])

    await localRepository.saveTrackerEntry(draft(yesterday, true, 'will be rejected'))
    const rejectedEntry = await localRepository.getTrackerEntry(trackerId, yesterday)
    const rejectionOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', rejectedEntry!.id]).first()
    await db.syncOperations.put({ ...rejectionOperation!, payload: { ...rejectedEntry!, trackerId: crypto.randomUUID() } })
    const rejection = await synchronizeWorkspace(userId, client)
    expect(rejection).toMatchObject({ conflicts: 1, failed: 0 })
    await expect(db.syncOperations.get(rejectionOperation!.id)).resolves.toMatchObject({ status: 'conflict' })
    expect((await getProvisionalXp(userId, today)).some((reward) => reward.id.includes(rejectedEntry!.id))).toBe(false)
    expect(await getConfirmedXp(userId)).toBe(30)

    await localRepository.saveTrackerEntry(draft(today, false, 'second device wins'))
    const staleEntry = await localRepository.getTrackerEntry(trackerId, today)
    const staleOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', staleEntry!.id]).first()
    const stalePayload = { id: staleEntry!.id, tracker_id: trackerId, entry_date: today, outcome: 'recorded', entry_values: { done: true }, note: 'cloud edit', created_at: staleEntry!.createdAt, updated_at: new Date(Date.now() + 1000).toISOString(), deleted_at: null }
    const cloudEdit = await client.rpc('apply_tracker_sync_operation', { p_expected_user_id: userId, p_operation_id: crypto.randomUUID(), p_entity: 'tracker_entry', p_expected_revision: staleOperation!.expectedRevision, p_record: stalePayload })
    expect(cloudEdit.error).toBeNull()
    const staleSync = await synchronizeWorkspace(userId, client)
    expect(staleSync.conflicts).toBeGreaterThan(0)
    await expect(db.syncOperations.get(staleOperation!.id)).resolves.toMatchObject({ status: 'conflict' })

    // PostgreSQL session-level barrier: both independent psql transactions are
    // confirmed waiting before they are released together.
    await overlapPostgresTransactions(userId, [
      `SELECT public.initialize_progression_account('${userId}'::uuid);`,
      `SELECT public.initialize_progression_account('${userId}'::uuid);`,
    ], 'postgres')
    // This account was initialized as new before it had any retained history.
    // Concurrent retries must preserve that honest unavailable/new-account
    // state rather than fabricate a historical opening balance.
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_account_state WHERE user_id='${userId}';`)).toBe('1')
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_events WHERE user_id='${userId}' AND reason_code='LEGACY_XP_OPENING_BALANCE';`)).toBe('0')

    const revisionQuery = await client.from('tracker_entries').select('id,server_revision,created_at,updated_at').eq('tracker_id', trackerId).eq('entry_date', today).single()
    if (revisionQuery.error || !revisionQuery.data) throw new Error(`Could not load the revision-conflict fixture: ${revisionQuery.error?.message ?? 'missing entry'}`)
    const revisionEntry = revisionQuery.data
    const concurrentRevision = revisionEntry.server_revision as number
    const contestedPayload = (note: string) => JSON.stringify({ id: revisionEntry.id, tracker_id: trackerId, entry_date: today, outcome: 'recorded', entry_values: { done: true }, note, created_at: revisionEntry.created_at, updated_at: new Date(Date.now() + 2000).toISOString(), deleted_at: null })
    const revisionStatements = ['device A', 'device B'].map((note) => `SELECT (public.apply_tracker_sync_operation('${userId}'::uuid,'${crypto.randomUUID()}'::uuid,'tracker_entry',${concurrentRevision},$payload$${contestedPayload(note)}$payload$::jsonb)->>'status');`) as [string, string]
    const concurrentRevisionResults = (await overlapPostgresTransactions(userId, revisionStatements)).join('\n')
    expect((concurrentRevisionResults.match(/applied/g) ?? []).length).toBe(1)
    expect((concurrentRevisionResults.match(/conflict/g) ?? []).length).toBe(1)

    const perfectDayEntry = await client.from('tracker_entries').select('*').eq('tracker_id', trackerId).eq('entry_date', today).single()
    expect(perfectDayEntry.error).toBeNull()
    const removeQualification = await client.rpc('apply_tracker_sync_operation', {
      p_expected_user_id: userId, p_operation_id: crypto.randomUUID(), p_entity: 'tracker_entry', p_expected_revision: perfectDayEntry.data.server_revision,
      p_record: { id: perfectDayEntry.data.id, tracker_id: trackerId, entry_date: today, outcome: 'recorded', entry_values: { done: false }, note: 'temporarily unqualified', created_at: perfectDayEntry.data.created_at, updated_at: now, deleted_at: null },
    })
    expect(removeQualification.error).toBeNull()
    expect(await queryLocalDatabase(`SELECT current_xp FROM public.progression_award_state WHERE user_id='${userId}' AND reason_code='PERFECT_DAY_BONUS';`)).toBe('0')
    const unqualifiedRow = await client.from('tracker_entries').select('*').eq('id', perfectDayEntry.data.id).single()
    const requalificationPayload = JSON.stringify({ id: perfectDayEntry.data.id, tracker_id: trackerId, entry_date: today, outcome: 'recorded', entry_values: { done: true }, note: 'concurrent requalification', created_at: perfectDayEntry.data.created_at, updated_at: now, deleted_at: null })
    const perfectDayStatements = [crypto.randomUUID(), crypto.randomUUID()].map((operationId) => `SELECT (public.apply_tracker_sync_operation('${userId}'::uuid,'${operationId}'::uuid,'tracker_entry',${unqualifiedRow.data.server_revision},$payload$${requalificationPayload}$payload$::jsonb)->>'status');`) as [string, string]
    const perfectDay = (await overlapPostgresTransactions(userId, perfectDayStatements)).join('\n')
    expect((perfectDay.match(/applied/g) ?? []).length).toBe(1)
    expect((perfectDay.match(/conflict/g) ?? []).length).toBe(1)
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_award_state WHERE user_id='${userId}' AND reason_code='PERFECT_DAY_BONUS' AND current_xp>0;`)).toBe('1')

    const partialTracker = { ...tracker, id: crypto.randomUUID(), name: 'Partial sync fixture', createdAt: now, updatedAt: now }
    await localRepository.saveTracker(partialTracker)
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    const partialFirst = await localRepository.saveTrackerEntry({ trackerId: partialTracker.id, date: today, outcome: 'recorded', values: { done: true }, note: 'first transaction commits' })
    const partialSecond = await localRepository.saveTrackerEntry({ trackerId: partialTracker.id, date: yesterday, outcome: 'recorded', values: { done: true }, note: 'second transaction rejected' })
    const partialFirstOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', partialFirst.id]).first()
    const partialSecondOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', partialSecond.id]).first()
    await db.syncOperations.update(partialFirstOperation!.id, { createdAt: '2000-01-01T00:00:00.000Z' })
    await db.syncOperations.update(partialSecondOperation!.id, { createdAt: '2000-01-01T00:00:01.000Z', payload: { ...partialSecond, trackerId: crypto.randomUUID() } })
    const xpBeforePartial = await getConfirmedXp(userId)
    const partialResult = await synchronizeWorkspace(userId, client)
    expect(partialResult.uploaded).toBe(1)
    expect(partialResult.conflicts).toBeGreaterThan(0)
    expect((await client.from('tracker_entries').select('id').eq('id', partialFirst.id).maybeSingle()).data?.id).toBe(partialFirst.id)
    expect((await client.from('tracker_entries').select('id').eq('id', partialSecond.id).maybeSingle()).data).toBeNull()
    const xpAfterPartial = await getConfirmedXp(userId)
    expect(xpAfterPartial).toBeGreaterThan(xpBeforePartial)
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_event_sources s JOIN public.progression_events e ON e.user_id=s.user_id AND e.id=s.event_id WHERE s.user_id='${userId}' AND s.source_id='${partialFirst.id}' AND e.reason_code='DAILY_CHECK_IN_COMPLETED';`)).toBe('1')
    expect(await getProvisionalXp(userId, today)).toEqual([])

    const fixedPayload = { ...partialSecond, trackerId: partialTracker.id }
    await db.syncConflicts.delete(partialSecondOperation!.id)
    await db.syncOperations.put({ ...partialSecondOperation!, status: 'pending', expectedRevision: null, payload: fixedPayload, attempts: partialSecondOperation!.attempts + 1, lastError: null })
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    expect((await client.from('tracker_entries').select('id').eq('id', partialSecond.id).maybeSingle()).data?.id).toBe(partialSecond.id)
    expect(await getConfirmedXp(userId)).toBe(xpAfterPartial)

    const duplicateTracker = { ...tracker, id: crypto.randomUUID(), name: 'Concurrent duplicate fixture', createdAt: now, updatedAt: now }
    await localRepository.saveTracker(duplicateTracker)
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    const duplicateDate = shiftCalendarDate(today, -1)
    const duplicateEntryId = crypto.randomUUID()
    const duplicateOperationId = crypto.randomUUID()
    const duplicatePayload = JSON.stringify({ id: duplicateEntryId, tracker_id: duplicateTracker.id, entry_date: duplicateDate, outcome: 'recorded', entry_values: { done: true }, note: 'duplicate race', created_at: now, updated_at: now, deleted_at: null })
    const duplicateStatement = `SELECT (public.apply_tracker_sync_operation('${userId}'::uuid,'${duplicateOperationId}'::uuid,'tracker_entry',NULL,$payload$${duplicatePayload}$payload$::jsonb)->>'status');`
    const duplicateResults = await overlapPostgresTransactions(userId, [duplicateStatement, duplicateStatement])
    expect(duplicateResults.every((result) => result === 'applied')).toBe(true)
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.tracker_entries WHERE user_id='${userId}' AND id='${duplicateEntryId}';`)).toBe('1')

    // The integration suite uses a disposable account. Move its cutover back
    // seven days so the following seven-day run is post-cutover and eligible.
    // Production cutovers are never rewritten by the application.
    const streakCutover = `${shiftCalendarDate(today, -7)}T00:00:00.000Z`
    await queryLocalDatabase(`UPDATE public.progression_account_state SET initialized_at='${streakCutover}'::timestamptz WHERE user_id='${userId}'; UPDATE public.progression_achievement_accounts SET initialized_at='${streakCutover}'::timestamptz WHERE user_id='${userId}';`)

    const streakCreatedAt = `${shiftCalendarDate(today, -6)}T00:00:00.000Z`
    const streakTracker = { ...tracker, id: crypto.randomUUID(), name: 'Concurrent streak fixture', createdAt: streakCreatedAt, updatedAt: streakCreatedAt }
    await localRepository.saveTracker(streakTracker)
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    for (let offset = -6; offset <= -2; offset += 1) {
      await localRepository.saveTrackerEntry({ trackerId: streakTracker.id, date: shiftCalendarDate(today, offset), outcome: 'recorded', values: { done: true }, note: '' })
    }
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 5, failed: 0 })
    const streakPenultimate = await localRepository.saveTrackerEntry({ trackerId: streakTracker.id, date: shiftCalendarDate(today, -1), outcome: 'recorded', values: { done: true }, note: 'concurrent streak day six' })
    const streakFinal = await localRepository.saveTrackerEntry({ trackerId: streakTracker.id, date: today, outcome: 'recorded', values: { done: true }, note: 'concurrent streak day seven' })
    const streakPenultimateOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', streakPenultimate.id]).first()
    const streakFinalOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', streakFinal.id]).first()
    const streakStatement = (operation: NonNullable<typeof streakPenultimateOperation>, entry: StoredTrackerEntry) => `SELECT (public.apply_tracker_sync_operation('${userId}'::uuid,'${operation.id}'::uuid,'tracker_entry',${operation.expectedRevision ?? 'NULL'},$payload$${JSON.stringify(serverEntryPayload(entry))}$payload$::jsonb)->>'status');`
    const streakSubmissions = await overlapPostgresTransactions(userId, [streakStatement(streakPenultimateOperation!, streakPenultimate), streakStatement(streakFinalOperation!, streakFinal)])
    expect(streakSubmissions).toEqual(['applied', 'applied'])
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 2, failed: 0 })
    const streakRace = await overlapPostgresTransactions(userId, [
      `SELECT public.reconcile_progression_tracker_milestones('${userId}'::uuid,'${streakTracker.id}'::uuid);`,
      `SELECT public.reconcile_progression_tracker_milestones('${userId}'::uuid,'${streakTracker.id}'::uuid);`,
    ], 'postgres')
    expect(streakRace).toHaveLength(2)
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_award_state WHERE user_id='${userId}' AND tracker_id='${streakTracker.id}' AND reason_code='STREAK_MILESTONE' AND current_xp>0;`)).toBe('1')

    const goalTracker: StoredTrackerDefinition = {
      ...tracker, id: crypto.randomUUID(), name: 'Concurrent goal fixture', kind: 'goal',
      metrics: [{ id: 'pages', name: 'Pages', valueType: 'quantity', unit: 'pages', thresholds: { direction: 'increase', minimum: 1, target: 10, stretch: 20, streakQualification: 'minimum' } }],
      milestones: [{ id: 'checkpoint-10', title: 'Reach ten', description: '', metricId: 'pages', targetValue: 10, position: 0 }],
    }
    await localRepository.saveTracker(goalTracker)
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    const goalEntry = await localRepository.saveTrackerEntry({ trackerId: goalTracker.id, date: today, outcome: 'recorded', values: { pages: 12 }, note: '' })
    const goalEntryOperation = await db.syncOperations.where('[ownerUserId+entity+entityId]').equals([userId, 'tracker_entry', goalEntry.id]).first()
    const goalSubmission = `SELECT (public.apply_tracker_sync_operation('${userId}'::uuid,'${goalEntryOperation!.id}'::uuid,'tracker_entry',NULL,$payload$${JSON.stringify(serverEntryPayload(goalEntry))}$payload$::jsonb)->>'status');`
    expect(await overlapPostgresTransactions(userId, [goalSubmission, goalSubmission])).toEqual(['applied', 'applied'])
    await expect(synchronizeWorkspace(userId, client)).resolves.toMatchObject({ uploaded: 1, failed: 0 })
    const goalRace = await overlapPostgresTransactions(userId, [
      `SELECT public.reconcile_progression_goal_tracker('${userId}'::uuid,'${goalTracker.id}'::uuid);`,
      `SELECT public.reconcile_progression_goal_tracker('${userId}'::uuid,'${goalTracker.id}'::uuid);`,
    ], 'postgres')
    expect(goalRace).toHaveLength(2)
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_award_state WHERE user_id='${userId}' AND tracker_id='${goalTracker.id}' AND reason_code='GOAL_MILESTONE' AND current_xp>0;`)).toBe('1')

    const achievementRace = await overlapPostgresTransactions(userId, [
      `SELECT public.reconcile_progression_achievements('${userId}'::uuid);`,
      `SELECT public.reconcile_progression_achievements('${userId}'::uuid);`,
    ], 'postgres')
    expect(achievementRace).toHaveLength(2)
    const historyCountBeforeReconcile = await queryLocalDatabase(`SELECT count(*) FROM public.progression_achievement_events WHERE user_id='${userId}';`)
    await overlapPostgresTransactions(userId, [
      `SELECT public.reconcile_progression_achievements('${userId}'::uuid);`,
      `SELECT public.reconcile_progression_achievements('${userId}'::uuid);`,
    ], 'postgres')
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_achievement_events WHERE user_id='${userId}';`)).toBe(historyCountBeforeReconcile)

    const reverseEntryId = revisionEntry.id
    const latestRevision = await queryLocalDatabase(`SELECT server_revision FROM public.tracker_entries WHERE user_id='${userId}' AND id='${reverseEntryId}';`)
    const reversePayload = (deletedAt: string | null) => JSON.stringify({ id: reverseEntryId, tracker_id: trackerId, entry_date: today, outcome: 'recorded', entry_values: { done: false }, note: 'competing correction', created_at: revisionEntry.created_at, updated_at: new Date(Date.now() + 3000).toISOString(), deleted_at: deletedAt })
    const reversalStatements = [null, now].map((deletedAt) => `SELECT (public.apply_tracker_sync_operation('${userId}'::uuid,'${crypto.randomUUID()}'::uuid,'tracker_entry',${latestRevision},$payload$${reversePayload(deletedAt)}$payload$::jsonb)->>'status');`) as [string, string]
    const reversalRace = (await overlapPostgresTransactions(userId, reversalStatements)).join('\n')
    expect((reversalRace.match(/applied/g) ?? []).length).toBe(1)
    expect((reversalRace.match(/conflict/g) ?? []).length).toBe(1)
    expect(await queryLocalDatabase(`SELECT coalesce(sum(e.xp_delta),0) FROM public.progression_events e WHERE e.id IN (SELECT event_id FROM public.progression_event_sources WHERE user_id='${userId}' AND source_id='${reverseEntryId}') OR e.reverses_event_id IN (SELECT event_id FROM public.progression_event_sources WHERE user_id='${userId}' AND source_id='${reverseEntryId}');`)).toBe('0')

    const rollbackTrackerId = crypto.randomUUID()
    const rollbackEntryId = crypto.randomUUID()
    const rollbackTracker: StoredTrackerDefinition = { ...tracker, id: rollbackTrackerId, name: 'Rolled back fixture' }
    const rollbackTrackerRecord = { id: rollbackTrackerId, schema_version: 1, kind: 'habit', status: 'active', name: rollbackTracker.name, definition: rollbackTracker, created_at: now, updated_at: now, deleted_at: null }
    const rollbackEntryRecord = { id: rollbackEntryId, tracker_id: rollbackTrackerId, entry_date: today, outcome: 'recorded', entry_values: { done: true }, note: '', created_at: now, updated_at: now, deleted_at: null }
    await queryLocalDatabase(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; SELECT public.apply_tracker_sync_operation('${userId}'::uuid,'${crypto.randomUUID()}'::uuid,'tracker',NULL,$tracker$${JSON.stringify(rollbackTrackerRecord)}$tracker$::jsonb); SELECT public.apply_tracker_sync_operation('${userId}'::uuid,'${crypto.randomUUID()}'::uuid,'tracker_entry',NULL,$entry$${JSON.stringify(rollbackEntryRecord)}$entry$::jsonb); ROLLBACK;`)
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.trackers WHERE user_id='${userId}' AND id='${rollbackTrackerId}';`)).toBe('0')
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.tracker_entries WHERE user_id='${userId}' AND id='${rollbackEntryId}';`)).toBe('0')
    expect(await queryLocalDatabase(`SELECT count(*) FROM public.progression_events e JOIN public.progression_event_sources s ON s.user_id=e.user_id AND s.event_id=e.id WHERE s.tracker_id='${rollbackTrackerId}';`)).toBe('0')

    const ownershipFailure = await client.rpc('apply_tracker_sync_operation', {
      p_expected_user_id: crypto.randomUUID(), p_operation_id: crypto.randomUUID(), p_entity: 'tracker', p_expected_revision: null,
      p_record: { id: crypto.randomUUID(), schema_version: 1, kind: 'habit', status: 'active', name: 'must not create', definition: { ...tracker, id: crypto.randomUUID() }, created_at: now, updated_at: now, deleted_at: null },
    })
    expect(ownershipFailure.error?.code).toBe('42501')
  }, 90_000)
})

export { suite as progressionLiveIntegrationSuite }

import { describe, expect, it } from 'vitest'
import { capabilities, capabilityRoutes, capabilityVersion } from './_generated/capabilityBundle'
import { sourceIndex } from './_generated/sourceIndex'
import { knowledgeVersion } from './_generated/knowledgeBundle'
import { sourcePaths, sourceRelationships } from './_generated/sourceBundle'
import { retrieveCapabilities } from './capabilityCore'
import { retrieveSourceExcerpts } from './assistantCore'
import type { CapabilityIndex } from './capabilityCore'

const capabilityIndex: CapabilityIndex = { version: capabilityVersion, routes: capabilityRoutes, capabilities: capabilities as unknown as CapabilityIndex['capabilities'] }

const benchmark = [
  ['D1', 'What does the sync engine do when a server revision conflicts with the local tracker revision?', 'src/services/supabase/syncEngine.ts'],
  ['D2', 'Which timestamp and owner fields are included when a check-in is serialized for upload?', 'src/services/supabase/syncEngine.ts'],
  ['D3', 'Which comparison operands are accepted for boolean versus numeric measures?', 'src/domain/trackers/schema.ts'],
  ['D4', 'Does a quantity value of zero qualify for a streak when no explicit streak qualification is configured?', 'src/domain/trackers/progression.ts'],
  ['D5', 'Which measure properties may change without changing a measure’s historical meaning?', 'src/domain/trackers/invariants.ts'],
  ['C1', 'Why does changing a tracker’s start date preserve historical check-ins?', 'src/features/trackers/TrackerConfigurationEditor.tsx'],
  ['C2', 'How does the application prevent writes to archived trackers?', 'supabase/migrations/20261030000400_tracker_archived_entry_guard.sql'],
  ['C3', 'What happens to offline changes when a tracker is moved to Bin?', 'src/db/localRepository.ts'],
  ['C4', 'How are AI Help ratings separated from general support feedback?', 'supabase/migrations/20261031000100_route_ai_answer_feedback_separately.sql'],
  ['C5', 'How does the application enforce ownership when syncing data?', 'supabase/migrations/20261009000200_sync_write_boundary.sql'],
  ['DB1', 'What row ownership policy protects support feedback threads?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['DB2', 'Can an authenticated user read the support email outbox?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['DB3', 'Which role can invoke support_maintainer_reply?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['DB4', 'How does the tracker metric trigger reject changing a saved type?', 'supabase/migrations/20261018000100_tracker_metric_integrity.sql'],
  ['DB5', 'Why might a support conversation status update fail?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['F1', 'What happens to tracker form state when the user cancels editing?', 'src/features/trackers/TrackerSetupPage.tsx'],
  ['F2', 'How does the History page resolve a measure name for an old entry?', 'src/features/history/HistoryPage.tsx'],
  ['F3', 'When does the goals page show the cumulative deadline validation error?', 'src/features/goals/GoalsPage.tsx'],
  ['F4', 'How is the selected workspace timezone persisted?', 'src/features/settings/WorkspaceTimeZone.tsx'],
  ['F5', 'How does the Today page behave when a required check-in field is missing?', 'src/features/today/TodayPage.tsx'],
  ['E1', 'How does the AI Help Edge Function handle a Groq 429 response?', 'supabase/functions/ai-help/assistantCore.ts'],
  ['E2', 'What does AI Help send to Groq about source excerpts?', 'supabase/functions/ai-help/assistantCore.ts'],
  ['E3', 'How does the support inbox authenticate a maintainer?', 'supabase/functions/support-inbox/index.ts'],
  ['E4', 'How does send-feedback prevent duplicate provider email sends?', 'supabase/functions/send-feedback/feedbackCore.ts'],
  ['E5', 'What conditions cause the AI Help Edge Function to reject an origin?', 'supabase/functions/ai-help/index.ts'],
] as const

const paraphrases = [
  ['Which fields go on a check-in when it syncs to the server?', 'src/services/supabase/syncEngine.ts'],
  ['Can a numeric measure use greater-than comparisons?', 'src/domain/trackers/schema.ts'],
  ['Does editing the tracker start date rewrite saved entries?', 'src/features/trackers/TrackerConfigurationEditor.tsx'],
  ['Where is an archived tracker check-in blocked by the database?', 'supabase/migrations/20261030000400_tracker_archived_entry_guard.sql'],
  ['How do database writes make sure the signed-in user owns the record?', 'supabase/migrations/20261009000200_sync_write_boundary.sql'],
  ['Which status update function rejects an old expected timestamp?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['Where is the workspace time zone preference saved?', 'src/features/settings/WorkspaceTimeZone.tsx'],
  ['How does sync record a conflict for a stale server revision?', 'src/services/supabase/syncEngine.ts'],
  ['What Origin checks happen before AI Help accepts a request?', 'supabase/functions/ai-help/index.ts'],
  ['Can History still show a retired measure name for an old entry?', 'src/features/history/HistoryPage.tsx'],
] as const

const lexicalDrift = [
  ['Which properties of an old metric are allowed to change?', 'src/domain/trackers/invariants.ts'],
  ['What exactly gets written into the queued check-in request?', 'src/services/supabase/syncEngine.ts'],
  ['Can a boolean rule compare greater-than, or only equality?', 'src/domain/trackers/schema.ts'],
  ['If I move the tracker start date forward, does it erase earlier logs?', 'src/db/localRepository.ts'],
  ['Where is the server-side guard that blocks entries for archived trackers?', 'supabase/migrations/20261030000400_tracker_archived_entry_guard.sql'],
  ['What database rule keeps one person from reading another person’s support thread?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['What happens if the support status was changed after the inbox loaded?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['Does the timezone preference update the workspace or just this page?', 'src/features/settings/WorkspaceTimeZone.tsx'],
  ['What is done if the server rejects a stale tracker revision?', 'src/services/supabase/syncEngine.ts'],
  ['Which origin checks run before the AI helper handles the request?', 'supabase/functions/ai-help/index.ts'],
] as const

function selectedPaths(question: string): string[] {
  return selectedPathsAt(question, 4)
}

function selectedPathsAt(question: string, limit: number, relationships = sourceRelationships): string[] {
  const matched = retrieveCapabilities(question, [], capabilityIndex, 6)
  const preferred = [...new Set(matched.flatMap((item) => item.evidenceRefs))]
  const text = retrieveSourceExcerpts(question, [], sourceIndex, limit, 5200, '', preferred, relationships)
  const paths = [...text.matchAll(/^SOURCE ([^ ·]+) ·/gm)].map((match) => match[1]!)
  expect(paths.length).toBeLessThanOrEqual(limit)
  return paths
}

const necessarySources: Record<string, readonly string[]> = {
  C1: ['src/features/trackers/TrackerSetupPage.tsx', 'src/db/localRepository.ts', 'src/domain/trackers/planning.ts', 'src/domain/trackers/activityStatus.ts'],
  C2: ['supabase/migrations/20261030000400_tracker_archived_entry_guard.sql', 'src/features/today/TodayPage.tsx'],
  C3: ['src/features/trackers/TrackerBinPage.tsx', 'src/db/localRepository.ts', 'src/services/supabase/syncEngine.ts'],
  C4: ['supabase/migrations/20261031000100_route_ai_answer_feedback_separately.sql', 'supabase/functions/ai-help-feedback/index.ts'],
  C5: ['supabase/migrations/20261009000200_sync_write_boundary.sql', 'src/services/supabase/syncEngine.ts'],
  DB3: ['supabase/migrations/20261030000200_unified_feedback_support.sql', 'supabase/functions/support-inbox/index.ts'],
  E4: ['supabase/functions/send-feedback/feedbackCore.ts', 'supabase/migrations/20261029000100_support_feedback_delivery.sql'],
  E5: ['supabase/functions/ai-help/index.ts', 'src/routes/router.tsx'],
}

// Supplementary phrasing sample. It is reported separately from the unchanged
// benchmark and is not used to set its pass threshold. H7 targets AuthProvider
// because it implements sign-out and workspace selection; WorkspaceBackup only
// handles export/restore and was not the authoritative source for that intent.
const supplementaryWording = [
  ['H1', 'When a day has nothing to log, does the app count it as a miss?', 'src/domain/trackers/activityStatus.ts'],
  ['H2', 'If I check off a holiday, will it still count toward the routine?', 'src/domain/trackers/progression.ts'],
  ['H3', 'Can I change the rule for a streak without changing my old entries?', 'src/domain/trackers/invariants.ts'],
  ['H4', 'Why does the goal show how much I should do each scheduled day?', 'src/domain/trackers/planning.ts'],
  ['H5', 'Can my schedule skip Sundays?', 'src/domain/trackers/planning.ts'],
  ['H6', 'Where does the workspace remember the timezone I chose?', 'src/features/settings/WorkspaceTimeZone.tsx'],
  ['H7', 'What stays in the local workspace if I sign out?', 'src/features/auth/AuthProvider.tsx'],
  ['H8', 'Can I stop future notifications without losing my completed check-ins?', 'src/features/notifications/NotificationsSettings.tsx'],
  ['H9', 'Why did the app keep my previous value after I edited a tracker?', 'src/features/trackers/TrackerSetupPage.tsx'],
  ['H10', 'How does the app decide whether a specific check-in is a success?', 'src/domain/trackers/progression.ts'],
  ['H11', 'What happens if I enter more checklist items than the daily target allows?', 'src/domain/trackers/schema.ts'],
  ['H12', 'Does removing a measure hide its old entries?', 'src/features/history/HistoryPage.tsx'],
  ['H13', 'How is a change to my email address confirmed?', 'src/features/auth/authService.ts'],
  ['H14', 'Why did a sign-in link return me to the page I was using?', 'src/features/auth/AuthPage.tsx'],
  ['H15', 'Does an email confirmation from a new address finish a pending address change?', 'src/features/auth/authService.ts'],
  ['H16', 'Can I connect Google Fit and import workouts automatically?', null],
  ['H17', 'Does ProgressTracker guarantee same-day delivery for transactional email?', null],
  ['H18', 'Can I make a public leaderboard from my tracker?', null],
  ['H19', 'Can I export check-ins directly to a smartwatch?', null],
  ['H20', 'Does AI Help erase Groq requests from provider servers within 24 hours?', null],
] as const

// Final held-out questions were authored only after the retrieval settings
// were frozen. Do not use these examples to tune ranking rules.
const finalHeldOut = [
  ['V1', 'Did the app erase older entries when the active tracker range changed?', 'src/features/trackers/TrackerSetupPage.tsx'],
  ['V2', 'If the server copy changed while my phone was offline, will both versions blend automatically?', 'src/services/supabase/syncEngine.ts'],
  ['V3', 'How can I tell whether a date is outside the period when a tracker counts progress?', 'src/domain/trackers/activityStatus.ts'],
  ['V4', 'What gets sent to the cloud when I add a note to a check-in?', 'src/services/supabase/syncEngine.ts'],
  ['V5', 'Why would an old app still be blocked from adding a check-in to an archived tracker?', 'supabase/migrations/20261030000400_tracker_archived_entry_guard.sql'],
  ['V6', 'Can I record part of a unit, like 1.25, as a measure value?', 'src/domain/trackers/schema.ts'],
  ['V7', 'Does recording zero keep the streak alive?', 'src/domain/trackers/progression.ts'],
  ['V8', 'Can History show the old name of a measure I stopped using?', 'src/features/history/HistoryPage.tsx'],
  ['V9', 'Is Checklist one of the styles I can choose for a brand-new tracker?', 'src/features/trackers/TrackerConfigurationEditor.tsx'],
  ['V10', 'When I plan a goal, where does its unit come from?', 'src/features/goals/GoalsPage.tsx'],
  ['V11', 'What can I do if sending a feedback report does not finish?', 'src/features/feedback/SendFeedback.tsx'],
  ['V12', 'Can another signed-in person read a support thread that belongs to me?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['V13', 'Will opening the link at my new address always finish an email change?', 'src/features/auth/authService.ts'],
  ['V14', 'If I delete my account, are changes still only on this device uploaded first?', 'src/features/settings/AccountDeletion.tsx'],
  ['V15', 'Can support staff see my actual tracker entries from the support inbox?', 'supabase/migrations/20261030000200_unified_feedback_support.sql'],
  ['V16', 'Can the tracker import meetings from Outlook Calendar automatically?', null],
  ['V17', 'Does ProgressTracker charge for creating more than ten trackers?', null],
  ['V18', 'Can reminders be delivered through SMS text messages?', null],
  ['V19', 'Does Groq promise to delete every AI Help prompt within one day?', null],
  ['V20', 'Can I automatically sync steps from Apple Health into a tracker?', null],
] as const

describe('AI Help source retrieval benchmark', () => {
  it('retains a consistent generated bundle version for all source evidence', () => {
    expect(capabilityVersion).toBe(knowledgeVersion)
  })

  it('measures unchanged source-only benchmark prompts at the runtime four-excerpt limit', () => {
    const results = benchmark.map(([id, question, expected]) => ({ id, question, expected, paths: selectedPaths(question) }))
    const groups = ['D', 'C', 'DB', 'F', 'E'].map((prefix) => {
      const subset = results.filter(({ id }) => prefix === 'D' ? /^D\d/.test(id) : id.startsWith(prefix))
      return `${prefix}: ${subset.filter(({ paths, expected }) => paths.includes(expected)).length}/${subset.length}`
    })
    for (const cutoff of [1, 2, 4]) {
      const scoreAt = results.filter(({ question, expected }) => selectedPathsAt(question, cutoff).includes(expected)).length
      console.warn(`Source Recall@${cutoff} ${scoreAt}/${results.length}`)
    }
    const score = results.filter(({ paths, expected }) => paths.includes(expected)).length
    console.warn(`Source Recall@4 ${score}/${results.length}; ${groups.join(', ')}`)
    for (const result of results.filter(({ paths, expected }) => !paths.includes(expected))) console.warn(`Miss ${result.id}: expected ${result.expected}; retrieved ${result.paths.join(', ')}`)
    expect(score, groups.join(', ')).toBeGreaterThanOrEqual(20)
  }, 30_000)

  it('compares lexical-only selection with bounded relationship-aware hybrid selection', () => {
    const lexical = benchmark.filter(([, question, expected]) => selectedPathsAt(question, 4, {}).includes(expected)).length
    const hybrid = benchmark.filter(([, question, expected]) => selectedPathsAt(question, 4).includes(expected)).length
    const categories = ['D', 'C', 'DB', 'F', 'E'].map((prefix) => {
      const rows = benchmark.filter(([id]) => prefix === 'D' ? /^D\d/.test(id) : id.startsWith(prefix))
      const count = (relationships: typeof sourceRelationships) => rows.filter(([, question, expected]) => selectedPathsAt(question, 4, relationships).includes(expected)).length
      return `${prefix} ${count({})}/5→${count(sourceRelationships)}/5`
    })
    const layeredCoverage = (relationships: typeof sourceRelationships) => Object.entries(necessarySources).filter(([id, required]) => {
      const [, question] = benchmark.find(([benchmarkId]) => benchmarkId === id)!
      const paths = selectedPathsAt(question, 4, relationships)
      return required.every((path) => paths.includes(path))
    }).length
    console.warn(`Ablation on unchanged questions: lexical-only ${lexical}/25; lexical plus bounded source relationships ${hybrid}/25; categories ${categories.join(', ')}; all-required-source coverage ${layeredCoverage({})}/${Object.keys(necessarySources).length}→${layeredCoverage(sourceRelationships)}/${Object.keys(necessarySources).length}`)
    // The checked-in pre-change runtime measured 20/25. The hybrid selector
    // must not fall below that frozen deployed baseline; ablation deltas are
    // reported transparently rather than presented as monotonic gains.
    expect(hybrid).toBeGreaterThanOrEqual(20)
  }, 30_000)

  it('measures complete evidence coverage for layered questions', () => {
    const results = Object.entries(necessarySources).map(([id, required]) => {
      const [, question] = benchmark.find(([benchmarkId]) => benchmarkId === id)!
      const paths = selectedPaths(question)
      return { id, required, paths, complete: required.every((path) => paths.includes(path)) }
    })
    const complete = results.filter(({ complete: value }) => value).length
    console.warn(`All-required-source coverage ${complete}/${results.length}; ${results.map(({ id, required, paths }) => `${id}: ${required.filter((path) => paths.includes(path)).length}/${required.length} [${paths.join(', ')}]`).join(' | ')}`)
    expect(complete).toBeGreaterThanOrEqual(2)
  })

  it('retrieves start-date behavior from natural user wording', () => {
    expect(selectedPaths('Why does the app remember my progress after I change the start date?')).toContain('src/features/trackers/TrackerSetupPage.tsx')
  })

  it('selects behavior-bearing excerpts for the three observed unnecessary-refusal questions', () => {
    const offline = retrieveSourceExcerpts('What happens to offline changes when a tracker is moved to Bin?', [], sourceIndex, 4, 5200, 'other', [], sourceRelationships)
    expect(offline).toMatch(/src\/db\/localRepository\.ts|src\/services\/supabase\/syncEngine\.ts/)
    expect(offline).toMatch(/queueSyncMutation|tombstone|pending|syncOperations/)

    const cancel = retrieveSourceExcerpts('What happens to tracker form state when the user cancels editing?', [], sourceIndex, 4, 5200, 'other', [], sourceRelationships)
    expect(cancel).toContain('src/features/trackers/TrackerSetupPage.tsx')
    expect(cancel).toMatch(/dirty|discard|unsaved|confirm/i)

    const payload = retrieveSourceExcerpts('What does AI Help send to Groq about source excerpts?', [], sourceIndex, 4, 5200, 'other', [], sourceRelationships)
    expect(payload).toContain('supabase/functions/ai-help/assistantCore.ts')
    expect(payload).toMatch(/response_format|max_completion_tokens|temperature/)
  })

  it('selects authoritative SQL and provider-delivery evidence for cross-file security and feedback questions', () => {
    const archived = retrieveSourceExcerpts('How does the application prevent writes to archived trackers?', [], sourceIndex, 4, 5200, 'other', [], sourceRelationships)
    expect(archived).toContain('supabase/migrations/20261030000400_tracker_archived_entry_guard.sql')
    expect(archived).toContain('src/features/today/TodayPage.tsx')

    const ratings = retrieveSourceExcerpts('How are AI Help ratings separated from general support feedback?', [], sourceIndex, 4, 5200, 'other', [], sourceRelationships)
    expect(ratings).toContain('supabase/migrations/20261031000100_route_ai_answer_feedback_separately.sql')

    const delivery = retrieveSourceExcerpts('How does send-feedback prevent duplicate provider email sends?', [], sourceIndex, 4, 5200, 'other', [], sourceRelationships)
    expect(delivery).toContain('supabase/migrations/20261029000100_support_feedback_delivery.sql')
    expect(delivery).toMatch(/support_feedback_send_attempts|begin_support_feedback_submission|delivery_state/)

    const rpcAccess = retrieveSourceExcerpts('Which role can invoke support_maintainer_reply?', [], sourceIndex, 4, 5200, 'other', [], sourceRelationships)
    expect(rpcAccess).toContain('supabase/migrations/20261030000200_unified_feedback_support.sql')
    expect(rpcAccess).toMatch(/grant execute|revoke all on function/i)
    expect(rpcAccess).toContain('supabase/functions/support-inbox/index.ts')
  })

  it('keeps generated source relationships bounded to reviewed bundle files', () => {
    expect(Object.keys(sourceRelationships).sort()).toEqual([...sourcePaths].sort())
    for (const related of Object.values(sourceRelationships)) expect(related.every((path) => sourcePaths.includes(path))).toBe(true)
    expect(sourceRelationships['src/features/trackers/TrackerBinPage.tsx']).toContain('src/db/localRepository.ts')
    expect(sourceRelationships['supabase/migrations/20261031000100_route_ai_answer_feedback_separately.sql']).toContain('supabase/migrations/20261030000200_unified_feedback_support.sql')
  })

  it('is deterministic and obeys the runtime excerpt and character budgets', () => {
    const question = 'How does sync preserve both versions when two devices edit the same tracker?'
    const first = selectedPaths(question)
    expect(selectedPaths(question)).toEqual(first)
    const text = retrieveSourceExcerpts(question, [], sourceIndex, 4, 5200, '', [], sourceRelationships)
    expect(text.length).toBeLessThanOrEqual(5200)
    expect(new Set(first).size).toBe(first.length)
    expect(first.length).toBeLessThanOrEqual(4)
  })

  it('measures local retrieval cost without making an external request', () => {
    const samples: number[] = []
    for (let index = 0; index < 80; index += 1) {
      const started = performance.now()
      selectedPaths('Why does my offline check-in stay saved after a tracker edit?')
      samples.push(performance.now() - started)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length * 0.5)] ?? 0
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0
    console.warn(`Local Vitest retrieval latency: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms across ${samples.length} warm calls; not a Deno or deployed Edge measurement.`)
  }, 15000)

  it('records supplementary natural-language and unsupported questions', () => {
    const answerable = supplementaryWording.filter(([, , expected]) => expected !== null)
    const results = answerable.map(([id, question, expected]) => ({ id, expected: expected!, paths: selectedPaths(question) }))
    const score = results.filter(({ expected, paths }) => paths.includes(expected)).length
    console.warn(`Supplementary wording Recall@4 ${score}/${results.length} (five unsupported questions were excluded)`)
    for (const result of results.filter(({ expected, paths }) => !paths.includes(expected))) console.warn(`Supplementary miss ${result.id}: expected ${result.expected}; retrieved ${result.paths.join(', ')}`)
    const unsupported = supplementaryWording.filter(([, , expected]) => expected === null).map(([id, question]) => ({ id, paths: selectedPaths(question) }))
    console.warn(`Unsupported-query retrieval returned source context for ${unsupported.filter(({ paths }) => paths.length > 0).length}/5; this is retrieval only, not a measured model abstention rate.`)
  })

  it('measures a frozen 20-question held-out set without tuning on its results', () => {
    const answerable = finalHeldOut.filter(([, , expected]) => expected !== null)
    const results = answerable.map(([id, question, expected]) => ({ id, expected: expected!, paths: selectedPaths(question) }))
    const score = results.filter(({ expected, paths }) => paths.includes(expected)).length
    console.warn(`Final held-out Recall@4 ${score}/${results.length} (five unsupported questions were excluded)`)
    for (const result of results.filter(({ expected, paths }) => !paths.includes(expected))) console.warn(`Held-out miss ${result.id}: expected ${result.expected}; retrieved ${result.paths.join(', ')}`)
    const unsupported = finalHeldOut.filter(([, , expected]) => expected === null).map(([id, question]) => ({ id, paths: selectedPaths(question) }))
    console.warn(`Final held-out unsupported questions with source context: ${unsupported.filter(({ paths }) => paths.length > 0).length}/5; answer abstention is unmeasured.`)
  })

  it('generalizes to paraphrased implementation questions', () => {
    const results = paraphrases.map(([question, expected]) => selectedPaths(question).includes(expected))
    const score = results.filter(Boolean).length
    console.warn(`Paraphrased source retrieval ${score}/${results.length}`)
    expect(score).toBeGreaterThanOrEqual(4)
  })

  it('records performance on high lexical-drift implementation wording', () => {
    const results = lexicalDrift.map(([question, expected]) => selectedPaths(question).includes(expected))
    const score = results.filter(Boolean).length
    console.warn(`High lexical-drift source retrieval ${score}/${results.length}`)
    expect(score).toBeGreaterThanOrEqual(3)
  })
})

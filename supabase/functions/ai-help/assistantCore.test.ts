import { describe, expect, it, vi } from 'vitest'
import { buildFollowUpSuggestions, buildHelpMessages, buildRetrievalQuery, classifyHelpIntent, deterministicProductAnswer, documentationCoverage, hasUnverifiedEmailClaim, hasUnsupportedNavigationClaim, hasUnsupportedUnavailableWorkflowClaim, parseGroqCompletion, parseRetryAfter, providerHealthTransition, ProviderRequestError, rankKnowledgeDocuments, rankSourceIndex, rankVerifiedCatalog, renderVerifiedKnowledge, requestGroqCompletion, retrieveSourceExcerpts, retrieveVerifiedCatalog, selectRelevantLinkIds, shouldUseDeterministicAnswer, socialConversationReply } from './assistantCore'
import type { AssistantHistoryItem } from './validation'
import { knowledgeDocuments } from './_generated/knowledgeBundle'
import { sourceIndex } from './_generated/sourceIndex'
import { verifiedQuestionCatalog } from './_generated/knowledgeBundle'

const measureGuide = { slug: 'measures', title: 'Measures', path: 'docs/ai-help/measures-and-success-rules.md', content: 'New measures are Yes/No or Quantity. Existing Duration and Checklist measures remain supported.' }
const goalGuide = { slug: 'goals', title: 'Goals', path: 'docs/ai-help/goals-and-milestones.md', content: 'Daily checklist targets cannot exceed item count; cumulative goals can count incremental items.' }
const docs = [measureGuide, goalGuide, { slug: 'streaks', title: 'Streaks', path: 'docs/ai-help/schedules-and-streaks.md', content: 'Streaks use scheduled check-in days.' }]
const sourceEntries = [
  { path: 'src/domain/trackers/invariants.ts', symbol: 'assertTrackerInvariant', kind: 'implementation' as const, startLine: 20, endLine: 32, terms: 'measure type immutable history saved meaning', content: 'A saved measure type cannot change because its historical values use that interpretation.' },
  { path: 'src/domain/trackers/schema.test.ts', symbol: 'rejectsTypeChanges', kind: 'test' as const, startLine: 80, endLine: 91, terms: 'measure type immutable history saved', content: 'Test: rejects changing a saved measure type.' },
  { path: 'src/features/goals/GoalsPage.tsx', symbol: 'calculateGoalProgress', kind: 'implementation' as const, startLine: 120, endLine: 132, terms: 'goal progress cumulative target', content: 'Goal progress is calculated from the saved plan and eligible entries.' },
]

describe('AI Help retrieval and provider boundary', () => {
  it('retrieves verified answers for the three previously failing questions and their paraphrases', () => {
    const cases = [
      ['How do streak statistics work?', 'streak-statistics', /current streak|longest streak/i],
      ['How is completion rate calculated?', 'completion-rate', /qualifying opportunities divided by the number of counted opportunities/i],
      ['What does History include?', 'history-includes', /saved check-ins.*holidays.*missing check-in/i],
    ] as const
    for (const [question, id, answer] of cases) {
      const result = retrieveVerifiedCatalog(question, verifiedQuestionCatalog)
      expect(result?.id).toBe(id)
      expect(result?.answer).toMatch(answer)
    }
    expect(retrieveVerifiedCatalog('How do you calculate my completion percentage?', verifiedQuestionCatalog)?.id).toBe('completion-rate')
    expect(retrieveVerifiedCatalog('Why does History not show every date?', verifiedQuestionCatalog)?.id).toBe('history-includes')
    expect(retrieveVerifiedCatalog('Why did my streak reset?', verifiedQuestionCatalog)?.id).toBe('streak-statistics')
    expect(retrieveVerifiedCatalog('How do I cook pasta?', verifiedQuestionCatalog)).toBeNull()
  })
  it('evaluates representative natural phrasing, ambiguity, and unsupported requests', () => {
    const cases = [
      ['Why did my streak reset?', 'streak-statistics'],
      ['Do holidays count against my streak?', 'holidays-streaks'],
      ['What is the difference between skipped and not checked?', 'skipped-vs-unchecked'],
      ['Can I undo a check-in?', 'clear-checkin'],
      ['What happens if I clear yesterday’s progress?', 'clear-checkin'],
      ['Where do I review missed check-ins?', 'missing-checkins'],
      ['Why does History not show every date?', 'history-includes'],
      ['Can I use this without internet?', 'offline-sync'],
      ['Will my progress appear on another device?', 'cross-device-sync'],
      ['What happens if two devices edit the same day?', 'sync-conflicts'],
      ['Can AI Help read my check-in values?', 'ai-help-private-data'],
    ] as const
    const retrieved = cases.map(([question, id]) => retrieveVerifiedCatalog(question, verifiedQuestionCatalog)?.id === id)
    expect(retrieved.filter(Boolean)).toHaveLength(cases.length)
    expect(retrieveVerifiedCatalog('What is my percentage?', verifiedQuestionCatalog)).toBeNull()
    expect(retrieveVerifiedCatalog('Can the app calculate my annual tax return?', verifiedQuestionCatalog)).toBeNull()
  })
  it('keeps catalog ranking distinct and conservative for ambiguous prompts', () => {
    const ranked = rankVerifiedCatalog('How do streak statistics work?', verifiedQuestionCatalog)
    expect(ranked[0]?.entry.id).toBe('streak-statistics')
    expect(retrieveVerifiedCatalog('What is my history?', verifiedQuestionCatalog)).toBeNull()
    expect(retrieveVerifiedCatalog('History', verifiedQuestionCatalog)).toBeNull()
  })
  it('uses a concise user-facing style while retaining grounding, safety, and fallback instructions', () => {
    const prompt = buildHelpMessages({ question: 'How do streak statistics work?', history: [], pageContext: 'analytics', relevantDocs: '', sourceExcerpts: '', verifiedKnowledge: 'Verified answer text', linkIds: [] })[0]!.content
    expect(prompt).toContain('everyday language')
    expect(prompt).toContain('one to three short paragraphs')
    expect(prompt).toContain('Avoid internal filenames, type names, and implementation detail')
    expect(prompt).toContain('source excerpts take priority')
    expect(prompt).toContain('Set supported=false only when the available evidence cannot support a useful answer')
  })
  it('only returns deterministic static support contact answers without source retrieval', () => {
    expect(shouldUseDeterministicAnswer('account', 'What is the support email?')).toBe(true)
    expect(shouldUseDeterministicAnswer('account', 'How can I contact support?')).toBe(true)
    expect(shouldUseDeterministicAnswer('account', 'Can an authenticated user read the support email outbox?')).toBe(false)
    expect(shouldUseDeterministicAnswer('account', 'When will my pending support email arrive?')).toBe(false)
    expect(shouldUseDeterministicAnswer('trackers', 'Where is the Bin?')).toBe(false)
    expect(shouldUseDeterministicAnswer('account', 'How do I delete my account?')).toBe(false)
  })
  it('answers social messages without making product claims', () => {
    expect(socialConversationReply('Helo!')).toMatch(/How can I help/)
    expect(socialConversationReply('Thanks!')).toBe("You're welcome!")
    expect(socialConversationReply('bye')).toMatch(/See you/)
    expect(socialConversationReply('Where is the tracker history?')).toBeNull()
  })
  it('answers verified account and contact workflows deterministically', () => {
    const email = 'spraha.progresstracker@gmail.com'
    expect(deterministicProductAnswer('How do I create an account?', [], email)?.answer).toContain('first use of an email creates an account')
    expect(deterministicProductAnswer('How do I sign in?', [], email)?.answer).toContain('Use password')
    expect(deterministicProductAnswer('How do I set my password?', [], email)?.answer).toContain('Settings → Sync & Data')
    expect(deterministicProductAnswer('How can I delete my account?', [], email)?.answer).toContain('exact word DELETE')
    expect(deterministicProductAnswer('What is your support email?', [], email)?.answer).toBe(`For ProgressTracker support, email ${email}.`)
    expect(deterministicProductAnswer('What is that email?', [{ role: 'user', content: 'How can I contact support?' }], email)?.answer).toBe(`For ProgressTracker support, email ${email}.`)
    expect(deterministicProductAnswer('Can an authenticated user read the support email outbox?', [], email)).toBeNull()
    expect(deterministicProductAnswer('When will my pending support email arrive?', [], email)).toBeNull()
    expect(deterministicProductAnswer('Why are streaks broken?', [], email)).toBeNull()
    expect(hasUnverifiedEmailClaim(`Email ${email}`, email)).toBe(false)
    expect(hasUnverifiedEmailClaim('Email support@example.com', email)).toBe(true)
  })
  it('classifies the six reported question intents and includes the current intent in the prompt', () => {
    expect(classifyHelpIntent('What are measures?')).toBe('explanation')
    expect(classifyHelpIntent('Can I add Checklist measures?')).toBe('instructions')
    expect(classifyHelpIntent("I'm trying to add Checklist measures and having problems.")).toBe('troubleshooting')
    expect(classifyHelpIntent('How can I add Checklist and what should I take care of?')).toBe('instructions')
    expect(classifyHelpIntent('Help me.')).toBe('clarification')
    expect(classifyHelpIntent('Tell me more about Checklist measures.')).toBe('deeper_detail')
    const messages = buildHelpMessages({ question: 'Tell me more about Checklist measures.', history: [], pageContext: 'trackers', relevantDocs: '', sourceExcerpts: '', linkIds: [] })
    expect(messages[0]?.content).toContain('latest turn intent is deeper_detail')
    expect(messages[0]?.content).toContain('add supported information beyond the earlier reply')
  })

  it('resolves follow-up wording and checkbox synonyms against measure and legacy knowledge', () => {
    const history: AssistantHistoryItem[] = [
      { role: 'user', content: 'What are measures?' },
      { role: 'assistant', content: 'Measures are values you record in a tracker.' },
    ]
    expect(rankKnowledgeDocuments('Are there only two types?', history, docs)[0]?.slug).toBe('measures')
    expect(rankKnowledgeDocuments('What about checkbox measures?', history, docs)[0]?.slug).toBe('measures')
    expect(retrieveSourceExcerpts('What about checkbox measures?', history, [{ path: 'tracker.tsx', symbol: 'legacyChecklist', kind: 'implementation', startLine: 1, endLine: 2, terms: 'legacy checklist measure checked items', content: 'Existing Checklist measure with checked items.' }])).toContain('checked items')
  })

  it('retrieves multiple guides for questions spanning checklist goals and legacy type support', () => {
    const result = rankKnowledgeDocuments('Can a checklist measure be used in a cumulative goal?', [], docs, 3).map((doc) => doc.slug)
    expect(result).toContain('measures')
    expect(result).toContain('goals')
  })

  it('builds a contextual prompt that prioritizes the latest turn without trusting prior answers', () => {
    const messages = buildHelpMessages({
      question: 'What about checkbox measures?',
      history: [{ role: 'user', content: 'Are there only two types?' }, { role: 'assistant', content: 'They are Yes/No and Quantity.' }],
      pageContext: 'trackers', relevantDocs: 'Checklist is a legacy format.', sourceExcerpts: 'Checked items are counted.', linkIds: ['trackers'],
    })
    expect(messages[0]?.content).toContain('Answer the latest question first')
    expect(messages[0]?.content).toContain('do not repeat it unless asked')
    expect(messages[0]?.content).toContain('implementation and test excerpts')
    expect(messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('Are there only two types?') })
    expect(messages[2]).toMatchObject({ role: 'assistant', content: expect.stringContaining('unverified') })
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('What about checkbox measures?') })
  })

  it('uses reviewed topic knowledge as evidence and asks Groq to return candidates only when justified', () => {
    const knowledge = renderVerifiedKnowledge([{
      topic_id: 'measures.type_immutability', title: 'Saved measure types stay fixed',
      explanation: 'A saved measure retains its original type.', detailed_explanation: null,
      feature_category: 'trackers', source_refs: ['src/domain/trackers/invariants.ts'],
      source_fingerprints: {}, knowledge_version: 'v1', status: 'verified',
    }])
    const messages = buildHelpMessages({ question: 'Why is this fixed?', history: [], pageContext: 'trackers', relevantDocs: '', verifiedKnowledge: knowledge, sourceExcerpts: 'Current code says type stays fixed.', linkIds: [] })
    expect(messages[0]?.content).toContain('VERIFIED TOPIC measures.type_immutability')
    expect(messages[0]?.content).toContain('knowledge_candidate (object or null)')
    expect(messages[0]?.content).toContain('pending human review')
    expect(messages[0]?.content).toContain('source excerpts take priority when they clearly establish a newer behavior')
  })

  it('keeps retrieval empty when no supplied source is relevant', () => {
    expect(rankKnowledgeDocuments('How do I cook pasta?', [], docs)).toEqual([])
    expect(retrieveSourceExcerpts('How do I cook pasta?', [], sourceEntries)).toBe('')
  })

  it('automatically selects source fallback when documentation does not explain why a rule exists', () => {
    const question = 'Why can’t I change a saved measure type?'
    expect(documentationCoverage(question, [], docs).needsSourceFallback).toBe(true)
    const selected = rankSourceIndex(question, [], sourceEntries)
    expect(selected.map((entry) => entry.path)).toContain('src/domain/trackers/invariants.ts')
    expect(retrieveSourceExcerpts(question, [], sourceEntries)).toContain('lines 20-32')
  })

  it('searches the source index when documentation only partially covers an app question', () => {
    expect(documentationCoverage('Can I archive a goal?', [], docs).needsSourceFallback).toBe(true)
  })

  it('retrieves the actual account deletion process and approved support contact', () => {
    const question = 'How can I delete my ProgressTracker account?'
    const relevantDocs = rankKnowledgeDocuments(question, [], knowledgeDocuments)
    expect(relevantDocs[0]?.content).toContain('Permanently Delete Account')
    expect(relevantDocs[0]?.content).toContain('spraha.progresstracker@gmail.com')
    const evidence = retrieveSourceExcerpts(question, [], sourceIndex)
    expect(evidence).toContain('src/features/settings/AccountDeletion.tsx')
    expect(evidence).toContain('supabase/functions/delete-account/index.ts')
  })

  it('answers Bin questions from current availability and routes to the real page', () => {
    const binAnswer = deterministicProductAnswer('Why are my deleted items not permanently deleting?', [], 'support@example.com')
    expect(binAnswer?.answer).toContain('permanent-delete control appears in app builds with the feature enabled')
    expect(binAnswer?.answer).toContain('server must confirm deletion before this device clears its copy')
    expect(deterministicProductAnswer('Where is the Bin?', [], 'support@example.com')?.answer).toContain('More navigation')
    expect(deterministicProductAnswer('How do I restore a tracker?', [], 'support@example.com')?.answer).toContain('choose Restore')
    expect(deterministicProductAnswer('What happens after 30 days?', [{ role: 'user', content: 'Why are my deleted items not permanently deleting?' }], 'support@example.com')?.answer).toContain('not an automatic deletion schedule')
    expect(deterministicProductAnswer('Why can’t I permanantly delete it?', [{ role: 'user', content: 'Where is the Bin?' }], 'support@example.com')?.answer).toContain('server must confirm deletion')
    const refs = ['src/features/trackers/TrackerBinPage.tsx']
    expect(buildFollowUpSuggestions(refs, 'Where is the Bin?')).toEqual(['How do I restore a tracker from The Bin?', 'What happens after the 30-day recovery period?'])
    expect(selectRelevantLinkIds('Why are my deleted items not permanently deleting?', [])).toEqual(['bin'])
    expect(selectRelevantLinkIds('How do I create a tracker?', [])).toEqual(['create_tracker'])
    expect(selectRelevantLinkIds('How do milestones work?', [])).toEqual(['goals'])
    expect(selectRelevantLinkIds('How do I cook pasta?', [])).toEqual([])
    const ranked = rankSourceIndex('Why are deleted items not permanently deleting?', [], sourceIndex)
    expect(ranked[0]?.path).toBe('src/features/trackers/TrackerBinPage.tsx')
    expect(retrieveSourceExcerpts('Why are deleted items not permanently deleting?', [], sourceIndex)).toContain('permanently delete it at any time')
    expect(rankSourceIndex('How do I restore a tracker?', [], sourceIndex)[0]?.path).toBe('src/features/trackers/TrackerBinPage.tsx')
  })

  it('prevents available-action instructions when current evidence explicitly says the capability is disabled', () => {
    expect(hasUnsupportedUnavailableWorkflowClaim(
      'Tap Permanently delete on the tracker card to erase it now.',
      'The Bin shows “Permanent deletion is locked until the hosted database migration and scheduled cleanup have been verified.”',
    )).toBe(true)
    expect(hasUnsupportedUnavailableWorkflowClaim(
      'Permanent deletion requests are automatically queued when offline.',
      'Permanent deletion is locked until the hosted migration and scheduled cleanup are verified.',
    )).toBe(true)
    expect(hasUnsupportedUnavailableWorkflowClaim(
      'Resolve deletion sync conflicts from The Bin.',
      'SOURCE src/features/trackers/TrackerBinPage.tsx · implementation · The Bin shows Restore and no conflict controls.',
    )).toBe(true)
    expect(hasUnsupportedUnavailableWorkflowClaim(
      'You can enable background push delivery from Settings.',
      'Device permission does not enable closed-app delivery; background sender/scheduler setup is not deployed.',
    )).toBe(true)
    expect(hasUnsupportedUnavailableWorkflowClaim(
      'Choose Restore to bring the tracker back.',
      'The Bin has a Restore button. Permanent deletion is locked until setup is verified.',
    )).toBe(false)
    expect(hasUnsupportedUnavailableWorkflowClaim(
      'Tap Permanently delete to erase it.',
      'The backend provides a permanent deletion endpoint.',
    )).toBe(true)
    expect(hasUnsupportedNavigationClaim('The Bin is under Settings → Bin.', 'The Bin is a separate page at More → Bin.')).toBe(true)
    expect(hasUnsupportedNavigationClaim('Open The Bin at More → Bin.', 'Deleted trackers appear at More → Bin.')).toBe(false)
  })

  it('keeps Bin guidance consistent with current generated product knowledge', () => {
    const core = knowledgeDocuments.filter(({ slug }) => slug === 'core-application').map(({ content }) => content).join('\n')
    expect(core.toLocaleLowerCase()).toContain('production shows the permanent-delete action when')
    expect(core.toLocaleLowerCase()).toContain('automatic cleanup is not configured because')
    expect(core).not.toContain('Permanent deletion is a separate action that removes the tracker')
  })

  it('keeps implementation behavior ahead of test-only matches and limits evidence to relevant indexed chunks', () => {
    const excerpts = retrieveSourceExcerpts('Why can’t I change a saved measure type?', [], sourceEntries)
    expect(excerpts).toContain('src/domain/trackers/invariants.ts')
    expect(excerpts).toContain('assertTrackerInvariant')
    expect(excerpts).not.toContain('GoalsPage.tsx')
  })

  it('adds broad implementation vocabulary for demonstrated retrieval gaps without changing answer content', () => {
    expect(buildRetrievalQuery('What happens to offline changes when a tracker is moved to Bin?', []).terms).toEqual(expect.arrayContaining(['tombstone','queued','reconciliation']))
    expect(buildRetrievalQuery('What does AI Help send to Groq about source excerpts?', []).terms).toEqual(expect.arrayContaining(['response','temperature','completion','token']))
    expect(buildRetrievalQuery('How does send-feedback prevent duplicate provider email sends?', []).terms).toEqual(expect.arrayContaining(['attempt','delivery','state','uncertain']))
  })

  it('instructs evidence-first answers and separates related technical workflows', () => {
    const system = buildHelpMessages({ question: 'Which role can invoke this RPC?', history: [], pageContext: 'other', relevantDocs: '', sourceExcerpts: 'SQL grant evidence', linkIds: [] })[0]!.content
    expect(system).toContain('distinguish database grants and database roles from user authorization performed by an Edge Function')
    expect(system).toContain('provider delivery reservations from support submission idempotency')
    expect(system).toContain('answer it directly and completely instead of returning a generic refusal')
  })

  it('parses Retry-After delta-seconds and HTTP dates with safe fallback', () => {
    expect(parseRetryAfter('17', 0)).toBe(17)
    expect(parseRetryAfter('0', 0)).toBe(1)
    expect(parseRetryAfter(new Date(25_000).toUTCString(), 0)).toBe(25)
    expect(parseRetryAfter('invalid', 0)).toBe(60)
  })

  it('applies bounded provider cooldowns and clears them after a successful response', () => {
    expect(providerHealthTransition(0, true, 429, 17)).toEqual({ failedAttempts: 1, cooldownMs: 17_000 })
    expect(providerHealthTransition(0, true, 429, 3_600)).toEqual({ failedAttempts: 1, cooldownMs: 15 * 60_000 })
    expect(providerHealthTransition(0, true, 503)).toEqual({ failedAttempts: 1, cooldownMs: 30_000 })
    expect(providerHealthTransition(1, true, 503)).toEqual({ failedAttempts: 2, cooldownMs: 60_000 })
    expect(providerHealthTransition(10, false, 200)).toEqual({ failedAttempts: 0, cooldownMs: 0 })
  })

  it('offers only curated follow-ups related to the cited feature', () => {
    expect(buildFollowUpSuggestions(['docs/ai-help/measures-and-success-rules.md'], 'How are measures different?')).toHaveLength(2)
    expect(buildFollowUpSuggestions([], 'How are measures different?')).toEqual([])
  })

  it('uses mocked Groq success and sends only the bounded JSON-mode request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ supported: true, answer: 'Checklist is a legacy type.', source_refs: [measureGuide.path], link_ids: ['trackers', 'unsafe'] }) } }] }), { status: 200 }))
    const result = await requestGroqCompletion({ credentials: [{ slot: 'primary', key: 'test-secret' }], model: 'test-model', messages: [{ role: 'user', content: 'checkbox' }], fetcher })
    expect(parseGroqCompletion(result, new Set([measureGuide.path]), new Set(['trackers']))).toMatchObject({ answer: 'Checklist is a legacy type.', links: ['trackers'], sourceRefs: [measureGuide.path] })
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.response_format).toEqual({ type: 'json_object' })
    expect(request.messages[0].content).toBe('checkbox')
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer test-secret' })
  })

  it('does not rotate credentials on a provider 429 and surfaces retry delay', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '17' } }))
    const onFailure = vi.fn(async () => undefined)
    await expect(requestGroqCompletion({ credentials: [{ slot: 'primary', key: 'one' }, { slot: 'secondary', key: 'two' }], model: 'test', messages: [], fetcher, onFailure }))
      .rejects.toMatchObject({ status: 429, retryAfterSeconds: 17 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledTimes(2)
  })

  it('fails over once after a transient provider failure', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const onFailure = vi.fn(async () => undefined)
    const onSuccess = vi.fn(async () => undefined)
    await expect(requestGroqCompletion({ credentials: [{ slot: 'primary', key: 'one' }, { slot: 'secondary', key: 'two' }], model: 'test', messages: [], fetcher, onFailure, onSuccess })).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onFailure).toHaveBeenCalledWith('primary', 503)
    expect(onSuccess).toHaveBeenCalledWith('secondary')
  })

  it('fails over after a network error without exposing request details', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('sensitive transport details'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const onFailure = vi.fn(async () => undefined)
    await expect(requestGroqCompletion({ credentials: [{ slot: 'primary', key: 'one' }, { slot: 'secondary', key: 'two' }], model: 'test', messages: [], fetcher, onFailure })).resolves.toEqual({ ok: true })
    expect(onFailure).toHaveBeenCalledWith('primary', 0)
    await expect(requestGroqCompletion({ credentials: [{ slot: 'primary', key: 'one' }], model: 'test', messages: [], fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('secret')) })).rejects.toMatchObject({ status: 0 })
  })

  it('rejects malformed or ungrounded model output without exposing it as supported', () => {
    expect(() => parseGroqCompletion({ choices: [{ message: { content: 'not JSON' } }] }, new Set(), new Set())).toThrow(ProviderRequestError)
    const ungrounded = parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({ supported: true, answer: 'Made up', source_refs: [], link_ids: [] }) } }] }, new Set(), new Set())
    expect(ungrounded.answer).toContain('can’t verify')
    expect(ungrounded.offerSupport).toBe(true)
  })

  it('parses structured claims while dropping evidence references outside the retrieved set', () => {
    const parsed = parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({
      supported: true, answer: 'History is at /history.', source_refs: ['src/routes/router.tsx'], link_ids: [],
      claims: [{ text: 'History is at /history.', kind: 'route', evidence_refs: ['src/routes/router.tsx', 'src/private.ts'], capability_ids: ['route.history'] }],
    }) } }] }, new Set(['src/routes/router.tsx']), new Set())
    expect(parsed.claims).toEqual([{ text: 'History is at /history.', kind: 'route', evidenceRefs: ['src/routes/router.tsx'], capabilityIds: ['route.history'], prerequisites: [] }])
    const unsupported = parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({ supported: false, answer: 'Unsupported made up instruction.' }) } }] }, new Set(), new Set())
    expect(unsupported.answer).toContain('can’t confirm')
    expect(unsupported.offerSupport).toBe(true)
  })

  it('passes an optional knowledge candidate through the existing grounded response parse', () => {
    const candidate = { topic_id: 'goals.cumulative_deadline', title: 'Cumulative goal deadlines', explanation: 'Cumulative goal planning requires a deadline to calculate a pacing target.', feature_category: 'goals', source_refs: ['src/features/goals/GoalsPage.tsx'] }
    const result = parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({ supported: true, answer: 'Cumulative goals need a deadline.', source_refs: ['src/features/goals/GoalsPage.tsx'], link_ids: [], knowledge_candidate: candidate }) } }] }, new Set(['src/features/goals/GoalsPage.tsx']), new Set())
    expect(result.knowledgeCandidate).toEqual(candidate)
    expect(parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({ supported: false, answer: 'Not sure.', knowledge_candidate: candidate }) } }] }, new Set(), new Set()).knowledgeCandidate).toBeNull()
  })
})

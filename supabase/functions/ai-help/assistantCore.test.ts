import { describe, expect, it, vi } from 'vitest'
import { buildFollowUpSuggestions, buildHelpMessages, classifyHelpIntent, deterministicProductAnswer, documentationCoverage, hasUnverifiedEmailClaim, hasUnsupportedNavigationClaim, hasUnsupportedUnavailableWorkflowClaim, parseGroqCompletion, ProviderRequestError, rankKnowledgeDocuments, rankSourceIndex, renderVerifiedKnowledge, requestGroqCompletion, retrieveSourceExcerpts, selectRelevantLinkIds, socialConversationReply } from './assistantCore'
import type { AssistantHistoryItem } from './validation'
import { knowledgeDocuments } from './_generated/knowledgeBundle'
import { sourceIndex } from './_generated/sourceIndex'

const measureGuide = { slug: 'measures', title: 'Measures', path: 'docs/ai-help/measures-and-success-rules.md', content: 'New measures are Yes/No or Quantity. Existing Duration and Checklist measures remain supported.' }
const goalGuide = { slug: 'goals', title: 'Goals', path: 'docs/ai-help/goals-and-milestones.md', content: 'Daily checklist targets cannot exceed item count; cumulative goals can count incremental items.' }
const docs = [measureGuide, goalGuide, { slug: 'streaks', title: 'Streaks', path: 'docs/ai-help/schedules-and-streaks.md', content: 'Streaks use scheduled check-in days.' }]
const sourceEntries = [
  { path: 'src/domain/trackers/invariants.ts', symbol: 'assertTrackerInvariant', kind: 'implementation' as const, startLine: 20, endLine: 32, terms: 'measure type immutable history saved meaning', content: 'A saved measure type cannot change because its historical values use that interpretation.' },
  { path: 'src/domain/trackers/schema.test.ts', symbol: 'rejectsTypeChanges', kind: 'test' as const, startLine: 80, endLine: 91, terms: 'measure type immutable history saved', content: 'Test: rejects changing a saved measure type.' },
  { path: 'src/features/goals/GoalsPage.tsx', symbol: 'calculateGoalProgress', kind: 'implementation' as const, startLine: 120, endLine: 132, terms: 'goal progress cumulative target', content: 'Goal progress is calculated from the saved plan and eligible entries.' },
]

describe('AI Help retrieval and provider boundary', () => {
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
    expect(messages[0]?.content).toContain('add useful supported information beyond the earlier reply')
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
    expect(messages[0]?.content).toContain('Do not repeat a previous explanation unless asked')
    expect(messages[0]?.content).toContain('newly available options from legacy data formats')
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
    expect(messages[0]?.content).toContain('Source implementation/test excerpts take priority')
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
    expect(binAnswer?.answer).toContain('permanent deletion is disabled')
    expect(binAnswer?.answer).toContain('no permanent-delete control')
    expect(binAnswer?.answer).toContain('keep the tracker in the Bin or restore it')
    expect(deterministicProductAnswer('Where is the Bin?', [], 'support@example.com')?.answer).toContain('More navigation')
    expect(deterministicProductAnswer('How do I restore a tracker?', [], 'support@example.com')?.answer).toContain('choose Restore')
    expect(deterministicProductAnswer('What happens after 30 days?', [{ role: 'user', content: 'Why are my deleted items not permanently deleting?' }], 'support@example.com')?.answer).toContain('30-day recovery period')
    expect(deterministicProductAnswer('Why can’t I permanantly delete it?', [{ role: 'user', content: 'Where is the Bin?' }], 'support@example.com')?.answer).toContain('no permanent-delete control')
    const refs = ['src/features/trackers/TrackerBinPage.tsx']
    expect(buildFollowUpSuggestions(refs, 'Where is the Bin?')).toEqual(['How do I restore a tracker from The Bin?', 'Why is permanent deletion locked?'])
    expect(selectRelevantLinkIds('Why are my deleted items not permanently deleting?', [])).toEqual(['bin'])
    expect(selectRelevantLinkIds('How do I create a tracker?', [])).toEqual(['create_tracker'])
    expect(selectRelevantLinkIds('How do milestones work?', [])).toEqual(['goals'])
    expect(selectRelevantLinkIds('How do I cook pasta?', [])).toEqual([])
    const ranked = rankSourceIndex('Why are deleted items not permanently deleting?', [], sourceIndex)
    expect(ranked[0]?.path).toBe('src/features/trackers/TrackerBinPage.tsx')
    expect(retrieveSourceExcerpts('Why are deleted items not permanently deleting?', [], sourceIndex)).toContain('Permanent deletion is locked')
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
    expect(core.toLocaleLowerCase()).toContain('permanent deletion is not available in that app build')
    expect(core.toLocaleLowerCase()).toContain('source does not prove whether the hosted migration')
    expect(core).not.toContain('Permanent deletion is a separate action that removes the tracker')
  })

  it('keeps implementation behavior ahead of test-only matches and limits evidence to relevant indexed chunks', () => {
    const excerpts = retrieveSourceExcerpts('Why can’t I change a saved measure type?', [], sourceEntries)
    expect(excerpts).toContain('src/domain/trackers/invariants.ts')
    expect(excerpts).toContain('assertTrackerInvariant')
    expect(excerpts).not.toContain('GoalsPage.tsx')
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

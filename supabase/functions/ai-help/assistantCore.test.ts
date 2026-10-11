import { describe, expect, it, vi } from 'vitest'
import { buildFollowUpSuggestions, buildHelpMessages, classifyHelpIntent, documentationCoverage, parseGroqCompletion, ProviderRequestError, rankKnowledgeDocuments, rankSourceIndex, renderVerifiedKnowledge, requestGroqCompletion, retrieveSourceExcerpts } from './assistantCore'
import type { AssistantHistoryItem } from './validation'

const measureGuide = { slug: 'measures', title: 'Measures', path: 'docs/ai-help/measures-and-success-rules.md', content: 'New measures are Yes/No or Quantity. Existing Duration and Checklist measures remain supported.' }
const goalGuide = { slug: 'goals', title: 'Goals', path: 'docs/ai-help/goals-and-milestones.md', content: 'Daily checklist targets cannot exceed item count; cumulative goals can count incremental items.' }
const docs = [measureGuide, goalGuide, { slug: 'streaks', title: 'Streaks', path: 'docs/ai-help/schedules-and-streaks.md', content: 'Streaks use scheduled check-in days.' }]
const sourceEntries = [
  { path: 'src/domain/trackers/invariants.ts', symbol: 'assertTrackerInvariant', kind: 'implementation' as const, startLine: 20, endLine: 32, terms: 'measure type immutable history saved meaning', content: 'A saved measure type cannot change because its historical values use that interpretation.' },
  { path: 'src/domain/trackers/schema.test.ts', symbol: 'rejectsTypeChanges', kind: 'test' as const, startLine: 80, endLine: 91, terms: 'measure type immutable history saved', content: 'Test: rejects changing a saved measure type.' },
  { path: 'src/features/goals/GoalsPage.tsx', symbol: 'calculateGoalProgress', kind: 'implementation' as const, startLine: 120, endLine: 132, terms: 'goal progress cumulative target', content: 'Goal progress is calculated from the saved plan and eligible entries.' },
]

describe('AI Help retrieval and provider boundary', () => {
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
    expect(parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({ supported: true, answer: 'Made up', source_refs: [], link_ids: [] }) } }] }, new Set(), new Set()).answer).toContain('couldn’t verify')
  })

  it('passes an optional knowledge candidate through the existing grounded response parse', () => {
    const candidate = { topic_id: 'goals.cumulative_deadline', title: 'Cumulative goal deadlines', explanation: 'Cumulative goal planning requires a deadline to calculate a pacing target.', feature_category: 'goals', source_refs: ['src/features/goals/GoalsPage.tsx'] }
    const result = parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({ supported: true, answer: 'Cumulative goals need a deadline.', source_refs: ['src/features/goals/GoalsPage.tsx'], link_ids: [], knowledge_candidate: candidate }) } }] }, new Set(['src/features/goals/GoalsPage.tsx']), new Set())
    expect(result.knowledgeCandidate).toEqual(candidate)
    expect(parseGroqCompletion({ choices: [{ message: { content: JSON.stringify({ supported: false, answer: 'Not sure.', knowledge_candidate: candidate }) } }] }, new Set(), new Set()).knowledgeCandidate).toBeNull()
  })
})

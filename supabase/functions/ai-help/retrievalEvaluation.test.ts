import { describe, expect, it } from 'vitest'
import { knowledgeDocuments, knowledgeVersion } from './_generated/knowledgeBundle'
import { evidenceFingerprints, sourcePaths, sourceVersion } from './_generated/sourceBundle'
import { sourceIndex, sourceIndexVersion } from './_generated/sourceIndex'
import { documentationCoverage, rankKnowledgeDocuments, rankSourceIndex } from './assistantCore'

const measureHistory = [
  { role: 'user' as const, content: 'What are measures?' },
  { role: 'assistant' as const, content: 'A measure is one value recorded for a tracker.' },
]

const cases: Array<{ question: string; guide: string; history?: typeof measureHistory }> = [
  { question: 'What are measures?', guide: 'measures-and-success-rules' },
  { question: 'Are there only two types?', guide: 'measures-and-success-rules', history: measureHistory },
  { question: 'What about checkbox measures?', guide: 'measures-and-success-rules', history: measureHistory },
  { question: 'Can I change a saved measure type?', guide: 'measures-and-success-rules' },
  { question: 'What does a checklist count toward?', guide: 'measures-and-success-rules' },
  { question: 'How do AND, OR, and At least N rules work?', guide: 'measures-and-success-rules' },
  { question: 'How does precision affect a quantity measure?', guide: 'measures-and-success-rules' },
  { question: 'What is the difference between a daily goal and a cumulative goal?', guide: 'goals-and-milestones' },
  { question: 'Why does cumulative planning need a deadline?', guide: 'goals-and-milestones' },
  { question: 'Do snapshot entries count toward a cumulative target?', guide: 'goals-and-milestones' },
  { question: 'Are automatic allocation suggestions saved?', guide: 'goals-and-milestones' },
  { question: 'How does a linked milestone become reached?', guide: 'goals-and-milestones' },
  { question: 'Does a rest-day Sunday break my streak?', guide: 'schedules-and-streaks' },
  { question: 'What changes in Strict Mode?', guide: 'schedules-and-streaks' },
  { question: 'How do holidays affect a streak?', guide: 'schedules-and-streaks' },
  { question: 'Can retired measures still appear in History and Analytics?', guide: 'history-analytics-sync' },
  { question: 'How does sync handle two incompatible edits?', guide: 'history-analytics-sync' },
  { question: 'What is a custom check-in field?', guide: 'core-application' },
  { question: 'How do I create a goal with a daily target?', guide: 'core-application' },
  { question: 'Does changing the time zone move old check-ins?', guide: 'core-application' },
  { question: 'Does AI Help read my tracker values?', guide: 'core-application' },
  { question: 'Why might AI Help be temporarily unavailable?', guide: 'core-application' },
]

describe('AI Help retrieval evaluation', () => {
  it('uses matching knowledge and source bundle versions', () => {
    expect(sourceVersion).toBe(knowledgeVersion)
    expect(sourceIndexVersion).toBe(knowledgeVersion)
    expect(sourceIndex.length).toBeGreaterThan(300)
    expect(sourcePaths).toContain('src/domain/trackers/invariants.ts')
    expect(sourcePaths).toContain('src/domain/trackers/schema.test.ts')
    expect(sourcePaths).toContain('supabase/functions/ai-help/index.ts')
    expect(sourcePaths).toContain('supabase/functions/ai-help/learningCore.ts')
    expect(sourcePaths).toContain('supabase/functions/ai-help-review/index.ts')
    expect(evidenceFingerprints['docs/ai-help/goals-and-milestones.md']).toMatch(/^[a-f0-9]{64}$/)
    expect(sourcePaths.every((path) => /^[a-f0-9]{64}$/.test(evidenceFingerprints[path] ?? ''))).toBe(true)
  })

  it('automatically searches implementation and test evidence when documentation is insufficient', () => {
    const question = 'Why can’t I change a saved measure type?'
    expect(documentationCoverage(question, [], knowledgeDocuments).needsSourceFallback).toBe(true)
    const results = rankSourceIndex(question, [], sourceIndex)
    expect(results.some((entry) => entry.path === 'src/domain/trackers/invariants.ts'), results.map((entry) => `${entry.path}:${entry.symbol}`).join('\n')).toBe(true)
    expect(results.some((entry) => entry.path.endsWith('.test.ts'))).toBe(true)
  })

  it('retrieves implementation evidence for sync conflicts, cumulative goals, and streak edge cases', () => {
    const cases = [
      ['What happens when two devices edit the same tracker offline?', /syncEngine|syncConflict/i],
      ['Why is my cumulative goal pace behind?', /planning|GoalsPage/i],
      ['Does a missed rest day break my streak?', /progression|planning|activityStatus/i],
    ] as const
    for (const [question, expected] of cases) {
      const results = rankSourceIndex(question, [], sourceIndex)
      expect(results.some((entry) => expected.test(entry.path)), `${question}: ${results.map((entry) => entry.path).join(', ')}`).toBe(true)
    }
  })

  it('keeps Edge Function modules out of embedded source evidence', () => {
    expect(sourceIndex.some(({ content }) => content.includes("from './validation.ts'"))).toBe(false)
    expect(sourceIndex.some(({ content }) => content.includes("import './styles.css?raw'"))).toBe(false)
    expect(sourceIndex.some(({ content }) => content.includes('import syntax omitted from indexed evidence'))).toBe(true)
  })

  it.each(cases)('retrieves $guide for “$question”', ({ question, guide, history = [] }) => {
    expect(rankKnowledgeDocuments(question, history, knowledgeDocuments).map((doc) => doc.slug)).toContain(guide)
  })

  it('uses context to rank a follow-up about legacy checkbox behavior', () => {
    const selected = rankKnowledgeDocuments('What about checkbox measures?', measureHistory, knowledgeDocuments)
    expect(selected[0]?.slug).toBe('measures-and-success-rules')
    expect(selected[0]?.content).toContain('legacy Checklist')
  })
})

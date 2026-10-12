import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { selectRelevantCatalogKnowledge, rankVerifiedCatalog, retrieveVerifiedCatalog } from './assistantCore'
import { verifiedQuestionCatalog } from './_generated/knowledgeBundle'

type EvaluationCase = { id: string; kind: 'exact' | 'paraphrase' | 'multipart' | 'ambiguous' | 'unsupported'; question: string; expected: string[] }
const evaluation = JSON.parse(readFileSync('scripts/ai-help-catalog-evaluation.json', 'utf8')) as EvaluationCase[]

describe('AI Help catalog evaluation', () => {
  it('reports exact and unseen paraphrase retrieval separately at ranks one and three', () => {
    const exact = evaluation.filter(({ kind }) => kind === 'exact')
    const paraphrases = evaluation.filter(({ kind }) => kind === 'paraphrase')
    const recall = (cases: EvaluationCase[], limit: number) => cases.filter(({ question, expected }) => {
      const ids = rankVerifiedCatalog(question, verifiedQuestionCatalog).slice(0, limit).map(({ entry }) => entry.id)
      return expected.some((id) => ids.includes(id))
    }).length
    console.warn(`Catalog exact Recall@1 ${recall(exact, 1)}/${exact.length}; paraphrase Recall@1 ${recall(paraphrases, 1)}/${paraphrases.length}, Recall@3 ${recall(paraphrases, 3)}/${paraphrases.length}`)
    for (const item of paraphrases.filter(({ question, expected }) => !expected.some((id) => rankVerifiedCatalog(question, verifiedQuestionCatalog).slice(0, 3).some(({ entry }) => entry.id === id)))) console.warn(`Catalog paraphrase miss ${item.id}: expected ${item.expected.join(', ')}; retrieved ${rankVerifiedCatalog(item.question, verifiedQuestionCatalog).slice(0, 3).map(({ entry }) => entry.id).join(', ')}`)
    expect(recall(exact, 1)).toBe(exact.length)
    expect(recall(paraphrases, 3)).toBeGreaterThanOrEqual(Math.ceil(paraphrases.length * 0.8))
  })

  it('keeps deterministic routing precise and abstains on ambiguous and unsupported prompts', () => {
    const routable = evaluation.filter(({ kind }) => kind === 'exact' || kind === 'paraphrase')
    const direct = routable.map(({ id, question, expected }) => ({ id, expected, result: retrieveVerifiedCatalog(question, verifiedQuestionCatalog) }))
    const wrong = direct.filter(({ expected, result }) => Boolean(result && !expected.includes(result.id)))
    const correct = direct.filter(({ expected, result }) => result && expected.includes(result.id)).length
    const routedCount = direct.filter(({ result }) => result !== null).length
    const refused = evaluation.filter(({ kind }) => kind === 'ambiguous' || kind === 'unsupported')
      .filter(({ question }) => retrieveVerifiedCatalog(question, verifiedQuestionCatalog) === null).length
    for (const item of direct.filter(({ expected, result }) => result && !expected.includes(result.id))) console.warn(`Incorrect direct route ${item.id}: ${item.result?.id}`)
    for (const item of evaluation.filter(({ kind }) => kind === 'ambiguous' || kind === 'unsupported').filter(({ question }) => retrieveVerifiedCatalog(question, verifiedQuestionCatalog) !== null)) console.warn(`Failed abstention ${item.id}: ${retrieveVerifiedCatalog(item.question, verifiedQuestionCatalog)?.id}`)
    console.warn(`Strong-match precision ${routedCount - wrong.length}/${routedCount || 0}; incorrect deterministic-routing rate ${wrong.length}/${routable.length}; correct abstention ${refused}/${evaluation.filter(({ kind }) => kind === 'ambiguous' || kind === 'unsupported').length}; correct direct answers ${correct}/${routable.length}`)
    expect(wrong, wrong.map(({ id, result }) => `${id} routed to ${result?.id}`).join('\n')).toHaveLength(0)
    expect(refused).toBe(evaluation.filter(({ kind }) => kind === 'ambiguous' || kind === 'unsupported').length)
  })

  it('retrieves knowledge for every supported part without forcing one partial answer', () => {
    const cases = evaluation.filter(({ kind }) => kind === 'multipart')
    for (const item of cases) {
      expect(retrieveVerifiedCatalog(item.question, verifiedQuestionCatalog), item.id).toBeNull()
      const matches = selectRelevantCatalogKnowledge(item.question, verifiedQuestionCatalog, 2).map(({ entry }) => entry.id)
      expect(matches, `${item.id}: ${matches.join(', ')}`).toEqual(expect.arrayContaining(item.expected))
    }
  })

  it('keeps closely worded note-removal and permanent-erasure questions distinct', () => {
    expect(retrieveVerifiedCatalog('Does clearing remove a check-in note?', verifiedQuestionCatalog)?.id).toBe('history-clear-note')
    expect(retrieveVerifiedCatalog('Does clearing permanently erase a check-in note from storage?', verifiedQuestionCatalog)).toBeNull()
    const matches = selectRelevantCatalogKnowledge('Does clearing a check-in remove its note from History, and does clearing permanently erase that note from storage?', verifiedQuestionCatalog, 2)
    expect(matches.map(({ entry }) => entry.id)).toEqual(expect.arrayContaining(['history-clear-note', 'history-clear-sync']))
  })

  it('preserves distinct Standard and Strict Mode holiday outcomes in verified answers', () => {
    const modeAnswer = verifiedQuestionCatalog.find(({ id }) => id === 'completion-holidays-rest-days')!.answer
    const holidayAnswer = verifiedQuestionCatalog.find(({ id }) => id === 'completion-holiday-entry')!.answer
    expect(modeAnswer).toMatch(/Standard Mode.*excluded.*Strict Mode.*counts/i)
    expect(holidayAnswer).toMatch(/Standard Mode.*does not affect.*Strict Mode.*contributes/i)
    expect(verifiedQuestionCatalog.find(({ id }) => id === 'history-cleared-holiday')!.answer).toMatch(/Standard Mode.*not listed.*Strict Mode.*appear/i)
  })
})

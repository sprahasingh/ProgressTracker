import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const learningSql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261024000100_ai_help_learning_safety.sql'), 'utf8')
const verifiedSql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261023000100_ai_help_verified_knowledge.sql'), 'utf8')
const reviewHandler = readFileSync(resolve(process.cwd(), 'supabase/functions/ai-help-review/index.ts'), 'utf8')
const helpHandler = readFileSync(resolve(process.cwd(), 'supabase/functions/ai-help/index.ts'), 'utf8')

function functionBody(source: string, name: string, nextName: string) {
  const start = source.indexOf(`function public.${name}`)
  const end = source.indexOf(`function public.${nextName}`, start + 1)
  expect(start, `${name} definition exists`).toBeGreaterThanOrEqual(0)
  return source.slice(start, end < 0 ? undefined : end)
}

describe('AI generated knowledge approval boundaries', () => {
  it('stores generated suggestions as pending and never inserts them into verified knowledge', () => {
    const submit = functionBody(verifiedSql, 'submit_ai_knowledge_candidate', 'reconcile_ai_knowledge')
    expect(submit).toMatch(/p_candidate_fingerprint, p_explanation, p_source_refs, p_knowledge_version, 'pending'/)
    expect(submit).not.toMatch(/insert\s+into\s+public\.ai_verified_knowledge/i)
  })

  it('reconciliation only marks candidates stale and does not approve them', () => {
    const reconcile = functionBody(learningSql, 'reconcile_ai_knowledge', 'review_ai_knowledge_candidate')
    expect(reconcile).toMatch(/update public\.ai_knowledge_candidates candidate\s+set status = 'stale'/i)
    expect(reconcile).not.toMatch(/set status = 'verified'|insert\s+into\s+public\.ai_verified_knowledge/i)
  })

  it('requires maintainer authorization before the review handler can call the service-role review RPC', () => {
    const authorization = reviewHandler.indexOf('if (error || !user?.email || !user.email_confirmed_at || !isMaintainer(')
    const reviewRpc = reviewHandler.indexOf("admin.rpc('review_ai_knowledge_candidate'")
    expect(authorization).toBeGreaterThanOrEqual(0)
    expect(reviewRpc).toBeGreaterThan(authorization)
    expect(learningSql).toMatch(/revoke all on function public\.review_ai_knowledge_candidate\([\s\S]*?from public, anon, authenticated;/)
    expect(learningSql).toMatch(/grant execute on function public\.review_ai_knowledge_candidate\([\s\S]*?to service_role;/)
  })

  it('retrieves only verified knowledge rows and not pending candidate content', () => {
    expect(helpHandler).toMatch(/from\('ai_verified_knowledge'\)[\s\S]*?\.eq\('status', 'verified'\)/)
    expect(helpHandler).not.toMatch(/from\('ai_knowledge_candidates'\)/)
  })
})

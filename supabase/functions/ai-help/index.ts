import { createClient } from 'npm:@supabase/supabase-js@2'
import { knowledgeDocuments, knowledgeVersion } from './_generated/knowledgeBundle.ts'
import { sourcePaths, sourceVersion } from './_generated/sourceBundle.ts'
import { sourceIndex, sourceIndexVersion } from './_generated/sourceIndex.ts'
import { buildFollowUpSuggestions, buildHelpMessages, documentationCoverage, parseGroqCompletion, ProviderRequestError, rankKnowledgeDocuments, requestGroqCompletion, retrieveSourceExcerpts } from './assistantCore.ts'
import { AssistantInputError as RequestError, MAX_BODY_BYTES, createCandidateFingerprint, findVerifiedAnswer, isGeneralConversation, normalizeAssistantInput, type AssistantHistoryItem } from './validation.ts'

const APP_LINKS: Record<string, { label: string; href: string }> = {
  today: { label: 'Today', href: '/' }, trackers: { label: 'Trackers', href: '/trackers' }, create_tracker: { label: 'Create a tracker', href: '/trackers/new' }, analytics: { label: 'Insights', href: '/dashboard' },
  goals: { label: 'Goals', href: '/goals' }, calendar: { label: 'Calendar', href: '/calendar' }, history: { label: 'History', href: '/history' }, settings: { label: 'Settings', href: '/settings' },
}
const ORIGIN_ALLOWLIST = new Set((Deno.env.get('AI_HELP_ALLOWED_ORIGINS') ?? Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((value) => { try { return new URL(value.trim()).origin } catch { return '' } }).filter(Boolean))

type HistoryItem = AssistantHistoryItem
type ProviderCredential = { slot: 'primary' | 'secondary'; key: string }
let syncedKnowledgeVersion = ''

function response(status: number, body: Record<string, unknown>, origin: string) {
  const retryAfterSeconds = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '3600', Vary: 'Origin', 'Cache-Control': 'no-store',
    ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
  } })
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES || !request.body) throw new RequestError(413, 'Request is too large.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new RequestError(413, 'Request is too large.') }
    chunks.push(value)
  }
  try {
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch { throw new RequestError(400, 'Invalid request.') }
}

async function recordProviderHealth(admin: ReturnType<typeof createClient>, slot: string, status: number, failed: boolean, retryAfterSeconds?: number) {
  const previous = await admin.from('ai_help_provider_health').select('consecutive_failures').eq('provider_slot', slot).maybeSingle()
  const failures = failed ? Math.min(10, (previous.data?.consecutive_failures ?? 0) + 1) : 0
  const cooldownMs = status === 429 ? Math.min(15 * 60_000, Math.max(1_000, (retryAfterSeconds ?? 60) * 1_000)) : Math.min(15 * 60_000, 30_000 * 2 ** (failures - 1))
  const cooldown = failed ? new Date(Date.now() + cooldownMs).toISOString() : null
  await admin.from('ai_help_provider_health').upsert({ provider_slot: slot, last_status: status, consecutive_failures: failures, disabled_until: cooldown, checked_at: new Date().toISOString() })
}

async function generate(admin: ReturnType<typeof createClient>, question: string, history: HistoryItem[], pageContext: string) {
  const credentials: ProviderCredential[] = [
    { slot: 'primary', key: Deno.env.get('GROQ_API_KEY_PRIMARY') ?? '' },
    { slot: 'secondary', key: Deno.env.get('GROQ_API_KEY_SECONDARY') ?? '' },
  ].filter(({ key }) => Boolean(key))
  if (!credentials.length) throw new RequestError(503, 'AI help is not configured yet.', 'configuration_missing')
  const health = await admin.from('ai_help_provider_health').select('provider_slot,disabled_until').in('provider_slot', credentials.map(({ slot }) => slot))
  const now = Date.now()
  const disabledEntries = (health.data ?? []).filter((item) => item.disabled_until && new Date(item.disabled_until).getTime() > now)
  const disabled = new Set(disabledEntries.map((item) => item.provider_slot))
  const available = credentials.filter((item) => !disabled.has(item.slot))
  if (!available.length) {
    const nextAvailable = disabledEntries.reduce((soonest, item) => Math.min(soonest, new Date(item.disabled_until!).getTime()), Number.POSITIVE_INFINITY)
    const retryAfterSeconds = Number.isFinite(nextAvailable) ? Math.max(1, Math.ceil((nextAvailable - now) / 1000)) : undefined
    throw new RequestError(503, 'AI help is temporarily unavailable. Please retry after the provider cooldown.', 'provider_cooldown', retryAfterSeconds)
  }
  const docs = rankKnowledgeDocuments(question, history, knowledgeDocuments, 4, pageContext)
  const relevantDocs = docs.map((doc) => `DOCUMENT SECTION: ${doc.title} (${doc.path})\n${doc.content}`).join('\n\n').slice(0, 7000)
  const sourcePlan = documentationCoverage(question, history, knowledgeDocuments, pageContext)
  const sources = sourcePlan.needsSourceFallback
    ? retrieveSourceExcerpts(question, history, sourceIndex, 4, 5200, pageContext)
    : ''
  const messages = buildHelpMessages({ question, history, pageContext, relevantDocs, sourceExcerpts: sources, linkIds: Object.keys(APP_LINKS) })
  const model = Deno.env.get('GROQ_MODEL') || 'openai/gpt-oss-120b'
  const sourceRefs = [...new Set([...docs.flatMap((doc) => [doc.path, doc.slug]), ...(sources.matchAll(/^SOURCE ([^ ·]+) ·/gm)).map((match) => match[1]!)])]
  const allowedSources = new Set(sourceRefs)
  let raw: unknown
  try {
    raw = await requestGroqCompletion({ credentials: available, model, messages,
      onFailure: (slot, status, retryAfter) => recordProviderHealth(admin, slot, status, true, retryAfter),
      onSuccess: (slot) => recordProviderHealth(admin, slot, 200, false),
    })
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      if (error.status === 429) throw new RequestError(429, 'The assistant provider is busy. Please try again after the stated wait.', 'provider_rate_limit', error.retryAfterSeconds)
      if (error.invalidResponse) throw new RequestError(502, 'AI help received an unreadable response. Please retry.', 'invalid_model_response')
    }
    throw new RequestError(503, 'AI help is temporarily unavailable. Please try again later.', 'provider_unavailable')
  }
  const result = parseGroqCompletion(raw, allowedSources, new Set(Object.keys(APP_LINKS)))
  const links = result.links.map((id) => APP_LINKS[id])
  if (result.sourceRefs.length && isGeneralConversation(question, history)) {
      const candidateFingerprint = await createCandidateFingerprint(result.answer, result.sourceRefs)
      const existing = await admin.from('ai_knowledge_candidates').select('id').eq('candidate_fingerprint', candidateFingerprint).eq('knowledge_version', knowledgeVersion).eq('status', 'pending').maybeSingle()
      if (!existing.data) await admin.from('ai_knowledge_candidates').insert({ candidate_fingerprint: candidateFingerprint, answer: result.answer, source_refs: result.sourceRefs, knowledge_version: knowledgeVersion })
  }
  return { answer: result.answer, links, followUps: result.sourceRefs.length ? buildFollowUpSuggestions(result.sourceRefs, question) : [] }
}

Deno.serve(async (request) => {
  const originHeader = request.headers.get('origin')
  let origin = ''
  try { origin = originHeader ? new URL(originHeader).origin : '' } catch { /* Invalid origins are rejected below. */ }
  if (!origin || !ORIGIN_ALLOWLIST.has(origin)) return new Response('Forbidden', { status: 403, headers: { Vary: 'Origin' } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Max-Age': '3600', Vary: 'Origin' } })
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, origin)
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return response(415, { error: 'Content-Type must be application/json.' }, origin)

  try {
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return response(401, { error: 'Sign in to use AI help.' }, origin)
    const input = normalizeAssistantInput(await readBody(request))
    const url = Deno.env.get('SUPABASE_URL')
    const publishableKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !publishableKey || !serviceRoleKey) throw new RequestError(503, 'AI help is not configured yet.', 'configuration_missing')
    const verifier = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: identity, error: identityError } = await verifier.auth.getUser(token)
    const userId = identity.user?.id
    if (identityError || !userId) return response(401, { error: 'Your session expired. Sign in again to use AI help.' }, origin)
    const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: rate, error: rateError } = await admin.rpc('consume_ai_help_request', { p_user_id: userId })
    if (rateError) throw new RequestError(503, 'AI help is temporarily unavailable. Please try again later.', 'rate_limit_unavailable')
    if (!rate?.allowed) throw new RequestError(429, 'The assistant request limit has been reached. Please try again after the stated wait.', 'application_rate_limit', typeof rate?.retryAfterSeconds === 'number' ? rate.retryAfterSeconds : 60)
    if (sourceVersion !== knowledgeVersion || sourceIndexVersion !== knowledgeVersion) throw new RequestError(503, 'AI Help knowledge is being updated. Please try again shortly.', 'knowledge_version_mismatch')

    const { data: memory } = await admin.from('ai_question_memory').select('question,answer,source_refs').eq('active', true).eq('knowledge_version', knowledgeVersion).limit(30)
    const validMemoryRefs = new Set([...knowledgeDocuments.flatMap((doc) => [doc.path, doc.slug]), ...sourcePaths])
    const verifiedMemory = (memory ?? []).filter((item) => Array.isArray(item.source_refs) && item.source_refs.length > 0 && item.source_refs.every((ref: unknown) => typeof ref === 'string' && validMemoryRefs.has(ref)))
    const cachedAnswer = findVerifiedAnswer(input.question, verifiedMemory, input.history)
    if (syncedKnowledgeVersion !== knowledgeVersion) {
      const documentsBySlug = new Map<string, { slug: string; title: string; content: string; source_refs: string[]; knowledge_version: string }>()
      for (const section of knowledgeDocuments) {
        const previous = documentsBySlug.get(section.slug)
        if (previous) previous.content += `\n\n${section.content}`
        else documentsBySlug.set(section.slug, { slug: section.slug, title: section.title.split(': ')[0] ?? section.title, content: section.content, source_refs: [section.path], knowledge_version: knowledgeVersion })
      }
      await admin.from('ai_feature_knowledge').upsert([...documentsBySlug.values()], { onConflict: 'slug' })
      await admin.from('ai_question_memory').update({ active: false }).neq('knowledge_version', knowledgeVersion)
      await admin.from('ai_knowledge_candidates').update({ status: 'stale' }).eq('status', 'pending').neq('knowledge_version', knowledgeVersion)
      syncedKnowledgeVersion = knowledgeVersion
    }
    if (cachedAnswer) return response(200, { answer: cachedAnswer.answer, links: [] }, origin)
    const result = await generate(admin, input.question, input.history, input.pageContext)
    return response(200, result, origin)
  } catch (error) {
    if (error instanceof RequestError) return response(error.status, { error: error.message, code: error.code, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }, origin)
    // Do not log prompts, provider bodies, credentials, or stack details.
    return response(500, { error: 'AI help could not complete this request. Please retry.', code: 'internal_error' }, origin)
  }
})

import { createClient } from 'npm:@supabase/supabase-js@2'
import { knowledgeDocuments, knowledgeVersion, verifiedQuestionCatalog } from './_generated/knowledgeBundle.ts'
import { PUBLIC_SUPPORT_EMAIL } from '../_shared/supportContact.ts'
import { evidenceFingerprints, sourcePaths, sourceRelationships, sourceVersion } from './_generated/sourceBundle.ts'
import { sourceIndex, sourceIndexVersion } from './_generated/sourceIndex.ts'
import { capabilities, capabilityRoutes, capabilityVersion } from './_generated/capabilityBundle.ts'
import { canReturnHighRiskAnswer, capabilityEvidence, claimEvidenceOverlap, renderPartiallySupportedClaims, retrieveCapabilities, shouldEnforceCoveredClaims, unverifiedResponse, validateStructuredClaims, versionMatchedAvailability, type CapabilityIndex } from './capabilityCore.ts'
import { buildFollowUpSuggestions, buildHelpMessages, deterministicProductAnswer, documentationCoverage, hasUnverifiedEmailClaim, hasUnsupportedNavigationClaim, hasUnsupportedUnavailableWorkflowClaim, parseGroqCompletion, providerHealthTransition, ProviderRequestError, rankKnowledgeDocuments, rankVerifiedCatalog, renderVerifiedKnowledge, requestGroqCompletion, retrieveSourceExcerpts, retrieveVerifiedCatalog, selectRelevantLinkIds, shouldUseDeterministicAnswer, socialConversationReply } from './assistantCore.ts'
import { AssistantInputError as RequestError, MAX_BODY_BYTES, isGeneralConversation, normalizeAssistantInput, type AssistantHistoryItem } from './validation.ts'
import { createKnowledgeFingerprint, mapFeatureCategory, parseKnowledgeCandidate, rankVerifiedKnowledge, resolveVerifiedKnowledgeForRequest, scheduleBestEffortCandidateCollection, type VerifiedKnowledge } from './learningCore.ts'

const APP_LINKS: Record<string, { label: string; href: string }> = {
  today: { label: 'Today', href: '/' }, trackers: { label: 'Trackers', href: '/trackers' }, create_tracker: { label: 'Create a tracker', href: '/trackers/new' }, analytics: { label: 'Insights', href: '/dashboard' },
  goals: { label: 'Goals', href: '/goals' }, calendar: { label: 'Calendar', href: '/calendar' }, history: { label: 'History', href: '/history' }, settings: { label: 'Settings', href: '/settings' }, bin: { label: 'The Bin', href: '/bin' },
}
const ORIGIN_ALLOWLIST = new Set((Deno.env.get('AI_HELP_ALLOWED_ORIGINS') ?? Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((value) => { try { return new URL(value.trim()).origin } catch { return '' } }).filter(Boolean))

type HistoryItem = AssistantHistoryItem
type ProviderCredential = { slot: 'primary' | 'secondary'; key: string }
let syncedKnowledgeVersion = ''

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

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
  const transition = providerHealthTransition(previous.data?.consecutive_failures ?? 0, failed, status, retryAfterSeconds)
  const cooldown = failed ? new Date(Date.now() + transition.cooldownMs).toISOString() : null
  await admin.from('ai_help_provider_health').upsert({ provider_slot: slot, last_status: status, consecutive_failures: transition.failedAttempts, disabled_until: cooldown, checked_at: new Date().toISOString() })
}

async function recordLearningMetric(admin: ReturnType<typeof createClient>, event: string, category: string) {
  try {
    const { error } = await admin.rpc('record_ai_help_metric', { p_event: event, p_feature_category: category })
    if (error) console.error('AI_HELP_METRIC_WRITE_FAILED', JSON.stringify({ event, databaseCode: error.code ?? 'unknown' }))
  } catch { console.error('AI_HELP_METRIC_WRITE_FAILED', JSON.stringify({ event, databaseCode: 'unavailable' })) }
}

async function buildCandidate(admin: ReturnType<typeof createClient>, raw: unknown, result: ReturnType<typeof parseGroqCompletion>,
  question: string, history: HistoryItem[], suppliedSourceExcerpts: string, category: string): Promise<void> {
  if (!raw) return
  if (!isGeneralConversation(question, history)) {
    await recordLearningMetric(admin, 'candidate_skipped', category)
    return
  }
  const suppliedSourceRefs = new Set([...suppliedSourceExcerpts.matchAll(/^SOURCE ([^ ·]+) ·/gm)].map((match) => match[1]!))
  const candidate = parseKnowledgeCandidate(raw, {
    allowedSourceRefs: new Set(sourcePaths),
    suppliedSourceRefs,
    evidenceFingerprints,
    sourceExcerpts: suppliedSourceExcerpts,
  })
  if (!candidate || candidate.sourceRefs.some((ref) => !result.sourceRefs.includes(ref))) {
    await recordLearningMetric(admin, 'candidate_rejected', category)
    return
  }
  try {
    const candidateFingerprint = await createKnowledgeFingerprint(candidate)
    const { error } = await admin.rpc('submit_ai_knowledge_candidate', {
      p_topic_id: candidate.topicId,
      p_title: candidate.title,
      p_explanation: candidate.explanation,
      p_detailed_explanation: candidate.detailedExplanation,
      p_feature_category: candidate.featureCategory,
      p_source_refs: candidate.sourceRefs,
      p_source_fingerprints: Object.fromEntries(candidate.sourceRefs.map((ref) => [ref, evidenceFingerprints[ref]])),
      p_knowledge_version: knowledgeVersion,
      p_candidate_fingerprint: candidateFingerprint,
    })
    if (error) throw error
  } catch (error) {
    const databaseCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable'
    console.error('AI_HELP_CANDIDATE_PERSISTENCE_FAILED', JSON.stringify({ databaseCode, category }))
    await recordLearningMetric(admin, 'candidate_persistence_failure', category)
  }
}

async function generate(admin: ReturnType<typeof createClient>, question: string, history: HistoryItem[], pageContext: string, verifiedRows: VerifiedKnowledge[], runtimeAvailability: Record<string, 'available' | 'disabled'>, clientCapabilityVersion?: string) {
  const deterministic = deterministicProductAnswer(question, history, PUBLIC_SUPPORT_EMAIL)
  // Static support contact details do not describe a feature workflow. All
  // feature-specific deterministic answers go through current evidence retrieval.
  if (deterministic && shouldUseDeterministicAnswer(deterministic.topic, question)) {
    return { answer: deterministic.answer, links: [], followUps: [], topic: deterministic.topic, knowledge_version: knowledgeVersion }
  }
  const verifiedCatalogAnswer = retrieveVerifiedCatalog(question, verifiedQuestionCatalog)
  if (verifiedCatalogAnswer) {
    const topic = ({ 'getting-started': 'trackers', 'check-ins': 'history', streaks: 'schedules', statistics: 'analytics', history: 'history', holidays: 'schedules', goals: 'goals', calendar: 'analytics', notifications: 'notifications', 'accounts-sync': 'sync', 'settings-privacy': 'settings', 'ai-help': 'privacy' } as Record<string, string>)[verifiedCatalogAnswer.category] ?? 'other'
    return { answer: verifiedCatalogAnswer.answer, links: [], followUps: [], topic, knowledge_version: knowledgeVersion }
  }
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
  const capabilityIndex: CapabilityIndex = { version: capabilityVersion, routes: capabilityRoutes, capabilities: capabilities as unknown as CapabilityIndex['capabilities'] }
  const trustedRuntimeAvailability = versionMatchedAvailability(clientCapabilityVersion, capabilityVersion, runtimeAvailability)
  const matchedCapabilities = retrieveCapabilities(question, history, capabilityIndex, 6)
  const sourcePlan = documentationCoverage(question, history, knowledgeDocuments, pageContext)
  const useSourceEvidence = sourcePlan.needsSourceFallback || matchedCapabilities.length > 0
  const capabilitySourcePaths = [...new Set(matchedCapabilities.flatMap((capability) => capability.evidenceRefs))]
  const sources = useSourceEvidence
    ? retrieveSourceExcerpts(question, history, sourceIndex, 4, 5200, pageContext, capabilitySourcePaths, sourceRelationships)
    : ''
  if (useSourceEvidence && !sources) await recordLearningMetric(admin, 'retrieval_no_match', mapFeatureCategory(pageContext))
  const rankedVerified = rankVerifiedKnowledge(question, history, verifiedRows, 3)
  const category = mapFeatureCategory(pageContext)
  const verifiedResolution = resolveVerifiedKnowledgeForRequest(rankedVerified, category)
  if (verifiedResolution.conflict) await recordLearningMetric(admin, 'conflicting_knowledge', verifiedResolution.featureCategory)
  const verified = verifiedResolution.entries
  const relevantVerified = renderVerifiedKnowledge(verified)
  const catalogMatches = rankVerifiedCatalog(question, verifiedQuestionCatalog).slice(0, 2).filter(({ promptScore }) => promptScore >= 0.28)
  const relevantCatalog = catalogMatches.map(({ entry }) => `VERIFIED Q&A ${entry.id} (${entry.category})\nQuestion: ${entry.question}\nAliases: ${entry.aliases.join('; ')}\nAnswer: ${entry.answer}\nSources: ${entry.sources.join(', ')}`).join('\n\n')
  const allVerified = [relevantCatalog, relevantVerified].filter(Boolean).join('\n\n')
  const linkIds = selectRelevantLinkIds(question, history).filter((id) => id in APP_LINKS)
  const relevantCapabilityText = capabilityEvidence(matchedCapabilities)
  const messages = buildHelpMessages({ question, history, pageContext, relevantDocs, verifiedKnowledge: allVerified, sourceExcerpts: sources, linkIds, capabilityContext: relevantCapabilityText })
  if (sourcePlan.needsSourceFallback) await recordLearningMetric(admin, 'source_fallback', category)
  if (verified.length) await recordLearningMetric(admin, 'verified_knowledge_used', category)
  const model = Deno.env.get('GROQ_MODEL') || 'openai/gpt-oss-120b'
  const sourceRefs = [...new Set([...verified.flatMap((entry) => entry.source_refs), ...docs.flatMap((doc) => [doc.path, doc.slug]), ...(sources.matchAll(/^SOURCE ([^ ·]+) ·/gm)).map((match) => match[1]!)])]
  const allowedSources = new Set(sourceRefs)
  let raw: unknown
  try {
    raw = await requestGroqCompletion({ credentials: available, model, messages,
      onFailure: (slot, status, retryAfter) => recordProviderHealth(admin, slot, status, true, retryAfter),
      onSuccess: (slot) => recordProviderHealth(admin, slot, 200, false),
    })
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      await recordLearningMetric(admin, 'provider_failure', category)
      if (error.status === 429) throw new RequestError(429, 'The assistant provider is busy. Please try again after the stated wait.', 'provider_rate_limit', error.retryAfterSeconds)
      if (error.invalidResponse) throw new RequestError(502, 'AI help received an unreadable response. Please retry.', 'invalid_model_response')
    }
    throw new RequestError(503, 'AI help is temporarily unavailable. Please try again later.', 'provider_unavailable')
  }
  const result = parseGroqCompletion(raw, allowedSources, new Set(linkIds))
  if (result.offerSupport) {
    await recordLearningMetric(admin, 'grounding_failure', category)
    return { answer: unverifiedResponse(question), links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  const groundingEvidence = [relevantVerified, relevantDocs, sources].join('\n')
  const evidenceByRef: Record<string, string> = {}
  for (const doc of docs) {
    evidenceByRef[doc.path] = [evidenceByRef[doc.path], doc.content].filter(Boolean).join('\n')
    evidenceByRef[doc.slug] = [evidenceByRef[doc.slug], doc.content].filter(Boolean).join('\n')
  }
  for (const match of sources.matchAll(/^SOURCE ([^ ·]+) ·[^\n]*\n([\s\S]*?)(?=\n\nSOURCE |$)/gm)) evidenceByRef[match[1]!] = match[2]!
  // Enforce claims when current source excerpts back a retrieved feature capability.
  // The global rollout switch remains opt-in for the rest of the product.
  const coveredEvidenceEnforcement = shouldEnforceCoveredClaims(matchedCapabilities.length > 0, sources.length > 0, Deno.env.get('AI_HELP_GROUNDING_ENFORCEMENT') === 'true')
  const claimValidation = validateStructuredClaims({ claims: result.claims, index: capabilityIndex,
    allowedEvidence: new Set([...Object.keys(evidenceByRef), ...docs.map((doc) => doc.slug)]), evidenceByRef,
    runtimeAvailability: trustedRuntimeAvailability,
    enforcement: coveredEvidenceEnforcement })
  // Technical identifiers are cheap to check deterministically and should
  // never pass in shadow mode when absent from the claim's cited excerpts.
  if (claimValidation.issues.some((issue) => ['unsupported_technical_identifier', 'authorization_layer_ambiguous'].includes(issue))) {
    await recordLearningMetric(admin, 'grounding_failure', category)
    const answer = renderPartiallySupportedClaims(claimValidation.acceptedClaims, question)
    return { answer, links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  const claimCoverage = claimEvidenceOverlap(result.answer, result.claims.map((claim) => claim.text).join(' '))
  if (claimValidation.issues.length || claimCoverage < 0.65) await recordLearningMetric(admin, 'grounding_failure', category)
  // High-risk actions fail closed until their current prerequisites and availability are verified.
  if (!canReturnHighRiskAnswer(result.answer, result.claims.length, claimValidation, claimCoverage)) {
    await recordLearningMetric(admin, 'grounding_failure', category)
    return { answer: unverifiedResponse(question), links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  if ((!claimValidation.valid || claimCoverage < 0.65) && Deno.env.get('AI_HELP_GROUNDING_ENFORCEMENT') === 'true') {
    await recordLearningMetric(admin, 'grounding_failure', category)
    return { answer: unverifiedResponse(question), links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  if (coveredEvidenceEnforcement && (!claimValidation.valid || claimCoverage < 0.65)) {
    await recordLearningMetric(admin, 'grounding_failure', category)
    const answer = renderPartiallySupportedClaims(claimValidation.acceptedClaims, question)
    return { answer, links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  if (hasUnsupportedUnavailableWorkflowClaim(result.answer, groundingEvidence)) {
    await recordLearningMetric(admin, 'grounding_failure', category)
    return { answer: 'I can’t confirm that action is currently available. The current app information says this feature is disabled or awaiting setup. Would you like to raise a support query?', links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  if (hasUnsupportedNavigationClaim(result.answer, groundingEvidence)) {
    await recordLearningMetric(admin, 'grounding_failure', category)
    return { answer: 'I can’t verify that navigation path from the current app information. Would you like to raise a support query?', links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  if (hasUnverifiedEmailClaim(result.answer, PUBLIC_SUPPORT_EMAIL)) {
    await recordLearningMetric(admin, 'grounding_failure', category)
    return { answer: `I can’t verify that email address from ProgressTracker’s current information. For support, email ${PUBLIC_SUPPORT_EMAIL}.`, links: [], followUps: [], topic: category, knowledge_version: knowledgeVersion, offerSupport: true, supportPrefill: question.slice(0, 1800) }
  }
  if (!result.sourceRefs.length) await recordLearningMetric(admin, 'grounding_failure', category)
  if (Deno.env.get('AI_HELP_CANDIDATE_COLLECTION_ENABLED') !== 'false' && result.knowledgeCandidate) {
    const candidateTask = sources
      ? buildCandidate(admin, result.knowledgeCandidate, result, question, history, sources, category)
      : recordLearningMetric(admin, 'candidate_skipped', category)
    scheduleBestEffortCandidateCollection(candidateTask, typeof EdgeRuntime !== 'undefined' ? EdgeRuntime.waitUntil.bind(EdgeRuntime) : undefined)
  }
  const links = result.links.map((id) => APP_LINKS[id])
  return { answer: result.answer, links, followUps: result.sourceRefs.length ? buildFollowUpSuggestions(result.sourceRefs, question) : [], topic: category, knowledge_version: knowledgeVersion, offerSupport: false }
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
    if (rateError) {
      // Keep diagnostics useful without logging a user ID, request body, provider data, or database message.
      console.error('AI_HELP_RATE_LIMIT_RPC_FAILED', JSON.stringify({ databaseCode: rateError.code ?? 'unknown' }))
      throw new RequestError(503, 'AI help is temporarily unavailable. Please try again later.', 'rate_limit_unavailable')
    }
    if (!rate?.allowed) throw new RequestError(429, 'The assistant request limit has been reached. Please try again after the stated wait.', 'application_rate_limit', typeof rate?.retryAfterSeconds === 'number' ? rate.retryAfterSeconds : 60)
    const socialReply = socialConversationReply(input.question)
    if (socialReply) {
      await recordLearningMetric(admin, 'request', mapFeatureCategory(input.pageContext))
      return response(200, { answer: socialReply, links: [], followUps: [] }, origin)
    }
  if (sourceVersion !== knowledgeVersion || sourceIndexVersion !== knowledgeVersion || capabilityVersion !== knowledgeVersion) throw new RequestError(503, 'AI Help knowledge is being updated. Please try again shortly.', 'knowledge_version_mismatch')
    await recordLearningMetric(admin, 'request', mapFeatureCategory(input.pageContext))
    if (syncedKnowledgeVersion !== knowledgeVersion) {
      const { error: freshnessError } = await admin.rpc('reconcile_ai_knowledge', { p_current_fingerprints: evidenceFingerprints, p_knowledge_version: knowledgeVersion })
      if (freshnessError) throw new RequestError(503, 'AI Help knowledge could not be refreshed. Please try again shortly.', 'knowledge_reconciliation_unavailable')
      const documentsBySlug = new Map<string, { slug: string; title: string; content: string; source_refs: string[]; knowledge_version: string }>()
      for (const section of knowledgeDocuments) {
        const previous = documentsBySlug.get(section.slug)
        if (previous) previous.content += `\n\n${section.content}`
        else documentsBySlug.set(section.slug, { slug: section.slug, title: section.title.split(': ')[0] ?? section.title, content: section.content, source_refs: [section.path], knowledge_version: knowledgeVersion })
      }
      await admin.from('ai_feature_knowledge').upsert([...documentsBySlug.values()], { onConflict: 'slug' })
      syncedKnowledgeVersion = knowledgeVersion
    }
    const { data: knowledgeRows } = await admin.from('ai_verified_knowledge')
      .select('topic_id,title,explanation,detailed_explanation,feature_category,source_refs,source_fingerprints,knowledge_version,status')
      .eq('status', 'verified').eq('knowledge_version', knowledgeVersion).order('reviewed_at', { ascending: false }).limit(100)
    const verifiedRows = (knowledgeRows ?? []).filter((entry) => Array.isArray(entry.source_refs)
      && entry.source_refs.length > 0
      && entry.source_refs.every((ref: unknown) => typeof ref === 'string' && Boolean(evidenceFingerprints[ref]))
      && entry.source_refs.every((ref: string) => entry.source_fingerprints?.[ref] === evidenceFingerprints[ref])) as VerifiedKnowledge[]
    const result = await generate(admin, input.question, input.history, input.pageContext, verifiedRows, input.runtimeAvailability, input.capabilityVersion)
    return response(200, result, origin)
  } catch (error) {
    if (error instanceof RequestError) return response(error.status, { error: error.message, code: error.code, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }, origin)
    // Do not log prompts, provider bodies, credentials, or stack details.
    return response(500, { error: 'AI help could not complete this request. Please retry.', code: 'internal_error' }, origin)
  }
})

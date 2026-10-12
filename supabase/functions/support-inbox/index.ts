import { createClient } from 'npm:@supabase/supabase-js@2'
import { isMaintainer, normalizeMaintainerEmails } from '../ai-help/learningCore.ts'
import { deliverPendingSupportEmail } from '../_shared/supportFeedbackDelivery.ts'
import { PUBLIC_SUPPORT_EMAIL } from '../_shared/supportContact.ts'
import { consentedMaintainerEmail, supportReplyRpc } from './supportInboxCore.ts'

const allowedOrigins = new Set((Deno.env.get('SUPPORT_FEEDBACK_ALLOWED_ORIGINS') ?? Deno.env.get('AI_HELP_ALLOWED_ORIGINS') ?? '').split(',').map((item) => {
  try { return new URL(item.trim()).origin } catch { return '' }
}).filter(Boolean))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const categories = new Set(['support_query','bug_report','feature_request','general_feedback','ai_answer_feedback'])
const statuses = new Set(['open','in_progress','waiting_for_user','resolved'])

function json(status: number, body: Record<string, unknown>, origin = '') {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  } })
}

async function boundedJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('content-length') ?? 0) > 8_000 || !request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 8_000) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

Deno.serve(async (request) => {
  let origin = ''
  try { origin = request.headers.get('origin') ? new URL(request.headers.get('origin')!).origin : '' } catch { /* Rejected below. */ }
  if (!origin || !allowedOrigins.has(origin)) return new Response('Forbidden', { status: 403, headers: { Vary: 'Origin' } })
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Max-Age': '3600', Vary: 'Origin' } })
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, origin)
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json(415, { error: 'Content-Type must be application/json.' }, origin)
  try {
    const body = await boundedJson(request)
    if (!body || typeof body.action !== 'string') return json(400, { error: 'Invalid support request.' }, origin)
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    const url = Deno.env.get('SUPABASE_URL')
    const key = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!token || !url || !key || !serviceKey) return json(401, { error: 'Sign in to access support conversations.' }, origin)
    const verifier = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: auth, error: authError } = await verifier.auth.getUser(token)
    if (authError || !auth.user) return json(401, { error: 'Your session expired. Sign in again.' }, origin)
    const user = auth.user
    const adminAction = ['list_admin','get_admin','reply_admin','set_status','retry_email'].includes(body.action)
    if (adminAction && (!user.email || !user.email_confirmed_at || !isMaintainer(user.email, normalizeMaintainerEmails(Deno.env.get('AI_HELP_MAINTAINER_EMAILS'))))) {
      return json(403, { error: 'This account is not authorized to manage feedback and support.' }, origin)
    }
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const fields = 'id,user_id,category,source,subject,original_message,status,metadata,email_status,share_email,maintainer_seen_at,maintainer_seen_by,last_activity_at,created_at,updated_at'
    const messages = async (id: string) => admin.from('support_feedback_messages').select('id,feedback_id,sender_user_id,sender_role,body,request_id,created_at').eq('feedback_id', id).order('created_at', { ascending: true })

    if (body.action === 'list_mine') {
      const { data, error } = await admin.from('support_feedback').select(fields).eq('user_id', user.id).neq('category', 'ai_answer_feedback').order('last_activity_at', { ascending: false }).limit(100)
      if (error) return json(503, { error: 'Your support queries could not be loaded.' }, origin)
      return json(200, { threads: data ?? [] }, origin)
    }
    if (body.action === 'get_mine' || body.action === 'get_admin') {
      if (typeof body.feedback_id !== 'string' || !uuid.test(body.feedback_id)) return json(400, { error: 'Choose a valid support conversation.' }, origin)
      let query = admin.from('support_feedback').select(fields).eq('id', body.feedback_id)
      if (body.action === 'get_mine') query = query.eq('user_id', user.id)
      const { data: thread, error } = await query.maybeSingle()
      if (error || !thread) return json(404, { error: 'That support conversation is unavailable.' }, origin)
      if (body.action === 'get_admin') {
        const { error: seenError } = await admin.from('support_feedback').update({ maintainer_seen_at: new Date().toISOString(), maintainer_seen_by: user.id }).eq('id', thread.id)
        if (seenError) return json(503, { error: 'The feedback record could not be marked as reviewed.' }, origin)
      }
      const { data: threadMessages, error: messageError } = await messages(thread.id)
      if (messageError) return json(503, { error: 'Conversation messages could not be loaded.' }, origin)
      let userEmail: string | null = null
      if (body.action === 'get_admin' && thread.user_id && thread.share_email) {
        const { data: account } = await admin.auth.admin.getUserById(thread.user_id)
        userEmail = consentedMaintainerEmail(Boolean(thread.share_email && account.user?.email_confirmed_at), account.user?.email)
      }
      return json(200, { thread: body.action === 'get_admin' ? { ...thread, maintainer_seen_at: new Date().toISOString(), maintainer_seen_by: user.id } : thread, messages: threadMessages ?? [], ...(body.action === 'get_admin' ? { user_email: userEmail } : {}) }, origin)
    }
    if (body.action === 'list_admin') {
      const status = typeof body.status === 'string' ? body.status : 'all'
      const category = typeof body.category === 'string' ? body.category : 'all'
      const search = typeof body.search === 'string' ? body.search.trim().slice(0, 80).replace(/[%_,()\\]/g, ' ') : ''
      const sort = body.sort === 'oldest' ? 'oldest' : 'newest'
      const limit = typeof body.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(body.limit))) : 25
      const offset = typeof body.offset === 'number' ? Math.min(10000, Math.max(0, Math.floor(body.offset))) : 0
      if (status !== 'all' && !statuses.has(status)) return json(400, { error: 'Choose a valid status filter.' }, origin)
      if (category !== 'all' && !categories.has(category)) return json(400, { error: 'Choose a valid category filter.' }, origin)
      try { await admin.from('support_feedback').delete().eq('category', 'ai_answer_feedback').lte('created_at', new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()) } catch { /* AI answer reports follow the existing 180-day retention policy. */ }
      let query = admin.from('support_feedback').select(fields, { count: 'exact' })
      if (status !== 'all') query = query.eq('status', status)
      if (category !== 'all') query = query.eq('category', category)
      if (search) query = query.or(`subject.ilike.%${search}%,original_message.ilike.%${search}%`)
      const { data, error, count } = await query.order('last_activity_at', { ascending: sort === 'oldest' }).range(offset, offset + limit - 1)
      if (error) return json(503, { error: 'Feedback inbox could not be loaded.' }, origin)
      const [total, open, waiting, resolved, incorrect, unread] = await Promise.all([
        admin.from('support_feedback').select('id', { count: 'exact', head: true }),
        admin.from('support_feedback').select('id', { count: 'exact', head: true }).in('status', ['open','in_progress']),
        admin.from('support_feedback').select('id', { count: 'exact', head: true }).eq('status', 'waiting_for_user'),
        admin.from('support_feedback').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
        admin.from('support_feedback').select('id', { count: 'exact', head: true }).eq('category', 'ai_answer_feedback').neq('metadata->>answer_category', 'helpful'),
        admin.from('support_feedback').select('id', { count: 'exact', head: true }).is('maintainer_seen_at', null),
      ])
      if ([total,open,waiting,resolved,incorrect,unread].some((item) => item.error)) return json(503, { error: 'Feedback inbox metrics could not be loaded.' }, origin)
      const threads = await Promise.all((data ?? []).map(async (thread) => {
        if (!thread.user_id || !thread.share_email) return { ...thread, user_email: null }
        const { data: account } = await admin.auth.admin.getUserById(thread.user_id)
        return { ...thread, user_email: consentedMaintainerEmail(Boolean(thread.share_email && account.user?.email_confirmed_at), account.user?.email) }
      }))
      return json(200, { threads, total: count ?? 0, has_more: (data?.length ?? 0) === limit, metrics: { total: total.count ?? 0, open: open.count ?? 0, waiting: waiting.count ?? 0, resolved: resolved.count ?? 0, incorrect_ai: incorrect.count ?? 0, unread: unread.count ?? 0 } }, origin)
    }
    if (body.action === 'reply_mine' || body.action === 'reply_admin') {
      if (typeof body.feedback_id !== 'string' || !uuid.test(body.feedback_id) || typeof body.request_id !== 'string' || !uuid.test(body.request_id) || typeof body.message !== 'string' || body.message.trim().length < 1 || body.message.length > 4000) return json(400, { error: 'Enter a reply between 1 and 4,000 characters.' }, origin)
      const { data: thread, error: threadError } = await admin.from('support_feedback').select('id,user_id').eq('id', body.feedback_id).maybeSingle()
      if (threadError || !thread || (body.action === 'reply_mine' && thread.user_id !== user.id)) return json(404, { error: 'That support conversation is unavailable.' }, origin)
      const rpcCall = supportReplyRpc(body.action, user.id, body.feedback_id, body.request_id, body.message.trim())
      const { data: result, error } = await admin.rpc(rpcCall.name, rpcCall.args)
      if (error) return json(error.code === 'P0002' ? 404 : error.code === '55000' || error.code === '40001' ? 409 : error.code === 'P4290' ? 429 : error.code === '22023' ? 400 : 503, { error: error.code === '55000' ? 'This conversation is resolved. Start a new support query to continue.' : error.code === 'P4290' ? 'You have sent several replies recently. Please wait before trying again.' : error.code === '40001' ? 'This conversation changed. Refresh and try again.' : 'Your reply could not be saved. Please retry.' }, origin)
      let emailStatus = 'not_required'
      if (body.action === 'reply_mine') {
        try { emailStatus = await deliverPendingSupportEmail(admin, body.feedback_id, { userId: user.id, email: user.email_confirmed_at ? user.email ?? null : null }, { apiKey: Deno.env.get('BREVO_API_KEY') ?? '', from: Deno.env.get('FEEDBACK_FROM_EMAIL') ?? '', to: PUBLIC_SUPPORT_EMAIL, appVersion: Deno.env.get('SUPPORT_FEEDBACK_APP_VERSION') ?? '0.1.0' }) }
        catch (deliveryError) { console.error('SUPPORT_REPLY_DELIVERY_FAILED', JSON.stringify({ code: deliveryError instanceof Error ? deliveryError.message : 'unknown' })) }
      }
      return json(200, { ...result, emailStatus }, origin)
    }
    if (body.action === 'set_status') {
      if (typeof body.feedback_id !== 'string' || !uuid.test(body.feedback_id) || typeof body.status !== 'string' || !statuses.has(body.status)) return json(400, { error: 'Choose a valid support status.' }, origin)
      if (typeof body.expected_updated_at !== 'string' || !Number.isFinite(Date.parse(body.expected_updated_at))) return json(400, { error: 'Refresh this conversation before changing its status.' }, origin)
      const { data, error } = await admin.rpc('support_set_status', { p_feedback_id: body.feedback_id, p_status: body.status, p_maintainer_id: user.id, p_expected_updated_at: body.expected_updated_at })
      if (error) return json(error.code === 'P0002' ? 404 : error.code === '40001' ? 409 : 503, { error: error.code === '40001' ? 'This conversation changed. Refresh before changing its status.' : 'The feedback status could not be updated.' }, origin)
      return json(200, data)
    }
    if (body.action === 'retry_email') {
      if (typeof body.feedback_id !== 'string' || !uuid.test(body.feedback_id)) return json(400, { error: 'Choose a valid feedback record.' }, origin)
      const { data: thread, error } = await admin.from('support_feedback').select('id,user_id,email_status').eq('id', body.feedback_id).maybeSingle()
      if (error || !thread) return json(404, { error: 'That feedback record is unavailable.' }, origin)
      if (!['pending','failed'].includes(thread.email_status)) return json(409, { error: 'Only pending or confirmed failed notifications can be retried. Uncertain deliveries are never resent.' }, origin)
      const { data: account } = thread.user_id ? await admin.auth.admin.getUserById(thread.user_id) : { data: { user: null } }
      try {
        const deliveryStatus = await deliverPendingSupportEmail(admin, thread.id, { userId: thread.user_id ?? user.id, email: account.user?.email_confirmed_at ? account.user.email ?? null : null }, {
          apiKey: Deno.env.get('BREVO_API_KEY') ?? '', from: Deno.env.get('FEEDBACK_FROM_EMAIL') ?? '', to: PUBLIC_SUPPORT_EMAIL,
          appVersion: Deno.env.get('SUPPORT_FEEDBACK_APP_VERSION') ?? '0.1.0',
        })
        return json(200, { accepted: true, deliveryStatus }, origin)
      } catch {
        return json(503, { error: 'The notification retry could not be completed. Refresh to check its saved delivery state.' }, origin)
      }
    }
    return json(400, { error: 'Unsupported support action.' }, origin)
  } catch {
    return json(500, { error: 'The support request could not be completed.' }, origin)
  }
})

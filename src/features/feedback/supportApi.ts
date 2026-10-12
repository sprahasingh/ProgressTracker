import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from '../../services/supabase/client'

export type SupportStatus = 'open' | 'in_progress' | 'waiting_for_user' | 'resolved'
export type SupportCategory = 'support_query' | 'bug_report' | 'feature_request' | 'general_feedback' | 'ai_answer_feedback'
export type SupportMessage = { id: string; feedback_id: string; sender_user_id: string | null; sender_role: 'user' | 'maintainer'; body: string; created_at: string }
export type SupportThread = { id: string; user_id: string | null; category: SupportCategory; source: string; subject: string; original_message: string; status: SupportStatus; metadata: Record<string, unknown>; email_status: string; share_email?: boolean; maintainer_seen_at?: string | null; maintainer_seen_by?: string | null; created_at: string; last_activity_at: string; updated_at: string }
export type SupportThreadDetail = { thread: SupportThread; messages: SupportMessage[]; user_email?: string | null }

export class SupportApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }

async function invoke<T>(body: Record<string, unknown>, client: SupabaseClient | null = getSupabaseClient()): Promise<T> {
  if (!client) throw new SupportApiError(503, 'Support conversations are unavailable because the account service is not configured.')
  const { data: session, error: sessionError } = await client.auth.getSession()
  const token = session.session?.access_token
  if (sessionError || !token) throw new SupportApiError(401, 'Sign in again to access support conversations.')
  const { data, error } = await client.functions.invoke<T>('support-inbox', { body, headers: { Authorization: `Bearer ${token}` } })
  if (!error) return data as T
  const response = error.context instanceof Response ? error.context : null
  let message = ''
  let status = 0
  if (response) {
    status = response.status
    try { const payload = await response.clone().json() as { error?: unknown }; if (typeof payload.error === 'string') message = payload.error } catch { /* Stable message below. */ }
  }
  if (!message) {
    if (status === 401) message = 'Your sign-in expired. Sign in again to view support conversations.'
    else if (status === 403) message = 'This account cannot access that support conversation.'
    else if (status === 404) message = 'That support conversation is unavailable.'
    else if (status === 429) message = 'You have sent several support requests recently. Please wait before trying again.'
    else if (status >= 500) message = 'Support is temporarily unavailable. Your saved messages are safe; please retry.'
    else if (!response) message = 'Could not connect to Support. Check your connection and retry.'
    else message = 'Check the support request and try again.'
  }
  throw new SupportApiError(status, message)
}

export const listMySupportThreads = (client?: SupabaseClient | null) => invoke<{ threads: SupportThread[] }>({ action: 'list_mine' }, client)
export const getMySupportThread = (feedbackId: string, client?: SupabaseClient | null) => invoke<SupportThreadDetail>({ action: 'get_mine', feedback_id: feedbackId }, client)
export const replyToMySupportThread = (feedbackId: string, message: string, requestId: string, client?: SupabaseClient | null) => invoke<{ accepted: boolean; duplicate: boolean; emailStatus: string }>({ action: 'reply_mine', feedback_id: feedbackId, message, request_id: requestId }, client)

export type SupportInboxFilters = { status: SupportStatus | 'all'; category: SupportCategory | 'all'; search: string; offset?: number; sort?: 'newest' | 'oldest' }
export type SupportInboxList = { threads: Array<SupportThread & { user_email?: string | null }>; total: number; has_more: boolean; metrics: { total: number; open: number; waiting: number; resolved: number; incorrect_ai: number; unread: number } }
export const listSupportInbox = (filters: SupportInboxFilters, client?: SupabaseClient | null) => invoke<SupportInboxList>({ action: 'list_admin', ...filters, limit: 25 }, client)
export const getSupportInboxThread = (feedbackId: string, client?: SupabaseClient | null) => invoke<SupportThreadDetail>({ action: 'get_admin', feedback_id: feedbackId }, client)
export const replyAsMaintainer = (feedbackId: string, message: string, requestId: string, client?: SupabaseClient | null) => invoke<{ accepted: boolean; duplicate: boolean; status: SupportStatus }>({ action: 'reply_admin', feedback_id: feedbackId, message, request_id: requestId }, client)
export async function setSupportThreadStatus(feedbackId: string, status: SupportStatus, expectedUpdatedAt: string, client?: SupabaseClient | null): Promise<{ status: SupportStatus }> {
  const result = await invoke<{ status: SupportStatus }>({ action: 'set_status', feedback_id: feedbackId, status, expected_updated_at: expectedUpdatedAt }, client)
  if (!result || result.status !== status) throw new SupportApiError(502, 'The server did not confirm the requested status. Refresh the conversation and try again.')
  return result
}
export const retrySupportEmail = (feedbackId: string, client?: SupabaseClient | null) => invoke<{ accepted: boolean; deliveryStatus: string }>({ action: 'retry_email', feedback_id: feedbackId }, client)

export type SupportReplyAction = 'reply_mine' | 'reply_admin'

export function supportStatusRpcFailure(code: string) {
  if (code === 'P0002') return { status: 404, error: 'That feedback record is unavailable.' }
  if (code === '40001') return { status: 409, error: 'This conversation changed. Refresh before changing its status.' }
  if (code === '22023') return { status: 400, error: 'Choose a valid status for this conversation.' }
  return { status: 503, error: 'The feedback status could not be updated.' }
}

/** Return the exact named RPC signature for the selected reply path. */
export function supportReplyRpc(action: SupportReplyAction, userId: string, feedbackId: string, requestId: string, message: string) {
  if (action === 'reply_mine') {
    return {
      name: 'support_user_reply' as const,
      args: { p_user_id: userId, p_feedback_id: feedbackId, p_request_id: requestId, p_message: message },
    }
  }
  return {
    name: 'support_maintainer_reply' as const,
    args: { p_maintainer_id: userId, p_feedback_id: feedbackId, p_request_id: requestId, p_message: message },
  }
}

export function consentedMaintainerEmail(shareEmail: boolean, email: string | null | undefined): string | null {
  return shareEmail && email ? email : null
}

export type ConsentedSupportIdentity = { display_name: string | null; email: string | null }

/** Explicit DTO excludes owner IDs, consent flags, arbitrary metadata, and message linkage IDs. */
export function buildSupportMaintainerThread(thread: Record<string, any>, identity: ConsentedSupportIdentity | null, currentPreference = false) {
  const metadata = thread.category === 'ai_answer_feedback'
    ? Object.fromEntries(['answer_category', 'topic', 'knowledge_version']
      .filter((key) => typeof thread.metadata?.[key] === 'string')
      .map((key) => [key, thread.metadata[key]]))
    : {}
  return {
    id: thread.id,
    category: thread.category,
    source: thread.source,
    subject: thread.subject,
    original_message: thread.original_message,
    status: thread.status,
    metadata,
    email_status: thread.email_status,
    maintainer_seen_at: thread.maintainer_seen_at ?? null,
    last_activity_at: thread.last_activity_at,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    identity: thread.share_identity && currentPreference ? identity ?? { display_name: null, email: null } : null,
  }
}

export function buildSupportMaintainerMessage(message: Record<string, any>) {
  return { id: message.id, sender_role: message.sender_role, body: message.body, created_at: message.created_at }
}

/** Maintainer RPC responses may contain message IDs; return only workflow state. */
export function buildMaintainerReplyResponse(result: Record<string, unknown> | null | undefined) {
  return { accepted: result?.accepted === true, duplicate: result?.duplicate === true, status: result?.status }
}

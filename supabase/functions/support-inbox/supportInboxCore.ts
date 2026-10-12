export type SupportReplyAction = 'reply_mine' | 'reply_admin'

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

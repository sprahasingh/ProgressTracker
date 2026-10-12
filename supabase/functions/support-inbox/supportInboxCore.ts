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

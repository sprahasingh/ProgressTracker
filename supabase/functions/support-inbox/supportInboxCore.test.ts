import { describe, expect, it } from 'vitest'
import { consentedMaintainerEmail, supportReplyRpc, supportStatusRpcFailure } from './supportInboxCore.ts'

describe('support reply RPC mapping', () => {
  it('omits the account address from maintainer-facing data unless the user opted in', () => {
    expect(consentedMaintainerEmail(false, 'person@example.com')).toBeNull()
    expect(consentedMaintainerEmail(true, 'person@example.com')).toBe('person@example.com')
    expect(consentedMaintainerEmail(true, null)).toBeNull()
  })
  it('matches the user reply SQL signature', () => {
    expect(supportReplyRpc('reply_mine', 'user-1', 'thread-1', 'request-1', 'reply')).toEqual({
      name: 'support_user_reply',
      args: { p_user_id: 'user-1', p_feedback_id: 'thread-1', p_request_id: 'request-1', p_message: 'reply' },
    })
  })

  it('matches the maintainer reply SQL signature without omitted named parameters', () => {
    expect(supportReplyRpc('reply_admin', 'maintainer-1', 'thread-1', 'request-1', 'reply')).toEqual({
      name: 'support_maintainer_reply',
      args: { p_maintainer_id: 'maintainer-1', p_feedback_id: 'thread-1', p_request_id: 'request-1', p_message: 'reply' },
    })
  })
})

describe('support status RPC failures', () => {
  it('maps conflict and invalid status errors to recoverable client responses', () => {
    expect(supportStatusRpcFailure('40001')).toEqual({ status: 409, error: 'This conversation changed. Refresh before changing its status.' })
    expect(supportStatusRpcFailure('22023')).toEqual({ status: 400, error: 'Choose a valid status for this conversation.' })
  })
  it('keeps missing records and unexpected database failures distinct', () => {
    expect(supportStatusRpcFailure('P0002').status).toBe(404)
    expect(supportStatusRpcFailure('XX000').status).toBe(503)
  })
})

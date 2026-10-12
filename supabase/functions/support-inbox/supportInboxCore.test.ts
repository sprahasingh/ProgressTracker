import { describe, expect, it } from 'vitest'
import { buildMaintainerReplyResponse, buildSupportMaintainerMessage, buildSupportMaintainerThread, consentedMaintainerEmail, supportReplyRpc, supportStatusRpcFailure } from './supportInboxCore.ts'

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

describe('maintainer-safe support DTOs', () => {
  it('strips internal message identifiers from maintainer reply responses', () => {
    const dto = buildMaintainerReplyResponse({ accepted: true, duplicate: false, status: 'waiting_for_user', message_id: 'private-message-id', feedback_id: 'private-thread-id' })
    expect(dto).toEqual({ accepted: true, duplicate: false, status: 'waiting_for_user' })
  })

  const thread = {
    id: 'thread-1', user_id: 'account-secret', category: 'support_query', source: 'settings', subject: 'Help',
    original_message: 'Please help.', status: 'open', metadata: { private_key: 'never-return', response_id: 'linked-id' },
    email_status: 'pending', share_email: true, share_identity: false, maintainer_seen_at: null,
    maintainer_seen_by: 'reviewer-secret', last_activity_at: '2026-10-12T00:00:00Z', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
  }

  it('omits all account identifiers and arbitrary metadata for anonymous support threads', () => {
    const dto = buildSupportMaintainerThread(thread, { display_name: 'Ada', email: 'ada@example.com' })
    expect(dto).toMatchObject({ identity: null, metadata: {}, id: 'thread-1' })
    expect(dto).not.toHaveProperty('user_id')
    expect(dto).not.toHaveProperty('share_email')
    expect(dto).not.toHaveProperty('share_identity')
    expect(dto).not.toHaveProperty('maintainer_seen_by')
    expect(JSON.stringify(dto)).not.toContain('account-secret')
    expect(JSON.stringify(dto)).not.toContain('linked-id')
  })

  it('includes only the opted-in display name and permitted email for identified threads', () => {
    expect(buildSupportMaintainerThread({ ...thread, share_identity: true }, { display_name: 'Ada', email: 'ada@example.com' }, true))
      .toMatchObject({ identity: { display_name: 'Ada', email: 'ada@example.com' } })
  })

  it('withdraws identity when current consent is disabled even if the submission snapshot is true', () => {
    const dto = buildSupportMaintainerThread({ ...thread, share_identity: true }, { display_name: 'Ada', email: 'ada@example.com' }, false)
    expect(dto.identity).toBeNull()
  })

  it('removes sender, request, and thread identifiers from maintainer message records', () => {
    const dto = buildSupportMaintainerMessage({ id: 'message-1', feedback_id: 'thread-1', sender_user_id: 'account-secret', sender_role: 'user', body: 'Follow-up', request_id: 'request-secret', created_at: '2026-10-12T00:00:00Z' })
    expect(dto).toEqual({ id: 'message-1', sender_role: 'user', body: 'Follow-up', created_at: '2026-10-12T00:00:00Z' })
  })
})

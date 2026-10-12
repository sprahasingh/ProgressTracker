import { afterEach, describe, expect, it, vi } from 'vitest'
import { logReviewStage, reviewFailureDetails, reviewFailureLog, reviewFailureResponse } from './diagnostics'

describe('AI Help review diagnostics', () => {
  afterEach(() => vi.restoreAllMocks())
  it('classifies database schema and permission errors by safe SQLSTATE only', () => {
    expect(reviewFailureDetails({ name: 'PostgrestError', code: '42P01', message: 'private table detail' }))
      .toEqual({ category: 'database_schema_or_permission', code: '42P01' })
    expect(reviewFailureDetails({ code: '42501' })).toEqual({ category: 'database_schema_or_permission', code: '42501' })
  })

  it('classifies uncaught network and runtime failures without logging their messages', () => {
    const failure = new Error('contains secret response content')
    failure.name = 'FunctionsFetchError'
    expect(reviewFailureLog('list', 'knowledge_list_queries', failure)).toEqual({
      action: 'list', operation: 'knowledge_list_queries', category: 'network',
    })
    expect(JSON.stringify(reviewFailureLog('feedback_list', 'admin_client_initialization', new Error('private content'))))
      .not.toContain('private content')
  })

  it('omits malformed or non-SQLSTATE error codes', () => {
    expect(reviewFailureDetails({ name: 'Error', code: 'secret-value' })).toEqual({ category: 'runtime' })
  })

  it('writes the unexpected-failure diagnostic before returning a generic 500', async () => {
    const events: string[] = []
    const order: string[] = []
    const response = reviewFailureResponse(
      'feedback_list',
      'admin_client_initialization',
      new Error('private details'),
      (event, payload) => { order.push('diagnostic'); events.push(event, payload) },
      (body) => { order.push('response'); return new Response(JSON.stringify(body), { status: 500 }) },
    )
    expect(order).toEqual(['diagnostic', 'response'])
    expect(events[0]).toBe('AI_HELP_REVIEW_UNEXPECTED_FAILURE')
    expect(events[1]).toContain('"operation":"admin_client_initialization"')
    expect(events[1]).not.toContain('private details')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'The review request could not be completed.' })
  })

  it('keeps the generic response if error inspection or diagnostic writing fails', async () => {
    const hostileError = Object.defineProperty({}, 'name', { get() { throw new Error('private getter detail') } })
    const fallback = vi.spyOn(console, 'log').mockImplementation(() => {})
    const response = reviewFailureResponse('list', 'auth_user_verification', hostileError, () => {
      throw new Error('logger unavailable')
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'The review request could not be completed.' })
    expect(fallback).toHaveBeenCalledWith('AI_HELP_REVIEW_FAILURE_LOG_FALLBACK', expect.stringContaining('auth_user_verification'))
  })

  it('emits fixed stage markers without changing behavior when logging fails', () => {
    const events: string[] = []
    logReviewStage('authorization_complete', 'list', (event, payload) => events.push(event, payload))
    expect(events).toEqual(['AI_HELP_REVIEW_STAGE', '{"stage":"authorization_complete","action":"list"}'])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => logReviewStage('handler_entry', 'unknown', () => { throw new Error('logger unavailable') })).not.toThrow()
    expect(console.error).toHaveBeenCalledWith('AI_HELP_REVIEW_STAGE_LOG_FAILURE', '{"stage":"handler_entry","action":"unknown"}')
  })
})

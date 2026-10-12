import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initialState, isLoopbackAssistantEndpoint, persistQuestionResult, redact, recoverInterruptedState, runBenchmark } from '../../../scripts/ai-help-evaluation-runner.mjs'

const temporaryDirectories: string[] = []
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('interruption-safe AI Help evaluation runner', () => {
  it('accepts only the local AI Help endpoint', () => {
    expect(isLoopbackAssistantEndpoint('http://127.0.0.1:54321/functions/v1/ai-help')).toBe(true)
    expect(isLoopbackAssistantEndpoint('http://localhost:54321/functions/v1/ai-help')).toBe(true)
    expect(isLoopbackAssistantEndpoint('https://project.supabase.co/functions/v1/ai-help')).toBe(false)
    expect(isLoopbackAssistantEndpoint('http://127.0.0.1:54321/functions/v1/other')).toBe(false)
  })

  it('redacts credentials and email addresses in persisted output', () => {
    expect(redact({ access_token: 'secret-token', answer: 'Bearer abc.def and user@example.test' })).toEqual({ access_token: '[REDACTED]', answer: 'Bearer [REDACTED] and [REDACTED EMAIL]' })
  })

  it('marks an interrupted in-flight question lost and never marks it complete', () => {
    const state = { ...initialState(['D1'], 1), reservedCalls: 1, results: { D1: { id: 'D1', status: 'started' } } }
    const recovered = recoverInterruptedState(state)
    expect(recovered.reservedCalls).toBe(1)
    expect(recovered.results.D1).toMatchObject({ status: 'lost_result', assessment: 'unscored' })
    expect(recoverInterruptedState(recovered)).toBe(recovered)
  })

  it('persists a question result atomically with its resume manifest', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-help-runner-'))
    temporaryDirectories.push(directory)
    const result = { id: 'DB2', status: 'failed', httpStatus: 429, latencyMs: 8, access_token: 'must-not-persist' }
    const state = await persistQuestionResult(directory, result, { ...initialState(['DB2'], 2), reservedCalls: 1 })
    expect(JSON.parse(await readFile(path.join(directory, 'questions/DB2.json'), 'utf8'))).toMatchObject({ id: 'DB2', status: 'failed', access_token: '[REDACTED]' })
    expect(JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'))).toMatchObject({ reservedCalls: 1, results: { DB2: { status: 'failed' } } })
    expect(state.results.DB2.status).toBe('failed')
  })

  it('reserves a strict potential-call budget before sending and refuses remote endpoints', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-help-runner-'))
    temporaryDirectories.push(directory)
    const benchmark = Array.from({ length: 30 }, (_, index) => ({ id: `Q${index}`, question: `Question ${index}`, expected: 'Expected behavior' }))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'cooldown' }), { status: 503 }))
    await expect(runBenchmark({ benchmark, outputDir: directory, endpoint: 'https://hosted.supabase.co/functions/v1/ai-help', anonKey: 'local', accessToken: 'user', maxGroqCalls: 1, fetcher })).rejects.toThrow('non-loopback')
    const state = await runBenchmark({ benchmark, outputDir: directory, endpoint: 'http://127.0.0.1:54321/functions/v1/ai-help', anonKey: 'local', accessToken: 'user', maxGroqCalls: 1, fetcher })
    expect(state.reservedCalls).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(state.results.Q0.status).toBe('failed')
    expect(Object.values(state.results).filter((item: { status: string }) => item.status === 'not_run_budget_exhausted')).toHaveLength(29)
  })
})

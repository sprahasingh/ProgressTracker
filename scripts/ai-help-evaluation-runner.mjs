import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const secretKeys = /(?:token|password|api.?key|authorization|secret|credential)/i
const deterministicContact = /^For ProgressTracker support, email [^\s]+\.$/i

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]')
      .replace(/\b(?:sk|gsk)_[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED KEY]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]')
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKeys.test(key) ? '[REDACTED]' : redact(item)]))
}

export function isLoopbackAssistantEndpoint(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname.replace(/\/$/, '') === '/functions/v1/ai-help'
      && !url.username && !url.password
  } catch { return false }
}

export function initialState(questionIds, maxGroqCalls = 30) {
  if (!Number.isInteger(maxGroqCalls) || maxGroqCalls < 1 || maxGroqCalls > 30) throw new Error('Groq call budget must be between 1 and 30.')
  return { schemaVersion: 1, maxGroqCalls, reservedCalls: 0, questionIds, results: {} }
}

export function recoverInterruptedState(state) {
  let changed = false
  const results = { ...state.results }
  for (const [id, result] of Object.entries(results)) {
    if (result.status === 'started') {
      results[id] = { ...result, status: 'lost_result', assessment: 'unscored', recoveredAt: new Date().toISOString() }
      changed = true
    }
  }
  return changed ? { ...state, results } : state
}

function safeId(id) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('Benchmark question IDs must use letters, numbers, underscore, or hyphen.')
  return id
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(redact(value), null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, filePath)
}

export async function persistQuestionResult(outputDir, result, state) {
  const id = safeId(result.id)
  await atomicJson(path.join(outputDir, 'questions', `${id}.json`), result)
  const next = { ...state, results: { ...state.results, [id]: result } }
  await atomicJson(path.join(outputDir, 'run.json'), next)
  return next
}

function validateBenchmark(value) {
  if (!Array.isArray(value) || value.length !== 30) throw new Error('Benchmark must contain exactly the fixed 30 questions.')
  const ids = new Set()
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || typeof item.question !== 'string' || typeof item.expected !== 'string') throw new Error('Each benchmark row needs id, question, and expected text.')
    safeId(item.id)
    if (ids.has(item.id)) throw new Error('Benchmark question IDs must be unique.')
    ids.add(item.id)
  }
  return value
}

export async function runBenchmark({ benchmark, outputDir, endpoint, anonKey, accessToken, model = null, maxGroqCalls = 30, intervalMs = 9_000, fetcher = fetch }) {
  if (!isLoopbackAssistantEndpoint(endpoint)) throw new Error('Refusing a non-loopback AI Help endpoint.')
  if (!anonKey || !accessToken) throw new Error('Local publishable key and user access token are required.')
  if (!Number.isInteger(maxGroqCalls) || maxGroqCalls < 1 || maxGroqCalls > 30) throw new Error('Groq call budget must be between 1 and 30.')
  const questions = validateBenchmark(benchmark)
  const directory = path.resolve(outputDir)
  const temp = path.resolve(os.tmpdir())
  if (!(directory === temp || directory.startsWith(`${temp}${path.sep}`) || directory.startsWith('/private/tmp/'))) throw new Error('Evaluation artifacts must be outside the repository in a temporary directory.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let state
  try {
    state = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'))
    if (state.maxGroqCalls !== maxGroqCalls || JSON.stringify(state.questionIds) !== JSON.stringify(questions.map(({ id }) => id))) throw new Error('Resume parameters do not match the existing run.')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    state = initialState(questions.map(({ id }) => id), maxGroqCalls)
  }
  const interruptedIds = Object.entries(state.results).filter(([, result]) => result.status === 'started').map(([id]) => id)
  state = recoverInterruptedState(state)
  await atomicJson(path.join(directory, 'run.json'), state)
  for (const id of interruptedIds) state = await persistQuestionResult(directory, state.results[id], state)

  let previousRequestAt = 0
  for (const item of questions) {
    if (state.results[item.id]) continue // Completed, failed, or lost results are never silently rerun.
    const isKnownDeterministic = /^(?:hi|hello|hey|thanks|thank you)\b/i.test(item.question)
      || /^what(?:'s| is) (?:the |your )?support email\??$/i.test(item.question)
    if (!isKnownDeterministic && state.reservedCalls >= maxGroqCalls) {
      for (const notRun of questions.filter(({ id }) => !state.results[id])) {
        const result = { id: notRun.id, question: notRun.question, expected: notRun.expected, status: 'not_run_budget_exhausted', assessment: 'unscored', groqCallReserved: false }
        state = await persistQuestionResult(directory, result, state)
      }
      break
    }
    if (previousRequestAt && intervalMs > 0) {
      const delay = Math.max(0, intervalMs - (Date.now() - previousRequestAt))
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    }
    previousRequestAt = Date.now()
    const startedAt = Date.now()
    const attempt = { id: item.id, question: item.question, expected: item.expected, status: 'started', assessment: null, startedAt: new Date(startedAt).toISOString(), groqCallReserved: !isKnownDeterministic }
    state = { ...state, reservedCalls: state.reservedCalls + (isKnownDeterministic ? 0 : 1), results: { ...state.results, [item.id]: attempt } }
    await persistQuestionResult(directory, attempt, state)
    let result
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: item.question, history: [], pageContext: 'other' }),
        signal: AbortSignal.timeout(40_000),
      })
      const latencyMs = Date.now() - startedAt
      const body = await response.json().catch(() => null)
      const deterministic = response.ok && typeof body?.answer === 'string' && deterministicContact.test(body.answer)
      const groqCallsObserved = response.ok ? (deterministic ? 0 : 1)
        : body?.code === 'provider_rate_limit' ? 1
          : ['provider_cooldown', 'application_rate_limit', 'configuration_missing', 'invalid_request'].includes(body?.code) ? 0 : null
      result = {
        ...attempt,
        status: response.ok ? (deterministic ? 'deterministic' : 'success') : 'failed',
        responseKind: deterministic ? 'deterministic' : response.ok ? 'assistant_endpoint_response' : 'error',
        httpStatus: response.status,
        latencyMs,
        groqCallsObserved,
        configuredModel: model,
        bundleVersion: typeof body?.knowledge_version === 'string' ? body.knowledge_version : null,
        modelOutput: response.ok && !deterministic ? redact(body) : null,
        deterministicResponse: deterministic ? redact(body) : null,
        error: response.ok ? null : redact(body),
        finishedAt: new Date().toISOString(),
      }
    } catch (error) {
      result = { ...attempt, status: 'failed', responseKind: 'transport_error', latencyMs: Date.now() - startedAt, error: { name: error?.name ?? 'Error', message: 'Local endpoint request failed.' }, finishedAt: new Date().toISOString() }
    }
    state = await persistQuestionResult(directory, result, state)
  }
  return state
}

async function main() {
  const args = process.argv.slice(2)
  const options = Object.fromEntries(args.reduce((pairs, arg, index) => arg.startsWith('--') && args[index + 1] && !args[index + 1].startsWith('--') ? [...pairs, [arg.slice(2), args[index + 1]]] : pairs, []))
  if (!options.benchmark || !options.output || !options.endpoint) throw new Error('Usage: node scripts/ai-help-evaluation-runner.mjs --benchmark /tmp/fixed-30.json --output /tmp/ai-help-eval --endpoint http://127.0.0.1:54321/functions/v1/ai-help [--max-groq-calls 30]')
  const state = await runBenchmark({
    benchmark: JSON.parse(await readFile(options.benchmark, 'utf8')),
    outputDir: options.output,
    endpoint: options.endpoint,
    anonKey: process.env.SUPABASE_ANON_KEY,
    accessToken: process.env.SUPABASE_ACCESS_TOKEN,
    model: process.env.AI_HELP_EVAL_MODEL ?? null,
    maxGroqCalls: Number(options['max-groq-calls'] ?? 30),
  })
  const completed = Object.values(state.results).filter(({ status }) => status !== 'started').length
  console.log(`Saved ${completed}/${state.questionIds.length} question results; reserved provider-call budget: ${state.reservedCalls}/${state.maxGroqCalls}.`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Evaluation runner failed.'); process.exitCode = 1 })
}

export type ReviewFailure = { name?: unknown; code?: unknown }
type DiagnosticWriter = (...values: string[]) => void

const sqlStatePattern = /^[0-9A-Z]{5}$/

export function reviewFailureDetails(error: unknown) {
  try {
    const failure = error && typeof error === 'object' ? error as ReviewFailure : {}
    const name = typeof failure.name === 'string' ? failure.name : ''
    const rawCode = typeof failure.code === 'string' && sqlStatePattern.test(failure.code) ? failure.code : undefined
    const category = rawCode
      ? rawCode.startsWith('08') ? 'database_connection'
        : rawCode.startsWith('28') ? 'database_authorization'
          : rawCode.startsWith('42') ? 'database_schema_or_permission'
            : 'database'
      : name === 'ReconciliationResponseError' ? 'reconciliation_contract'
        : /fetch|network|socket/i.test(name) ? 'network'
        : /config|url/i.test(name) ? 'configuration'
          : name ? 'runtime' : 'unknown'
    return { category, ...(rawCode ? { code: rawCode } : {}) }
  } catch {
    return { category: 'unknown' }
  }
}

export function reviewFailureLog(action: string, operation: string, error: unknown) {
  return { action, operation, ...reviewFailureDetails(error) }
}

/** Emit only fixed stage names and the non-sensitive action label; logging must never change request behavior. */
export function logReviewStage(stage: string, action = 'unknown', write: DiagnosticWriter = console.log) {
  const payload = JSON.stringify({ stage, action })
  try { write('AI_HELP_REVIEW_STAGE', payload) }
  catch {
    try { console.error('AI_HELP_REVIEW_STAGE_LOG_FAILURE', payload) } catch { /* Diagnostics must not interrupt request handling. */ }
  }
}

/** Record the failure before constructing the stable, privacy-safe client response. */
export function reviewFailureResponse(
  action: string,
  operation: string,
  error: unknown,
  write: DiagnosticWriter = console.error,
  respond: (body: Record<string, string>) => Response = (body) => new Response(JSON.stringify(body), {
    status: 500,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }),
) {
  const payload = JSON.stringify(reviewFailureLog(action, operation, error))
  try { write('AI_HELP_REVIEW_UNEXPECTED_FAILURE', payload) }
  catch {
    try { console.log('AI_HELP_REVIEW_FAILURE_LOG_FALLBACK', payload) }
    catch { /* A logging failure must not replace the generic response. */ }
  }
  return respond({ error: 'The review request could not be completed.' })
}

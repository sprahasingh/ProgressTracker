/** Lightweight User Timing instrumentation. Names and counts only; never record user data. */
export function measureDevPerformance(name: string): () => void {
  if (!import.meta.env.DEV || typeof performance === 'undefined') return () => undefined
  const startedAt = performance.now()
  return () => {
    performance.measure(`progress-tracker:${name}`, { start: startedAt, end: performance.now() })
  }
}

export function countDevPerformance(name: string, count = 1): void {
  if (!import.meta.env.DEV || typeof performance === 'undefined') return
  performance.mark(`progress-tracker:${name}`, { detail: { count } })
}

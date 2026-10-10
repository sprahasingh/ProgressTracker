export const generalMotivationMessages = [
  'Small steps still move you forward.', 'Consistency beats waiting for the perfect moment.',
  'A little progress today is still progress.', 'Your future self will appreciate today’s effort.',
  'Focus on the next small action.', 'Progress doesn’t have to be perfect.',
  'One focused session can change your day.', 'Keep showing up for what matters to you.',
  'Build momentum, one check-in at a time.', 'A fresh start is always available.',
]
export type MotivationMode = 'off' | 'general' | 'custom' | 'both'
export function chooseMotivation(input: { mode: MotivationMode; customMessages: readonly string[]; recentMessages: readonly string[]; sequence: number; lastSource?: 'general' | 'custom' }): { source: 'general' | 'custom'; message: string } | null {
  if (input.mode === 'off') return null
  const general = input.mode === 'custom' ? [] : generalMotivationMessages
  const custom = input.mode === 'general' ? [] : input.customMessages
  if (!general.length && !custom.length) return null
  let pool: readonly string[]
  let source: 'general' | 'custom'
  if (general.length && custom.length) {
    source = input.lastSource === 'general' ? 'custom' : 'general'
    pool = source === 'general' ? general : custom
  } else {
    source = general.length ? 'general' : 'custom'
    pool = general.length ? general : custom
  }
  const unique = [...new Set(pool)]
  const available = unique.filter((message) => !input.recentMessages.includes(message))
  const candidates = available.length ? available : unique.filter((message) => message !== input.recentMessages[0])
  const message = candidates[Math.abs(input.sequence) % Math.max(candidates.length, 1)]
  return message ? { source, message } : null
}

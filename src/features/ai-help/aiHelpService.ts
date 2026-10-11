import type { SupabaseClient } from '@supabase/supabase-js'

export type HelpRoute = 'today' | 'trackers' | 'analytics' | 'goals' | 'calendar' | 'history' | 'settings' | 'other'
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; status?: 'error'; retryAfterSeconds?: number; retryAfterUntil?: number; links?: Array<{ label: string; href: string }>; followUps?: string[] }

export const suggestionsByRoute: Record<HelpRoute, string[]> = {
  today: ['How are streaks calculated?', 'How do daily check-ins work?', 'What is a success rule?'],
  trackers: ['How do measures work?', 'What is a success rule?', 'Can I change a saved measure?'],
  analytics: ['How is completion rate calculated?', 'How do streak statistics work?', 'What does history include?'],
  goals: ['What is cumulative progress?', 'How are milestones calculated?', 'What is the daily goal target?'],
  calendar: ['What does the calendar show?', 'How can I view past check-ins?', 'How are streaks calculated?'],
  history: ['How do I review past check-ins?', 'What happens to retired measures?', 'How is completion calculated?'],
  settings: ['How does offline sync work?', 'How do I change my workspace settings?', 'How are schedules used?'],
  other: ['How are streaks calculated?', 'What is the difference between daily and cumulative goals?', 'Can I change a saved measure?'],
}

export function getHelpRoute(pathname: string): HelpRoute {
  if (pathname === '/') return 'today'
  if (/^\/(trackers|goals)(\/|$)/.test(pathname)) return pathname.startsWith('/goals') ? 'goals' : 'trackers'
  if (/^\/(dashboard|analytics|achievements)(\/|$)/.test(pathname)) return 'analytics'
  if (/^\/(calendar|holidays)(\/|$)/.test(pathname)) return 'calendar'
  if (/^\/history(\/|$)/.test(pathname)) return 'history'
  if (/^\/(settings|auth)(\/|$)/.test(pathname)) return 'settings'
  return 'other'
}

export type AssistantReply = { answer: string; links?: Array<{ label: string; href: string }>; followUps?: string[] }
export type HelpFailure = 'offline' | 'unauthenticated' | 'unavailable' | 'configuration' | 'edge-error' | 'rate-limit-service' | 'provider-unavailable' | 'provider-cooldown' | 'application-rate-limit' | 'provider-rate-limit' | 'invalid-response' | 'network' | 'unsupported'
export class HelpRequestError extends Error {
  constructor(readonly kind: HelpFailure, readonly retryAfterSeconds?: number) { super(kind) }
}

const allowedLinkLabels = new Map([
  ['/', 'Today'], ['/trackers', 'Trackers'], ['/trackers/new', 'Create a tracker'], ['/goals', 'Goals'],
  ['/dashboard', 'Insights'], ['/calendar', 'Calendar'], ['/history', 'History'], ['/settings', 'Settings'],
])

const answers: Array<{ terms: string[]; answer: string }> = [
  { terms: ['streak', 'miss sunday', 'miss a day'], answer: 'A streak counts consecutive scheduled check-in days that meet the tracker’s success rule. Days outside the tracker schedule do not break the streak. A missed scheduled day does.' },
  { terms: ['cumulative', 'daily goal', 'goal target', 'total goal'], answer: 'A daily goal asks you to reach a target on each scheduled day. A cumulative goal adds progress over a date range toward one total, and needs a deadline. Milestones show progress along the way.' },
  { terms: ['success rule', 'qualify', 'minimum', 'threshold'], answer: 'A success rule decides whether a check-in qualifies. It can compare measure values with thresholds and combine conditions. The rule is evaluated against the values recorded for that check-in.' },
  { terms: ['offline', 'sync', 'synchronization'], answer: 'ProgressTracker saves check-ins locally so you can keep working offline. When you are signed in and online, pending changes synchronize with your account.' },
  { terms: ['completion rate', 'analytics', 'history'], answer: 'History preserves recorded check-ins and their measure context. Analytics summarizes progress across the selected period; retired measures remain part of historical views.' },
  { terms: ['schedule', 'scheduled'], answer: 'A tracker schedule defines which days count as expected check-in days. Streaks and completion summaries use that schedule when interpreting missed days.' },
]

export function getLocalHelpAnswer(question: string, history: ChatMessage[] = []): string | null {
  const normalized = question.toLocaleLowerCase().replace(/\b(?:check[ -]?box(?:es)?|tick[ -]?box(?:es)?)\b/g, 'checklist')
  const followUp = /^(?:and\b|what about\b|how about\b|are there\b|only\b|other\b)/i.test(question.trim()) || /\b(?:it|that|those|other types)\b/i.test(question) || question.trim().split(/\s+/).length <= 3
  const context = followUp ? history.slice(-4).map(({ content }) => content.toLocaleLowerCase()).join(' ') : ''
  const combined = `${normalized} ${context}`
  const hasMeasure = /\b(?:measure|measures|metric|metrics)\b/.test(combined)
  if (/\b(?:checklist|check list)\b/.test(normalized)) {
    return 'Checklist is a legacy measure type kept for existing trackers. Each check-in stores which items are checked, and thresholds or goal planning use the number checked. New measures can be Yes/No or Quantity; Checklist is not available when creating a new measure.'
  }
  if (hasMeasure && /\bduration\b/.test(normalized)) {
    return 'Duration is a legacy numeric measure type retained by existing trackers, usually for elapsed time with a unit such as minutes. New measures use Yes/No or Quantity, and a saved measure type cannot be changed.'
  }
  if ((hasMeasure && /\b(?:type|types|option|options|supported|available|only two|two types)\b/.test(combined)) || (/\b(?:yes\s*\/\s*no|quantity)\b/.test(normalized) && /\b(?:type|types|difference|option|options)\b/.test(normalized))) {
    return 'New measures can be Yes/No or Quantity. Duration and Checklist are legacy types that remain supported on existing trackers, but cannot be selected for new measures. A saved measure’s type cannot be changed.'
  }
  if (hasMeasure && /\b(?:change|edit|switch|convert)\b/.test(combined)) {
    return 'A saved measure keeps its type so historical check-ins retain their meaning. To record a different kind of value, add a new measure. Measures with history can be retired while their past entries remain available.'
  }
  if (hasMeasure && /\b(?:what is|what are|define|meaning|purpose|tell me about|how do measures? work|how does a measure work)\b/.test(combined)) return 'A measure is one value a tracker records on each check-in. New measures can be Yes/No, for a simple state, or Quantity, for a number with an optional unit and precision.'
  return answers.find(({ terms }) => terms.some((term) => normalized.includes(term)))?.answer ?? null
}

async function failureDetails(error: unknown): Promise<{ status?: number; code?: string; retryAfterSeconds?: number }> {
  if (!error || typeof error !== 'object') return {}
  const context = (error as { context?: unknown }).context
  if (!context || typeof context !== 'object') return {}
  const response = context as Response
  const details: { status?: number; code?: string; retryAfterSeconds?: number } = { status: response.status }
  const retryHeader = response.headers?.get('retry-after')
  const headerDelay = Number(retryHeader)
  if (Number.isFinite(headerDelay) && headerDelay > 0) details.retryAfterSeconds = Math.ceil(headerDelay)
  else if (retryHeader) {
    const timestamp = Date.parse(retryHeader)
    if (Number.isFinite(timestamp) && timestamp > Date.now()) details.retryAfterSeconds = Math.ceil((timestamp - Date.now()) / 1000)
  }
  try {
    const payload = await response.clone().json() as { code?: unknown; retryAfterSeconds?: unknown }
    if (typeof payload.code === 'string') details.code = payload.code
    if (typeof payload.retryAfterSeconds === 'number' && Number.isFinite(payload.retryAfterSeconds) && payload.retryAfterSeconds > 0) details.retryAfterSeconds = Math.ceil(payload.retryAfterSeconds)
  } catch { /* Keep the status-only fallback for gateway errors. */ }
  return details
}

export async function askAssistant(client: SupabaseClient | null, question: string, history: ChatMessage[], page: HelpRoute, online: boolean, canUseRemote: boolean): Promise<AssistantReply> {
  if (!online) {
    const answer = getLocalHelpAnswer(question, history)
    if (answer) return { answer }
    throw new HelpRequestError('offline')
  }
  if (!canUseRemote) {
    const answer = getLocalHelpAnswer(question, history)
    if (answer) return { answer }
    throw new HelpRequestError('unauthenticated')
  }
  if (!client) {
    const answer = getLocalHelpAnswer(question, history)
    if (answer) return { answer }
    throw new HelpRequestError('unavailable')
  }
  try {
    const { data, error } = await client.functions.invoke<AssistantReply>('ai-help', {
      body: { question, pageContext: page, history: history.filter((message) => message.status !== 'error').slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 2000) })) },
    })
    if (error) {
      const { status, code, retryAfterSeconds } = await failureDetails(error)
      if (status === 429) throw new HelpRequestError(code === 'provider_rate_limit' ? 'provider-rate-limit' : 'application-rate-limit', retryAfterSeconds)
      if (status === 401 || status === 403) throw new HelpRequestError('unauthenticated')
      if (status === 502 || code === 'invalid_model_response') throw new HelpRequestError('invalid-response')
      if (status === 503) {
        const kind = code === 'configuration_missing' ? 'configuration'
          : code === 'provider_cooldown' ? 'provider-cooldown'
            : code === 'provider_unavailable' ? 'provider-unavailable'
              : code === 'rate_limit_unavailable' ? 'rate-limit-service' : 'unavailable'
        throw new HelpRequestError(kind, retryAfterSeconds)
      }
      if (status === 500) throw new HelpRequestError('edge-error')
      throw new HelpRequestError('network')
    }
    if (typeof data?.answer !== 'string' || !data.answer.trim()) throw new HelpRequestError('unavailable')
    const followUps = Array.isArray(data.followUps) ? [...new Set(data.followUps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 140))].slice(0, 2) : []
    const links = Array.isArray(data.links) ? data.links.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const href = (item as { href?: unknown }).href
      if (typeof href !== 'string' || !allowedLinkLabels.has(href)) return []
      return [{ href, label: allowedLinkLabels.get(href)! }]
    }) : []
    return { answer: data.answer, links, followUps }
  } catch (error) {
    if (error instanceof HelpRequestError && ['application-rate-limit', 'provider-rate-limit', 'invalid-response'].includes(error.kind)) throw error
    const cached = getLocalHelpAnswer(question, history)
    if (cached) return { answer: cached }
    if (error instanceof HelpRequestError) throw error
    throw new HelpRequestError('network')
  }
}

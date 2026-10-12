import type { SupabaseClient } from '@supabase/supabase-js'
import { SUPPORT_EMAIL } from '../../config/supportContact'
import { capabilityVersion } from './capabilityVersion'

export type HelpRoute = 'today' | 'trackers' | 'analytics' | 'goals' | 'calendar' | 'history' | 'settings' | 'other'
export type FeedbackCategory = 'helpful' | 'factually_incorrect' | 'outdated' | 'wrong_instructions' | 'wrong_contact' | 'other'
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; status?: 'error'; retryAfterSeconds?: number; retryAfterUntil?: number; links?: Array<{ label: string; href: string }>; followUps?: string[]; topic?: string; knowledgeVersion?: string; feedbackStatus?: 'helpful' | 'reported'; offerSupport?: boolean; supportPrefill?: string }

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

export function collectRenderedCapabilityStates(root: ParentNode = document): Record<string, 'available' | 'disabled'> {
  const result: Record<string, 'available' | 'disabled'> = {}
  for (const element of root.querySelectorAll<HTMLElement>('[data-ai-capability]')) {
    const id = element.dataset.aiCapability
    const declared = element.dataset.aiAvailability
    if (!id || !/^[a-z0-9_.-]{1,100}$/.test(id) || Object.keys(result).length >= 32) continue
    if (declared === 'unknown' || declared === 'conditional') continue
    const disabled = declared === 'disabled' || (element instanceof HTMLButtonElement && element.disabled)
      || element.getAttribute('aria-disabled') === 'true'
    result[id] = result[id] === 'available' || !disabled ? 'available' : 'disabled'
  }
  return result
}

export type AssistantReply = { answer: string; links?: Array<{ label: string; href: string }>; followUps?: string[]; topic?: string; knowledge_version?: string; offerSupport?: boolean; supportPrefill?: string }
export type HelpFailure = 'offline' | 'unauthenticated' | 'unavailable' | 'configuration' | 'edge-error' | 'rate-limit-service' | 'provider-unavailable' | 'provider-cooldown' | 'application-rate-limit' | 'provider-rate-limit' | 'invalid-response' | 'network' | 'unsupported'
export class HelpRequestError extends Error {
  constructor(readonly kind: HelpFailure, readonly retryAfterSeconds?: number) { super(kind) }
}

export type ConversationIntent = 'greeting' | 'thanks' | 'goodbye' | 'support' | 'clarification' | 'unrelated' | 'product'
export function classifyConversationIntent(question: string): ConversationIntent {
  const clean = question.toLocaleLowerCase().normalize('NFKD').replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^(?:hi|hii+|helo+|hello+|hey+|good morning|good afternoon|good evening|howdy)(?: there)?(?:\s+(?:there|assistant))?$/.test(clean)) return 'greeting'
  if (/^(?:thanks?|thank you|thx|ty|ok(?:ay)?|much appreciated)(?: so much| a lot)?$/.test(clean)) return 'thanks'
  if (/^(?:bye|goodbye|see you|see ya|talk later|that is all|i am done|i'm done)$/.test(clean)) return 'goodbye'
  if (/\b(?:talk to support|contact support|raise (?:a )?(?:(?:support )?query)?|report (?:a )?bug|send (?:this issue|this|the issue) to (?:support|the developer)|human help|help from a human|need (?:a )?human|this (?:didn.?t|did not) help|still not working|still doesn.?t work)\b/.test(clean)) return 'support'
  if (/^(?:help me|help|what about that|why|why not|how|and then|what now)[?.! ]*$/.test(clean)) return 'clarification'
  if (/^(?:how do i cook|write me a poem|what is the weather|tell me a joke|solve this equation)\b/.test(clean)) return 'unrelated'
  return 'product'
}

export function conversationReply(intent: ConversationIntent, history: ChatMessage[] = []): string | null {
  if (intent === 'greeting') return 'Hey! 👋 How can I help?'
  if (intent === 'thanks') return "You're welcome!"
  if (intent === 'goodbye') return 'See you! Keep making progress.'
  if (intent === 'unrelated') return 'I’m best at helping with ProgressTracker. What would you like to know about the app?'
  if (intent === 'clarification' && !history.some((message) => message.role === 'user' && message.status !== 'error' && classifyConversationIntent(message.content) === 'product')) return 'What are you trying to do, and which page or step are you stuck on?'
  return null
}

export function supportDraftFromConversation(question: string, history: ChatMessage[]): string {
  const current = question.trim()
  const specificIssue = /\b(?:bug|issue|error|not working|doesn.t work|won.t|failed|stuck|problem|when i|trying to)\b/i.test(current)
  if ((classifyConversationIntent(current) !== 'support' || specificIssue) && current.length > 8) return current.slice(0, 1800)
  const previous = [...history].reverse().find((message) => message.role === 'user' && message.status !== 'error'
    && classifyConversationIntent(message.content) === 'product' && message.content.trim().length > 8)
  return (previous?.content.trim() || current).slice(0, 1800)
}

export async function submitAnswerFeedback(client: SupabaseClient | null, input: { responseId: string; category: FeedbackCategory; explanation?: string; topic: string; knowledgeVersion: string }): Promise<void> {
  if (!client) throw new Error('Feedback requires an internet connection and a signed-in account.')
  const { data: sessionData, error: sessionError } = await client.auth.getSession()
  const token = sessionData.session?.access_token
  if (sessionError || !token) throw new Error('Sign in again to send feedback.')
  const { error } = await client.functions.invoke('ai-help-feedback', {
    body: { response_id: input.responseId, category: input.category, explanation: input.explanation ?? null, topic: input.topic, knowledge_version: input.knowledgeVersion },
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!error) return
  let message = ''
  let status = 0
  if (error.context instanceof Response) {
    status = error.context.status
    try {
      const payload = await error.context.clone().json() as { error?: unknown }
      if (typeof payload.error === 'string') message = payload.error
    } catch { /* Use a stable fallback for empty gateway responses. */ }
  }
  if (status === 429) throw new Error(message || 'Too many feedback reports. Try again later.')
  if (status === 401) throw new Error('Sign in again to send feedback.')
  throw new Error(message || 'Feedback could not be saved right now. Try again shortly.')
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
  if (/\b(?:support|contact|reach (?:out|you|the team)|help desk)\b/.test(normalized) && /\b(?:email|address|contact|reach|support)\b/.test(normalized)
    || /\b(?:what(?:'s| is)|give me|find) (?:the )?(?:progresstracker |your )?(?:support )?(?:email|email address|contact address)\b/.test(normalized)) {
    return `For ProgressTracker support, email ${SUPPORT_EMAIL}.`
  }
  if (/\b(?:create (?:an )?account|creating an account|sign up|signup|register)\b/.test(normalized)) {
    return 'Choose Create account on the account screen and enter an email and a password of at least eight characters. You can also choose Email me a sign-in link; using an email for the first time creates an account, while an existing account’s email signs that account in.'
  }
  if (/\b(?:sign in|signin|log in|login|authentication|authenticate)\b/.test(normalized)) {
    return 'On the account screen, choose Email me a sign-in link for passwordless access or Use password to sign in with your email and password. Choose Create account only when registering a new account.'
  }
  if (/\b(?:passwordless|magic link|email link)\b/.test(normalized)) {
    return 'Choose Email me a sign-in link on the account screen. The first use of an email creates an account; an existing account’s email signs that account in. A password is optional for sign-in, but deletion requires a password that you can set under Settings → Sync & Data.'
  }
  if (/\b(?:forgot|reset|recovery)\b/.test(normalized) && /\bpassword\b/.test(normalized)) {
    return 'Choose Forgot password? on the account screen and enter the account email. Open the recovery link to choose a new password.'
  }
  if (/\b(?:set|change|update)\b/.test(normalized) && /\bpassword\b/.test(normalized)) {
    return 'While signed in, open Settings → Sync & Data → Set or change password. Save a password with at least eight characters. If you cannot sign in, choose Forgot password? on the account screen.'
  }
  if (/\b(?:account|profile)\b/.test(normalized) && /\b(?:delete|deletion|remove|permanently)\b/.test(normalized)) {
    return 'I can’t verify the current account-deletion steps while offline. Open Settings → Account Actions in the app to see the available controls, or reconnect and ask me again for verified guidance.'
  }
  const followUp = /^(?:and\b|what about\b|how about\b|are there\b|only\b|other\b|tell me more\b)/i.test(question.trim()) || /\b(?:it|that|those|other types|more about)\b/i.test(question) || question.trim().split(/\s+/).length <= 3
  const context = followUp ? history.slice(-4).map(({ content }) => content.toLocaleLowerCase()).join(' ') : ''
  const combined = `${normalized} ${context}`
  const hasMeasure = /\b(?:measure|measures|metric|metrics)\b/.test(combined)
  const checklist = /\b(?:checklist|check list)\b/.test(normalized) || (followUp && /\bchecklist\b/.test(context))
  if (checklist && /\b(?:problem|problems|issue|issues|stuck|error|trouble|having trouble|doesn.t work|cannot|can.t)\b/.test(normalized)) {
    return 'Checklist measures are supported only on existing trackers; new measures offer Yes/No or Quantity. If you are editing an existing tracker, keep its Checklist measure and tell me which step fails or what error you see. For a new tracker, use one Yes/No measure per item or a Quantity measure for the total.'
  }
  if (checklist && /\b(?:what should|take care|before i|keep in mind|consider)\b/.test(normalized)) {
    return 'Checklist cannot be selected for a new tracker. To model the same idea, create one Yes/No measure per item when you need each item tracked separately, or one Quantity measure when only the total matters. The total approach won’t preserve which individual items were checked. Existing Checklist measures can stay on their current tracker for history.'
  }
  if (checklist && /\b(?:how|steps|add|create|instruction|what should|take care|configure|set up)\b/.test(normalized)) {
    return 'You can’t add a Checklist measure to a new tracker. In the tracker form, add a Yes/No measure for each independently checked item, or a Quantity measure if you only need a total. Existing trackers can keep their legacy Checklist measures; their values are preserved for history.'
  }
  if (checklist && /\b(?:more|detail|details|explain|tell me)\b/.test(normalized)) {
    return 'Checklist is a legacy format used by some existing trackers. A check-in records which checklist items are checked, and threshold or goal calculations use the checked-item count. New trackers cannot select Checklist; use separate Yes/No measures for individual items or Quantity for a count. An existing Checklist measure remains available on its tracker.'
  }
  if (checklist && /\b(?:help me|help)\b/.test(normalized.trim())) {
    return 'I can help with Checklist measures. They can be used on existing trackers, but you can’t add one to a new tracker. Are you editing an existing tracker or creating a new one, and what happens when you try?'
  }
  if (checklist && /\b(?:add|create|new|available|can i|can we|supported)\b/.test(normalized)) {
    return 'Checklist isn’t available for new measures. Existing trackers may still use it. For a new tracker, choose Yes/No for each item or Quantity for a total.'
  }
  if (checklist) {
    return 'Checklist is a legacy measure type retained on existing trackers. Each check-in records checked items, and thresholds or goals use the number checked. New measures are Yes/No or Quantity, so Checklist cannot be selected when creating a measure.'
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
  const intent = classifyConversationIntent(question)
  const conversational = conversationReply(intent, history)
  if (conversational) return { answer: conversational }
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
      body: { question, pageContext: page, history: history.filter((message) => message.status !== 'error').slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 2000) })), capabilityVersion, runtimeAvailability: collectRenderedCapabilityStates() },
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
    return {
      answer: data.answer,
      links,
      followUps,
      topic: typeof data.topic === 'string' ? data.topic : undefined,
      knowledge_version: typeof data.knowledge_version === 'string' ? data.knowledge_version : undefined,
      offerSupport: data.offerSupport === true,
      supportPrefill: typeof data.supportPrefill === 'string' ? data.supportPrefill.slice(0, 1800) : undefined,
    }
  } catch (error) {
    if (error instanceof HelpRequestError && ['application-rate-limit', 'provider-rate-limit', 'rate-limit-service', 'invalid-response'].includes(error.kind)) throw error
    const cached = getLocalHelpAnswer(question, history)
    if (cached) return { answer: cached }
    if (error instanceof HelpRequestError) throw error
    throw new HelpRequestError('network')
  }
}

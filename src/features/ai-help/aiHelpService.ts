import type { SupabaseClient } from '@supabase/supabase-js'

export type HelpRoute = 'today' | 'trackers' | 'analytics' | 'goals' | 'calendar' | 'history' | 'settings' | 'other'
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; status?: 'error'; links?: Array<{ label: string; href: string }> }

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

export type AssistantReply = { answer: string; links?: Array<{ label: string; href: string }> }
export type HelpFailure = 'offline' | 'unauthenticated' | 'unavailable' | 'rate-limit' | 'network' | 'unsupported'
export class HelpRequestError extends Error {
  constructor(readonly kind: HelpFailure) { super(kind) }
}

const answers: Array<{ terms: string[]; answer: string }> = [
  { terms: ['streak', 'miss sunday', 'miss a day'], answer: 'A streak counts consecutive scheduled check-in days that meet the tracker’s success rule. Days outside the tracker schedule do not break the streak. A missed scheduled day does.' },
  { terms: ['cumulative', 'daily goal', 'goal target', 'total goal'], answer: 'A daily goal asks you to reach a target on each scheduled day. A cumulative goal adds progress over a date range toward one total, and needs a deadline. Milestones show progress along the way.' },
  { terms: ['success rule', 'qualify', 'minimum', 'threshold'], answer: 'A success rule decides whether a check-in qualifies. It can compare measure values with thresholds and combine conditions. The rule is evaluated against the values recorded for that check-in.' },
  { terms: ['change a saved measure', 'measure type', 'measure types', 'retire'], answer: 'A saved measure keeps its type so earlier entries retain their meaning. Measures with history can be retired: they leave future check-ins while remaining visible with their past values.' },
  { terms: ['offline', 'sync', 'synchronization'], answer: 'ProgressTracker saves check-ins locally so you can keep working offline. When you are signed in and online, pending changes synchronize with your account.' },
  { terms: ['completion rate', 'analytics', 'history'], answer: 'History preserves recorded check-ins and their measure context. Analytics summarizes progress across the selected period; retired measures remain part of historical views.' },
  { terms: ['measure', 'yes/no', 'quantity'], answer: 'A measure is one value you record for a tracker. Yes/No measures record a simple state; Quantity measures record a number and can use a unit and precision.' },
  { terms: ['schedule', 'scheduled'], answer: 'A tracker schedule defines which days count as expected check-in days. Streaks and completion summaries use that schedule when interpreting missed days.' },
]

export function getLocalHelpAnswer(question: string): string | null {
  const normalized = question.toLocaleLowerCase()
  return answers.find(({ terms }) => terms.some((term) => normalized.includes(term)))?.answer ?? null
}

export async function askAssistant(client: SupabaseClient | null, question: string, history: ChatMessage[], page: HelpRoute, online: boolean, canUseRemote: boolean): Promise<AssistantReply> {
  if (!online) {
    const answer = getLocalHelpAnswer(question)
    if (answer) return { answer }
    throw new HelpRequestError('offline')
  }
  if (!canUseRemote) {
    const answer = getLocalHelpAnswer(question)
    if (answer) return { answer }
    throw new HelpRequestError('unauthenticated')
  }
  if (!client) {
    const answer = getLocalHelpAnswer(question)
    if (answer) return { answer }
    throw new HelpRequestError('unavailable')
  }
  try {
    const { data, error } = await client.functions.invoke<AssistantReply>('ai-help', {
      body: { question, pageContext: page, history: history.filter((message) => message.status !== 'error').slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 2000) })) },
    })
    if (error) {
      const status = (error as { context?: Response }).context?.status
      if (status === 429) throw new HelpRequestError('rate-limit')
      if (status === 401 || status === 403) throw new HelpRequestError('unauthenticated')
      if (status === 503) throw new HelpRequestError('unavailable')
      throw new HelpRequestError('network')
    }
    if (typeof data?.answer !== 'string' || !data.answer.trim()) throw new HelpRequestError('unavailable')
    return data
  } catch (error) {
    const cached = getLocalHelpAnswer(question)
    if (cached) return { answer: cached }
    if (error instanceof HelpRequestError) throw error
    throw new HelpRequestError('network')
  }
}

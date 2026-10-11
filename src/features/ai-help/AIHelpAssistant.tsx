import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { IconButton } from '../../components/ui/IconButton'
import { getSupabaseClient } from '../../services/supabase/client'
import { useAuth } from '../auth/AuthProvider'
import { askAssistant, getHelpRoute, submitAnswerFeedback, type ChatMessage, type FeedbackCategory, type HelpFailure } from './aiHelpService'

const AIHelpPanel = lazy(() => import('./AIHelpPanel').then((module) => ({ default: module.AIHelpPanel })))
const storageKey = 'progress-tracker:ai-help:session'
const safeRoutes = new Map([['/', 'Today'], ['/trackers', 'Trackers'], ['/trackers/new', 'Create a tracker'], ['/goals', 'Goals'], ['/dashboard', 'Insights'], ['/calendar', 'Calendar'], ['/history', 'History'], ['/settings', 'Settings']])
function loadSession(): { messages: ChatMessage[]; draft: string } {
  if (typeof sessionStorage === 'undefined') return { messages: [], draft: '' }
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}') as { messages?: unknown[]; draft?: string }
    const messages = Array.isArray(parsed.messages) ? parsed.messages.slice(-30).flatMap((value, index): ChatMessage[] => {
      if (!value || typeof value !== 'object') return []
      const message = value as Record<string, unknown>
      if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') return []
      const links = Array.isArray(message.links) ? message.links.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const href = (entry as Record<string, unknown>).href
        if (typeof href !== 'string' || !safeRoutes.has(href)) return []
        return [{ href, label: safeRoutes.get(href)! }]
      }) : undefined
      const followUps = Array.isArray(message.followUps) ? message.followUps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 140).slice(0, 2) : undefined
      const topic = typeof message.topic === 'string' && ['core', 'trackers', 'goals', 'schedules', 'history', 'analytics', 'sync', 'privacy', 'account', 'notifications', 'settings', 'other'].includes(message.topic) ? message.topic : undefined
      const knowledgeVersion = typeof message.knowledgeVersion === 'string' && message.knowledgeVersion.length <= 100 ? message.knowledgeVersion : undefined
      return [{ id: typeof message.id === 'string' ? message.id : `restored-${index}`, role: message.role, content: message.content.slice(0, 6000), status: message.status === 'error' ? 'error' : undefined, retryAfterSeconds: typeof message.retryAfterSeconds === 'number' && Number.isFinite(message.retryAfterSeconds) ? message.retryAfterSeconds : undefined, retryAfterUntil: typeof message.retryAfterUntil === 'number' && Number.isFinite(message.retryAfterUntil) ? message.retryAfterUntil : undefined, links, followUps, topic, knowledgeVersion, feedbackStatus: message.feedbackStatus === 'helpful' || message.feedbackStatus === 'reported' ? message.feedbackStatus : undefined }]
    }) : []
    return { messages, draft: typeof parsed.draft === 'string' ? parsed.draft.slice(0, 1500) : '' }
  } catch { return { messages: [], draft: '' } }
}
function failureCopy(kind: HelpFailure) {
  if (kind === 'application-rate-limit') return 'You’ve reached the assistant’s request limit. The Retry button will unlock after the short wait.'
  if (kind === 'provider-rate-limit' || kind === 'provider-cooldown') return 'The assistant provider is busy. The Retry button will unlock after the provider’s wait.'
  if (kind === 'provider-unavailable') return 'The answer service is temporarily unavailable. Please retry in a little while.'
  if (kind === 'rate-limit-service') return 'AI Help could not check its request limit. Please retry shortly.'
  if (kind === 'configuration') return 'AI Help is not ready in this deployment yet. Please try again later.'
  if (kind === 'edge-error') return 'AI Help encountered a temporary service error. Please retry.'
  if (kind === 'invalid-response') return 'The assistant could not format a reliable answer. Your question is still here; please retry.'
  if (kind === 'offline') return 'AI help needs an internet connection. Try one of the available help topics when you are online.'
  if (kind === 'unauthenticated') return 'Sign in to ask the AI assistant. Common feature answers are available without an account.'
  if (kind === 'unavailable') return 'AI help is temporarily unavailable. Please try again later.'
  if (kind === 'unsupported') return 'I’m best at helping with ProgressTracker. Ask me about its features and how they work.'
  return 'Couldn’t connect right now. Please try again.'
}

export function AIHelpAssistant() {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState(loadSession)
  const [loading, setLoading] = useState(false)
  const [liveText, setLiveText] = useState('')
  const [nearBottom, setNearBottom] = useState(true)
  const [clock, setClock] = useState(Date.now())
  const requestSequence = useRef(0)
  const sendingRef = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const location = useLocation()
  const { isOnline, status } = useAuth()
  const route = useMemo(() => getHelpRoute(location.pathname), [location.pathname])
  const closePanel = useCallback(() => setOpen(false), [])

  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(session)) } catch { /* Session persistence is best effort. */ } }, [session])
  useEffect(() => {
    if (!session.messages.some((message) => message.retryAfterUntil && message.retryAfterUntil > clock)) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [clock, session.messages])
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus()
    wasOpen.current = open
  }, [open])

  const send = useCallback(async (question: string, appendUser = true) => {
    const content = question.trim()
    if (!content || loading || sendingRef.current) return
    sendingRef.current = true
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content }
    const prior = session.messages.slice(-6)
    setSession((current) => ({ ...current, draft: '', messages: appendUser ? [...current.messages, userMessage] : current.messages.filter((message) => message.status !== 'error') }))
    setLoading(true)
    setLiveText('Looking into that…')
    const sequence = ++requestSequence.current
    try {
      const context = appendUser ? prior : session.messages.filter((message) => message.status !== 'error').slice(-6)
      const result = await askAssistant(getSupabaseClient(), content, context, route, isOnline ?? navigator.onLine, status === 'signed-in')
      if (requestSequence.current !== sequence) return
      const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: result.answer, links: result.links, followUps: result.followUps, topic: result.topic, knowledgeVersion: result.knowledge_version }
      setSession((current) => ({ ...current, messages: [...current.messages, assistantMessage].slice(-30) }))
      setLiveText('New answer received.')
    } catch (error) {
      if (requestSequence.current !== sequence) return
      const kind = error instanceof Error && 'kind' in error ? error.kind as HelpFailure : 'network'
      const retryAfterSeconds = error instanceof Error && 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number' ? error.retryAfterSeconds : undefined
      const message: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', status: 'error', retryAfterSeconds, retryAfterUntil: retryAfterSeconds ? Date.now() + retryAfterSeconds * 1000 : undefined, content: failureCopy(kind) }
      setSession((current) => ({ ...current, draft: content, messages: [...current.messages.filter((item) => item.status !== 'error'), message].slice(-30) }))
      setLiveText(message.content)
    } finally { if (requestSequence.current === sequence) { sendingRef.current = false; setLoading(false) } }
  }, [isOnline, loading, route, session.messages, status])

  const retry = useCallback((messageId: string) => {
    const message = session.messages.find((item) => item.id === messageId)
    const previous = message && session.messages[session.messages.indexOf(message) - 1]
    if (!previous || previous.role !== 'user') return
    setSession((current) => ({ ...current, messages: current.messages.filter((item) => item.id !== messageId) }))
    void send(previous.content, false)
  }, [send, session.messages])

  const sendFeedback = useCallback(async (messageId: string, category: FeedbackCategory, explanation?: string) => {
    const message = session.messages.find((item) => item.id === messageId)
    if (!message?.topic || !message.knowledgeVersion) throw new Error('This response does not include current product version details for feedback.')
    await submitAnswerFeedback(getSupabaseClient(), { responseId: messageId, category, explanation, topic: message.topic, knowledgeVersion: message.knowledgeVersion })
    setSession((current) => ({ ...current, messages: current.messages.map((item) => item.id === messageId ? { ...item, feedbackStatus: category === 'helpful' ? 'helpful' : 'reported' } : item) }))
  }, [session.messages])

  const newConversation = () => {
    requestSequence.current += 1
    sendingRef.current = false
    setLoading(false)
    setSession({ messages: [], draft: '' })
    setLiveText('New conversation started.')
  }

  return <>
    <IconButton ref={triggerRef} className="ai-help-trigger" label="Open AI Help Assistant" title="Open AI Help Assistant" onClick={() => setOpen(true)}>
      <AppIcon name="spark" />
    </IconButton>
    {open && <Suspense fallback={null}><AIHelpPanel
      messages={session.messages} draft={session.draft} loading={loading} route={route} liveText={liveText} nearBottom={nearBottom} now={clock}
      onClose={closePanel} onSend={(question) => { setNearBottom(true); void send(question) }} onDraftChange={(draft) => setSession((current) => ({ ...current, draft }))}
      onRetry={retry} onNewConversation={() => { setNearBottom(true); newConversation() }} onScrollPositionChange={setNearBottom} triggerRef={triggerRef}
      onFeedback={sendFeedback}
    /></Suspense>}
  </>
}

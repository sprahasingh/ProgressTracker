import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { IconButton } from '../../components/ui/IconButton'
import { getSupabaseClient } from '../../services/supabase/client'
import { useAuth } from '../auth/AuthProvider'
import { askAssistant, getHelpRoute, type ChatMessage, type HelpFailure } from './aiHelpService'

const AIHelpPanel = lazy(() => import('./AIHelpPanel').then((module) => ({ default: module.AIHelpPanel })))
const storageKey = 'progress-tracker:ai-help:session'
const safeRoutes = new Map([['/', 'Today'], ['/trackers', 'Trackers'], ['/goals', 'Goals'], ['/dashboard', 'Insights'], ['/calendar', 'Calendar'], ['/history', 'History'], ['/settings', 'Settings']])
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
      return [{ id: typeof message.id === 'string' ? message.id : `restored-${index}`, role: message.role, content: message.content.slice(0, 6000), status: message.status === 'error' ? 'error' : undefined, links }]
    }) : []
    return { messages, draft: typeof parsed.draft === 'string' ? parsed.draft.slice(0, 1500) : '' }
  } catch { return { messages: [], draft: '' } }
}
function failureCopy(kind: HelpFailure) {
  if (kind === 'rate-limit') return 'The assistant is temporarily busy. Please try again shortly.'
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
      const assistantMessage: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: result.answer, links: result.links }
      setSession((current) => ({ ...current, messages: [...current.messages, assistantMessage].slice(-30) }))
      setLiveText('New answer received.')
    } catch (error) {
      if (requestSequence.current !== sequence) return
      const kind = error instanceof Error && 'kind' in error ? error.kind as HelpFailure : 'network'
      const message: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', status: 'error', content: failureCopy(kind) }
      setSession((current) => ({ ...current, draft: content, messages: [...current.messages, message].slice(-30) }))
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
      messages={session.messages} draft={session.draft} loading={loading} route={route} liveText={liveText} nearBottom={nearBottom}
      onClose={closePanel} onSend={(question) => { setNearBottom(true); void send(question) }} onDraftChange={(draft) => setSession((current) => ({ ...current, draft }))}
      onRetry={retry} onNewConversation={() => { setNearBottom(true); newConversation() }} onScrollPositionChange={setNearBottom} triggerRef={triggerRef}
    /></Suspense>}
  </>
}

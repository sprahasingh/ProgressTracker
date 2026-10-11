import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { getSupabaseClient } from '../../services/supabase/client'
import { checkMaintainerAccess, ReviewApiError } from './aiKnowledgeApi'

export type MaintainerAccessStatus = 'checking' | 'authorized' | 'denied' | 'expired' | 'error' | 'signed-out'
export type MaintainerAccess = { status: MaintainerAccessStatus; message?: string; refresh: () => void }

export function useMaintainerAccess(): MaintainerAccess {
  const { status: authStatus, user } = useAuth()
  const [status, setStatus] = useState<MaintainerAccessStatus>('checking')
  const [message, setMessage] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const refresh = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    const expireAccess = () => {
      setStatus('expired')
      setMessage('Your session has expired. Sign in again.')
    }
    window.addEventListener('progress-tracker:ai-knowledge-session-expired', expireAccess)
    const revokeAccess = () => { setStatus('denied'); setMessage(undefined) }
    window.addEventListener('progress-tracker:ai-knowledge-access-revoked', revokeAccess)
    return () => {
      window.removeEventListener('progress-tracker:ai-knowledge-session-expired', expireAccess)
      window.removeEventListener('progress-tracker:ai-knowledge-access-revoked', revokeAccess)
    }
  }, [])

  useEffect(() => {
    if (authStatus === 'loading') { setStatus('checking'); return }
    if (authStatus !== 'signed-in' || !user?.id) { setStatus('signed-out'); setMessage(undefined); return }
    let active = true
    setStatus('checking')
    setMessage(undefined)
    void checkMaintainerAccess(getSupabaseClient() ?? undefined).then((authorized) => {
      if (active) setStatus(authorized ? 'authorized' : 'denied')
    }).catch((error: unknown) => {
      if (!active) return
      if (error instanceof ReviewApiError && error.status === 403) setStatus('denied')
      else if (error instanceof ReviewApiError && error.status === 401) { setStatus('expired'); setMessage(error.message) }
      else { setStatus('error'); setMessage(error instanceof Error ? error.message : 'Maintainer access could not be checked.') }
    })
    return () => { active = false }
  }, [authStatus, user?.id, user?.email, attempt])

  return { status, message, refresh }
}

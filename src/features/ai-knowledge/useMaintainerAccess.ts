import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { getSupabaseClient } from '../../services/supabase/client'
import { checkMaintainerAccess, ReviewApiError } from './aiKnowledgeApi'

export type MaintainerAccessStatus = 'checking' | 'authorized' | 'denied' | 'expired' | 'error' | 'signed-out'
export type MaintainerAccess = { status: MaintainerAccessStatus; message?: string; refresh: () => void }

type UserAccessState = { status: MaintainerAccessStatus; userId: string | null; message?: string }

export function useMaintainerAccess(): MaintainerAccess {
  const { status: authStatus, user } = useAuth()
  const [access, setAccess] = useState<UserAccessState>({ status: 'checking', userId: null })
  const [attempt, setAttempt] = useState(0)
  const activeUserIdRef = useRef<string | null>(null)
  const userId = authStatus === 'signed-in' ? user?.id ?? null : null
  activeUserIdRef.current = userId
  const refresh = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    const expireAccess = () => {
      setAccess({ status: 'expired', userId: activeUserIdRef.current, message: 'Your session has expired. Sign in again.' })
    }
    window.addEventListener('progress-tracker:ai-knowledge-session-expired', expireAccess)
    const revokeAccess = () => { setAccess({ status: 'denied', userId: activeUserIdRef.current }) }
    window.addEventListener('progress-tracker:ai-knowledge-access-revoked', revokeAccess)
    return () => {
      window.removeEventListener('progress-tracker:ai-knowledge-session-expired', expireAccess)
      window.removeEventListener('progress-tracker:ai-knowledge-access-revoked', revokeAccess)
    }
  }, [])

  useEffect(() => {
    if (authStatus === 'loading') return
    if (authStatus !== 'signed-in' || !user?.id) {
      setAccess({ status: 'signed-out', userId: null })
      return
    }
    let active = true
    setAccess((current) => current.userId === user.id && current.status === 'authorized'
      ? current
      : { status: 'checking', userId: user.id })
    void checkMaintainerAccess(getSupabaseClient() ?? undefined).then((authorized) => {
      if (active) setAccess({ status: authorized ? 'authorized' : 'denied', userId: user.id })
    }).catch((error: unknown) => {
      if (!active) return
      if (error instanceof ReviewApiError && error.status === 403) setAccess({ status: 'denied', userId: user.id })
      else if (error instanceof ReviewApiError && error.status === 401) setAccess({ status: 'expired', userId: user.id, message: error.message })
      else setAccess((current) => current.userId === user.id && current.status === 'authorized'
        ? current
        : { status: 'error', userId: user.id, message: error instanceof Error ? error.message : 'Maintainer access could not be checked.' })
    })
    return () => { active = false }
  }, [authStatus, user?.id, attempt])

  const status: MaintainerAccessStatus = authStatus === 'loading'
    ? 'checking'
    : authStatus !== 'signed-in' || !userId
      ? 'signed-out'
      : access.userId === userId ? access.status : 'checking'

  return { status, message: access.userId === userId ? access.message : undefined, refresh }
}

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMaintainerAccess } from './useMaintainerAccess'

const authState = vi.hoisted(() => ({
  value: { status: 'signed-in', user: { id: 'maintainer-a', email: 'first@example.com' } },
}))
const accessCheck = vi.hoisted(() => ({ check: vi.fn<() => Promise<boolean>>() }))

vi.mock('../auth/AuthProvider', () => ({ useAuth: () => authState.value }))
vi.mock('../../services/supabase/client', () => ({ getSupabaseClient: () => undefined }))
vi.mock('./aiKnowledgeApi', () => ({
  checkMaintainerAccess: accessCheck.check,
  ReviewApiError: class ReviewApiError extends Error { status = 403 },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe('useMaintainerAccess', () => {
  beforeEach(() => {
    authState.value = { status: 'signed-in', user: { id: 'maintainer-a', email: 'first@example.com' } }
    accessCheck.check.mockReset()
  })

  it('keeps same-user authorization while profile details change or permission is revalidated', async () => {
    const initialCheck = deferred<boolean>()
    const retryCheck = deferred<boolean>()
    accessCheck.check.mockReturnValueOnce(initialCheck.promise).mockRejectedValueOnce(new Error('temporary network failure')).mockReturnValueOnce(retryCheck.promise)
    const { result, rerender } = renderHook(() => useMaintainerAccess())
    expect(result.current.status).toBe('checking')

    await act(async () => { initialCheck.resolve(true) })
    await waitFor(() => expect(result.current.status).toBe('authorized'))

    authState.value = { status: 'signed-in', user: { id: 'maintainer-a', email: 'updated@example.com' } }
    rerender()
    expect(result.current.status).toBe('authorized')
    expect(accessCheck.check).toHaveBeenCalledTimes(1)

    act(() => result.current.refresh())
    expect(result.current.status).toBe('authorized')
    await waitFor(() => expect(accessCheck.check).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.status).toBe('authorized'))

    act(() => result.current.refresh())
    await waitFor(() => expect(accessCheck.check).toHaveBeenCalledTimes(3))
    expect(result.current.status).toBe('authorized')
    await act(async () => { retryCheck.resolve(false) })
    await waitFor(() => expect(result.current.status).toBe('denied'))
  })

  it('does not authorize an unknown user before the server permission check resolves', async () => {
    const check = deferred<boolean>()
    accessCheck.check.mockReturnValue(check.promise)
    const { result } = renderHook(() => useMaintainerAccess())
    expect(result.current.status).toBe('checking')
    await act(async () => { check.resolve(false) })
    await waitFor(() => expect(result.current.status).toBe('denied'))
  })

  it('drops a previous user authorization immediately when the active user changes', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    accessCheck.check.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(() => useMaintainerAccess())
    await act(async () => { first.resolve(true) })
    await waitFor(() => expect(result.current.status).toBe('authorized'))

    authState.value = { status: 'signed-in', user: { id: 'maintainer-b', email: 'second@example.com' } }
    rerender()
    expect(result.current.status).toBe('checking')
    await act(async () => { second.resolve(false) })
    await waitFor(() => expect(result.current.status).toBe('denied'))
  })
})

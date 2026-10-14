import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { publishWorkspaceDataChange, publishWorkspaceSyncCompleted } from './workspaceMutationEvents'
import { useWorkspaceDataChanges } from './useWorkspaceDataChanges'

describe('useWorkspaceDataChanges', () => {
  it('does not reload local-only views after an upload that changed no workspace records', () => {
    const refresh = vi.fn()
    renderHook(() => useWorkspaceDataChanges('account-a', true, refresh))

    act(() => publishWorkspaceSyncCompleted('account-a'))
    expect(refresh).not.toHaveBeenCalled()

    act(() => publishWorkspaceDataChange('account-a'))
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('lets progression views refresh on server confirmation while remaining account-scoped', () => {
    const refresh = vi.fn()
    renderHook(() => useWorkspaceDataChanges('account-a', true, refresh, true))

    act(() => publishWorkspaceSyncCompleted('account-b'))
    expect(refresh).not.toHaveBeenCalled()

    act(() => publishWorkspaceSyncCompleted('account-a'))
    expect(refresh).toHaveBeenCalledOnce()
  })
})

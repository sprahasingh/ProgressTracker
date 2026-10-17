import { describe, expect, it } from 'vitest'
import { matchRoutes } from 'react-router-dom'
import { router } from './router'

describe('application route loading', () => {
  const children = router.routes[0]?.children ?? []

  it('keeps Today eager and loads substantial pages through React Router lazy routes', () => {
    expect(children.find((route) => route.index)?.lazy).toBeUndefined()
    for (const path of [
      'dashboard', 'analytics', 'achievements', 'trackers', 'trackers/new', 'trackers/:trackerId/edit',
      'goals', 'calendar', 'history', 'holidays', 'bin', 'settings', 'auth', 'ai-knowledge',
    ]) {
      expect(children.find((route) => route.path === path)?.lazy, `${path} should be loaded on demand`).toBeTypeOf('function')
    }
  })

  it('retains a root-level route error boundary for failed lazy imports', () => {
    expect(router.routes[0]?.errorElement).toBeTruthy()
  })

  it('matches the GitHub Pages recovery inspection deep link to Settings', () => {
    const matches = matchRoutes(router.routes, '/settings?recoveryPreview=1#sync-data')
    expect(matches?.at(-1)?.route.path).toBe('settings')
  })
})

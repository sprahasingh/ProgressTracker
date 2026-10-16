import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { RouteErrorFallback, RouteNotFound } from './RouteFallback'

afterEach(cleanup)

describe('application route fallback', () => {
  it('shows a helpful not-found message and a working Today link', () => {
    render(<MemoryRouter initialEntries={['/missing-page']}><Routes><Route path="*" element={<RouteNotFound />} /></Routes></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'We couldn’t find that page' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Today' })).toHaveAttribute('href', '/')
  })

  it('renders a calm application error instead of exposing a route exception', async () => {
    const router = createMemoryRouter([{ path: '/', loader: () => { throw new Error('private internal diagnostic') }, element: <div />, errorElement: <RouteErrorFallback /> }])
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: 'This page couldn’t load' })).toBeInTheDocument()
    expect(screen.queryByText('private internal diagnostic')).not.toBeInTheDocument()
  })

  it('shows the accessible recovery route when a lazy route chunk fails', async () => {
    const router = createMemoryRouter([{
      path: '/insights',
      lazy: async () => { throw new TypeError('failed to fetch dynamically imported module') },
      errorElement: <RouteErrorFallback />,
    }], { initialEntries: ['/insights'] })
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: 'This page couldn’t load' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Today' })).toHaveAttribute('href', '/')
    expect(screen.queryByText(/dynamically imported module/)).not.toBeInTheDocument()
  })
})

import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { NavLink } from 'react-router-dom'

type Item = { to: string; label: string }

export function SectionTabs({ label, items }: { label: string; items: readonly Item[] }) {
  const navRef = useRef<HTMLElement>(null)
  const location = useLocation()
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('.section-tab[aria-current="page"]')
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [location.pathname])
  const scrollable = items.length >= 4
  return <nav ref={navRef} className={`section-tabs${scrollable ? ' section-tabs-scrollable' : ''}`} aria-label={label}>
    {items.map(({ to, label: itemLabel }) => <NavLink key={to} to={to} end className={({ isActive }) => `section-tab${isActive ? ' active' : ''}`} onFocus={(event) => event.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}>{itemLabel}</NavLink>)}
  </nav>
}

export const trackerSectionTabs = [
  { to: '/trackers', label: 'All trackers' },
  { to: '/goals', label: 'Goals & planning' },
] as const

export const insightsSectionTabs = [
  { to: '/dashboard', label: 'Overview' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/achievements', label: 'Wins' },
  { to: '/history', label: 'History' },
] as const

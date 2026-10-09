import { NavLink } from 'react-router-dom'

type Item = { to: string; label: string }

export function SectionTabs({ label, items }: { label: string; items: readonly Item[] }) {
  return <nav className="section-tabs" aria-label={label}>
    {items.map(({ to, label: itemLabel }) => <NavLink key={to} to={to} end className={({ isActive }) => `section-tab${isActive ? ' active' : ''}`}>{itemLabel}</NavLink>)}
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

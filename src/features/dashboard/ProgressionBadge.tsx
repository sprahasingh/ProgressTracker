import { useId } from 'react'
import { AppIcon, type AppIconName } from '../../components/ui/AppIcon'
import { achievementDefinition, badgeTierLabel } from './achievementCatalog'

const badgeIcons: Record<string, AppIconName> = {
  'first-step': 'check', momentum: 'habit', 'first-flame': 'spark', 'steady-flame': 'spark', unstoppable: 'trackers', century: 'calendar',
  'perfect-day': 'today', 'perfect-week': 'calendar', 'milestone-maker': 'goal', 'goal-crusher': 'goal', 'consistency-star': 'insights', dedicated: 'check',
  'perfect-month': 'calendar', 'perfect-year': 'calendar', 'the-comeback': 'reset',
}

export function ProgressionBadge({ achievementId, tier = 1, locked = false, size = 'normal' }: {
  achievementId: string
  tier?: number
  locked?: boolean
  size?: 'normal' | 'large'
}) {
  const gradientId = useId().replaceAll(':', '')
  const tierName = badgeTierLabel(tier).toLowerCase()
  const threshold = achievementDefinition(achievementId)?.badgeThreshold
  const [thresholdValue, thresholdUnit] = threshold?.split(' ') ?? []
  const name = achievementDefinition(achievementId)?.name ?? achievementId.replaceAll('-', ' ')
  return <svg className={`progression-badge progression-badge-${tierName}${locked ? ' is-locked' : ''}${size === 'large' ? ' is-large' : ''}${threshold ? ' has-threshold' : ''}`} viewBox="0 0 120 120" role="img" aria-label={`${locked ? 'Locked' : tierName} ${name} badge${threshold ? `, ${threshold.toLowerCase()} threshold` : ''}`}>
    <defs>
      <linearGradient id={`${gradientId}-metal`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" className="badge-metal-light"/><stop offset=".48" className="badge-metal-mid"/><stop offset="1" className="badge-metal-dark"/></linearGradient>
      <radialGradient id={`${gradientId}-core`} cx="38%" cy="28%" r="78%"><stop offset="0" className="badge-core-light"/><stop offset="1" className="badge-core-dark"/></radialGradient>
    </defs>
    <path className="badge-ribbon" d="m39 77-8 37 28-13 28 13-8-37" />
    <path className="badge-outline" d="M60 5 73 12 88 12 96 25 109 33 107 49 114 62 105 75 103 91 88 97 78 110 62 106 47 112 36 100 21 96 18 80 7 69 13 54 8 39 20 28 23 13 39 11Z" />
    <path className="badge-medal" fill={`url(#${gradientId}-metal)`} d="M60 12 72 18 85 18 91 30 103 37 101 51 107 63 99 75 97 88 84 93 76 104 62 101 49 106 40 96 27 92 25 78 15 68 20 55 16 42 27 33 29 20 43 18Z" />
    {tierName === 'platinum' && <path className="badge-platinum-ornament" d="m60 8 4 9 9 3-7 6 1 9-7-5-8 5 2-9-7-6 9-3Zm0 69 4 8 9 3-7 6 1 9-7-5-8 5 2-9-7-6 9-3Zm44-18 5 6 8 1-6 5 2 8-8-4-7 4 1-8-6-5 9-1Zm-88 0 5 6 8 1-6 5 2 8-8-4-7 4 1-8-6-5 9-1Z" />}
    {tierName === 'gold' && <g className="badge-gold-ornament"><path d="M61 21v5M61 92v5M23 59h5M94 59h5M34 32l4 4m46 46 4 4M88 32l-4 4m-46 46-4 4" /><circle cx="61" cy="59" r="37" /></g>}
    {tierName === 'silver' && <g className="badge-silver-ornament"><circle cx="61" cy="20" r="2.3"/><circle cx="99" cy="59" r="2.3"/><circle cx="61" cy="98" r="2.3"/><circle cx="22" cy="59" r="2.3"/></g>}
    <circle className="badge-inner-ring" cx="61" cy="59" r="32" />
    <circle className="badge-core" cx="61" cy="59" r="27" fill={`url(#${gradientId}-core)`} />
    <path className="badge-highlight" d="M40 39c7-8 18-12 30-10" />
    <AppIcon name={badgeIcons[achievementId] ?? 'spark'} className="badge-glyph" x={threshold ? '49' : '45'} y={threshold ? '36' : '43'} width={threshold ? '22' : '32'} height={threshold ? '22' : '32'} />
    {threshold && thresholdValue && <g className="badge-threshold" aria-hidden="true"><text className="badge-threshold-value" x="61" y="69">{thresholdValue}</text><text className="badge-threshold-unit" x="61" y="79">{thresholdUnit}</text></g>}
    {locked && <g className="badge-lock-mark" aria-hidden="true"><circle cx="61" cy="84" r="13"/><rect x="55" y="82" width="12" height="10" rx="2"/><path d="M57.5 82v-2.5a3.5 3.5 0 0 1 7 0V82"/></g>}
  </svg>
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { achievementDefinition } from './achievementCatalog'
import { ProgressionBadge } from './ProgressionBadge'
import { getAchievementAwardXp, getEarnedAndLockedBadges, getProgressionOverview, subscribeToProgressionChanges, type AchievementHistoryEvent } from '../../services/supabase/progressionRepository'
import { InfoButton } from '../../components/ui/InfoButton'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'
import { calculateProgressionLevel } from '../../domain/trackers/progressionModel'
import { measureDevPerformance } from '../../utils/devPerformance'

type Celebration = AchievementHistoryEvent & { repeatable: boolean }
type LevelCelebration = { kind: 'level'; id: string; fromLevel: number; toLevel: number; confirmedXp: number }
type QueuedCelebration = { kind: 'badge'; event: Celebration } | LevelCelebration
const storageKey = (userId: string) => `progress-tracker:achievement-seen:${userId}`
const pendingStorageKey = (userId: string) => `progress-tracker:achievement-pending:${userId}`
const levelStateKey = (userId: string) => `progress-tracker:level-state:${userId}`
const levelPendingKey = (userId: string) => `progress-tracker:level-pending:${userId}`
const levelForXp = (xp: number) => calculateProgressionLevel(xp).level

export function badgeCelebrationLevel(repeatable: boolean, occurrence: number): 'first' | 'repeat' | 'milestone' {
  if (occurrence === 1 || !repeatable) return 'first'
  return occurrence === 5 || occurrence === 10 || occurrence === 25 || occurrence === 50 || (occurrence > 0 && occurrence % 100 === 0) ? 'milestone' : 'repeat'
}

/** Watches persisted server unlock events, baselines historical events on first account load, and serializes new celebrations. */
export function BadgeCelebrationMonitor({ userId }: { userId: string }) {
  const { timeZone } = useWorkspaceTimeZone()
  const [queue, setQueue] = useState<QueuedCelebration[]>([])
  const seeded = useRef(false)
  const initialReadStartedAt = useRef(0)
  const refreshSequence = useRef(0)
  const refresh = useCallback(async () => {
    const measure = measureDevPerformance('wins.celebration-eligibility-refresh')
    const requestId = ++refreshSequence.current
    try {
      let badges: Awaited<ReturnType<typeof getEarnedAndLockedBadges>> | undefined
      let overview: Awaited<ReturnType<typeof getProgressionOverview>> | undefined
      let readError: unknown
      try {
        // The overview already contains server-confirmed badge history. Share this
        // read instead of repeating the qualification refresh and history queries.
        overview = await getProgressionOverview(userId, { forceRefresh: true })
        if (Array.isArray(overview.achievements)) badges = overview.achievements
        else throw new Error('Progression overview did not include achievement history.')
      } catch (error) {
        readError = error
        // Preserve badge celebrations if unrelated XP or score-history reads fail.
        // The fallback performs the same full-history qualification refresh.
        // Retry it at most once; repeated retries can queue expensive reconciles
        // while the next progression notification will request a fresh read.
        try { badges = await getEarnedAndLockedBadges(userId) }
        catch (badgeError) { readError = badgeError }
      }
      if (!badges) throw readError
      if (requestId !== refreshSequence.current) return
      let levelItems: LevelCelebration[] = []
      if (overview) {
        const levelKey = levelStateKey(userId)
        const pendingLevelsKey = levelPendingKey(userId)
        const previous = (() => {
          try { return JSON.parse(localStorage.getItem(levelKey) ?? 'null') as { xp: number; watermark: string } | null } catch { return null }
        })()
        const watermark = overview.scoreHistory.map((event) => `${event.recordedAt}|${event.id}`).sort().at(-1) ?? ''
        if (!previous) {
          // The first read may reconstruct years of XP. Establish a baseline without celebrating it.
          localStorage.setItem(levelKey, JSON.stringify({ xp: overview.confirmedXp, watermark }))
        } else if (watermark > previous.watermark || watermark === previous.watermark && overview.confirmedXp === previous.xp) {
          const oldLevel = levelForXp(previous.xp)
          const newLevel = levelForXp(overview.confirmedXp)
          if (overview.confirmedXp > previous.xp && newLevel > oldLevel) {
            const id = `level:${watermark}`
            levelItems.push({ kind: 'level', id, fromLevel: oldLevel, toLevel: newLevel, confirmedXp: overview.confirmedXp })
          }
          // A lower server-confirmed total is accepted only with a current ledger watermark;
          // reversals therefore lower the displayed level without creating a celebration.
          if (watermark > previous.watermark) localStorage.setItem(levelKey, JSON.stringify({ xp: overview.confirmedXp, watermark }))
        }
        try { levelItems = [...(JSON.parse(localStorage.getItem(pendingLevelsKey) ?? '[]') as LevelCelebration[]), ...levelItems] } catch { /* Ignore malformed local queue data. */ }
        levelItems = [...new Map(levelItems.map((item) => [item.id, item])).values()]
        localStorage.setItem(pendingLevelsKey, JSON.stringify(levelItems))
      }
      const events = badges.flatMap((badge) => badge.history.map((event) => ({ ...event, repeatable: badge.repeatable }))).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))
      const key = storageKey(userId)
      const pendingKey = pendingStorageKey(userId)
      let seen: string[] = []
      try { seen = JSON.parse(localStorage.getItem(key) ?? '[]') as string[] } catch { seen = [] }
      const known = new Set(seen)
      let pending: string[] = []
      try { pending = JSON.parse(localStorage.getItem(pendingKey) ?? '[]') as string[] } catch { pending = [] }
      const pendingIds = new Set(pending)
      if (!seeded.current) {
        // Sign-in and the first authenticated sync can overlap this read. Only
        // baseline events that predate the read; events committed during it
        // are new awards and must enter the queue.
        const readStartedAt = initialReadStartedAt.current
        events.filter((event) => Date.parse(event.recordedAt) < readStartedAt && !pendingIds.has(event.id)).forEach((event) => known.add(event.id))
        seeded.current = true
      }
      const fresh = events.filter((event) => !known.has(event.id) && event.eventType === 'unlocked' && (pendingIds.has(event.id) || Date.parse(event.recordedAt) >= initialReadStartedAt.current))
      events.filter((event) => event.eventType === 'revoked').forEach((event) => known.add(event.id))
      localStorage.setItem(key, JSON.stringify([...known].slice(-3000)))
      const activeIds = new Set(events.filter((event) => event.eventType === 'revoked').map((event) => event.reversesEventId).filter((id): id is string => Boolean(id)))
      const positive = fresh.filter((event) => event.eventType === 'unlocked' && !activeIds.has(event.id))
      const stillPending = new Set([...pendingIds, ...positive.map((event) => event.id)])
      for (const id of activeIds) stillPending.delete(id)
      localStorage.setItem(pendingKey, JSON.stringify([...stillPending].slice(-3000)))
      setQueue((current) => {
        const surviving = current.filter((item) => item.kind === 'level' || !activeIds.has(item.event.id))
        const queued = new Set(surviving.map((item) => item.kind === 'level' ? item.id : item.event.id))
        const levels = levelItems.filter((item) => !queued.has(item.id))
        const badgesToQueue = positive.filter((event) => !queued.has(event.id)).map((event): QueuedCelebration => ({ kind: 'badge', event }))
        return [...surviving, ...levels, ...badgesToQueue]
      })
      // Confirmed awards should be presented as soon as their history is read.
      // XP attribution is supplementary and may wait on a slower Auth/API call;
      // it must never hold the celebration queue or make an award appear lost.
      const sourceEventIds = [...new Set(positive.map((event) => event.sourceEventId).filter((id): id is string => Boolean(id)))]
      if (sourceEventIds.length) {
        void getAchievementAwardXp(userId, sourceEventIds).then((xpBySource) => {
          setQueue((current) => current.map((item) => item.kind === 'badge' && item.event.sourceEventId && xpBySource.has(item.event.sourceEventId)
            ? { ...item, event: { ...item.event, rewardXpDelta: xpBySource.get(item.event.sourceEventId)! } }
            : item))
        }).catch(() => { /* XP is optional; show confirmed badge events without it. */ })
      }
    } catch { /* Network or sync failures are retried on the next server confirmation. */ }
    finally { measure() }
  }, [userId])

  useEffect(() => {
    seeded.current = false
    initialReadStartedAt.current = Date.now()
    void refresh()
    return subscribeToProgressionChanges(userId, () => { void refresh() })
  }, [refresh, userId])

  const current = queue[0]
  const acknowledge = useCallback((item: QueuedCelebration) => {
    if (item.kind === 'level') {
      let pending: LevelCelebration[] = []
      try { pending = JSON.parse(localStorage.getItem(levelPendingKey(userId)) ?? '[]') as LevelCelebration[] } catch { pending = [] }
      localStorage.setItem(levelPendingKey(userId), JSON.stringify(pending.filter((entry) => entry.id !== item.id)))
      return
    }
    const event = item.event
    const key = storageKey(userId)
    let seen: string[] = []
    try { seen = JSON.parse(localStorage.getItem(key) ?? '[]') as string[] } catch { seen = [] }
    if (!seen.includes(event.id)) localStorage.setItem(key, JSON.stringify([...seen, event.id].slice(-3000)))
    let pending: string[] = []
    try { pending = JSON.parse(localStorage.getItem(pendingStorageKey(userId)) ?? '[]') as string[] } catch { pending = [] }
    localStorage.setItem(pendingStorageKey(userId), JSON.stringify(pending.filter((id) => id !== event.id)))
  }, [userId])
  const close = useCallback(() => {
    if (current) {
      acknowledge(current)
    }
    setQueue((items) => items.slice(1))
  }, [acknowledge, current])
  const finish = useCallback(() => {
    queue.forEach(acknowledge)
    setQueue([])
  }, [acknowledge, queue])
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const currentId = current ? current.kind === 'level' ? current.id : current.event.id : null
  useModalLayer(Boolean(current), dialogRef, close, { manageHistoryEntry: false })
  useVisualViewportBounds(Boolean(current), backdropRef)
  useEffect(() => { if (current) closeRef.current?.focus() }, [currentId])
  if (!current) return null
  if (current.kind === 'level') return createPortal(<div ref={backdropRef} className="modal-backdrop progression-dialog-backdrop badge-celebration-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className="progression-dialog level-up-celebration" role="dialog" aria-modal="true" aria-labelledby="level-up-title" tabIndex={-1}>
      <header className="progression-dialog-header"><div><span className="eyebrow">LEVEL UP</span><h2 id="level-up-title">Level {current.toLevel}</h2></div><button ref={closeRef} type="button" className="info-dialog-close" aria-label="Close celebration" onClick={close}><AppIcon name="close" /></button></header>
      <div className="progression-dialog-content level-up-content"><span className="level-up-mark" aria-hidden="true"><AppIcon name="spark" /></span><p>You advanced from level {current.fromLevel} to level {current.toLevel}.</p><strong>{current.confirmedXp.toLocaleString()} confirmed XP</strong><div className="badge-celebration-actions"><button className="button button-primary button-medium" onClick={close}>{queue.length > 1 ? 'Continue' : 'Done'}</button>{queue.length > 1 && <button className="button button-quiet button-medium" onClick={finish}>Dismiss remaining</button>}</div></div>
    </section>
  </div>, document.body)
  const event = current.event
  const definition = achievementDefinition(event.achievementId)
  if (!definition) return null
  const level = badgeCelebrationLevel(event.repeatable, event.tier)
  const milestone = level === 'milestone'
  const grand = level !== 'repeat'
  const label = event.tier === 1 ? 'New Achievement Unlocked!' : milestone ? 'Achievement Milestone!' : 'Achievement Earned Again!'
  const ordinal = (count: number) => `${count}${count % 100 >= 11 && count % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[count % 10] ?? 'th'}`
  const occurrenceLabel = event.tier === 1 ? 'First Unlock' : milestone ? `${ordinal(event.tier)} ${definition.name}!` : `Earned for the ${ordinal(event.tier)} time`
  const earnedAt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(event.recordedAt))
  const index = queue.findIndex((item) => item.kind === 'badge' && item.event.id === event.id)
  return createPortal(<div ref={backdropRef} className="modal-backdrop progression-dialog-backdrop badge-celebration-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className={`progression-dialog badge-celebration${grand ? ' is-grand' : ' is-subtle'}`} role="dialog" aria-modal="true" aria-labelledby="badge-celebration-title" tabIndex={-1}>
      {grand && <div className="badge-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--confetti-index': index } as React.CSSProperties} />)}</div>}
      <header className="progression-dialog-header badge-celebration-header">
        <div className="badge-celebration-heading">
          <span className="eyebrow">{label}</span>
          {queue.length > 1 && <span className="badge-celebration-queue">Celebration {index + 1} of {queue.length}</span>}
          <div className="badge-celebration-title-row">
            <h2 id="badge-celebration-title">{definition.name}</h2>
          <InfoButton title={definition.name} label="About this celebration" compact summary={definition.description} description={`${definition.requirement} ${event.repeatable ? 'This badge is repeatable.' : 'This badge can be earned once.'}`} />
          </div>
        </div>
        <button ref={closeRef} type="button" className="info-dialog-close badge-celebration-close" aria-label="Close celebration" onClick={close}><AppIcon name="close" /></button>
      </header>
      <div className="progression-dialog-content badge-celebration-content"><ProgressionBadge achievementId={event.achievementId} tier={event.tier} size="large" /><p>{definition.description}</p><p className="badge-celebration-occurrence">{occurrenceLabel}{event.repeatable && event.tier > 1 ? ` · ${event.tier} valid awards` : ''}</p><p className="badge-celebration-earned">Earned {earnedAt}{event.sourceDate ? ` · qualifying date ${event.sourceDate}` : ''}</p><p className="badge-celebration-xp">{event.rewardXpDelta !== null && event.rewardXpDelta > 0 ? `+${event.rewardXpDelta} XP confirmed` : 'No XP awarded for this achievement'}</p><div className="badge-celebration-actions"><button className="button button-primary button-medium" onClick={close}>{queue.length > 1 ? 'Next' : 'Finish'}</button>{queue.length > 1 && <button className="button button-quiet button-medium" onClick={finish}>Dismiss remaining</button>}</div></div>
    </section>
  </div>, document.body)
}

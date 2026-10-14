import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from '../../components/ui/AppIcon'
import { useModalLayer } from '../../components/ui/useModalLayer'
import { useVisualViewportBounds } from '../../components/ui/useVisualViewportBounds'
import { achievementDefinition } from './achievementCatalog'
import { ProgressionBadge } from './ProgressionBadge'
import { getAchievementAwardXp, getEarnedAndLockedBadges, subscribeToProgressionChanges, type AchievementHistoryEvent } from '../../services/supabase/progressionRepository'
import { InfoButton } from '../../components/ui/InfoButton'
import { useWorkspaceTimeZone } from '../settings/WorkspaceTimeZone'

type Celebration = AchievementHistoryEvent & { repeatable: boolean }
const storageKey = (userId: string) => `progress-tracker:achievement-seen:${userId}`
const pendingStorageKey = (userId: string) => `progress-tracker:achievement-pending:${userId}`
const retryDelay = (attempt: number) => new Promise((resolve) => window.setTimeout(resolve, 250 * 2 ** attempt))

export function badgeCelebrationLevel(repeatable: boolean, occurrence: number): 'first' | 'repeat' | 'milestone' {
  if (occurrence === 1 || !repeatable) return 'first'
  return occurrence === 5 || occurrence === 10 || occurrence === 25 || occurrence === 50 || (occurrence > 0 && occurrence % 100 === 0) ? 'milestone' : 'repeat'
}

/** Watches persisted server unlock events, baselines historical events on first account load, and serializes new celebrations. */
export function BadgeCelebrationMonitor({ userId }: { userId: string }) {
  const { timeZone } = useWorkspaceTimeZone()
  const [queue, setQueue] = useState<Celebration[]>([])
  const seeded = useRef(false)
  const initialReadStartedAt = useRef(0)
  const refreshSequence = useRef(0)
  const refresh = useCallback(async () => {
    const requestId = ++refreshSequence.current
    try {
      let badges: Awaited<ReturnType<typeof getEarnedAndLockedBadges>> | undefined
      let readError: unknown
      for (let attempt = 0; attempt < 3 && !badges; attempt += 1) {
        try { badges = await getEarnedAndLockedBadges(userId) }
        catch (error) {
          readError = error
          if (attempt < 2) await retryDelay(attempt)
        }
      }
      if (!badges) throw readError
      if (requestId !== refreshSequence.current) return
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
        const surviving = current.filter((event) => !activeIds.has(event.id))
        const queued = new Set(surviving.map((event) => event.id))
        return [...surviving, ...positive.filter((event) => !queued.has(event.id))]
      })
      // Confirmed awards should be presented as soon as their history is read.
      // XP attribution is supplementary and may wait on a slower Auth/API call;
      // it must never hold the celebration queue or make an award appear lost.
      const sourceEventIds = [...new Set(positive.map((event) => event.sourceEventId).filter((id): id is string => Boolean(id)))]
      if (sourceEventIds.length) {
        void getAchievementAwardXp(userId, sourceEventIds).then((xpBySource) => {
          setQueue((current) => current.map((event) => event.sourceEventId && xpBySource.has(event.sourceEventId)
            ? { ...event, rewardXpDelta: xpBySource.get(event.sourceEventId)! }
            : event))
        }).catch(() => { /* XP is optional; show confirmed badge events without it. */ })
      }
    } catch { /* Network or sync failures are retried on the next workspace change. */ }
  }, [userId])

  useEffect(() => {
    seeded.current = false
    initialReadStartedAt.current = Date.now()
    void refresh()
    return subscribeToProgressionChanges(userId, () => { void refresh() })
  }, [refresh, userId])

  const current = queue[0]
  const acknowledge = useCallback((event: Celebration) => {
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
  useModalLayer(Boolean(current), dialogRef, close, { manageHistoryEntry: false })
  useVisualViewportBounds(Boolean(current), backdropRef)
  useEffect(() => { if (current) closeRef.current?.focus() }, [current?.id])
  if (!current) return null
  const definition = achievementDefinition(current.achievementId)
  if (!definition) return null
  const level = badgeCelebrationLevel(current.repeatable, current.tier)
  const milestone = level === 'milestone'
  const grand = level !== 'repeat'
  const label = current.tier === 1 ? 'New Achievement Unlocked!' : milestone ? 'Achievement Milestone!' : 'Achievement Earned Again!'
  const ordinal = (count: number) => `${count}${count % 100 >= 11 && count % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[count % 10] ?? 'th'}`
  const occurrenceLabel = current.tier === 1 ? 'First Unlock' : milestone ? `${ordinal(current.tier)} ${definition.name}!` : `Earned for the ${ordinal(current.tier)} time`
  const earnedAt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(current.recordedAt))
  const index = queue.findIndex((event) => event.id === current.id)
  return createPortal(<div ref={backdropRef} className="modal-backdrop progression-dialog-backdrop badge-celebration-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className={`progression-dialog badge-celebration${grand ? ' is-grand' : ' is-subtle'}`} role="dialog" aria-modal="true" aria-labelledby="badge-celebration-title" tabIndex={-1}>
      {grand && <div className="badge-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--confetti-index': index } as React.CSSProperties} />)}</div>}
      <header className="progression-dialog-header badge-celebration-header">
        <div className="badge-celebration-heading">
          <span className="eyebrow">{label}</span>
          {queue.length > 1 && <span className="badge-celebration-queue">Badge {index + 1} of {queue.length}</span>}
          <div className="badge-celebration-title-row">
            <h2 id="badge-celebration-title">{definition.name}</h2>
            <InfoButton title={definition.name} label="About this celebration" compact summary={definition.description} description={`${definition.requirement} ${current.repeatable ? 'This badge is repeatable.' : 'This badge can be earned once.'}`} />
          </div>
        </div>
        <button ref={closeRef} type="button" className="info-dialog-close badge-celebration-close" aria-label="Close celebration" onClick={close}><AppIcon name="close" /></button>
      </header>
      <div className="progression-dialog-content badge-celebration-content"><ProgressionBadge achievementId={current.achievementId} tier={current.tier} size="large" /><p>{definition.description}</p><p className="badge-celebration-occurrence">{occurrenceLabel}{current.repeatable && current.tier > 1 ? ` · ${current.tier} valid awards` : ''}</p><p className="badge-celebration-earned">Earned {earnedAt}{current.sourceDate ? ` · qualifying date ${current.sourceDate}` : ''}</p><p className="badge-celebration-xp">{current.rewardXpDelta !== null && current.rewardXpDelta > 0 ? `+${current.rewardXpDelta} XP confirmed` : 'No XP awarded for this achievement'}</p><div className="badge-celebration-actions"><button className="button button-primary button-medium" onClick={close}>{queue.length > 1 ? 'Next Badge' : 'Finish'}</button>{queue.length > 1 && <button className="button button-quiet button-medium" onClick={finish}>Dismiss remaining</button>}</div></div>
    </section>
  </div>, document.body)
}

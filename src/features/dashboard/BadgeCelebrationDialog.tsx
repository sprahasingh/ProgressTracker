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
type BadgeCelebrationGroup = { kind: 'badge'; id: string; groupKey: string; events: Celebration[] }
type QueuedCelebration = BadgeCelebrationGroup | LevelCelebration
const storageKey = (userId: string) => `progress-tracker:achievement-seen:${userId}`
const pendingStorageKey = (userId: string) => `progress-tracker:achievement-pending:${userId}`
const levelStateKey = (userId: string) => `progress-tracker:level-state:${userId}`
const levelPendingKey = (userId: string) => `progress-tracker:level-pending:${userId}`
const levelForXp = (xp: number) => calculateProgressionLevel(xp).level

function celebrationGroupKey(event: Celebration): string {
  // Several achievement events can be written from one local calendar day as
  // the same check-in is reconciled into First Step, Perfect Day, and streaks.
  return event.sourceDate ? `date:${event.sourceDate}` : event.sourceEventId ? `source:${event.sourceEventId}` : `event:${event.id}`
}

function withAwardEvents(group: BadgeCelebrationGroup, events: readonly Celebration[]): BadgeCelebrationGroup {
  const merged = new Map(group.events.map((event) => [event.id, event]))
  for (const event of events) merged.set(event.id, event)
  return { ...group, events: [...merged.values()].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id)) }
}

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
        const surviving: QueuedCelebration[] = []
        for (const item of current) {
          if (item.kind === 'level') surviving.push(item)
          else {
            const events = item.events.filter((event) => !activeIds.has(event.id))
            if (events.length) surviving.push({ ...item, events })
          }
        }
        const queued = new Set(surviving.map((item) => item.id))
        const next = [...surviving, ...levelItems.filter((item) => !queued.has(item.id))]
        for (const event of positive) {
          const groupKey = celebrationGroupKey(event)
          const existingIndex = next.findIndex((item) => item.kind === 'badge' && item.groupKey === groupKey)
          if (existingIndex >= 0) {
            const existing = next[existingIndex] as BadgeCelebrationGroup
            next[existingIndex] = withAwardEvents(existing, [event])
          } else {
            next.push({ kind: 'badge', id: `badge:${groupKey}`, groupKey, events: [event] })
          }
        }
        return next
      })
      // Confirmed awards should be presented as soon as their history is read.
      // XP attribution is supplementary and may wait on a slower Auth/API call;
      // it must never hold the celebration queue or make an award appear lost.
      const sourceEventIds = [...new Set(positive.map((event) => event.sourceEventId).filter((id): id is string => Boolean(id)))]
      if (sourceEventIds.length) {
        void getAchievementAwardXp(userId, sourceEventIds).then((xpBySource) => {
          setQueue((current) => current.map((item) => item.kind === 'badge'
            ? { ...item, events: item.events.map((event) => event.sourceEventId && xpBySource.has(event.sourceEventId)
              ? { ...event, rewardXpDelta: xpBySource.get(event.sourceEventId)! }
              : event) }
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
    const eventIds = new Set(item.events.map((event) => event.id))
    const key = storageKey(userId)
    let seen: string[] = []
    try { seen = JSON.parse(localStorage.getItem(key) ?? '[]') as string[] } catch { seen = [] }
    for (const id of eventIds) if (!seen.includes(id)) seen.push(id)
    localStorage.setItem(key, JSON.stringify(seen.slice(-3000)))
    let pending: string[] = []
    try { pending = JSON.parse(localStorage.getItem(pendingStorageKey(userId)) ?? '[]') as string[] } catch { pending = [] }
    localStorage.setItem(pendingStorageKey(userId), JSON.stringify(pending.filter((id) => !eventIds.has(id))))
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
  const currentId = current?.id ?? null
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
  const awards = current.events.map((event) => ({ event, definition: achievementDefinition(event.achievementId) }))
  const firstAward = awards[0]!
  const firstEvent = firstAward.event
  const firstDefinition = firstAward.definition
  const singleAward = awards.length === 1
  const level = badgeCelebrationLevel(firstEvent.repeatable, firstEvent.tier)
  const milestone = level === 'milestone'
  const grand = awards.some(({ event }) => badgeCelebrationLevel(event.repeatable, event.tier) !== 'repeat')
  const label = singleAward
    ? firstEvent.tier === 1 ? 'New Achievement Unlocked!' : milestone ? 'Achievement Milestone!' : 'Achievement Earned Again!'
    : 'New Achievements Unlocked!'
  const ordinal = (count: number) => `${count}${count % 100 >= 11 && count % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[count % 10] ?? 'th'}`
  const occurrenceLabel = (event: Celebration, name: string) => event.tier === 1 ? 'First Unlock' : badgeCelebrationLevel(event.repeatable, event.tier) === 'milestone' ? `${ordinal(event.tier)} ${name}!` : `Earned for the ${ordinal(event.tier)} time`
  const earnedAt = (event: Celebration) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(event.recordedAt))
  const index = queue.findIndex((item) => item.id === current.id)
  const title = singleAward ? firstDefinition?.name ?? 'Achievement' : `${awards.length} achievements unlocked`
  return createPortal(<div ref={backdropRef} className="modal-backdrop progression-dialog-backdrop badge-celebration-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className={`progression-dialog badge-celebration${grand ? ' is-grand' : ' is-subtle'}`} role="dialog" aria-modal="true" aria-labelledby="badge-celebration-title" tabIndex={-1}>
      {grand && <div className="badge-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--confetti-index': index } as React.CSSProperties} />)}</div>}
      <header className="progression-dialog-header badge-celebration-header">
        <div className="badge-celebration-heading">
          <span className="eyebrow">{label}</span>
          {queue.length > 1 && <span className="badge-celebration-queue">Celebration {index + 1} of {queue.length}</span>}
          <div className="badge-celebration-title-row">
            <h2 id="badge-celebration-title">{title}</h2>
            {singleAward && <InfoButton title={title} label="About this celebration" compact summary={firstDefinition?.description ?? 'A new achievement was confirmed.'} description={`${firstDefinition?.requirement ?? 'This achievement has been confirmed.'} ${firstEvent.repeatable ? 'This badge is repeatable.' : 'This badge can be earned once.'}`} />}
          </div>
        </div>
        <button ref={closeRef} type="button" className="info-dialog-close badge-celebration-close" aria-label="Close celebration" onClick={close}><AppIcon name="close" /></button>
      </header>
      {singleAward
        ? <div className="progression-dialog-content badge-celebration-content">
          <ProgressionBadge achievementId={firstEvent.achievementId} tier={firstEvent.tier} size="large" />
          <p>{firstDefinition?.description ?? 'A new achievement was confirmed.'}</p>
          <p className="badge-celebration-occurrence">{occurrenceLabel(firstEvent, firstDefinition?.name ?? 'Achievement')}{firstEvent.repeatable && firstEvent.tier > 1 ? ` · ${firstEvent.tier} valid awards` : ''}</p>
          <p className="badge-celebration-earned">Earned {earnedAt(firstEvent)}{firstEvent.sourceDate ? ` · qualifying date ${firstEvent.sourceDate}` : ''}</p>
          <p className="badge-celebration-xp">{firstEvent.rewardXpDelta !== null && firstEvent.rewardXpDelta > 0 ? `+${firstEvent.rewardXpDelta} XP confirmed` : 'No XP awarded for this achievement'}</p>
          <div className="badge-celebration-actions"><button className="button button-primary button-medium" onClick={close}>{queue.length > 1 ? 'Next' : 'Finish'}</button>{queue.length > 1 && <button className="button button-quiet button-medium" onClick={finish}>Dismiss remaining</button>}</div>
        </div>
        : <div className="progression-dialog-content badge-celebration-content is-multiple">
          <ul className="badge-celebration-awards" aria-label="Newly unlocked awards">
            {awards.map(({ event, definition }) => {
              const name = definition?.name ?? 'Achievement'
              return <li className="badge-celebration-award" key={event.id}>
                <ProgressionBadge achievementId={event.achievementId} tier={event.tier} size="large" />
                <div className="badge-celebration-award-details">
                  <div className="badge-celebration-title-row"><h3>{name}</h3><InfoButton title={name} label={`About ${name} celebration`} compact summary={definition?.description ?? 'A new achievement was confirmed.'} description={`${definition?.requirement ?? 'This achievement has been confirmed.'} ${event.repeatable ? 'This badge is repeatable.' : 'This badge can be earned once.'}`} /></div>
                  <p>{definition?.description ?? 'A new achievement was confirmed.'}</p>
                  <p className="badge-celebration-occurrence">{occurrenceLabel(event, name)}{event.repeatable && event.tier > 1 ? ` · ${event.tier} valid awards` : ''}</p>
                  <p className="badge-celebration-earned">Earned {earnedAt(event)}{event.sourceDate ? ` · qualifying date ${event.sourceDate}` : ''}</p>
                  <p className="badge-celebration-xp">{event.rewardXpDelta !== null && event.rewardXpDelta > 0 ? `+${event.rewardXpDelta} XP confirmed` : 'No XP awarded for this achievement'}</p>
                </div>
              </li>
            })}
          </ul>
          <div className="badge-celebration-actions"><button className="button button-primary button-medium" onClick={close}>{queue.length > 1 ? 'Next' : 'Finish'}</button>{queue.length > 1 && <button className="button button-quiet button-medium" onClick={finish}>Dismiss remaining</button>}</div>
        </div>}
    </section>
  </div>, document.body)
}

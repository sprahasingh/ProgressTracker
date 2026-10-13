import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'
import { AppIcon } from '../../components/ui/AppIcon'

export function ClearCheckInAction({ onClear, saving = false, holiday = false, compact = false, available = true }: {
  onClear: () => Promise<boolean>
  saving?: boolean
  holiday?: boolean
  compact?: boolean
  available?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  async function confirm() {
    if (processing || saving) return
    setProcessing(true)
    try { if (await onClear()) setConfirming(false) }
    finally { setProcessing(false) }
  }
  useLayoutEffect(() => {
    if (!showUnavailable) return
    const position = () => {
      const anchor = triggerRef.current?.getBoundingClientRect()
      const popover = popoverRef.current?.getBoundingClientRect()
      if (!anchor || !popover) return
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft ?? 0) + 12
      const topEdge = (viewport?.offsetTop ?? 0) + 12
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const rightEdge = (viewport?.offsetLeft ?? 0) + width - 12
      const bottomEdge = (viewport?.offsetTop ?? 0) + height - 12
      const left = Math.max(leftEdge, Math.min(anchor.left + anchor.width / 2 - popover.width / 2, rightEdge - popover.width))
      const above = anchor.top - popover.height - 8
      const below = anchor.bottom + 8
      const top = above >= topEdge ? above : Math.min(below, bottomEdge - popover.height)
      setPopoverPosition({ left, top })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.visualViewport?.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
    }
  }, [showUnavailable])
  useEffect(() => {
    if (!showUnavailable) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !popoverRef.current?.contains(event.target)) setShowUnavailable(false)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setShowUnavailable(false); triggerRef.current?.focus() } }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown, true) }
  }, [showUnavailable])
  const clearDescription = compact ? 'This removes the saved check-in for this day.' : `This will remove the recorded check-in and its note from active history. The date will become unchecked and may count as missed, affecting your streaks and progress statistics.${holiday ? ' The holiday on this date will remain in place.' : ''} The entry is retained as a sync tombstone.`
  const clearDetails = `The saved values and note are removed from current progress. The date becomes unchecked; if it was a required past opportunity, it can count as missed and affect your streak. A deletion record is kept so account sync can apply the clear on other devices.${holiday ? ' The holiday itself remains in place.' : ''}`
  return <>
    {compact
      ? <button ref={triggerRef} type="button" className={`today-secondary-action today-secondary-clear${available ? '' : ' is-unavailable'}`} disabled={saving} aria-disabled={!available} aria-expanded={showUnavailable} aria-controls={showUnavailable ? 'clear-checkin-unavailable' : undefined} onClick={() => available ? setConfirming(true) : setShowUnavailable((open) => !open)}><AppIcon name="reset" /><span>Clear check-in</span></button>
      : <button type="button" className="button button-quiet button-medium clear-checkin-action" disabled={saving} onClick={() => setConfirming(true)}>Clear Check-In</button>}
    {compact && showUnavailable && createPortal(<div ref={popoverRef} id="clear-checkin-unavailable" className="clear-checkin-unavailable" role="status" aria-live="polite" style={{ left: popoverPosition.left, top: popoverPosition.top }}><strong>Nothing to clear</strong><span>No check-in has been saved for this day yet.</span></div>, document.body)}
    {confirming && <ConfirmActionDialog title={compact ? 'Clear this check-in?' : 'Clear check-in?'} description={clearDescription} details={compact ? clearDetails : undefined} layer={compact ? 'checkin' : 'default'} actionLabel={compact ? 'Clear check-in' : 'Clear Check-In'} destructive={!compact} actionVariant={compact ? 'primary' : undefined} actionDisabled={processing || saving} cancelDisabled={processing || saving} onCancel={() => { if (!processing && !saving) setConfirming(false) }} onConfirm={() => void confirm()} />}
  </>
}

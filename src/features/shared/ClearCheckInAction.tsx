import { useState } from 'react'
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
  async function confirm() {
    if (processing || saving) return
    setProcessing(true)
    try { if (await onClear()) setConfirming(false) }
    finally { setProcessing(false) }
  }
  const clearDescription = compact ? 'This removes the saved check-in for this day.' : `This will remove the recorded check-in and its note from active history. The date will become unchecked and may count as missed, affecting your streaks and progress statistics.${holiday ? ' The holiday on this date will remain in place.' : ''} The entry is retained as a sync tombstone.`
  const clearDetails = `The saved values and note are removed from current progress. The date becomes unchecked; if it was a required past opportunity, it can count as missed and affect your streak. A deletion record is kept so account sync can apply the clear on other devices.${holiday ? ' The holiday itself remains in place.' : ''}`
  return <>
    {compact
      ? <button type="button" className="today-secondary-action today-secondary-clear" disabled={saving || !available} title={available ? undefined : 'There is no saved check-in to clear.'} onClick={() => setConfirming(true)}><AppIcon name="reset" /><span>Clear check-in</span></button>
      : <button type="button" className="button button-quiet button-medium clear-checkin-action" disabled={saving} onClick={() => setConfirming(true)}>Clear Check-In</button>}
    {confirming && <ConfirmActionDialog title={compact ? 'Clear this check-in?' : 'Clear check-in?'} description={clearDescription} details={compact ? clearDetails : undefined} layer={compact ? 'checkin' : 'default'} actionLabel={compact ? 'Clear check-in' : 'Clear Check-In'} destructive={!compact} actionVariant={compact ? 'primary' : undefined} actionDisabled={processing || saving} cancelDisabled={processing || saving} onCancel={() => { if (!processing && !saving) setConfirming(false) }} onConfirm={() => void confirm()} />}
  </>
}

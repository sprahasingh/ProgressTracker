import { useState } from 'react'
import { ConfirmActionDialog } from '../../components/ui/ConfirmActionDialog'

export function ClearCheckInAction({ onClear, saving = false, holiday = false }: {
  onClear: () => Promise<boolean>
  saving?: boolean
  holiday?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [processing, setProcessing] = useState(false)
  async function confirm() {
    if (processing || saving) return
    setProcessing(true)
    try { if (await onClear()) setConfirming(false) }
    finally { setProcessing(false) }
  }
  return <>
    <button type="button" className="button button-quiet button-medium clear-checkin-action" disabled={saving} onClick={() => setConfirming(true)}>Clear Check-In</button>
    {confirming && <ConfirmActionDialog title="Clear check-in?" description={`This will remove the recorded check-in and its note from active history. The date will become unchecked and may count as missed, affecting your streaks and progress statistics.${holiday ? ' The holiday on this date will remain in place.' : ''} The entry is retained as a sync tombstone.`} actionLabel="Clear Check-In" destructive actionDisabled={processing || saving} onCancel={() => setConfirming(false)} onConfirm={() => void confirm()} />}
  </>
}

import { useEffect, useState } from 'react'
import { InfoButton } from '../../components/ui/InfoButton'
import { getIdentitySharingPreferenceState, setIdentitySharingPreference } from './identitySharing'

export function IdentitySharingSettings() {
  const [shareIdentity, setShareIdentity] = useState<boolean | null>(null)
  const [explicitlyChosen, setExplicitlyChosen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void getIdentitySharingPreferenceState().then((value) => {
      if (active) { setShareIdentity(value.enabled); setExplicitlyChosen(value.explicitlyChosen) }
    }).catch((cause: unknown) => {
      if (active) {
        setShareIdentity(null)
        setError(cause instanceof Error ? cause.message : 'Your privacy setting could not be loaded. Try again.')
      }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [loadAttempt])

  async function save(next: boolean) {
    if (saving || loading || error) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const confirmed = await setIdentitySharingPreference(next)
      setShareIdentity(confirmed)
      setExplicitlyChosen(true)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your privacy setting could not be saved. Try again.')
    } finally { setSaving(false) }
  }

  return <div className="settings-privacy" aria-busy={loading || saving}>
    <div className="settings-privacy-control">
      {shareIdentity !== null && <label className="settings-privacy-toggle" htmlFor="share-identity-with-maintainers">
      <input
        id="share-identity-with-maintainers"
        type="checkbox"
        aria-label="Share my details with maintainers"
        checked={shareIdentity}
        disabled={loading || saving || Boolean(error)}
        onChange={(event) => void save(event.currentTarget.checked)}
        aria-describedby="identity-sharing-description"
      />
        <strong>Share my details with maintainers</strong>
      </label>
      }
      {shareIdentity !== null && <InfoButton
        title="How identity sharing works"
        label="How identity sharing works"
        compact
        content={<ul className="identity-sharing-details">
          <li>When enabled, maintainers can see your name and email for eligible feedback and support requests.</li>
          <li>When disabled, your identity is hidden from maintainers in feedback and support views.</li>
          <li>The app may still use account identifiers internally for authentication, ownership, abuse prevention, and support replies.</li>
          <li>Previously anonymous submissions remain anonymous even if sharing is enabled later.</li>
          <li>Information already viewed or exported by maintainers cannot be retroactively erased.</li>
          <li>This setting controls maintainer-facing feedback and support views, not privileged infrastructure administration.</li>
        </ul>}
      />}
    </div>
      <small className="settings-privacy-description" id="identity-sharing-description">Allow maintainers to see your name and eligible email when reviewing your AI feedback or support requests. The enabled default does not authorize identity disclosure until you explicitly confirm it.</small>
    {loading && <p className="settings-hint" role="status">Loading privacy setting…</p>}
    {saving && <p className="settings-hint" role="status">Saving privacy setting…</p>}
    {!loading && !error && !explicitlyChosen && shareIdentity === true && <div className="settings-hint">
      <p>Sharing is enabled by default, but you have not explicitly saved this choice. Maintainers will not see your identity until you confirm it.</p>
      <button type="button" className="button button-secondary button-small" disabled={saving} onClick={() => void save(true)}>Confirm sharing preference</button>
    </div>}
    {saved && <p className="settings-hint" role="status">Privacy setting saved.</p>}
    {error && <div className="settings-privacy-error"><p className="auth-error" role="alert">{error}</p><button type="button" className="button button-secondary button-small" onClick={() => { setError(''); setLoadAttempt((value) => value + 1) }}>Try again</button></div>}
  </div>
}

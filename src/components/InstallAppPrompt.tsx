import { useEffect, useState } from 'react'

type InstallChoice = { outcome: 'accepted' | 'dismissed'; platform: string }
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<InstallChoice>
}

export function InstallAppPrompt() {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault()
      setInstallEvent(event as InstallPromptEvent)
    }
    function handleInstalled() {
      setInstallEvent(null)
      setMessage('ProgressTracker is installed.')
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  async function install() {
    if (!installEvent) return
    try {
      await installEvent.prompt()
      const choice = await installEvent.userChoice
      setMessage(choice.outcome === 'accepted' ? 'ProgressTracker is installed.' : 'Installation was dismissed.')
    } catch {
      setMessage('Installation is unavailable in this browser right now.')
    } finally {
      setInstallEvent(null)
    }
  }

  if (installEvent) return <button className="install-app-button" type="button" onClick={() => void install()}>Install app</button>
  return message ? <span className="install-app-status" role="status">{message}</span> : null
}

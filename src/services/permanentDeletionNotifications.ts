export type PermanentDeletionNotification = {
  status: 'queued' | 'confirmed' | 'failed' | 'conflict'
  ownerUserId: string
  trackerId: string
  trackerName: string
  message?: string
}

const eventName = 'progress-tracker:permanent-deletion-notification'

export function permanentDeletionNotificationKey(ownerUserId: string, trackerId: string): string {
  return `permanent-delete:${ownerUserId}:${trackerId}`
}

export function publishPermanentDeletionNotification(notification: PermanentDeletionNotification): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<PermanentDeletionNotification>(eventName, { detail: notification }))
}

export function subscribeToPermanentDeletionNotifications(listener: (notification: PermanentDeletionNotification) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handle = (event: Event) => listener((event as CustomEvent<PermanentDeletionNotification>).detail)
  window.addEventListener(eventName, handle)
  return () => window.removeEventListener(eventName, handle)
}

export type HolidayDeletionNotification = {
  status: 'queued' | 'confirmed' | 'failed' | 'conflict' | 'cancelled'
  ownerUserId: string
  holidayId: string
  holidayDate: string
  message?: string
}

const eventName = 'progress-tracker:holiday-deletion-notification'

export function holidayDeletionNotificationKey(ownerUserId: string, holidayId: string): string {
  return `holiday-delete:${ownerUserId}:${holidayId}`
}

export function publishHolidayDeletionNotification(notification: HolidayDeletionNotification): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<HolidayDeletionNotification>(eventName, { detail: notification }))
}

export function subscribeToHolidayDeletionNotifications(listener: (notification: HolidayDeletionNotification) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handle = (event: Event) => listener((event as CustomEvent<HolidayDeletionNotification>).detail)
  window.addEventListener(eventName, handle)
  return () => window.removeEventListener(eventName, handle)
}

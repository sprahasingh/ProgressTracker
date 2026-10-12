import type { ActivityStatus } from '../../domain/trackers/activityStatus'
import { AppIcon } from './AppIcon'

export function ActivityStatusIcon({ status, className }: { status: ActivityStatus; className?: string }) {
  const iconStatus = status === 'rest-day' ? 'unscheduled' : status === 'outside-period' ? 'outside-period' : status === 'inactive' ? 'inactive' : status === 'no-trackers' ? 'no-trackers' : status
  return <AppIcon name={`status-${iconStatus}`} className={className} />
}

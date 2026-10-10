import type { ActivityStatus } from '../../domain/trackers/activityStatus'
import { AppIcon } from './AppIcon'

export function ActivityStatusIcon({ status, className }: { status: ActivityStatus; className?: string }) {
  return <AppIcon name={`status-${status}`} className={className} />
}

import { isProgressionUiEnabled } from '../../domain/trackers/schemaVersionGate'
import { LegacyAchievementsPage } from './LegacyAchievementsPage'
import { ProgressionAchievementsPage } from './ProgressionAchievementsPage'

/** Keep the established page intact until a release explicitly enables progression UI. */
export function AchievementsPage() {
  return isProgressionUiEnabled() ? <ProgressionAchievementsPage /> : <LegacyAchievementsPage />
}

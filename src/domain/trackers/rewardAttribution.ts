export type RewardAttributionInput = {
  reasonCode: string | null
  trackerId?: string | null
  goalId?: string | null
  displayName?: string | null
  trackerDeleted?: boolean
  trackerArchived?: boolean
  /** Original reward reason for an AWARD_REVERSAL ledger row. */
  originalReasonCode?: string | null
  /** Achievement catalog scope is authoritative for badge qualification. */
  accountWideAchievement?: boolean
}

export type RewardAttribution = {
  scope: 'account' | 'tracker' | 'goal' | 'unknown'
  label: string
  deleted: boolean
  archived: boolean
}

const accountRewards = new Set(['PERFECT_DAY_BONUS', 'LEGACY_XP_OPENING_BALANCE'])
const trackerRewards = new Set(['DAILY_CHECK_IN_COMPLETED', 'STREAK_MILESTONE'])
const goalRewards = new Set(['GOAL_MILESTONE', 'GOAL_COMPLETED'])
const unusableNames = new Set(['', 'Deleted tracker', 'Tracker unavailable', 'Tracker name unavailable', 'Progression reward', 'Pending check-in'])

/** Resolve a display label from the authoritative reward type and historical source snapshot. */
export function resolveRewardAttribution(input: RewardAttributionInput): RewardAttribution {
  const reasonCode = input.reasonCode === 'AWARD_REVERSAL' ? input.originalReasonCode : input.reasonCode
  const scope = input.accountWideAchievement || (reasonCode && accountRewards.has(reasonCode)) ? 'account'
    : reasonCode && trackerRewards.has(reasonCode) ? 'tracker'
      : reasonCode && goalRewards.has(reasonCode) ? 'goal' : 'unknown'
  if (scope === 'account') {
    return { scope, label: reasonCode === 'LEGACY_XP_OPENING_BALANCE' ? 'Account-wide XP' : 'All eligible trackers', deleted: false, archived: false }
  }
  const historicalName = input.displayName?.trim() ?? ''
  if ((scope === 'tracker' || scope === 'goal') && !unusableNames.has(historicalName)) {
    return { scope, label: historicalName, deleted: Boolean(input.trackerDeleted), archived: !input.trackerDeleted && Boolean(input.trackerArchived) }
  }
  return { scope: scope === 'unknown' ? 'unknown' : scope, label: 'Source unavailable', deleted: false, archived: false }
}

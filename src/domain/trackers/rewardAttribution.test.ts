import { describe, expect, it } from 'vitest'
import { resolveRewardAttribution } from './rewardAttribution'

describe('resolveRewardAttribution', () => {
  it('resolves account-wide rewards from reward type even when stale source text says deleted', () => {
    expect(resolveRewardAttribution({ reasonCode: 'PERFECT_DAY_BONUS', displayName: 'Deleted tracker', trackerDeleted: true }))
      .toEqual({ scope: 'account', label: 'All eligible trackers', deleted: false, archived: false })
  })

  it.each(['DAILY_CHECK_IN_COMPLETED', 'STREAK_MILESTONE'])( 'keeps tracker reward attribution tied to its historical name (%s)', (reasonCode) => {
    expect(resolveRewardAttribution({ reasonCode, trackerId: 'id', displayName: 'Original name', trackerArchived: true }))
      .toEqual({ scope: 'tracker', label: 'Original name', deleted: false, archived: true })
  })

  it.each(['GOAL_MILESTONE', 'GOAL_COMPLETED'])('uses historical source names for goal rewards (%s)', (reasonCode) => {
    expect(resolveRewardAttribution({ reasonCode, goalId: 'goal-id', displayName: 'Original goal' }).label).toBe('Original goal')
  })

  it('uses neutral wording when evidence is missing and honors explicit retained deletion context', () => {
    expect(resolveRewardAttribution({ reasonCode: 'DAILY_CHECK_IN_COMPLETED', trackerId: 'stale-id' }).label).toBe('Source unavailable')
    expect(resolveRewardAttribution({ reasonCode: 'DAILY_CHECK_IN_COMPLETED', displayName: 'Original name', trackerDeleted: true }).deleted).toBe(true)
  })

  it('uses the original reward type when displaying reversal rows', () => {
    expect(resolveRewardAttribution({ reasonCode: 'AWARD_REVERSAL', originalReasonCode: 'PERFECT_DAY_BONUS', displayName: 'Deleted tracker' }).label)
      .toBe('All eligible trackers')
  })
})

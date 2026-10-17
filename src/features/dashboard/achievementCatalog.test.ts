import { describe, expect, it } from 'vitest'
import { achievementCatalog, achievementRewardExplanation } from './achievementCatalog'
import { PROGRESSION_REWARDS } from '../../domain/trackers/progressionModel'

describe('achievement XP explanations', () => {
  it('describes only the XP events attached to each badge rule', () => {
    expect(achievementRewardExplanation('first-step')).toContain(`${PROGRESSION_REWARDS.checkIn} XP each`)
    expect(achievementRewardExplanation('momentum')).toContain('this badge adds no separate XP')
    for (const [id, milestone] of [
      ['first-flame', PROGRESSION_REWARDS.streakMilestones[0]],
      ['steady-flame', PROGRESSION_REWARDS.streakMilestones[1]],
      ['unstoppable', PROGRESSION_REWARDS.streakMilestones[2]],
      ['century', PROGRESSION_REWARDS.streakMilestones[3]],
    ] as const) {
      expect(achievementRewardExplanation(id)).toContain(`${milestone.days}-day streak milestone earns ${milestone.xp} additional XP`)
    }
    expect(achievementRewardExplanation('perfect-day')).toContain(`${PROGRESSION_REWARDS.perfectDay} XP`)
    expect(achievementRewardExplanation('perfect-week')).toContain(`${PROGRESSION_REWARDS.perfectDay} XP`)
    expect(achievementRewardExplanation('milestone-maker')).toContain(`${PROGRESSION_REWARDS.goalMilestone} XP`)
    expect(achievementRewardExplanation('goal-crusher')).toContain(`${PROGRESSION_REWARDS.goalCompleted} XP`)
    for (const badge of achievementCatalog) expect(achievementRewardExplanation(badge.id)).toBeTruthy()
    expect(achievementRewardExplanation('the-comeback')).toContain('this badge adds no separate XP')
  })
})

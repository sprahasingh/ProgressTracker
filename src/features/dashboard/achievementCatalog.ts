import { PROGRESSION_ACHIEVEMENTS, PROGRESSION_REWARDS } from '../../domain/trackers/progressionModel'

type AchievementId = typeof PROGRESSION_ACHIEVEMENTS[number]['id']
type RewardExplanation = 'check-in' | 'perfect-day' | 'perfect-day-series' | 'streak-7' | 'streak-14' | 'streak-30' | 'streak-100' | 'goal-milestone' | 'goal-completed'
type AchievementDetails = {
  description: string
  requirement: string
  progressUnit: string
  shortRequirement: string
  badgeThreshold?: string
  attribution: 'tracker' | 'account'
  rewardExplanation?: RewardExplanation
}

const details: Record<AchievementId, AchievementDetails> = {
  'first-step': { description: 'A meaningful beginning, built one check-in at a time.', requirement: 'Save one qualifying check-in.', progressUnit: 'check-ins', shortRequirement: 'Save a qualifying check-in', attribution: 'tracker', rewardExplanation: 'check-in' },
  momentum: { description: 'A short run of steady effort is taking shape.', requirement: 'Build a qualifying three-opportunity streak on one tracker.', progressUnit: 'streak days', shortRequirement: 'Reach a 3-day tracker streak', badgeThreshold: '3 DAYS', attribution: 'tracker', rewardExplanation: 'check-in' },
  'first-flame': { description: 'A full week of showing up with intention.', requirement: 'Build a qualifying seven-opportunity streak on one tracker.', progressUnit: 'streak days', shortRequirement: 'Reach a 7-day tracker streak', badgeThreshold: '7 DAYS', attribution: 'tracker', rewardExplanation: 'streak-7' },
  'steady-flame': { description: 'Your rhythm is holding through changing days.', requirement: 'Build a qualifying fourteen-opportunity streak on one tracker.', progressUnit: 'streak days', shortRequirement: 'Reach a 14-day tracker streak', badgeThreshold: '14 DAYS', attribution: 'tracker', rewardExplanation: 'streak-14' },
  unstoppable: { description: 'A month of sustained, qualifying activity.', requirement: 'Build a qualifying thirty-opportunity streak on one tracker.', progressUnit: 'streak days', shortRequirement: 'Reach a 30-day tracker streak', badgeThreshold: '30 DAYS', attribution: 'tracker', rewardExplanation: 'streak-30' },
  century: { description: 'A remarkable hundred-opportunity streak.', requirement: 'Build a qualifying one-hundred-opportunity streak on one tracker.', progressUnit: 'streak days', shortRequirement: 'Reach a 100-day tracker streak', badgeThreshold: '100 DAYS', attribution: 'tracker', rewardExplanation: 'streak-100' },
  'perfect-day': { description: 'Every eligible tracker was completed on one day.', requirement: 'Complete every eligible tracker on the same day.', progressUnit: 'perfect days', shortRequirement: 'Complete all eligible trackers in one day', attribution: 'account', rewardExplanation: 'perfect-day' },
  'perfect-week': { description: 'Seven consecutive calendar dates, each a Perfect Day.', requirement: 'Every date in a completed Monday-to-Sunday week must be a Perfect Day in your account timezone. Each date needs at least one eligible tracker with a positive target, and every eligible tracker must meet its configured success rule.', progressUnit: 'perfect weeks', shortRequirement: 'Complete all seven dates in a calendar week', attribution: 'account', rewardExplanation: 'perfect-day-series' },
  'milestone-maker': { description: 'A goal milestone reached through consistent progress.', requirement: 'Reach a configured goal milestone.', progressUnit: 'goal milestones', shortRequirement: 'Reach a configured goal milestone', attribution: 'tracker', rewardExplanation: 'goal-milestone' },
  'goal-crusher': { description: 'A goal completed and confirmed in your workspace.', requirement: 'Complete a goal tracker.', progressUnit: 'completed goals', shortRequirement: 'Complete a goal tracker', attribution: 'tracker', rewardExplanation: 'goal-completed' },
  'consistency-star': { description: 'A strong rhythm across completed required opportunities.', requirement: 'Reach 80% adherence across at least 30 completed eligible opportunities. Standard Mode holidays and rest days are neutral and excluded.', progressUnit: '% consistency', shortRequirement: 'Reach 80% across 30 eligible opportunities', badgeThreshold: '30 DAYS', attribution: 'account', rewardExplanation: 'check-in' },
  dedicated: { description: 'A deep history of qualifying check-ins.', requirement: 'Reach 100 qualifying saved check-ins.', progressUnit: 'check-ins', shortRequirement: 'Save 100 qualifying check-ins', badgeThreshold: '100 CHECK-INS', attribution: 'tracker', rewardExplanation: 'check-in' },
  'perfect-month': { description: 'Every calendar date in a month was a Perfect Day.', requirement: 'Every date in a completed calendar month must be a Perfect Day in your account timezone. The month uses its actual length, including leap February.', progressUnit: 'perfect months', shortRequirement: 'Complete every date in a calendar month', attribution: 'account', rewardExplanation: 'perfect-day-series' },
  'perfect-year': { description: 'Every calendar date in a year was a Perfect Day.', requirement: 'Every date in a completed calendar year must be a Perfect Day in your account timezone, including February 29 in leap years.', progressUnit: 'perfect years', shortRequirement: 'Complete every date in a calendar year', attribution: 'account', rewardExplanation: 'perfect-day-series' },
  'the-comeback': { description: 'You returned after a genuinely missed required opportunity and rebuilt a week-long streak on that tracker.', requirement: 'After a missed required opportunity, qualify on the next seven consecutive required opportunities for that tracker. Neutral dates preserve the recovery run; a saved skip breaks a run but does not trigger it.', progressUnit: 'comebacks', shortRequirement: 'Rebuild a 7-opportunity streak after a missed required day', badgeThreshold: '7 DAYS', attribution: 'tracker', rewardExplanation: 'check-in' },
}

export const achievementCatalog = PROGRESSION_ACHIEVEMENTS.map((achievement) => ({
  ...achievement,
  ...details[achievement.id]!,
}))

export function achievementDefinition(id: string) {
  return achievementCatalog.find((achievement) => achievement.id === id)
}

export function achievementRewardExplanation(id: string): string | null {
  const detail = details[id as AchievementId]
  const reward = detail?.rewardExplanation
  if (!reward) return null
  if (reward === 'check-in') return `Qualifying check-ins earn ${PROGRESSION_REWARDS.checkIn} XP each; this badge adds no separate XP.`
  if (reward === 'perfect-day') return `A Perfect Day earns ${PROGRESSION_REWARDS.perfectDay} XP; qualifying check-ins earn their own XP.`
  if (reward === 'perfect-day-series') return `Each Perfect Day in the qualifying period earns ${PROGRESSION_REWARDS.perfectDay} XP; the period badge adds no separate XP.`
  if (reward === 'goal-milestone') return `A configured goal milestone earns ${PROGRESSION_REWARDS.goalMilestone} XP; this badge adds no separate XP.`
  if (reward === 'goal-completed') return `A completed goal earns ${PROGRESSION_REWARDS.goalCompleted} XP; this badge adds no separate XP.`
  const milestone = PROGRESSION_REWARDS.streakMilestones.find(({ days }) => days === Number(reward.slice('streak-'.length)))
  return milestone ? `Qualifying check-ins earn ${PROGRESSION_REWARDS.checkIn} XP each. The ${milestone.days}-day streak milestone earns ${milestone.xp} additional XP.` : null
}

export function badgeTierLabel(tier: number): string {
  return ['Bronze', 'Silver', 'Gold', 'Platinum'][Math.max(0, Math.min(3, tier - 1))] ?? 'Bronze'
}

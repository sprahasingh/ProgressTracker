import { PROGRESSION_ACHIEVEMENTS } from '../../domain/trackers/progressionModel'

const details: Record<string, { description: string; requirement: string }> = {
  'first-step': { description: 'A meaningful beginning, built one check-in at a time.', requirement: 'Save one qualifying check-in.' },
  momentum: { description: 'A short run of steady effort is taking shape.', requirement: 'Build a qualifying three-day streak.' },
  'first-flame': { description: 'A full week of showing up with intention.', requirement: 'Build a qualifying seven-day streak.' },
  'steady-flame': { description: 'Your rhythm is holding through changing days.', requirement: 'Build a qualifying fourteen-day streak.' },
  unstoppable: { description: 'A month of sustained, qualifying activity.', requirement: 'Build a qualifying thirty-day streak.' },
  century: { description: 'A remarkable hundred-day streak.', requirement: 'Build a qualifying one-hundred-day streak.' },
  'perfect-day': { description: 'Every eligible tracker was completed on one day.', requirement: 'Complete every eligible tracker on the same day.' },
  'perfect-week': { description: 'A week of completing every eligible opportunity.', requirement: 'Complete every eligible tracker throughout one week.' },
  'milestone-maker': { description: 'A goal milestone reached through consistent progress.', requirement: 'Reach a configured goal milestone.' },
  'goal-crusher': { description: 'A goal completed and confirmed in your workspace.', requirement: 'Complete a goal tracker.' },
  'consistency-star': { description: 'A strong rhythm across a full set of eligible days.', requirement: 'Reach 80% consistency across at least 30 eligible days.' },
  dedicated: { description: 'A deep history of qualifying check-ins.', requirement: 'Reach 100 qualifying saved check-ins.' },
}

export const achievementCatalog = PROGRESSION_ACHIEVEMENTS.map((achievement) => ({
  ...achievement,
  ...details[achievement.id]!,
}))

export function achievementDefinition(id: string) {
  return achievementCatalog.find((achievement) => achievement.id === id)
}

export function badgeTierLabel(tier: number): string {
  return ['Bronze', 'Silver', 'Gold', 'Platinum'][Math.max(0, Math.min(3, tier - 1))] ?? 'Bronze'
}

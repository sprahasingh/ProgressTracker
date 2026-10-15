import { z } from 'zod'

export const trackerSetupSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name for this tracker.').max(200, 'Use 200 characters or fewer.'),
  description: z.string().max(2000, 'Use 2,000 characters or fewer.'),
  kind: z.enum(['habit', 'goal', 'challenge', 'project']),
  schedule: z.enum(['every-day', 'weekdays', 'weekends', 'custom-days', 'none', 'keep-current']),
  customWeekdays: z.array(z.number().int().min(0).max(6)).max(7).refine((days) => new Set(days).size === days.length),
  startDate: z.union([z.literal(''), z.iso.date()]),
  deadline: z.union([z.literal(''), z.iso.date()]),
  schedulingMode: z.enum(['calendar', 'effective', 'ongoing']).default('ongoing'),
  effectiveDays: z.string().default(''),
  effectiveDayCounting: z.enum(['planned-activity-days', 'all-non-holiday-days']).default('planned-activity-days'),
  strictMode: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.startDate && value.deadline && value.deadline < value.startDate) {
    context.addIssue({ code: 'custom', path: ['startDate'], message: 'Start date must be on or before the deadline. Choose an earlier start date or move the deadline to this date.' })
  }
  if (value.schedulingMode === 'calendar' && !value.deadline) context.addIssue({ code: 'custom', path: ['deadline'], message: 'Choose a deadline for Calendar Days scheduling.' })
  if (value.schedulingMode === 'effective' && (!/^\d+$/.test(value.effectiveDays) || Number(value.effectiveDays) < 1 || Number(value.effectiveDays) > 100_000)) context.addIssue({ code: 'custom', path: ['effectiveDays'], message: 'Enter a positive whole number of effective days (up to 100,000).' })
  if (value.schedule === 'custom-days' && value.customWeekdays.length === 0) context.addIssue({ code: 'custom', path: ['schedule'], message: 'Select at least one day, or choose No Recurrence.' })
})

export type TrackerSetupFields = z.infer<typeof trackerSetupSchema>

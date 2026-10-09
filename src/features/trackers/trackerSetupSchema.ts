import { z } from 'zod'

export const trackerSetupSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name for this tracker.').max(200, 'Use 200 characters or fewer.'),
  description: z.string().max(2000, 'Use 2,000 characters or fewer.'),
  kind: z.enum(['habit', 'goal', 'challenge', 'project']),
  schedule: z.enum(['every-day', 'weekdays', 'none', 'three-times-weekly']),
  startDate: z.union([z.literal(''), z.iso.date()]),
  deadline: z.union([z.literal(''), z.iso.date()]),
  metricName: z.string().trim().min(1, 'Give the measure a name.').max(120, 'Use 120 characters or fewer.'),
  unit: z.string().max(40, 'Use 40 characters or fewer.'),
  target: z.string(),
}).superRefine((value, context) => {
  if (value.startDate && value.deadline && value.deadline < value.startDate) {
    context.addIssue({ code: 'custom', path: ['deadline'], message: 'Deadline must be on or after the start date.' })
  }
  if (value.kind !== 'habit') {
    const target = Number(value.target)
    if (!value.target.trim() || !Number.isFinite(target) || target <= 0) {
      context.addIssue({ code: 'custom', path: ['target'], message: 'Enter a target greater than zero.' })
    }
  }
})

export type TrackerSetupFields = z.infer<typeof trackerSetupSchema>

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeEvidenceLines } from './sourceIndexUtils.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const docs = [
  ['core-application', 'ProgressTracker product map', 'docs/ai-help/core-application.md'],
  ['measures-and-success-rules', 'Measures and success rules', 'docs/ai-help/measures-and-success-rules.md'],
  ['schedules-and-streaks', 'Schedules and streaks', 'docs/ai-help/schedules-and-streaks.md'],
  ['goals-and-milestones', 'Goals, planning, and milestones', 'docs/ai-help/goals-and-milestones.md'],
  ['history-analytics-sync', 'Check-ins, History, Analytics, and sync', 'docs/ai-help/history-analytics-sync.md'],
]
const sources = [
  'src/routes/router.tsx',
  'src/app/AppShell.tsx',
  'src/domain/trackers/types.ts',
  'src/domain/trackers/schema.ts',
  'src/domain/trackers/schema.test.ts',
  'src/domain/trackers/planning.ts',
  'src/domain/trackers/progression.ts',
  'src/domain/trackers/analytics.ts',
  'src/domain/trackers/activityStatus.ts',
  'src/domain/trackers/activityHeatmap.ts',
  'src/domain/trackers/activePeriod.test.ts',
  'src/domain/trackers/goalPlanning.test.ts',
  'src/domain/trackers/allocationPreview.ts',
  'src/features/trackers/trackerSetupSchema.ts',
  'src/features/trackers/TrackerSetupPage.tsx',
  'src/features/trackers/TrackerSetupPage.test.tsx',
  'src/features/trackers/TrackerConfigurationEditor.tsx',
  'src/features/trackers/GoalPlanningEditor.tsx',
  'src/features/trackers/trackerSetupSchema.test.ts',
  'src/features/settings/WorkspaceTimeZone.tsx',
  'src/config/supportContact.ts',
  'src/features/settings/AccountDeletion.tsx',
  'src/features/settings/AccountDeletion.test.tsx',
  'src/features/today/TodayRequirements.tsx',
  'src/features/today/TodayPage.tsx',
  'src/features/today/TodayPage.test.tsx',
  'src/features/dashboard/DashboardPage.tsx',
  'src/features/dashboard/AchievementsPage.tsx',
  'src/features/ai-help/AIHelpAssistant.tsx',
  'src/features/ai-help/AIHelpPanel.tsx',
  'src/features/feedback/SendFeedback.tsx',
  'src/features/feedback/feedbackService.ts',
  'src/features/ai-help/aiHelpService.ts',
  'src/features/ai-knowledge/aiKnowledgeApi.ts',
  'src/features/ai-knowledge/aiKnowledgeApi.test.ts',
  'src/features/ai-knowledge/AIKnowledgePage.tsx',
  'src/features/ai-knowledge/AnswerFeedbackWorkspace.tsx',
  'src/features/history/HistoryPage.tsx',
  'src/features/history/HistoryPage.test.tsx',
  'src/features/analytics/AnalyticsPage.tsx',
  'src/features/analytics/AnalyticsPage.test.tsx',
  'src/features/goals/GoalsPage.tsx',
  'src/features/goals/GoalsPage.test.tsx',
  'src/features/trackers/TrackerLibraryPage.tsx',
  'src/features/trackers/TrackerBinPage.tsx',
  'src/features/auth/AuthPage.tsx',
  'src/features/auth/AuthPage.test.tsx',
  'src/features/auth/AuthProvider.tsx',
  'src/features/auth/authService.ts',
  'supabase/functions/delete-account/index.ts',
  'supabase/migrations/20261013000100_secure_account_deletion.sql',
  'supabase/migrations/20261015000100_preserve_parent_history_on_delete.sql',
  'src/features/auth/WorkspaceBackup.tsx',
  'src/features/settings/appearance.ts',
  'src/features/settings/UnifiedSettings.test.tsx',
  'src/features/holidays/HolidaysPage.tsx',
  'src/features/calendar/CalendarPage.tsx',
  'src/features/notifications/NotificationsSettings.tsx',
  'src/features/notifications/NotificationsSettings.test.tsx',
  'src/features/notifications/ForegroundReminderMonitor.tsx',
  'src/features/notifications/reminderRules.ts',
  'src/features/notifications/motivation.ts',
  'src/features/notifications/pushSubscriptionService.ts',
  'src/domain/holidays.ts',
  'src/domain/trackers/invariants.ts',
  'src/domain/trackers/legacyAdapters.ts',
  'src/domain/trackers/planning.test.ts',
  'src/domain/trackers/progression.test.ts',
  'src/domain/trackers/analytics.test.ts',
  'src/domain/trackers/activityStatus.test.ts',
  'src/db/syncConflictRepository.ts',
  'src/db/syncConflictRepository.test.ts',
  'src/db/workspaceBackup.ts',
  'src/db/calendarDate.ts',
  'src/services/supabase/syncEngine.test.ts',
  'src/db/localRepository.ts',
  'src/db/database.ts',
  'src/services/supabase/syncEngine.ts',
  'supabase/migrations/20261008000100_progress_tracker_schema.sql',
  'supabase/migrations/20261009000100_generic_trackers.sql',
  'supabase/migrations/20261009000200_sync_write_boundary.sql',
  'supabase/migrations/20261009000300_goal_planning_v2.sql',
  'supabase/migrations/20261009000400_goal_allocations_v3.sql',
  'supabase/migrations/20261010000100_tracker_bin_permanent_deletion.sql',
  'supabase/migrations/20261011000100_global_holidays.sql',
  'supabase/migrations/20261012000100_tracker_numeric_precision_v4.sql',
  'supabase/migrations/20261016000100_validate_owner_references_immediately.sql',
  'supabase/migrations/20261018000100_tracker_metric_integrity.sql',
  'supabase/migrations/20261019000100_ai_help_assistant.sql',
  'supabase/migrations/20261020000100_ai_help_rate_limit_retention.sql',
  'supabase/migrations/20261021000100_ai_help_provider_rate_limits.sql',
  'supabase/migrations/20261022000100_ai_help_candidate_privacy.sql',
  'supabase/migrations/20261023000100_ai_help_verified_knowledge.sql',
  'supabase/migrations/20261024000100_ai_help_learning_safety.sql',
  'supabase/migrations/20261025000100_ai_help_review_audit.sql',
  'supabase/tests/ai_help_verified_knowledge.test.sql',
  'supabase/functions/ai-help/index.ts',
  'supabase/functions/ai-help/assistantCore.ts',
  'supabase/functions/ai-help/learningCore.ts',
  'supabase/functions/ai-help/learningCore.test.ts',
  'supabase/functions/ai-help/validation.ts',
  'supabase/functions/ai-help-review/index.ts',
  'supabase/functions/ai-help-feedback/index.ts',
  'supabase/functions/ai-help-feedback/feedbackCore.ts',
  'supabase/functions/ai-help-feedback/feedbackCore.test.ts',
  'supabase/migrations/20261028000100_ai_help_answer_feedback.sql',
  'supabase/tests/ai_help_answer_feedback.test.sql',
  'supabase/functions/send-feedback/index.ts',
  'supabase/functions/send-feedback/feedbackCore.ts',
  'supabase/migrations/20261029000100_support_feedback_delivery.sql',
  'supabase/tests/support_feedback_delivery.test.sql',
]
const knowledge = await Promise.all(docs.map(async ([slug, title, path]) => ({
  slug,
  title,
  path,
  content: await readFile(resolve(root, path), 'utf8'),
})))
const knowledgeSections = knowledge.flatMap((document) => {
  const parts = document.content.split(/(?=^##? )/m).map((content) => content.trim()).filter(Boolean)
  return parts.map((content, index) => {
    const heading = content.match(/^#{1,2} (.+)$/m)?.[1] ?? (index === 0 ? 'Overview' : document.title)
    return { slug: document.slug, title: `${document.title}: ${heading}`, path: document.path, section: heading, content: content.slice(0, 3600) }
  })
})
const sourceFiles = await Promise.all(sources.map(async (path) => ({ path, content: await readFile(resolve(root, path), 'utf8') })))
const digest = createHash('sha256').update(JSON.stringify({ knowledge, sourceFiles })).digest('hex').slice(0, 12)
const version = `${packageInfo.version}+${digest}`
const outputDir = resolve(root, 'supabase/functions/ai-help/_generated')
await mkdir(outputDir, { recursive: true })
await writeFile(resolve(outputDir, 'knowledgeBundle.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const knowledgeVersion = ${JSON.stringify(version)}\nexport const knowledgeDocuments = ${JSON.stringify(knowledgeSections)} as const\n`)
const tokens = (text) => [...new Set((text.toLocaleLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map((term) => {
  if (term.length > 5 && term.endsWith('ies')) return `${term.slice(0, -3)}y`
  if (term.length > 4 && term.endsWith('sses')) return term.slice(0, -2)
  if (term.length > 4 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}))]
const sourceIndex = sourceFiles.flatMap(({ path, content }) => {
  // Keep import statements out of the indexed text. Supabase's Edge bundler
  // scans generated TypeScript for imports even when they occur inside data
  // strings; indexing client imports can therefore make it resolve browser-only
  // assets such as `*.css?raw` as Edge modules.
  const lines = sanitizeEvidenceLines(content)
  const declaration = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([\w$]+)/
  const testCase = /^\s*(?:it|test|describe)\s*\(\s*(['"`])(.+?)\1/
  const symbols = lines.map((line, index) => ({ index, name: line.match(declaration)?.[1] ?? line.match(testCase)?.[2] }))
  const result = []
  const windowSize = 14
  const stride = 10
  let symbolIndex = 0
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(lines.length, start + windowSize)
    while (symbolIndex + 1 < symbols.length && symbols[symbolIndex + 1].index <= start) symbolIndex += 1
    const nearest = symbols[symbolIndex]
    const body = lines.slice(start, end).join('\n')
    const symbol = nearest?.name ?? path.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? path
    result.push({ path, symbol, kind: path.includes('.test.') ? 'test' : 'implementation', startLine: start + 1, endLine: end, terms: tokens(`${path} ${symbol} ${body}`).join(' '), content: body })
  }
  return result
})
const evidenceFingerprints = Object.fromEntries([
  ...knowledge.map(({ path, content }) => [path, createHash('sha256').update(content).digest('hex')]),
  ...sourceFiles.map(({ path, content }) => [path, createHash('sha256').update(content).digest('hex')]),
])
await writeFile(resolve(outputDir, 'sourceBundle.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const sourceVersion = ${JSON.stringify(version)}\nexport const sourcePaths = ${JSON.stringify(sources)} as const\nexport const evidenceFingerprints = ${JSON.stringify(evidenceFingerprints)} as const\n`)
await writeFile(resolve(outputDir, 'sourceIndex.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const sourceIndexVersion = ${JSON.stringify(version)}\nexport const sourceIndex = ${JSON.stringify(sourceIndex)} as const\n`)
const supportEmail = sourceFiles.find(({ path }) => path === 'src/config/supportContact.ts')?.content.match(/export const SUPPORT_EMAIL = '([^']+)'/)?.[1]
if (!supportEmail) throw new Error('The public support email is missing from src/config/supportContact.ts.')
const sharedOutputDir = resolve(root, 'supabase/functions/_shared')
await mkdir(sharedOutputDir, { recursive: true })
await writeFile(resolve(sharedOutputDir, 'supportContact.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const PUBLIC_SUPPORT_EMAIL = ${JSON.stringify(supportEmail)}\n`)
console.log(`Built AI help knowledge bundle ${version} (${sourceFiles.length} reviewed files, ${sourceIndex.length} indexed excerpts).`)

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
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
  'src/features/ai-help/capability-definitions.json',
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
  'src/features/shared/TrackerEntryFields.tsx',
  'src/features/today/TodayPage.tsx',
  'src/features/today/TodayPage.test.tsx',
  'src/features/dashboard/DashboardPage.tsx',
  'src/features/dashboard/AchievementsPage.tsx',
  'src/features/dashboard/ProgressionAchievementsPage.tsx',
  'src/features/dashboard/LegacyAchievementsPage.tsx',
  'src/features/dashboard/achievementCatalog.ts',
  'src/features/dashboard/ProgressionBadge.tsx',
  'src/features/dashboard/ProgressionDetailDialog.tsx',
  'src/services/supabase/progressionRepository.ts',
  'src/domain/trackers/progressionModel.ts',
  'src/features/ai-help/AIHelpAssistant.tsx',
  'src/features/ai-help/AIHelpPanel.tsx',
  'src/features/feedback/SendFeedback.tsx',
  'src/features/feedback/MySupportQueries.tsx',
  'src/features/feedback/feedbackService.ts',
  'src/features/ai-help/aiHelpService.ts',
  'src/features/ai-knowledge/aiKnowledgeApi.ts',
  'src/features/ai-knowledge/aiKnowledgeApi.test.ts',
  'src/features/ai-knowledge/AIKnowledgePage.tsx',
  'src/features/ai-knowledge/AIKnowledgePage.test.tsx',
  'src/features/ai-knowledge/knowledgePagination.test.ts',
  'src/features/ai-knowledge/AnswerFeedbackWorkspace.tsx',
  'src/features/ai-knowledge/SupportInboxWorkspace.tsx',
  'src/features/feedback/supportApi.ts',
  'src/features/history/HistoryPage.tsx',
  'src/features/history/HistoryPage.test.tsx',
  'src/features/analytics/AnalyticsPage.tsx',
  'src/features/analytics/AnalyticsPage.test.tsx',
  'src/features/goals/GoalsPage.tsx',
  'src/features/goals/GoalsPage.test.tsx',
  'src/features/trackers/TrackerLibraryPage.tsx',
  'src/features/trackers/TrackerBinPage.tsx',
  'src/domain/trackers/schemaVersionGate.ts',
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
  'src/features/notifications/capabilities.ts',
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
  'supabase/migrations/20261027000100_account_deletion_password_authorization.sql',
  'supabase/migrations/20261009000300_goal_planning_v2.sql',
  'supabase/migrations/20261009000400_goal_allocations_v3.sql',
  'supabase/migrations/20261010000100_tracker_bin_permanent_deletion.sql',
  'supabase/migrations/20261104001500_guard_tracker_deletion_with_progression_history.sql',
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
  'supabase/migrations/20261026000100_ai_help_rate_limit_rpc_refresh.sql',
  'supabase/migrations/20261030000200_unified_feedback_support.sql',
  'supabase/migrations/20261030000300_support_feedback_email_consent.sql',
  'supabase/migrations/20261030000400_tracker_archived_entry_guard.sql',
  'supabase/tests/ai_help_verified_knowledge.test.sql',
  'supabase/functions/ai-help/index.ts',
  'supabase/functions/ai-help/assistantCore.ts',
  'supabase/functions/ai-help/capabilityCore.ts',
  'supabase/functions/ai-help/capabilityCore.test.ts',
  'supabase/functions/ai-help/learningCore.ts',
  'supabase/functions/ai-help/learningCore.test.ts',
  'supabase/functions/ai-help/validation.ts',
  'supabase/functions/ai-help-review/index.ts',
  'supabase/functions/_shared/knowledgePagination.ts',
  'supabase/functions/ai-help-feedback/index.ts',
  'supabase/functions/ai-help-feedback/feedbackCore.ts',
  'supabase/functions/ai-help-feedback/feedbackCore.test.ts',
  'supabase/functions/support-inbox/index.ts',
  'supabase/functions/support-inbox/supportInboxCore.ts',
  'supabase/functions/support-inbox/supportInboxCore.test.ts',
  'supabase/migrations/20261028000100_ai_help_answer_feedback.sql',
  'supabase/tests/ai_help_answer_feedback.test.sql',
  'supabase/tests/ai_answer_feedback_routing.test.sql',
  'supabase/tests/support_feedback_status.test.sql',
  'supabase/migrations/20261031000100_route_ai_answer_feedback_separately.sql',
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
const catalogDir = resolve(root, 'docs/ai-help/knowledge')
const catalogFiles = (await readdir(catalogDir)).filter((name) => name.endsWith('.md')).sort()
const allowedCategories = new Set(['getting-started', 'trackers', 'check-ins', 'streaks', 'statistics', 'history', 'holidays', 'goals', 'calendar', 'notifications', 'accounts-sync', 'settings-privacy', 'ai-help', 'insights'])
const catalog = []
const field = (block, label) => {
  const match = block.match(new RegExp(`\\*\\*${label}:\\*\\*[ \\t]*\\n([\\s\\S]*?)(?=\\n\\*\\*[A-Z][A-Za-z ]+:\\*\\*|$)`))
  return match?.[1]?.trim() ?? ''
}
for (const name of catalogFiles) {
  const path = `docs/ai-help/knowledge/${name}`
  const content = await readFile(resolve(root, path), 'utf8')
  if (/TODO|TBD|PLACEHOLDER|lorem ipsum/i.test(content)) throw new Error(`${path} contains an unresolved placeholder.`)
  const blocks = content.split(/(?=^### ID: )/m).slice(1)
  const declaredEntries = content.match(/^### ID:/gm)?.length ?? 0
  if (!blocks.length || declaredEntries !== blocks.length || !content.trimStart().startsWith('# ') || /^### (?!ID: )/m.test(content)) throw new Error(`${path} has malformed or no parseable knowledge entries.`)
  for (const block of blocks) {
    const labels = [...block.matchAll(/^\*\*([A-Z][A-Za-z ]+):\*\*/gm)].map((match) => match[1])
    const expectedLabels = ['Category', 'Question', 'Aliases', 'Keywords', 'Suggestible', 'Sources', 'Answer']
    if (labels.length !== expectedLabels.length || expectedLabels.some((label) => labels.filter((item) => item === label).length !== 1) || labels.some((label) => !expectedLabels.includes(label))) throw new Error(`${path} contains an unknown, duplicate, or missing field.`)
    const id = block.match(/^### ID: ([a-z0-9]+(?:-[a-z0-9]+)*)$/m)?.[1]
    const category = block.match(/^\*\*Category:\*\* ([a-z-]+)$/m)?.[1]
    const question = block.match(/^\*\*Question:\*\* (.+)$/m)?.[1]?.trim()
    const aliasLines = field(block, 'Aliases').split('\n').filter(Boolean)
    const sourceLines = field(block, 'Sources').split('\n').filter(Boolean)
    if (aliasLines.some((line) => !/^-\s+\S/.test(line)) || sourceLines.some((line) => !/^-\s+\S/.test(line))) throw new Error(`${path} contains malformed alias or source lists.`)
    const aliases = aliasLines.map((line) => line.replace(/^-\s+/, '').trim())
    const sources = sourceLines.map((line) => line.replace(/^-\s+/, '').trim())
    const answer = field(block, 'Answer')
    const keywords = block.match(/^\*\*Keywords:\*\* (.+)$/m)?.[1]?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
    const suggestible = block.match(/^\*\*Suggestible:\*\* (true|false)$/m)?.[1]
    if (!id || !category || !question || !allowedCategories.has(category) || !answer || !keywords.length || !sources.length || !suggestible) throw new Error(`${path} contains a malformed entry near ${id ?? 'unknown id'}.`)
    if (aliases.some((alias) => !alias || alias.length > 180) || new Set(aliases).size !== aliases.length) throw new Error(`${id} has invalid or duplicate aliases.`)
    for (const source of sources) {
      const absolute = resolve(root, source)
      if (!absolute.startsWith(`${root}/`) || !/^(?:src|supabase)\//.test(source)) throw new Error(`${id} has an invalid source path ${source}.`)
      await readFile(absolute, 'utf8').catch(() => { throw new Error(`${id} references missing source ${source}.`) })
    }
    if (/\b(?:internal filename|TypeScript type)\b/i.test(answer)) throw new Error(`${id} exposes an internal-only phrase in its answer.`)
    catalog.push({ id, category, question, aliases, keywords, suggestible: suggestible === 'true', sources, answer })
  }
}
for (const ref of new Set(catalog.flatMap(({ sources }) => sources))) if (!sources.includes(ref)) sources.push(ref)
const uniqueCheck = (key, label) => { const values = catalog.map((entry) => entry[key].toLocaleLowerCase()); if (new Set(values).size !== values.length) throw new Error(`Knowledge catalog has duplicate ${label}.`) }
uniqueCheck('id', 'IDs'); uniqueCheck('question', 'canonical questions')
if (new Set(catalog.map(({ id }) => id)).size !== catalog.length) throw new Error('Knowledge catalog has duplicate IDs.')
const prompts = new Map()
for (const entry of catalog) for (const prompt of [entry.question, ...entry.aliases]) {
  const normalized = prompt.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const prior = prompts.get(normalized)
  if (prior && prior !== entry.id) throw new Error(`Question or alias "${prompt}" is duplicated by ${prior} and ${entry.id}.`)
  prompts.set(normalized, entry.id)
}
const knowledgeSections = knowledge.flatMap((document) => {
  const parts = document.content.split(/(?=^##? )/m).map((content) => content.trim()).filter(Boolean)
  return parts.map((content, index) => {
    const heading = content.match(/^#{1,2} (.+)$/m)?.[1] ?? (index === 0 ? 'Overview' : document.title)
    return { slug: document.slug, title: `${document.title}: ${heading}`, path: document.path, section: heading, content: content.slice(0, 3600) }
  })
})
const sourceFiles = await Promise.all(sources.map(async (path) => ({ path, content: await readFile(resolve(root, path), 'utf8') })))
const reviewManifestPath = resolve(root, 'docs/ai-help/knowledge-review.json')
const currentReview = Object.fromEntries(catalog.map((entry) => [entry.id, Object.fromEntries(entry.sources.map((path) => {
  const file = sourceFiles.find(({ path: candidate }) => candidate === path)
  if (!file) throw new Error(`${entry.id} source ${path} is not included in the source bundle.`)
  return [path, createHash('sha256').update(file.content).digest('hex')]
}))]))
const refreshReview = process.argv.includes('--refresh-knowledge-review')
if (refreshReview) await writeFile(reviewManifestPath, `${JSON.stringify(currentReview, null, 2)}\n`)
else {
  const reviewed = JSON.parse(await readFile(reviewManifestPath, 'utf8').catch(() => '{}'))
  const stale = catalog.flatMap((entry) => Object.entries(currentReview[entry.id] ?? {}).filter(([path, digest]) => reviewed[entry.id]?.[path] !== digest).map(([path]) => `${entry.id} (${path})`))
  if (stale.length) throw new Error(`Verified knowledge needs source review before generation: ${[...new Set(stale)].join(', ')}. Re-check the answers, then run with --refresh-knowledge-review.`)
}
if (new Set(sources).size !== sources.length) throw new Error('The reviewed source manifest contains duplicate paths.')
const sourcePathSet = new Set(sources)
const relationshipSets = new Map(sources.map((path) => [path, new Set()]))
const importedPath = (fromPath, specifier) => {
  if (!specifier.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier.split('?')[0]))
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.sql'].map((extension) => `${base}${extension}`), ...['index.ts', 'index.tsx', 'index.js'].map((name) => `${base}/${name}`)]
  return candidates.find((candidate) => sourcePathSet.has(candidate)) ?? null
}
for (const { path, content } of sourceFiles) {
  const links = relationshipSets.get(path)
  for (const match of content.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gs)) {
    const target = importedPath(path, match[1])
    if (target && target !== path) {
      links.add(target)
      relationshipSets.get(target)?.add(path)
    }
  }
}
// Add compact links between SQL RPC definitions and their client/server call
// sites. These references are extracted from executable identifiers, not prose.
const sqlFunctions = sourceFiles.flatMap(({ path, content }) => [...content.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([\w$]+)/gi)].map((match) => ({ path, name: match[1] })))
for (const definition of sqlFunctions) {
  const identifier = new RegExp(`\\b${definition.name.replace(/[$]/g, '\\$')}\\b`, 'i')
  for (const candidate of sourceFiles) {
    if (candidate.path === definition.path || !identifier.test(candidate.content)) continue
    if (candidate.path.endsWith('.sql') && !/create\s+(?:or\s+replace\s+)?function/i.test(candidate.content)) continue
    relationshipSets.get(definition.path)?.add(candidate.path)
    relationshipSets.get(candidate.path)?.add(definition.path)
  }
}
const sourceRelationships = Object.fromEntries([...relationshipSets].map(([path, related]) => [path, [...related].sort()]))
const routerSource = sourceFiles.find(({ path }) => path === 'src/routes/router.tsx')?.content ?? ''
const declaredRoutes = [...routerSource.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((match) => match[1])
const routePaths = [...new Set(['/', ...declaredRoutes.filter((path) => path !== '/').map((path) => `/${path}`)])]
const routes = Object.fromEntries(routePaths.map((path) => [path.replace(/^\//, '').replaceAll('/', '.') || 'today', path]))
const appShellSource = sourceFiles.find(({ path }) => path === 'src/app/AppShell.tsx')?.content ?? ''
const indexedRoutePaths = new Set(Object.values(routes))
for (const match of appShellSource.matchAll(/<NavLink\s+to="(\/[^"]*)"/g)) {
  if (!indexedRoutePaths.has(match[1])) throw new Error(`App navigation path ${match[1]} is absent from the router-derived capability index.`)
}
const edgeSource = sourceFiles.find(({ path }) => path === 'supabase/functions/ai-help/index.ts')?.content ?? ''
for (const match of edgeSource.matchAll(/href:\s*'(\/[^']*)'/g)) {
  if (!indexedRoutePaths.has(match[1])) throw new Error(`AI Help link path ${match[1]} is absent from the router-derived capability index.`)
}
const capabilitySource = sourceFiles.find(({ path }) => path === 'src/features/ai-help/capability-definitions.json')?.content ?? '[]'
const declaredCapabilities = JSON.parse(capabilitySource)
for (const capability of declaredCapabilities) {
  if (!Array.isArray(capability.evidenceRefs) || capability.evidenceRefs.some((ref) => !sources.includes(ref))) {
    throw new Error(`AI Help capability ${capability.id} references a file outside the reviewed source bundle.`)
  }
  if (capability.routeId && !(capability.routeId in routes)) throw new Error(`AI Help capability ${capability.id} references a route absent from src/routes/router.tsx.`)
  if (['control', 'workflow'].includes(capability.kind)) {
    const colocated = capability.evidenceRefs.map((ref) => sourceFiles.find(({ path }) => path === ref)?.content ?? '')
    const marker = `data-ai-capability="${capability.id}"`
    const quotedId = `'${capability.id}'`
    if (!colocated.some((content) => content.includes(marker) || content.includes(quotedId))) {
      throw new Error(`AI Help capability ${capability.id} has no matching marker in its referenced implementation.`)
    }
  }
}
const capabilities = [
  ...Object.entries(routes).map(([routeId, path]) => ({ id: `route.${routeId}`, featureId: routeId.split('.')[0] ?? routeId, kind: 'route', label: routeId === 'today' ? 'Today' : routeId.split('.').at(-1), routeId, risk: 'low', availability: 'unknown', availabilityConditions: [], prerequisites: [], limitations: [], evidenceRefs: ['src/routes/router.tsx'] })),
  ...declaredCapabilities,
]
const binPage = sourceFiles.find(({ path }) => path === 'src/features/trackers/TrackerBinPage.tsx')?.content ?? ''
const binRoute = sourceFiles.find(({ path }) => path === 'src/routes/router.tsx')?.content ?? ''
const binNavigation = sourceFiles.find(({ path }) => path === 'src/app/AppShell.tsx')?.content ?? ''
const deletionGate = sourceFiles.find(({ path }) => path === 'src/domain/trackers/schemaVersionGate.ts')?.content ?? ''
const deletionMigration = sourceFiles.find(({ path }) => path === 'supabase/migrations/20261010000100_tracker_bin_permanent_deletion.sql')?.content ?? ''
const coreGuide = knowledge.find(({ slug }) => slug === 'core-application')?.content ?? ''
if (!binPage.includes('Permanent deletion isn’t available in this app version.')
  || !binPage.includes('isPermanentDeletionEnabled()')
  || !binRoute.includes("path: 'bin'") || !binNavigation.includes("to: '/bin'")
  || !deletionGate.includes('VITE_ENABLE_PERMANENT_DELETION')
  || !deletionMigration.includes("values (true, false)")
  || !/hosted manual deletion RPC and its permissions have been verified/i.test(coreGuide)
  || !/automatic cleanup is not configured because `pg_cron` is not installed/i.test(coreGuide)
  || /Permanent deletion is a separate action that removes the tracker/i.test(coreGuide)) {
  throw new Error('AI Help Bin availability guidance must be reviewed against the route, visible UI gate, production feature flag, and cleanup migration before generating the bundle.')
}
const digest = createHash('sha256').update(JSON.stringify({ knowledge, catalog, sourceFiles, capabilities, routes, sourceRelationships, sourceIndexFormat: 3 })).digest('hex').slice(0, 12)
const version = `${packageInfo.version}+${digest}`
const outputDir = resolve(root, 'supabase/functions/ai-help/_generated')
await mkdir(outputDir, { recursive: true })
await writeFile(resolve(outputDir, 'knowledgeBundle.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const knowledgeVersion = ${JSON.stringify(version)}\nexport const knowledgeDocuments = ${JSON.stringify(knowledgeSections)} as const\nexport const verifiedQuestionCatalog = ${JSON.stringify(catalog)} as const\n`)
const frontendCatalogPath = resolve(root, 'src/features/ai-help/_generated/verifiedQuestionCatalog.ts')
await mkdir(dirname(frontendCatalogPath), { recursive: true })
await writeFile(frontendCatalogPath, `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const verifiedQuestionCatalogVersion = ${JSON.stringify(version)}\nexport const verifiedQuestionCatalog = ${JSON.stringify(catalog)} as const\n`)
const tokens = (text) => [...new Set((text
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  .replace(/[_./-]+/g, ' ')
  .toLocaleLowerCase().match(/[a-z0-9]{3,}/g) ?? []).map((raw) => {
  let term = raw
  if (term.length > 5 && term.endsWith('ued')) term = term.slice(0, -1)
  else if (term.length > 5 && term.endsWith('ies')) term = `${term.slice(0, -3)}y`
  else if (term.length > 4 && term.endsWith('sses')) term = term.slice(0, -2)
  else if (term.length > 5 && term.endsWith('ed')) {
    term = term.slice(0, -2)
    if (/[bcdfghjklmnpqrstvwxz]$/.test(term) && !term.endsWith('t') && !term.endsWith('d')) term += 'e'
  } else if (term.length > 5 && term.endsWith('ing')) {
    term = term.slice(0, -3)
    if (/(.)\1$/.test(term)) term = term.slice(0, -1)
  } else if (term.length > 4 && term.endsWith('s') && !term.endsWith('ss')) term = term.slice(0, -1)
  return term
}))]
const sourceIndex = sourceFiles.flatMap(({ path, content }) => {
  // Keep import statements out of the indexed text. Supabase's Edge bundler
  // scans generated TypeScript for imports even when they occur inside data
  // strings; indexing client imports can therefore make it resolve browser-only
  // assets such as `*.css?raw` as Edge modules.
  const lines = sanitizeEvidenceLines(content)
  const declaration = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([\w$]+)/
  const sqlFunction = /^\s*create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([\w$]+)/i
  const testCase = /^\s*(?:it|test|describe)\s*\(\s*(['"`])(.+?)\1/
  const symbols = lines.map((line, index) => ({ index, name: line.match(declaration)?.[1] ?? line.match(sqlFunction)?.[1] ?? line.match(testCase)?.[2] }))
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
await writeFile(resolve(outputDir, 'sourceBundle.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const sourceVersion = ${JSON.stringify(version)}\nexport const sourcePaths = ${JSON.stringify(sources)} as const\nexport const sourceRelationships = ${JSON.stringify(sourceRelationships)} as const\nexport const evidenceFingerprints = ${JSON.stringify(evidenceFingerprints)} as const\n`)
await writeFile(resolve(outputDir, 'sourceIndex.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const sourceIndexVersion = ${JSON.stringify(version)}\nexport const sourceIndex = ${JSON.stringify(sourceIndex)} as const\n`)
await writeFile(resolve(outputDir, 'capabilityBundle.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const capabilityVersion = ${JSON.stringify(version)}\nexport const capabilityRoutes = ${JSON.stringify(routes)} as const\nexport const capabilities = ${JSON.stringify(capabilities)} as const\n`)
await writeFile(resolve(root, 'src/features/ai-help/capabilityVersion.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const capabilityVersion = ${JSON.stringify(version)}\n`)
const supportEmail = sourceFiles.find(({ path }) => path === 'src/config/supportContact.ts')?.content.match(/export const SUPPORT_EMAIL = '([^']+)'/)?.[1]
if (!supportEmail) throw new Error('The public support email is missing from src/config/supportContact.ts.')
const sharedOutputDir = resolve(root, 'supabase/functions/_shared')
await mkdir(sharedOutputDir, { recursive: true })
await writeFile(resolve(sharedOutputDir, 'supportContact.ts'), `// Generated by scripts/build-ai-help-bundle.mjs. Do not edit by hand.\nexport const PUBLIC_SUPPORT_EMAIL = ${JSON.stringify(supportEmail)}\n`)
console.log(`Built AI help knowledge bundle ${version} (${sourceFiles.length} reviewed files, ${sourceIndex.length} indexed excerpts).`)

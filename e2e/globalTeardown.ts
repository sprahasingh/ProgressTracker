import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'

const container = process.env.PROGRESSION_TEST_DB_CONTAINER ?? 'supabase_db_progression-live-api-isolated-20261014'
const fixturePath = process.env.PROGRESSION_TEST_FIXTURE_PATH ?? '/private/tmp/progression-playwright-auth.json'
type FixtureKey = 'primary' | 'retrospective'
const fixtureEmails: Partial<Record<FixtureKey, string>> = {
  primary: 'browser-achievement-e2e@progress-tracker.invalid',
  ...(process.env.PROGRESSION_RULE_HISTORY_PROJECT_ID ? { retrospective: 'browser-rule-history-retrospective@progress-tracker.invalid' } : {}),
}

function sql(query: string): string {
  return execFileSync('docker', ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', query], { encoding: 'utf8', timeout: 8_000, stdio: 'pipe' }).trim()
}

export default async function globalTeardown() {
  let cleaned = false
  try {
    let fixture: { users?: Partial<Record<keyof typeof fixtureEmails, { userId?: string; email?: string }>> }
    try {
      fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { userId?: string; email?: string }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    const expectedKeys = Object.keys(fixtureEmails).sort()
    const actualKeys = Object.keys(fixture.users ?? {}).sort()
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error(`Preserved the fixture at ${fixturePath}; account slots do not match this suite's exact allowlist.`)
    const users = (Object.keys(fixtureEmails) as FixtureKey[]).map((key) => {
      const user = fixture.users?.[key]
      if (!user || user.email !== fixtureEmails[key] || !user.userId || !/^[0-9a-f-]{36}$/i.test(user.userId)) {
        throw new Error(`Preserved the fixture at ${fixturePath}; its ${key} user does not match the exact disposable-account allowlist.`)
      }
      return { userId: user.userId, email: fixtureEmails[key] }
    })
    if (new Set(users.map(({ userId }) => userId)).size !== users.length) throw new Error(`Preserved the fixture at ${fixturePath}; disposable account IDs are not unique.`)
    if (users.length === Object.keys(fixtureEmails).length) {
      const deleteConditions = users.map(({ userId, email }) => `(id='${userId}' AND email='${email}')`).join(' OR ')
      const deleteAccount = `DELETE FROM auth.users WHERE ${deleteConditions};`
      const activeRefreshes = `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND pid<>pg_backend_pid() AND query ILIKE '%refresh_my_progression_qualification_progress%';`
      let drained = false
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (sql(activeRefreshes) === '0') {
          drained = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!drained) throw new Error(`A progression refresh is still active after 7.5s; preserved the disposable fixture record at ${fixturePath} rather than racing its account deletion.`)
      let lastError: unknown
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          execFileSync('docker', ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', deleteAccount], { encoding: 'utf8', timeout: 8_000, stdio: 'pipe' })
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          const message = error instanceof Error ? `${error.message}\n${'stderr' in error ? String(error.stderr) : ''}` : String(error)
          const transient = /deadlock detected|timed out|ETIMEDOUT|connection refused|database system is starting up/i.test(message)
          if (!transient || attempt === 3) throw error
          await new Promise((resolve) => setTimeout(resolve, attempt * 500))
        }
      }
      if (lastError) throw lastError
      cleaned = true
      process.stdout.write(`Removed only the ${users.length} named disposable browser Auth accounts from the isolated database.\n`)
    }
  } finally {
    if (cleaned) await rm(fixturePath, { force: true })
  }
}

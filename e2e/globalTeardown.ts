import { execFileSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'

const container = process.env.PROGRESSION_TEST_DB_CONTAINER ?? 'supabase_db_progression-live-api-isolated-20261014'
const fixturePath = '/private/tmp/progression-playwright-auth.json'
const email = 'browser-achievement-e2e@progress-tracker.invalid'

export default async function globalTeardown() {
  try {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { userId?: string; email?: string }
    if (fixture.email === email && fixture.userId && /^[0-9a-f-]{36}$/i.test(fixture.userId)) {
      const deleteAccount = `DELETE FROM auth.users WHERE id='${fixture.userId}' AND email='${email}';`
      let lastError: unknown
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          execFileSync('docker', ['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', deleteAccount], { encoding: 'utf8', timeout: 90_000, stdio: 'pipe' })
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          const message = error instanceof Error ? `${error.message}\n${'stderr' in error ? String(error.stderr) : ''}` : String(error)
          if (!message.includes('deadlock detected') || attempt === 4) throw error
          await new Promise((resolve) => setTimeout(resolve, attempt * 500))
        }
      }
      if (lastError) throw lastError
      process.stdout.write('Removed the named disposable browser Auth account from the isolated database.\n')
    }
  } finally {
    await rm(fixturePath, { force: true })
  }
}

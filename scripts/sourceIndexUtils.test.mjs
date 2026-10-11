import { describe, expect, it } from 'vitest'
import { sanitizeEvidenceLines } from './sourceIndexUtils.mjs'

describe('AI Help source evidence import sanitizing', () => {
  it('removes import declarations and dynamic import expressions from embedded source excerpts', () => {
    const source = [
      "import { thing } from './thing.ts'",
      "const panel = lazy(() => import('./Panel.tsx'))",
      "type Result = import('./types.ts').Result",
      'export function answer() { return 42 }',
    ].join('\n')
    const sanitized = sanitizeEvidenceLines(source).join('\n')
    expect(sanitized).not.toMatch(/\bimport\s*(?:\(|\{)/)
    expect(sanitized).toContain('export function answer()')
  })
})

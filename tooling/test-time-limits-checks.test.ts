/** `test-limits/scaled-by-slow` finds a time limit a test sets for itself that Windows would not get three times of (#845, #1602). */
import { describe, expect, it } from 'vitest'
import { guardLinter } from './eslint-virtual.test-helpers.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { EXCEPTIONS } from './eslint-test-time-limits.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const eslint = guardLinter()

async function reported(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath), warnIgnored: false })
  return (result?.messages ?? []).filter((message) => message.ruleId === 'test-limits/scaled-by-slow').map((message) => `${message.line}`)
}
const inTest = (code: string) => reported('packages/agent-host/src/x.test.ts', code)

describe('a time limit a test sets for itself', () => {
  it('is found in each place one can be given', async () => {
    const code = [
      "it('a', () => {}, 30_000)",
      "it('b', { timeout: 10_000 }, async () => {})",
      "it.each([1])('c', () => {}, 20_000)",
      'beforeAll(() => {}, 60_000)',
      "it('d', () => {}, 30_000 * SLOW)",
      "it('e', () => { setTimeout(() => {}, 20) })",
    ].join('\n')
    expect(await inTest(code)).toEqual(['1', '2', '3', '4'])
  })

  it.each([
    ['a test given a limit', "it('a', () => {}, 30_000)"],
    ['a test skipped on a platform', "it.skipIf(win)('a', () => {}, 30_000)"],
    ['a test in a table', "it.each([1])('a', () => {}, 30_000)"],
    ['a test given an options object', "test('a', { timeout: 10_000 }, () => {})"],
    ['a quoted timeout key', "test('a', { 'timeout': 10_000 }, () => {})"],
    ['a suite given a limit', "describe('a', () => {}, 30_000)"],
    ['a hook', 'afterEach(() => {}, 60_000)'],
    ['a function expression test', "it('a', function () {}, 30_000)"],
    ['a name holding an unscaled limit, where it is used', "const LIMIT = 30_000\nit('a', () => {}, LIMIT)"],
    ['a name holding a name holding an unscaled limit', "const A = 30_000\nconst B = A\nit('a', () => {}, B)"],
    ['a limit that multiplies by something else', "it('a', () => {}, 30_000 * FACTOR)"],
    ['a whole file', 'vi.setConfig({ testTimeout: 30_000 })'],
    ['a whole file hooks', 'vitest.setConfig({ hookTimeout: 30_000 })'],
    ['a wait with a number', 'await vi.waitFor(() => ok, 3_000)'],
    ['a wait with options', 'await vi.waitFor(() => ok, { timeout: 3_000 })'],
    ['waiting until', 'await vi.waitUntil(() => ok, 3_000)'],
    ['polling', 'await expect.poll(() => ok, { timeout: 3_000 }).toBe(1)'],
  ])('is reported: %s', async (_place, code) => {
    const line = code.split('\n').length
    expect(await inTest(code)).toEqual([`${line}`])
  })

  it.each([
    ['a test scaled by SLOW', "it('a', () => {}, 30_000 * SLOW)"],
    ['a timeout scaled by SLOW', "it('a', { timeout: 10_000 * SLOW }, () => {})"],
    ['a whole file scaled by SLOW', 'vi.setConfig({ testTimeout: 30_000 * SLOW })'],
    ['a wait scaled by SLOW', 'await vi.waitFor(() => ok, { timeout: 3_000 * SLOW })'],
    ['a name holding a scaled limit', "const LIMIT = 30_000 * SLOW\nit('a', () => {}, LIMIT)"],
    ['a name holding a name holding a scaled limit', "const A = 30_000 * SLOW\nconst B = A\nit('a', () => {}, B)"],
    ['a timeout key holding a scaled name', "const LIMIT = 10_000 * SLOW\nit('a', { timeout: LIMIT }, () => {})"],
    ['a test with no limit', "it('a', () => {})"],
    ['a timer inside a test', "it('a', () => { setTimeout(() => {}, 20) })"],
    ['a wait with no limit', 'await vi.waitFor(() => ok)'],
    ['a setConfig of something else', 'vi.setConfig({ retry: 2 })'],
    ['a timeout of a call that is no runner', 'fetch(url, { timeout: 5_000 })'],
    ['a test with a data argument after its function', "it('a', () => {}, { retry: 2 })"],
  ])('is not reported, and the unscaled limit after it is: %s', async (_place, code) => {
    // The second line keeps this from passing for want of a rule at all
    expect(await inTest(`${code}\nit('b', () => {}, 30_000)`)).toEqual([`${code.split('\n').length + 1}`])
  })

  it('is read in the files the unit test read, and in no others', async () => {
    const code = "it('a', () => {}, 30_000)\n"
    const files = ['packages/agent-host/src/x.test.ts', 'packages/ui/src/x.test.tsx', 'tooling/x.test.ts', 'tooling/fixtures/x.test.ts', 'e2e/x.spec.ts', 'scripts/x.mjs', 'packages/ui/src/x.ts']
    const found = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await reported(file, code)] as const)))
    expect(found).toEqual({
      'packages/agent-host/src/x.test.ts': ['1'],
      'packages/ui/src/x.test.tsx': ['1'],
      'tooling/x.test.ts': ['1'],
      'tooling/fixtures/x.test.ts': ['1'],
      'e2e/x.spec.ts': [],
      'scripts/x.mjs': [],
      'packages/ui/src/x.ts': [],
    })
  })

  it('cannot be switched off by a comment: the pass reads none as configuration', async () => {
    const code = ['// eslint-disable-next-line test-limits/scaled-by-slow', "it('a', () => {}, 30_000)", '/* eslint test-limits/scaled-by-slow: off */', "it('b', () => {}, 30_000)"].join('\n')
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, 'packages/agent-host/src/x.test.ts'), warnIgnored: false })
    expect(result?.messages.filter((m) => m.ruleId === 'test-limits/scaled-by-slow').map((m) => m.line)).toEqual([2, 4])
    expect(result?.suppressedMessages).toEqual([])
  })

  it('has no exceptions, and each one added later names its file and its reason', () => {
    // A ceiling: it is lowered when a line goes, never raised (#1602)
    expect(Object.keys(EXCEPTIONS).length).toBeLessThanOrEqual(0)
    const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'))
    for (const [file, reason] of Object.entries(EXCEPTIONS)) {
      expect(tracked.has(file), `${file} is a tracked file`).toBe(true)
      expect(String(reason).length, `${file} says why`).toBeGreaterThan(10)
    }
  })
})

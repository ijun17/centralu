import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, so pre-pr and the board can run it with Node alone
import { NEW_TEST_TIER, plainNewTest, RULES_FILE, tierOfChange } from '../scripts/tier.mjs'

/**
 * A new test file of plain tests is at most light, whatever path rule or subject would make it deep (#2563): a new check
 * weakens no boundary. Judged by its syntax. An edit to a test file there was, and any helpers file, keep their tier: a line
 * slipped into a test, or a hook or mock added above it, weakens it without removing a line (the review of #2586 found 21
 * such edits that a line check let through; each is a case below).
 */

const PLAIN = "import { describe, it, expect } from 'vitest'\nimport { x } from './x.js'\n\nit('one', () => {\n  expect(x).toBe(1)\n})\ndescribe('s', () => {\n  it('two', () => {\n    const y = [x].map((v) => v * 2)\n    expect(y).toEqual([2])\n  })\n})\n"
const withTest = (body: string) => `import { it, expect } from 'vitest'\n\nit('one', () => {\n${body}\n})\n`
const judge = (path: string, text: string) => plainNewTest(path, text, ts)

describe('a new test file of plain tests (#2563)', () => {
  it.each([
    ['tests and suites with imports that bind names', 'a.test.ts', PLAIN],
    ['a test that names test rather than it', 'a.test.ts', "import { test, expect } from 'vitest'\ntest('one', () => {\n  expect(1).toBe(1)\n})\n"],
    ['another code language', 'a.test.mjs', "import { it } from 'vitest'\nit('x', () => {})\n"],
    ['async tests and a value made inside them', 'a.test.ts', "import { it, expect } from 'vitest'\nit('one', async () => {\n  const v = await Promise.resolve(1)\n  expect(v).toBe(1)\n})\n"],
  ])('counts %s', (_, path, text) => {
    expect(judge(path, text)).toBe(true)
  })

  it.each([
    // What the reach of a test's own values is: the process, the global object, mocks, hooks
    ['a vi.mock', "import { it, vi } from 'vitest'\nvi.mock('./x.js', () => ({}))\nit('one', () => {})\n"],
    ['a vi.mock called inside a test', "import { it, vi } from 'vitest'\nit('one', () => {\n  vi.doMock('./x.js')\n})\n"],
    ['a spy that changes what a module returns', withTest("  vi.spyOn(Math, 'random').mockReturnValue(0)")],
    ['a hook that stubs the environment', "import { it, beforeEach, vi } from 'vitest'\nbeforeEach(() => vi.stubEnv('X', '1'))\nit('one', () => {})\n"],
    ['a hook inside a suite', "import { describe, it, afterEach } from 'vitest'\ndescribe('s', () => {\n  afterEach(() => {})\n  it('one', () => {})\n})\n"],
    ['a test that sets the global object', withTest('  globalThis.fetch = () => null')],
    ['a test that sets the environment', withTest("  process.env.X = '1'")],
    ['Object.assign onto the global object', withTest('  Object.assign(globalThis, { x: 1 })')],
    ['fake timers', withTest('  vi.useFakeTimers()')],
    // What makes a test not run as a plain one
    ['describe.skip by name', "import { describe, it } from 'vitest'\ndescribe['skip']('s', () => {\n  it('one', () => {})\n})\n"],
    ['a computed member of it', "import { it } from 'vitest'\nconst s = 'skip'\nit[s]('one', () => {})\n"],
    ['it.fails', "import { it } from 'vitest'\nit.fails('one', () => {})\n"],
    ['it.concurrent', "import { it } from 'vitest'\nit.concurrent('one', () => {})\n"],
    ['it.each over nothing', "import { it } from 'vitest'\nit.each([])('one', () => {})\n"],
    ['it.skip inside a suite', "import { describe, it } from 'vitest'\ndescribe('s', () => {\n  it.skip('one', () => {})\n})\n"],
    ['it.only', "import { it } from 'vitest'\nit.only('one', () => {})\n"],
    // What reaches past the file
    ['a shared fixture written on disk', "import { it } from 'vitest'\nimport { writeFileSync } from 'node:fs'\nit('one', () => {\n  writeFileSync('fixture.json', '{}')\n})\n"],
    ['a file written through a namespace', "import { it } from 'vitest'\nimport * as fs from 'node:fs'\nit('one', () => {\n  fs.writeFileSync('fixture.json', '{}')\n})\n"],
    ['a process started', "import { it } from 'vitest'\nimport { execFileSync } from 'node:child_process'\nit('one', () => {\n  execFileSync('git', ['push'])\n})\n"],
    ['an import run for its effects', "import './setup.js'\nimport { it } from 'vitest'\nit('one', () => {})\n"],
    ['a module imported at run time', withTest("  void import('./x.js')")],
    ['a top-level statement that is not a test', "import { it } from 'vitest'\nconst n = 1\nit('one', () => {})\n"],
    ['a file that does not parse', "import { it } from 'vitest'\nit('one', () => {\n"],
    // What is not a new test file
    ['a helpers file', 'HELPERS'],
    ['a Playwright spec', 'SPEC'],
  ])('does not count %s', (_, text) => {
    const path = text === 'HELPERS' ? 'a.test-helpers.ts' : text === 'SPEC' ? 'a.spec.ts' : 'a.test.ts'
    expect(judge(path, text === 'HELPERS' || text === 'SPEC' ? PLAIN : text)).toBe(false)
  })

  it('counts nothing without the typescript package', () => {
    expect(plainNewTest('a.test.ts', PLAIN, null)).toBe(false)
  })
})

describe('pnpm tier with tests under a deep path (#2563)', () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C' }
  const REAL_TYPESCRIPT = createRequire(import.meta.url).resolve('typescript')
  const BASE = withTest('  expect(1).toBe(1)')
  let repo = ''
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim()
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const change = (edits: Record<string, string>) => {
    for (const [path, text] of Object.entries(edits)) write(path, text)
    git('add', '-A')
    git('commit', '-q', '-m', 'change')
    return tierOfChange({ root: repo, base: 'main', head: 'top' })
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-tier-new-tests-'))
    git('init', '-q', '-b', 'main')
    write(RULES_FILE, JSON.stringify({ tiers: ['auto', 'light', 'deep', 'person'], fallback: 'light', rules: [{ id: 'links', tier: 'deep', paths: ['links/**'], why: 'processes' }] }))
    write('.gitignore', 'node_modules/\n')
    write('links/x.ts', 'export const x = 1\n')
    write('links/x.test.ts', BASE)
    write('links/x.test-helpers.ts', 'export const h = 1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'main')
    git('checkout', '-q', '-b', 'top')
    // The typescript the checkout installs, which the judge reads the files with
    write('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', main: 'index.js' }))
    write('node_modules/typescript/index.js', `module.exports = require(${JSON.stringify(REAL_TYPESCRIPT)})\n`)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('takes a new test file of plain tests as light, and says why', () => {
    const r = change({ 'links/y.test.ts': PLAIN })
    expect(r.tier).toBe(NEW_TEST_TIER)
    expect(r.files.find((f: { path: string }) => f.path === 'links/y.test.ts')).toMatchObject({ tier: 'light', newTest: 'deep' })
    expect(r.line).toContain('`links/y.test.ts` (a new file of plain tests, else deep)')
    expect(r.text).toContain('a new test file of plain tests, so at most light (by its name: deep)')
  })

  it.each([
    ['a test appended to a test file there was', { 'links/x.test.ts': `${BASE}it('two', () => {})\n` }],
    ['an early return slipped into a test there was', { 'links/x.test.ts': withTest('  return\n  expect(1).toBe(1)') }],
    ['a test inside if (false)', { 'links/x.test.ts': withTest('  if (false) {\n  expect(1).toBe(1)\n  }') }],
    ['a test wrapped in a template', { 'links/x.test.ts': withTest('  `\n  expect(1).toBe(1)\n  `') }],
    ['expect shadowed inside a test', { 'links/x.test.ts': withTest('  const expect = (_: unknown) => ({ toBe: () => {} })\n  expect(1).toBe(1)') }],
    ['a vi.mock added at the top of a test file there was', { 'links/x.test.ts': `import { vi } from 'vitest'\nvi.mock('./x.js')\n${BASE}` }],
    ['an export added to helpers there were', { 'links/x.test-helpers.ts': 'export const h = 1\nexport const i = 2\n' }],
    ['helpers gaining Object.assign(globalThis)', { 'links/x.test-helpers.ts': 'export const h = 1\nObject.assign(globalThis, { h })\n' }],
    ['a new helpers file', { 'links/y.test-helpers.ts': 'export const h = 1\n' }],
    ['a new test file with a vi.mock', { 'links/y.test.ts': "import { it, vi } from 'vitest'\nvi.mock('./x.js')\nit('one', () => {})\n" }],
    ['a new test file that writes a shared fixture', { 'links/y.test.ts': "import { it } from 'vitest'\nimport { writeFileSync } from 'node:fs'\nit('one', () => {\n  writeFileSync('links/fixture.json', '{}')\n})\n" }],
    ['a new test file beside a change to the file it tests', { 'links/x.test.ts': BASE, 'links/y.test.ts': PLAIN, 'links/x.ts': 'export const x = 2\n' }],
    ['a new test file beside a setup file', { 'links/y.test.ts': PLAIN, 'links/vitest.setup.ts': 'export {}\n' }],
  ])('keeps the change deep for %s', (_, edits) => {
    expect(change(edits).tier).toBe('deep')
  })

  it('judges nothing light when the checkout has no typescript to read the files with', () => {
    rmSync(join(repo, 'node_modules'), { recursive: true, force: true })
    expect(change({ 'links/y.test.ts': PLAIN }).tier).toBe('deep')
  })
})

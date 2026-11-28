import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs script, so pre-pr and the board can run it with Node alone
import { RULES_FILE, TESTS_ADDED_TIER, testsAdded, tierOfChange } from '../scripts/tier.mjs'

/**
 * A test file whose change only adds tests is at most light, whatever path rule or subject would make it deep (#2563): a
 * check added weakens no boundary. One that removes or changes a line it had, skips or focuses a test, or an added helpers
 * file keeps its tier, as does anything else in the change.
 */

const BASE = "import { it, expect } from 'vitest'\n\nit('one', () => {\n  expect(1).toBe(1)\n})\n"
const ADDED = `${BASE}\nit('two', () => {\n  expect(2).toBe(2)\n})\n`

describe('a change that only adds tests (#2563)', () => {
  it.each([
    ['a test appended', 'a.test.ts', BASE, ADDED],
    ['a test inserted between two', 'a.test.ts', `${BASE}it('three', () => {})\n`, `${BASE}it('two', () => {})\nit('three', () => {})\n`],
    ['an import added', 'a.test.ts', BASE, `import { x } from './x.js'\n${BASE}`],
    ['a helper appended to helpers it had', 'a.test-helpers.ts', 'export const a = 1\n', 'export const a = 1\nexport const b = 2\n'],
    ['a new test file', 'a.test.ts', null, ADDED],
    ['a new test file in another code language', 'a.test.mjs', null, "import { it } from 'vitest'\nit('x', () => {})\n"],
  ])('counts %s', (_, path, before, after) => {
    expect(testsAdded(path, before, after)).toBe(true)
  })

  it.each([
    ['an assertion changed', 'a.test.ts', BASE, BASE.replace('toBe(1)', 'toBeDefined()')],
    ['a test removed', 'a.test.ts', ADDED, BASE],
    ['a line removed while another is added', 'a.test.ts', BASE, `${BASE.replace("  expect(1).toBe(1)\n", '')}it('two', () => {})\n`],
    ['a test added as skipped', 'a.test.ts', BASE, `${BASE}it.skip('two', () => {})\n`],
    ['a test added as the only one to run', 'a.test.ts', BASE, `${BASE}describe.only('two', () => {})\n`],
    ['a test added to do', 'a.test.ts', BASE, `${BASE}it.todo('two')\n`],
    ['a test added that runs only on a condition', 'a.test.ts', BASE, `${BASE}it.skipIf(true)('two', () => {})\n`],
    ['a new test file with a skipped test', 'a.test.ts', null, `${BASE}it.skip('two', () => {})\n`],
    ['a new helpers file', 'a.test-helpers.ts', null, 'export const a = 1\n'],
    ['a file that is not a test', 'a.ts', 'export const a = 1\n', 'export const a = 1\nexport const b = 2\n'],
    ['a Playwright spec', 'a.spec.ts', BASE, ADDED],
    ['a vitest config', 'vitest.config.ts', 'export default {}\n', 'export default {}\nexport const x = 1\n'],
    ['no change', 'a.test.ts', BASE, BASE],
  ])('does not count %s', (_, path, before, after) => {
    expect(testsAdded(path, before, after)).toBe(false)
  })
})

describe('pnpm tier with tests added under a deep path (#2563)', () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C' }
  let repo = ''
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim()
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const change = (edits: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(edits)) {
      if (text === null) git('rm', '-q', path)
      else write(path, text)
    }
    git('add', '-A')
    git('commit', '-q', '-m', 'change')
    return tierOfChange({ root: repo, base: 'main', head: 'top' })
  }
  const fileOf = (r: { files: { path: string }[] }, path: string) => r.files.find((f) => f.path === path)

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cc-tier-tests-added-'))
    git('init', '-q', '-b', 'main')
    write(RULES_FILE, JSON.stringify({ tiers: ['auto', 'light', 'deep', 'person'], fallback: 'light', rules: [{ id: 'links', tier: 'deep', paths: ['links/**'], why: 'processes' }] }))
    write('links/x.ts', 'export const x = 1\n')
    write('links/x.test.ts', BASE)
    write('links/x.test-helpers.ts', 'export const h = 1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'main')
    git('checkout', '-q', '-b', 'top')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('takes a test file that only gains tests as light, and says why', () => {
    const r = change({ 'links/x.test.ts': ADDED })
    expect(r.tier).toBe(TESTS_ADDED_TIER)
    expect(fileOf(r, 'links/x.test.ts')).toMatchObject({ tier: 'light', testsAdded: 'deep' })
    expect(r.line).toContain('`links/x.test.ts` (only tests added, else deep)')
    expect(r.text).toContain('the change only adds tests to it, so at most light (by its name: deep)')
  })

  it('keeps a test file deep when a line it had is changed or removed', () => {
    expect(change({ 'links/x.test.ts': BASE.replace('toBe(1)', 'toBeDefined()') }).tier).toBe('deep')
    git('reset', '-q', '--hard', 'main')
    expect(change({ 'links/x.test.ts': null }).tier).toBe('deep')
  })

  it('keeps a test file deep when what it adds skips or focuses a test', () => {
    expect(change({ 'links/x.test.ts': `${BASE}it.only('two', () => {})\n` }).tier).toBe('deep')
  })

  it('takes a new test file as light, and one with a skipped test as deep', () => {
    expect(change({ 'links/y.test.ts': ADDED }).tier).toBe('light')
    git('reset', '-q', '--hard', 'main')
    expect(change({ 'links/y.test.ts': `${ADDED}it.skip('three', () => {})\n` }).tier).toBe('deep')
  })

  it('takes helpers that only gain an export as light, and a new helpers file as deep', () => {
    expect(change({ 'links/x.test-helpers.ts': 'export const h = 1\nexport const i = 2\n' }).tier).toBe('light')
    git('reset', '-q', '--hard', 'main')
    expect(change({ 'links/y.test-helpers.ts': 'export const h = 1\n' }).tier).toBe('deep')
  })

  it('keeps the change deep when it also touches the file the tests test, or a setup file', () => {
    expect(change({ 'links/x.test.ts': ADDED, 'links/x.ts': 'export const x = 2\n' }).tier).toBe('deep')
    git('reset', '-q', '--hard', 'main')
    expect(change({ 'links/x.test.ts': ADDED, 'links/vitest.setup.ts': 'export {}\n' }).tier).toBe('deep')
  })
})

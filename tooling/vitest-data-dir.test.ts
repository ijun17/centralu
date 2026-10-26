import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { SLOW } from './test-timing.js'

/*
 * The data folder tests run against (#368). A folder shared by every test file let one file's
 * session managers sweep away a handoff note another file had just written (ENOENT in CI,
 * run 37885918963). The guard is that each file is handed a fresh one: `mkdtemp` names it, so no
 * other file, and no other run on the machine, can be using it.
 */
describe('the data folder a test file runs against', () => {
  it('is a fresh temporary folder of its own, not one shared with other files', () => {
    const dir = process.env.CC_DATA_DIR!
    expect(dirname(dir)).toBe(tmpdir())
    expect(basename(dir)).toMatch(/^centralu-test-data-[A-Za-z0-9]{6}$/)
    expect(existsSync(dir)).toBe(true)
    // Nothing else has written into it: this file has not started a host or a manager
    expect(readdirSync(dir)).toEqual([])
  })
})

/*
 * A test that needs a data folder of its own stubs it (#845): vitest undoes the stub before the next test
 * (`unstubEnvs` in vitest.config.ts). Assigning `process.env.CC_DATA_DIR` by hand is what went wrong: a test
 * file deleted it after each test, leaving what ran next on the real `~/.centralu`, and another restored a
 * saved `undefined`, which Node stores as the string "undefined", a folder in the current directory.
 */
describe('a data folder a test sets for itself', () => {
  const own = process.env.CC_DATA_DIR
  it('is a stub (this one points it elsewhere)', () => {
    vi.stubEnv('CC_DATA_DIR', join(tmpdir(), 'somewhere-else'))
    expect(process.env.CC_DATA_DIR).toBe(join(tmpdir(), 'somewhere-else'))
  })
  it('and the next test is back on the file\'s own folder', () => {
    expect(process.env.CC_DATA_DIR).toBe(own)
  })

  it('finds a hand-made write in each form one can take', () => {
    const src = [
      "process.env.CC_DATA_DIR = '/x'",
      "process.env['CC_DATA_DIR'] = '/x'",
      'process.env["CC_DATA_DIR"] ??= dir',
      'delete process.env.CC_DATA_DIR',
      "delete process.env['CC_DATA_DIR']",
      "Object.assign(process.env, { CC_DATA_DIR: '/x' })",
      'Object.assign(process.env, saved)',
      'process.env = { ...saved }',
      "vi.stubEnv('CC_DATA_DIR', '/x')",
      'const d = process.env.CC_DATA_DIR',
      "Object.assign(process.env, { OTHER: '1' })",
      'if (process.env.CC_DATA_DIR === d) {}',
    ].join('\n')
    expect(writesByHand('x.test.ts', src)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('is never assigned or deleted by hand in a test file', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const files = execFileSync('git', ['ls-files', 'packages/*.test.ts', 'packages/*.test.tsx', 'tooling/*.test.ts', 'packages/*.test-helpers.ts'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n')
    expect(files.length).toBeGreaterThan(100)
    const byHand = files.flatMap((f) => writesByHand(f, readFileSync(join(root, f), 'utf8')).map((line) => `${f}:${line}`))
    expect(byHand).toEqual([])
    // It parses every test file in the repository (about 700): under a full CI run's load that passed 5 s (batch-229, #1590)
  }, 30_000 * SLOW)
})

/*
 * The lines of a file that write CC_DATA_DIR by hand, read from its syntax tree so that every spelling counts: dot or
 * bracket access, any assignment operator, `delete`, `Object.assign(process.env, …)` naming it or copying in what
 * cannot be seen (a saved environment), and replacing `process.env` whole. A line had to match a pattern before, and
 * `process.env['CC_DATA_DIR'] = …` or `Object.assign(process.env, saved)` did not.
 */
function writesByHand(file: string, source: string): number[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const isEnv = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === 'env' && e.expression.getText(sf) === 'process'
  const isDataDir = (e: ts.Expression) =>
    (ts.isPropertyAccessExpression(e) && isEnv(e.expression) && e.name.text === 'CC_DATA_DIR') ||
    (ts.isElementAccessExpression(e) && isEnv(e.expression) && ts.isStringLiteralLike(e.argumentExpression) && e.argumentExpression.text === 'CC_DATA_DIR')
  const assigns = (k: ts.SyntaxKind) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment
  const lines = new Set<number>()
  const hit = (n: ts.Node) => lines.add(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && assigns(n.operatorToken.kind) && (isDataDir(n.left) || isEnv(n.left))) hit(n)
    if (ts.isDeleteExpression(n) && isDataDir(n.expression)) hit(n)
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'Object.assign' && n.arguments[0] && isEnv(n.arguments[0])) {
      const named = n.arguments.slice(1).some((a) => !ts.isObjectLiteralExpression(a) || a.properties.some((p) => p.name?.getText(sf).replace(/['"]/g, '') === 'CC_DATA_DIR' || ts.isSpreadAssignment(p)))
      if (named) hit(n)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...lines].sort((a, b) => a - b)
}

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every time limit a test sets for itself is scaled for Windows (#845).
 *
 * vitest.config.ts multiplies its default limits by `SLOW` (three on Windows, #368). A limit given
 * to one test or hook replaces that default, so it used to keep its macOS value on Windows CI:
 * `lazy-resume`, `start-agent`, `versions`, `git-pr` and others set 10–30 s and ran out there while
 * the rest of the suite had three times the room. This reads each test file's syntax tree and lists
 * every limit passed to `it`/`test`/`describe` or a hook (`it(name, fn, 30_000)`,
 * `{ timeout: 10_000 }`) that does not multiply by `SLOW`.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const RUNNERS = new Set(['it', 'test', 'describe', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach'])

/** The runner a call goes back to: `it`, `it.skip`, `it.each([...])`, `test.skipIf(x)` */
function runnerOf(e: ts.Expression): string | null {
  for (;;) {
    if (ts.isIdentifier(e)) return e.text
    if (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = e.expression
    else return null
  }
}

/** The limits a file sets for its tests and hooks, as `line: text` */
export function limitsIn(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: ts.Expression[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && RUNNERS.has(runnerOf(n.expression) ?? '')) {
      const args = n.arguments
      const fn = args.findIndex((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      if (fn >= 0) {
        args.forEach((a, i) => {
          if (i > fn && !ts.isObjectLiteralExpression(a)) found.push(a)
          if (i !== fn && ts.isObjectLiteralExpression(a)) {
            for (const p of a.properties) if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'timeout') found.push(p.initializer)
          }
        })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found.map((e) => `${sf.getLineAndCharacterOfPosition(e.getStart(sf)).line + 1}: ${e.getText(sf)}`)
}

const testFiles = execFileSync('git', ['ls-files', 'packages/**/*.test.ts', 'packages/**/*.test.tsx', 'tooling/**/*.test.ts'], { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n')

describe('time limits a test sets for itself', () => {
  it('finds a limit in each place one can be given', () => {
    const src = [
      "it('a', () => {}, 30_000)",
      "it('b', { timeout: 10_000 }, async () => {})",
      "it.each([1])('c', () => {}, 20_000)",
      'beforeAll(() => {}, 60_000)',
      "it('d', () => {}, 30_000 * SLOW)",
      "it('e', () => { setTimeout(() => {}, 20) })",
    ].join('\n')
    expect(limitsIn('x.test.ts', src)).toEqual(['1: 30_000', '2: 10_000', '3: 20_000', '4: 60_000', '5: 30_000 * SLOW'])
  })

  it('every one is scaled by SLOW, so Windows gets three times it as it does the defaults', () => {
    expect(testFiles.length).toBeGreaterThan(100)
    const unscaled = testFiles.flatMap((f) =>
      limitsIn(f, readFileSync(`${root}/${f}`, 'utf8'))
        .filter((l) => !/\bSLOW\b/.test(l))
        .map((l) => `${f}:${l}`),
    )
    expect(unscaled).toEqual([])
  })
})

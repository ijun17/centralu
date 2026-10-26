/**
 * The type-aware lint (#1339) only ever gets stricter.
 *
 * eslint.config.js turned on rules that read types: no `any` flowing on from `JSON.parse` or a catch, no assertion
 * that narrows what nothing checked, no `x!`, no promise left floating. The findings that predate them are listed
 * per file in tooling/lint-allowlist/, and `pnpm lint` holds each file to its count (tooling/lint-allowlist.ts).
 *
 * What this adds, each a way around those counts that the #1343 review found open:
 *   - the lists against main's, line by line: no line may be new or higher but a file's own lines under the new
 *     path git sees it renamed to, so a hand-written line, a regenerated list or a count freed elsewhere cannot list
 *     a new finding; CI's verify job gives it main's history (and fails without it), elsewhere it says when it could
 *     not compare;
 *   - the weekly job that lowers stale lines (a line above its file is not a lint failure, see `lintFailed`);
 *   - no `eslint-disable` of a type-aware rule, and no comment that turns one off, anywhere they run (the lint rule
 *     `guard/no-rule-switch-comments`, tooling/eslint-guards-ts.js; `pnpm lint` also fails on one that hides a finding);
 *   - every `as T` in shipped code counted per package (ASSERTIONS in tooling/lint-allowlist.ts, checked by `pnpm lint`),
 *     the safe widening ones included, which no rule reports;
 *   - ESLint's threads capped, since each builds the whole program.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALLOWLIST_DIR,
  ASSERTION_ROOM,
  ASSERTIONS,
  lintHeapMb,
  addedSince,
  compareWithBase,
  eslintOptions,
  formatList,
  mainAssertions,
  mainLists,
  parseList,
  readAllowlist,
  renamesSince,
} from './lint-allowlist.js'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Rules this change turned on, whose findings it lists for the first time (`pnpm exec tsx tooling/lint.ts
 * --record-all`), each with why. Main's lists cannot hold them yet, so their lines are not compared with main's in
 * that one change; the next change takes its rule out of here again.
 */
const TURNED_ON: Record<string, string> = {}

/** The steps of build.yml's verify job, as text */
function verifyJob(): string {
  const workflow = readFileSync(join(ROOT, '.github/workflows/build.yml'), 'utf8')
  const start = workflow.indexOf('\n  verify:\n')
  const end = workflow.indexOf('\n  fail-fast:\n')
  return workflow.slice(start, end)
}

describe('type-aware lint (#1339)', () => {
  it('keeps every list sorted, one line per file and rule, in its own package', () => {
    const dir = join(ROOT, ALLOWLIST_DIR)
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
      const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n')
      expect(formatList(parseList(text, name)), `${ALLOWLIST_DIR}/${name} as \`pnpm lint:tighten\` writes it`).toBe(text)
    }
    // Throws for a line in another package's list
    expect(() => readAllowlist(ROOT)).not.toThrow()
  })

  it(
    "lists nothing main's lists do not: no new or higher line but a renamed file's own",
    () => {
      const main = mainLists(ROOT, process.env.CC_LINT_BASE ?? 'origin/main')
      if (main.kind === 'before-lists') {
        console.warn(`type-aware-lint.test.ts: main has no lists yet at ${main.base}; this change brings them`)
        return
      }
      if (main.kind !== 'lists') {
        // CI's verify job fetches main's history and sets CC_LINT_BASE: there, main's lists have to be read
        expect(process.env.CC_LINT_BASE, `main's lists: ${main.why}`).toBeUndefined()
        console.warn(`type-aware-lint.test.ts: not compared with main's lists (${main.why})`)
        return
      }
      const renames = renamesSince(ROOT, main.base)
      const added = addedSince(ROOT, main.base)
      expect(renames, `the renames since ${main.base}`).not.toBeNull()
      expect(added, `the files added since ${main.base}`).not.toBeNull()
      const raised = compareWithBase(main.lists, readAllowlist(ROOT), renames ?? [], added ?? []).filter((line) => !Object.keys(TURNED_ON).some((rule) => line.includes(` ${rule} `)))
      expect(
        raised,
        `${ALLOWLIST_DIR}/ lists more than main's lists: fix the new findings instead. Only a file git sees renamed takes ` +
          'its lines along (`pnpm lint:tighten`); code moved into another file is a new finding there.',
      ).toEqual([])
    },
    60_000 * SLOW,
  )

  it("holds no type-assertion ceiling above main's: they only come down", () => {
    const main = mainAssertions(ROOT, process.env.CC_LINT_BASE ?? 'origin/main')
    if (main.kind !== 'ceilings') {
      // CI's verify job fetches main's history and sets CC_LINT_BASE: there, main's ceilings have to be read (or be absent)
      if (main.kind === 'unreadable') expect(process.env.CC_LINT_BASE, `main's ceilings: ${main.why}`).toBeUndefined()
      console.warn(`type-aware-lint.test.ts: ceilings not compared with main's (${main.why})`)
      return
    }
    for (const [pkg, n] of Object.entries(ASSERTIONS)) expect(n, `${pkg}: ASSERTIONS in tooling/lint-allowlist.ts is above main's ${main.ceilings[pkg] ?? 0}; fix the assertions instead`).toBeLessThanOrEqual(main.ceilings[pkg] ?? 0)
    expect(ASSERTION_ROOM, `ASSERTION_ROOM is above main's ${main.room}`).toBeLessThanOrEqual(main.room)
  })

  it('has a weekly job lower stale lines in one pull request, with no dependency code where the write token is', () => {
    // A line above its file is not a lint failure (lintFailed), so something has to lower it
    const workflow = readFileSync(join(ROOT, '.github/workflows/lint-tighten.yml'), 'utf8')
    expect(workflow).toMatch(/schedule:\s*\n(\s*#.*\n)*\s*- cron:/)
    expect(workflow).toMatch(/^permissions: \{\}$/m)
    const tighten = workflow.slice(workflow.indexOf('\n  tighten:\n'), workflow.indexOf('\n  open:\n'))
    const open = workflow.slice(workflow.indexOf('\n  open:\n'))
    // The job that installs and runs repository code reads only, and its checkout keeps no token (#1343 review)
    expect(tighten).toMatch(/pnpm install/)
    expect(tighten).toMatch(/contents: read/)
    expect(tighten).not.toMatch(/: write/)
    expect(tighten).toMatch(/persist-credentials: false/)
    // Findings on main (1) do not stop it; a crash (2, tooling/lint-crash.ts) fails it
    expect(tighten).toMatch(/pnpm lint:tighten \|\| rc=\$\?/)
    expect(tighten).toMatch(/if \[ "\$rc" -gt 1 \]; then/)
    // The job with the write token runs nothing installed and nothing from the repository
    expect(open).toMatch(/contents: write/)
    expect(open).not.toMatch(/\bpnpm\b|\bnpm\b|\bnode\b|\btsx\b/)
    // One branch, one pull request: a week not yet landed is updated, not doubled
    expect(open).toMatch(/branch='lint-tighten\/weekly'/)
    expect(open).toMatch(/gh pr list --head "\$branch" --state open/)
  })

  it("is given main's history and made to compare in CI's verify job", () => {
    const job = verifyJob()
    expect(job).toMatch(/fetch-depth: 0/)
    expect(job).toMatch(/filter: blob:none/)
    expect(job).toMatch(/CC_LINT_BASE: origin\/main/)
    // Main's bundle is measured in the same checkout when no record of it is found: that fetch must not make it shallow
    expect(readFileSync(join(ROOT, '.github/scripts/bundle-base.mjs'), 'utf8')).toMatch(/--is-shallow-repository/)
  })

  it('runs ESLint on at most two threads', () => {
    // Each thread builds the whole program: six took 13.6 GB on a 12-thread PC, two 5.8 GB (#1343 review)
    expect(eslintOptions(ROOT).concurrency).toBeLessThanOrEqual(2)
    expect(readFileSync(join(ROOT, 'tooling/lint.ts'), 'utf8')).toMatch(/new ESLint\(eslintOptions\(ROOT\)\)/)
  })

  it('sizes the heap of each ESLint thread for the runner and raises it before the threads start', () => {
    const GB = 1024 ** 3
    // The 7 GB macOS runner got V8's ~2 GB default and ran out (beta.37, beta.38 rehearsals)
    expect(lintHeapMb(7 * GB)).toBe(3584)
    expect(lintHeapMb(2 * GB)).toBe(2048)
    expect(lintHeapMb(64 * GB)).toBe(4096)
    const lint = readFileSync(join(ROOT, 'tooling/lint.ts'), 'utf8')
    const flag = lint.indexOf('setFlagsFromString(`--max-old-space-size=${Math.max(lintHeapMb(totalmem())')
    expect(flag).toBeGreaterThan(-1)
    expect(flag).toBeLessThan(lint.indexOf('new ESLint('))
  })
})

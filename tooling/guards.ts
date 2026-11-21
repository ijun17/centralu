/**
 * The repository-wide guards (#2373): tests that fail on a file a branch did not touch. A branch passes CI alone and fails in the
 * queue on what landed before it, or lands and breaks another open pull request through what that one adds. `pnpm pre-pr`
 * (scripts/pre-pr.mjs) reads this list through scripts/pre-pr-guards.mjs: its repo-guards check runs each guard at the head of
 * every branch, and its guards check runs the ones a branch changes (the test, or a file it reads) against every other open pull
 * request. A guard is declared here with what it reads, each file named once, where its owner names it.
 *
 * A tooling test that reads the repository is in GUARDS or in NOT_GUARDS with why (tooling/guards.test.ts): one that runs
 * `git ls-files`, walks a folder with a recursive readdir, or carries the mark `pre-pr: guard`, which a test that reads the
 * repository through a module of its own carries. A declaration removed then fails until the test is named in one of the two.
 */
import { losesTargets } from './doc-refs.js'
import { OS_ALLOWLIST } from './os-layer.js'
import { RULES_FILE as TIER_RULES } from '../scripts/tier.mjs'

export interface Guard {
  /** The test file, from the repository root */
  test: string
  /** A vitest name pattern for the tests of the file that are the guard, when not all of them are */
  tests?: string
  /** The files besides the test whose change changes what the guard holds every other file to */
  reads: readonly string[]
  /** Files it reads for part of what they hold: those `path` matches, when `changed` says that part changed */
  readsPart?: { path: RegExp; changed: (path: string, before: () => string | null, after: () => string | null) => boolean }
}

export const GUARDS: readonly Guard[] = [
  {
    test: 'tooling/doc-refs.test.ts',
    reads: ['tooling/doc-refs.ts'],
    // Every reference, against the sections of every Markdown file: one that loses a section breaks what cites it
    readsPart: { path: /\.md$/, changed: losesTargets },
  },
  {
    test: 'tooling/os-layer.test.ts',
    tests: 'the allowlist',
    // The list; what counts as the layer and as checked code; how a file is found to touch the OS
    reads: [OS_ALLOWLIST, 'tooling/os-layer.js', 'tooling/os-tests.ts', 'tooling/eslint-platform-checks.js'],
  },
  { test: 'tooling/brand.test.ts', tests: 'the old name is not left anywhere', reads: [] },
  {
    test: 'tooling/build-workflow.test.ts',
    tests: 'render or read reaches the screen|the Rust tests include',
    // Which files are a change to the screen, and the paths the tiers call the e2e harness
    reads: ['.github/scripts/ci-changes.mjs', TIER_RULES],
  },
  { test: 'tooling/desktop-permissions.test.ts', reads: [] },
  { test: 'tooling/e2e-browser-sandbox.test.ts', tests: 'every Playwright config under e2e', reads: [] },
  { test: 'tooling/guards.test.ts', tests: 'reads the repository', reads: ['tooling/guards.ts'] },
  {
    test: 'tooling/project-board-queue.test.ts',
    tests: 'names files and commands that exist',
    // The merge queue's lists of mechanical conflicts, and how a file is matched against them
    reads: ['.centralu/apps/project-board/project.json', '.centralu/apps/project-board/queue-conflict.mjs'],
  },
  { test: 'tooling/styles.test.ts', tests: 'borders are solid tokens|our own classes are actually used', reads: [] },
  { test: 'tooling/tier.test.ts', tests: 'matches every glob', reads: [TIER_RULES, 'scripts/tier.mjs'] },
]

/** The tooling tests that read the repository and are not guards, each with why: what another pull request adds cannot fail them */
export const NOT_GUARDS: Readonly<Record<string, string>> = Object.fromEntries(
  ['tooling/guards-checks.test.ts', 'tooling/test-data-dir-checks.test.ts', 'tooling/test-time-limits-checks.test.ts'].map((t) => [
    t,
    'lists the tracked files only to check that each exception of its lint rule names one; lint holds every file to the rule',
  ]),
)

/** A file a branch changes: its path, and its text before and after (null where there is no file), read when asked */
export interface Change {
  path: string
  before: () => string | null
  after: () => string | null
}

/** The tests of the guards that `changes` change: the test itself, or a file it reads. */
export function changedGuards(changes: readonly Change[], guards: readonly Guard[] = GUARDS): string[] {
  const touches = (g: Guard, c: Change) => c.path === g.test || g.reads.includes(c.path) || (!!g.readsPart?.path.test(c.path) && g.readsPart.changed(c.path, c.before, c.after))
  return guards.filter((g) => changes.some((c) => touches(g, c))).map((g) => g.test)
}

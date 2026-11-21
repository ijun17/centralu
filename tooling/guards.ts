/**
 * The repository-wide guards (#2373): tests that fail on a file a branch did not touch. A branch passes CI alone and fails in the
 * queue on what landed before it, or lands and breaks another open pull request through what that one adds. `pnpm pre-pr`
 * (scripts/pre-pr.mjs) reads this list through scripts/pre-pr-guards.mjs: its repo-guards check runs each guard at the head of
 * every branch, and its guards check runs the ones a branch changes (the test, or a file it reads) against every other open pull
 * request. A guard is declared here with what it reads, each file named once, where its owner names it.
 */
import { losesTargets } from './doc-refs.js'
import { OS_ALLOWLIST } from './os-layer.js'

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
]

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

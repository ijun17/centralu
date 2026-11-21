/**
 * The repository-wide guards (#2373): tests that fail on a file a branch did not touch. A branch passes CI alone and fails in the
 * queue on what landed before it, or lands and breaks another open pull request through what that one adds. `pnpm pre-pr`
 * (scripts/pre-pr.mjs) reads this list through scripts/pre-pr-guards.mjs: its repo-guards check runs each guard at the head of
 * every branch, and its guards check runs the ones a branch changes (the test, or a file it reads) against every other open pull
 * request. A guard is declared here with what it reads, each file named once, where its owner names it.
 *
 * Every test under tooling/ is named once, in GUARDS or in NOT_GUARDS under why it is not one (tooling/guards.test.ts): a test
 * is a guard when it holds the files of a folder, or of the repository, to a rule, so a file another pull request adds there
 * can fail it. A new test, or a declaration removed, fails until it is named again.
 */
import { losesTargets } from './doc-refs.js'
import { OS_ALLOWLIST } from './os-layer.js'
// @ts-expect-error — a plain .mjs script, so pre-pr and the board can run it with Node alone
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
  { test: 'tooling/guards.test.ts', tests: 'names every tooling test', reads: ['tooling/guards.ts'] },
  {
    test: 'tooling/project-board-queue.test.ts',
    tests: 'names files and commands that exist',
    // The merge queue's lists of mechanical conflicts, and how a file is matched against them
    reads: ['.centralu/apps/project-board/project.json', '.centralu/apps/project-board/queue-conflict.mjs'],
  },
  { test: 'tooling/styles.test.ts', tests: 'borders are solid tokens|our own classes are actually used', reads: [] },
  { test: 'tooling/tier.test.ts', tests: 'matches every glob', reads: [TIER_RULES, 'scripts/tier.mjs'] },
  { test: 'tooling/actions-pinned.test.ts', reads: [] },
  { test: 'tooling/e2e-webkit-twins.test.ts', reads: [] },
  { test: 'tooling/workflow-runners.test.ts', reads: [] },
  // The format each list of the folder is held to
  { test: 'tooling/type-aware-lint.test.ts', tests: 'keeps every list sorted', reads: ['tooling/lint-allowlist.ts'] },
  // The platforms the folder's host-only packages are held to
  { test: 'tooling/host-package.test.ts', tests: 'is exactly the platforms', reads: ['packaging/remote-runtime.json'] },
  // Each exception names a tracked file: another pull request that deletes or renames one fails it
  { test: 'tooling/guards-checks.test.ts', tests: 'has exceptions that only shrink', reads: ['tooling/guard-exceptions.js'] },
  // The modules the app's build reaches from its entries, held to what may load first and to the calls left out of what ships
  { test: 'tooling/startup-bundle.test.ts', reads: ['tooling/window-build.test-helpers.ts'] },
  { test: 'tooling/pure-calls.test.ts', tests: 'the window bundle', reads: ['tooling/pure-calls.mjs', 'tooling/window-build.test-helpers.ts'] },
  // The board app's folder holds no data file of the person's
  { test: 'tooling/project-board-contribute.test.ts', tests: 'the private word list in the data folder', reads: [] },
  { test: 'tooling/project-board-reader.test.ts', tests: 'on this computer only', reads: [] },
]

/** The tests under tooling/ that are not guards, by why: no file another pull request adds is held to a rule of theirs */
export const NOT_GUARDS: Readonly<Record<string, readonly string[]>> = {
  'lists no folder of the repository: it tests code it imports, on inputs it makes and files it names': [
    'tooling/agent-adapter-checks.test.ts',
    'tooling/app-theme.test.ts',
    'tooling/apt-install.test.ts',
    'tooling/boundaries.test.ts',
    'tooling/browser-bootstrap.test.ts',
    'tooling/bundle-budget.test.ts',
    'tooling/bundle-out.test.ts',
    'tooling/bundle-stage.test.ts',
    'tooling/claude-permission-probe.test.ts',
    'tooling/codex-agent-card.test.ts',
    'tooling/conpty-files.test.ts',
    'tooling/content-manifest.test.ts',
    'tooling/dependency-cruiser.test.ts',
    'tooling/desktop-csp.test.ts',
    'tooling/dev-live.test.ts',
    'tooling/drift-workflow.test.ts',
    'tooling/e2e-engine.test.ts',
    'tooling/e2e-flaky-report.test.ts',
    'tooling/e2e-host-fixture.test.ts',
    'tooling/e2e-lock.test.ts',
    'tooling/e2e-warm-engine.test.ts',
    'tooling/e2e-web-server.test.ts',
    'tooling/engines.test.ts',
    'tooling/fake-gh.test.ts',
    'tooling/first-paint.test.ts',
    'tooling/free-port.test.ts',
    'tooling/guards-ts-checks.test.ts',
    'tooling/heavy-store.test.ts',
    'tooling/icon-check.test.ts',
    'tooling/icon-studio.test.ts',
    'tooling/keeper-executable.test.ts',
    'tooling/keeper-shutdown-bound.test.ts',
    'tooling/keeper-test-processes.test.ts',
    'tooling/key-pairing-vector.test.ts',
    'tooling/launcher-autostart.test.ts',
    'tooling/launcher-cmd.test.ts',
    'tooling/launcher-install.test.ts',
    'tooling/launcher-keys.test.ts',
    'tooling/launcher-node-floor.test.ts',
    'tooling/launcher-platform.test.ts',
    'tooling/launcher-semver.test.ts',
    'tooling/launcher-serve.test.ts',
    'tooling/launcher-swap.test.ts',
    'tooling/launcher-switch.test.ts',
    'tooling/lint-allowlist.test.ts',
    'tooling/lint-ceiling.test.ts',
    'tooling/macos-minos.test.ts',
    'tooling/mail-mock-parity.test.ts',
    'tooling/mock-capability-parity.test.ts',
    'tooling/node-pin.test.ts',
    'tooling/npm-protocol-version.test.ts',
    'tooling/platform-checks.test.ts',
    'tooling/pre-pr-worktrees.test.ts',
    'tooling/project-board-app.test.ts',
    'tooling/project-board-ci.test.ts',
    'tooling/project-board-code-age.test.ts',
    'tooling/project-board-queue-batches.test.ts',
    'tooling/project-board-queue-conflicts.test.ts',
    'tooling/project-board-queue-guard.test.ts',
    'tooling/project-board-queue-integrate.test.ts',
    'tooling/project-board-queue-model.test.ts',
    'tooling/project-board-queue-screen.test.ts',
    'tooling/project-board-risk.test.ts',
    'tooling/project-board-system.test.ts',
    'tooling/project-board-wait-checks.test.ts',
    'tooling/project-board-wait-policy.test.ts',
    'tooling/release-guard.test.ts',
    'tooling/release-registry.test.ts',
    'tooling/release-workflow.test.ts',
    'tooling/remove-tree.test.ts',
    'tooling/rpc-recovery.test.ts',
    'tooling/runner-sandbox.test.ts',
    'tooling/screen-protocol-rules.test.ts',
    'tooling/shell-bundle.test.ts',
    'tooling/shell-release-workflow.test.ts',
    'tooling/smoke-processes.test.ts',
    'tooling/stop-leftover-apt.test.ts',
    'tooling/surface-drift.test.ts',
    'tooling/test-timing.test.ts',
    'tooling/tier-comment-only.test.ts',
    'tooling/ux-engine.test.ts',
    'tooling/ux-klm.test.ts',
    'tooling/vitest-data-dir.test.ts',
    'tooling/vitest-stall-watch.test.ts',
    'tooling/vitest-tmp-root.test.ts',
  ],
  "lists the tracked files only to check that each exception of its lint rule names one, and the rule's ceiling is no exception": [
    'tooling/test-data-dir-checks.test.ts',
    'tooling/test-time-limits-checks.test.ts',
  ],
  'lists packaging/npm, itself or through the code under test, only to copy or serve what that code reads there': [
    'tooling/local-update.test.ts',
    'tooling/project-board-release.test.ts',
    'tooling/stamp-version.test.ts',
  ],
  'reads tooling/guards.ts through the reader it tests; from the empty tree every guard is changed, whatever else is there': ['tooling/pre-pr.test.ts'],
  'a fixture: a tooling test runs it in a vitest of its own': [
    'tooling/fixtures/leak/leak-probe.test.ts',
    'tooling/fixtures/listed/inner.test.ts',
    'tooling/fixtures/listed/outer.test.ts',
    'tooling/fixtures/stall/stall-probe.test.ts',
  ],
}

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

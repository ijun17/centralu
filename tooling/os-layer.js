/**
 * The OS layer: where the shipped code may touch the operating system (#1599, docs/plans/os-layer.md).
 *
 * This module is the one definition of "touches the OS". Two things read it:
 * - the lint rule `local/os-imports` (tooling/eslint-platform-checks.js), which refuses an import of an OS module in
 *   the checked code outside the layer and the files still on the allowlist;
 * - the test selection (tooling/os-tests.ts), which picks the tests the Windows job runs: those that reach the layer,
 *   an allowlisted file or any other module that touches the OS. Everything else runs on Linux only.
 *
 * Plain JavaScript, so that eslint.config.js can import it as it is.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The Node modules whose behaviour depends on the OS: files, paths, processes and shells, the OS itself, and sockets
 * and the servers on them (an address in use, a port held after close or reserved, named pipes). Each is also refused in its `node:` form and, for fs, its
 * promise form. `node:path`'s `posix` and `win32` halves are the same on every OS, so `path/posix` and `path/win32`
 * are not here.
 */
export const OS_MODULES = ['fs', 'fs/promises', 'child_process', 'os', 'path', 'net', 'http', 'https', 'dgram', 'worker_threads']

/**
 * The installed modules that reach the OS: the terminal's pseudo console (ConPTY on Windows), SQLite's files and
 * locks, and WebSocket servers and clients on real sockets. Named as imported, never with `node:`.
 */
export const INSTALLED_OS_MODULES = ['node-pty', 'better-sqlite3', 'ws']

/**
 * What `process` gives of the OS without an import: ending a process by its id (a signal, or `TerminateProcess`), the
 * working folder, the running program's path, and `process.env.PATH` (`Path` on Windows, read whatever its case).
 * Other reads of `process` (`argv`, `env` in general, `exitCode`) are the same on every OS.
 */
export const OS_PROCESS_USES = ['kill', 'cwd', 'chdir', 'execPath']

/** The named exports of a module that is otherwise not the OS's: `file:` URLs and paths convert by the OS's rules */
export const OS_NAMED_EXPORTS = { url: ['fileURLToPath', 'pathToFileURL'] }

/** The OS module an import specifier names (`node:fs/promises` → `fs/promises`, `node-pty`), or null */
export function osModule(specifier) {
  if (typeof specifier !== 'string') return null
  if (INSTALLED_OS_MODULES.includes(specifier)) return specifier
  const name = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  return OS_MODULES.includes(name) ? name : null
}

/**
 * The OS layer: the modules that carry each OS's semantics, so that a caller cannot tell which OS it is on. These
 * are also the modules that may ask which OS this is (`PLATFORM_MODULES` below, docs/architecture.md §2). A new
 * entry is a new subject, not a place to park a file: a file that touches the OS and is not yet behind the layer goes
 * on the allowlist, which only shrinks.
 */
export const OS_LAYER = [
  // The host's questions named for what differs: `ps`, clonefile, locked programs, path rules, install paths
  'packages/agent-host/src/os.ts',
  // Finding a tool on PATH (PATHEXT, npm shims) and starting it (`.cmd` shims, absolute paths)
  'packages/agent-host/src/env-path.ts',
  'packages/agent-host/src/tool-launch.ts',
  // Ending a process tree: groups and signals, or taskkill and parent links
  'packages/agent-host/src/dev-services/kill-tree.ts',
  // The terminal's and the Run button's shell
  'packages/agent-host/src/dev-services/terminal.ts',
  // How Claude Code is started on Windows (#353)
  'packages/agent-host/src/adapters/claude/exe-link.ts',
  // A new project's folder (#515): the Desktop (Windows' known folder, XDG, ~/Desktop) and each OS's path rules
  'packages/agent-host/src/dev-services/project-folder.ts',
  // The npm launcher's platform layer
  'packaging/npm/centralu/bin/platform.mjs',
  // serve.mjs and the modules it is split into
  'packaging/npm/centralu/bin/serve-autostart.mjs',
  'packaging/npm/centralu/bin/serve-detach.mjs',
  'packaging/npm/centralu/bin/serve-files.mjs',
  'packaging/npm/centralu/bin/serve-handover.mjs',
  'packaging/npm/centralu/bin/serve-host.mjs',
  'packaging/npm/centralu/bin/serve-install.mjs',
  'packaging/npm/centralu/bin/serve-run.mjs',
  'packaging/npm/centralu/bin/serve-window.mjs',
  'packaging/npm/centralu/bin/serve-windows.mjs',
]

/**
 * The modules that may ask which OS this is (`local/platform-checks`): the layer, and two places parked there before
 * the layer had a name. Neither is the layer: what in them touches the OS is on the allowlist, and moves out with
 * them.
 */
export const PLATFORM_MODULES = [
  ...OS_LAYER,
  // TODO: move the launcher's own checks into platform.mjs once remote phase 3's launcher work has
  // landed (it is changing serve.mjs and centralu.mjs now); listed so that work is not blocked.
  'packaging/npm/centralu/bin/centralu.mjs',
  // TODO: remote phase 3 is changing the hub's links; revisit what platform checks they need then.
  'packages/agent-host/src/links/**',
]

/**
 * The checked code: what ships (the packages, the apps, the npm launcher) and its tests, as for
 * `local/platform-checks`. Build and release scripts, tooling and e2e are about the repository and one platform's
 * artifacts, and are not checked.
 */
const CHECKED = /^(packages\/[^/]+\/src\/.+|apps\/[^/]+\/src\/.+|packaging\/.+)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
export const isChecked = (file) => CHECKED.test(file)

/**
 * The repository's own apps (`.centralu/apps/`, docs/apps.md): not held to the rule (an app is plain Node with no
 * installs), but they run on the person's machine, on any OS, so a test that reaches their OS use runs everywhere.
 */
export const isRepoApp = (file) => file.startsWith('.centralu/apps/')

/** A test, or a test's helper module */
export const isTestFile = (file) => /\.test\.(ts|tsx|mts|mjs)$|test-helpers\.(ts|mts|mjs)$/.test(file)

const LAYER_FILES = new Set(OS_LAYER)

/**
 * In the OS layer: one of its modules, or its test or test helper beside it, named for it exactly
 * (`kill-tree.test.ts` for `kill-tree.ts`). Any other name is not, `os.anything.test.ts` included: a test the name
 * would let in by its prefix goes on the allowlist like any other.
 */
export function inOsLayer(file) {
  if (LAYER_FILES.has(file)) return true
  const test = /^(.*)\.(test|test-helpers)\.(ts|tsx|mts|mjs)$/.exec(file)
  return test !== null && ['ts', 'tsx', 'mts', 'mjs'].some((ext) => LAYER_FILES.has(`${test[1]}.${ext}`))
}

/** The checked files that touch the OS outside the layer today, one path per line. It may only shrink. */
export const OS_ALLOWLIST = 'tooling/os-allowlist.txt'

/** The allowlist's paths, read from `root` */
export function readOsAllowlist(root = ROOT) {
  const text = readFileSync(`${root.replace(/[\\/]$/, '')}/${OS_ALLOWLIST}`, 'utf8')
  return parseOsAllowlist(text)
}

/** Lines that are not empty or a `#` comment, in order */
export function parseOsAllowlist(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

/** May `file` (a repository path with `/`) import an OS module? */
export function mayTouchOs(file, allowlist) {
  return !isChecked(file) || inOsLayer(file) || allowlist.has(file)
}

/**
 * Tests that run on every OS whatever they import: integration tests whose OS dependence is not in their imports
 * (a process started by path, for instance). Each with its reason; keep it short, the rule picks the rest.
 */
export const EVERY_OS_TESTS = [
  // The selection itself runs on the Windows runner (build.yml), so its own test runs there too
  { file: 'tooling/os-layer.test.ts', why: 'tooling/os-tests.ts picks the tests on the Windows runner itself' },
  // Starts `centralu.mjs serve` by path (its autostart, the host entry), which its imports do not show
  { file: 'tooling/launcher-node-floor.test.ts', why: 'starts the npm launcher as a process; its autostart differs per OS' },
  // The worker-stall watch exists for Windows CI's stalled workers (#368)
  { file: 'tooling/vitest-stall-watch.test.ts', why: 'tests the watch that exists for stalled vitest workers on Windows CI (#368)' },
]

export const REPO_ROOT = ROOT

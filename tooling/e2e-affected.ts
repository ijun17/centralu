/**
 * `pnpm e2e --affected` (#2373): the UI scenarios a branch changed, in Chromium and then WebKit (or the one engine
 * `E2E_BROWSER` names), under one e2e lock (tooling/with-e2e-lock.ts). A spec is affected when it, or a file it imports
 * through the repository's own files at any depth, differs from where the branch left main, uncommitted and untracked
 * files included (specsReaching). Each engine's specs are the ones Playwright lists for it, so a `-webkit.spec.ts` twin,
 * which a one-engine run leaves out (playwright.config.ts), is left out here too. A spec drives a browser: it imports e2e/
 * helpers, and only a few of those import the window's or the host's code (the theme, for one), so most changes to the
 * window pick no spec. When none is picked and CI's screen check (screenFiles, .github/scripts/ci-changes.mjs) says the
 * change reaches the screen, the run says to pick the specs near it by name. `--affected` takes no filter of its own: a
 * filter given with it widens the run (Playwright runs what any filter matches).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** The flag `pnpm e2e` takes for this; Playwright never sees it. */
export const AFFECTED = '--affected'

export type Engine = 'chromium' | 'webkit'

/**
 * The engines the affected specs run in, one after the other: both, as CI runs every spec in each (build.yml), unless
 * `E2E_BROWSER` names one (e2e/engine.ts), as a sandbox without WebKit has it.
 */
export function affectedEngines(env: NodeJS.ProcessEnv = process.env): Engine[] {
  return env.E2E_BROWSER === 'chromium' || env.E2E_BROWSER === 'webkit' ? [env.E2E_BROWSER] : ['chromium', 'webkit']
}

/** Where the branch left main, or null when main is not in this checkout. */
export function mergeBase(cwd = process.cwd(), main = 'origin/main'): string | null {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', main], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** The files of the working tree (relative to `cwd`, the repository's root) that differ from `base`, untracked ones included. */
export function changedFiles(base: string, cwd = process.cwd()): string[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean)
  return [...git(['diff', '--name-only', '--no-renames', '-z', base]), ...git(['ls-files', '--others', '--exclude-standard', '-z'])]
}

/**
 * The argument that keeps one engine's results (traces, error context) in `test-results/<engine>` beside the config
 * (`--config` or `-c`), where Playwright would put them: each run empties its output folder first, so one shared folder
 * would keep only the last engine's.
 */
export function engineOutput(args: string[], engine: string): string {
  let config = 'playwright.config.ts'
  for (const [i, a] of args.entries()) {
    if (a.startsWith('--config=')) config = a.slice('--config='.length)
    else if (a === '--config' || a === '-c') config = args[i + 1] ?? config
  }
  return `--output=${join(dirname(config), 'test-results', engine)}`
}

/**
 * The spec files (absolute) of Playwright's `--list --reporter=json`: each top-level suite is one file, named relative to
 * the config's `rootDir`. Answers why not when the listing is not that, or names errors (a spec that does not load).
 */
export function listedSpecs(json: string): { specs: string[] } | { why: string } {
  let listing: unknown
  try {
    listing = JSON.parse(json)
  } catch {
    return { why: 'the listing is not JSON' }
  }
  if (typeof listing !== 'object' || listing === null) return { why: 'the listing is not an object' }
  const errors = 'errors' in listing && Array.isArray(listing.errors) ? listing.errors : []
  const messages = errors.map((e: unknown) => (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message.split('\n')[0] : 'an error'))
  if (messages.length) return { why: messages.join('; ') }
  const rootDir = 'config' in listing && typeof listing.config === 'object' && listing.config !== null && 'rootDir' in listing.config ? listing.config.rootDir : null
  const suites = 'suites' in listing ? listing.suites : null
  if (typeof rootDir !== 'string' || !Array.isArray(suites)) return { why: 'the listing names no rootDir or suites' }
  const files = suites.map((s: unknown) => (typeof s === 'object' && s !== null && 'file' in s && typeof s.file === 'string' ? s.file : null))
  if (files.includes(null)) return { why: 'a suite of the listing names no file' }
  return { specs: [...new Set(files.filter((f) => f !== null).map((f) => resolve(rootDir, f)))] }
}

/** The repository's compiler options (tsconfig.json at `root`), so an import resolves as tsc resolves it, `paths` included. */
function compilerOptions(root: string): ts.CompilerOptions {
  const read = ts.readConfigFile(join(root, 'tsconfig.json'), (p) => ts.sys.readFile(p))
  return ts.parseJsonConfigFileContent(read.config, ts.sys, root).options
}

/** A path as one key on every system: absolute, and on Windows without regard to case or the separator. */
const keyOf = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))

/**
 * The files of `specs` that are one of `changed`, or import one through the repository's own files at any depth (all
 * absolute paths; `root` the repository's). Imports resolve as tsc resolves them; one into node_modules is not followed
 * (a workspace package resolves to its source through tsconfig's `paths`). A spec's tests are often defined in a fixture
 * the spec imports, so the file a test is defined in does not say which spec a change reaches. A file a spec reads
 * without importing it (a JSON fixture read from disk) is not followed.
 */
export function specsReaching(specs: string[], changed: string[], root: string): string[] {
  const options = compilerOptions(root)
  const touched = new Set(changed.map(keyOf))
  const imports = new Map<string, string[]>()
  const importsOf = (file: string): string[] => {
    const known = imports.get(keyOf(file))
    if (known) return known
    let found: string[] = []
    try {
      found = ts
        .preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles.map((i) => ts.resolveModuleName(i.fileName, file, options, ts.sys).resolvedModule?.resolvedFileName)
        .filter((f): f is string => f !== undefined)
        .map((f) => resolve(f))
        .filter((f) => !/[\\/]node_modules[\\/]/.test(f))
    } catch {
      // A file that cannot be read imports nothing that can be followed
    }
    imports.set(keyOf(file), found)
    return found
  }
  return specs.filter((spec) => {
    const seen = new Set<string>()
    const queue = [resolve(spec)]
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      const key = keyOf(file)
      if (touched.has(key)) return true
      if (seen.has(key)) continue
      seen.add(key)
      queue.push(...importsOf(file))
    }
    return false
  })
}

/**
 * The filter that picks one spec file (absolute) and no other: Playwright reads a filter as a regular expression over a
 * test file's path. The spec's own folder is part of it, so `a.spec.ts` does not pick `x/a.spec.ts`; any separator.
 */
export function specFilter(spec: string): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `(^|[\\\\/])${[basename(dirname(spec)), basename(spec)].map(escape).join('[\\\\/]')}$`
}

/** What a run that picked no spec says: nothing ran, and when the screen changed, how to run the specs near the change. */
export function noSpecLines(base: string, screen: boolean): string[] {
  const none = `e2e: no spec is or imports a file that differs from ${base.slice(0, 10)}; nothing ran.`
  if (!screen) return [none]
  return [none, 'e2e: this change reaches the screen (CI runs every spec for it): run the specs near it by name, `CI=1 pnpm e2e <filter>`.']
}

/**
 * Whether `files` (relative to `cwd`, the repository's root) reach the screen: CI's one definition, asked as the merge
 * queue asks it (`ci-changes.mjs --screen`, the files on stdin). An answer that cannot be had is taken to say yes: the run
 * then only names a filter.
 */
export function reachesScreen(files: string[], cwd = process.cwd()): boolean {
  try {
    const script = fileURLToPath(new URL('../.github/scripts/ci-changes.mjs', import.meta.url))
    const answer: unknown = JSON.parse(execFileSync(process.execPath, [script, '--screen'], { cwd, input: JSON.stringify(files), encoding: 'utf8' }))
    return !(typeof answer === 'object' && answer !== null && 'screen' in answer && answer.screen === false)
  } catch {
    return true
  }
}

/**
 * One `--affected` run under the lock: each engine's specs listed first (which starts no browser and no server) and the
 * affected ones picked (`pick`); nothing more when no engine has one; then each engine with any, in turn, given its specs.
 * `stopCode` is the exit code a signal that reached the runner asks for, or null: once there is one, nothing further
 * starts. Answers the exit code: of several runs, the first failing one's; 1 when a listing fails.
 */
export async function runAffected(o: {
  base: string
  engines: Engine[]
  list: (engine: Engine) => Promise<{ specs: string[] } | { why: string }>
  pick: (specs: string[]) => string[]
  run: (engine: Engine, specs: string[]) => Promise<number>
  stopCode: () => number | null
  screen: () => boolean
  say: (line: string) => void
}): Promise<number> {
  const picked: [Engine, string[]][] = []
  for (const engine of o.engines) {
    const listed = await o.list(engine)
    const stopped = o.stopCode()
    if (stopped !== null) return stopped
    if ('why' in listed) {
      o.say(`e2e: the specs in ${engine} could not be listed: ${listed.why}`)
      return 1
    }
    picked.push([engine, o.pick(listed.specs)])
  }
  if (picked.every(([, specs]) => !specs.length)) {
    for (const line of noSpecLines(o.base, o.screen())) o.say(line)
    return 0
  }
  let code = 0
  for (const [engine, specs] of picked) {
    const stop = o.stopCode()
    if (stop !== null) return code || stop
    if (!specs.length) {
      o.say(`e2e: no affected spec runs in ${engine}`)
      continue
    }
    o.say(`e2e: ${specs.length} affected spec(s) in ${engine}: ${specs.map((s) => basename(s)).join(', ')}`)
    const ran = await o.run(engine, specs)
    if (code === 0) code = ran
  }
  return code
}

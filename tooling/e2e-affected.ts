/**
 * `pnpm e2e --affected` (#2373): the UI scenarios a branch changed, in Chromium and then WebKit (or the one engine
 * `E2E_BROWSER` names), under one e2e lock (tooling/with-e2e-lock.ts). Which specs is Playwright's own `--only-changed`
 * against the merge-base with main: the specs the branch changed, uncommitted changes included, and the specs that import
 * a file it changed. A spec imports only e2e/ helpers, never the window's
 * source (it drives a browser), so a change to the window alone picks none; CI's screen check (screenFiles,
 * .github/scripts/ci-changes.mjs) then says the screen changed, and the run says to pick the specs near the change by name.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The flag `pnpm e2e` takes for this; Playwright never sees it. */
export const AFFECTED = '--affected'

/**
 * The engines the affected specs run in, one after the other: both, as CI runs every spec in each (build.yml), unless
 * `E2E_BROWSER` names one (e2e/engine.ts), as a sandbox without WebKit has it.
 */
export function affectedEngines(env: NodeJS.ProcessEnv = process.env): ('chromium' | 'webkit')[] {
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

/** Playwright's arguments for the affected specs: the flag replaced by `--only-changed` against `base`. */
export const affectedArgs = (args: string[], base: string): string[] => [...args.filter((a) => a !== AFFECTED), `--only-changed=${base}`]

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

/** How many tests `playwright test --list` names (its last line, `Total: N tests in M files`); null when it says no count. */
export function listedCount(listing: string): number | null {
  const m = /Total: (\d+) tests? in \d+ files?/.exec(listing)
  return m ? Number(m[1]) : null
}

/** What a run that picked no spec says: nothing ran, and when the screen changed, how to run the specs near the change. */
export function noSpecLines(base: string, screen: boolean): string[] {
  const none = `e2e: no spec is affected (Playwright's --only-changed against ${base.slice(0, 10)}); nothing ran.`
  if (!screen) return [none]
  return [none, 'e2e: this change reaches the screen (CI runs every spec for it): run the specs near it by name, `CI=1 pnpm e2e <filter>`.']
}

/**
 * Whether what differs from `base` in the working tree, as --only-changed reads it, reaches the screen: CI's one definition,
 * asked as the merge queue asks it (`ci-changes.mjs --screen`, the files on stdin). An answer that cannot be had is taken to
 * say yes: the run then only names a filter.
 */
export function reachesScreen(base: string, cwd = process.cwd()): boolean {
  try {
    const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean)
    const script = fileURLToPath(new URL('../.github/scripts/ci-changes.mjs', import.meta.url))
    const answer: unknown = JSON.parse(execFileSync(process.execPath, [script, '--screen'], { cwd, input: JSON.stringify(files), encoding: 'utf8' }))
    return !(typeof answer === 'object' && answer !== null && 'screen' in answer && answer.screen === false)
  } catch {
    return true
  }
}

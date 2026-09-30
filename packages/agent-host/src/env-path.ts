import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Aligns the GUI app's PATH with **the user's actual PATH**.
 *
 * **Why this is needed (measured):** launching as a `.app` on macOS does not inherit the login
 * shell's PATH, so only `/usr/bin:/bin:/usr/sbin:/sbin` comes through. As a result, `claude` and
 * `codex` were detected as "not installed," and the Start button in the create-session dialog
 * appeared to do nothing at all.
 *
 * **How:** a static list of paths is not enough — an agent tool could be anywhere: not just
 * Homebrew, but npm -g, nvm, volta, mise, asdf, or a manual install.
 * So **the user's login shell is run once to ask for the real PATH.** Whatever is written in the
 * shell config (.zshrc, etc.) is reflected exactly.
 * If that fails or is slow, it falls back to the static candidates below (better than finding
 * nothing at all).
 */

/** The fallback for when the shell cannot be used. Only common install locations */
const FALLBACK = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  join(homedir(), '.local/bin'),
  join(homedir(), '.bun/bin'),
  join(homedir(), '.volta/bin'),
  join(homedir(), '.cargo/bin'),
  join(homedir(), 'Library/pnpm'),
]

/** Asks the login shell for PATH. It has to be interactive (-i) for .zshrc's nvm/mise init to take effect */
function loginShellPath(): string[] {
  const shell = process.env.SHELL
  if (!shell || !existsSync(shell)) return []
  try {
    const out = execFileSync(shell, ['-ilc', 'command -p echo "__CC_PATH__:$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
      // Some shells ignore SIGTERM, so SIGKILL is used to guarantee it is cut off —
      // if this hangs, the host never reaches ready and the whole app fails to start
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      // So that a shell init script does not pop up an interactive prompt
      env: { ...process.env, TERM: 'dumb', CI: '1' },
    })
    // The shell config might print something else, so only the marked line is picked out
    const line = out.split('\n').find((l) => l.startsWith('__CC_PATH__:'))
    return line ? line.slice('__CC_PATH__:'.length).split(delimiter).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Augments PATH and returns the result. Called exactly once at host startup.
 * When launched from a terminal with `pnpm host`, PATH is already correct, so this is effectively
 * a no-op.
 */
/**
 * Cache of the login shell PATH lookup result.
 *
 * loginShellPath() launches the whole shell, so it costs around a second each time. Calling it
 * every time a terminal is opened would stall by that much every time (measured: terminal creation
 * takes 1 to 4 seconds). PATH cannot change while the process is alive, so it is asked only once.
 */
let cachedShellPath: string[] | null = null

/** Forces the lookup to run again in tests */
export function __resetToolPathCache(): void {
  cachedShellPath = null
}

export function ensureToolPath(): { path: string; source: 'shell' | 'fallback' | 'unchanged' } {
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)

  cachedShellPath ??= loginShellPath()
  const fromShell = cachedShellPath
  const source = fromShell.length > 0 ? 'shell' : 'fallback'
  const candidates = fromShell.length > 0 ? fromShell : FALLBACK.filter((p) => existsSync(p))

  // The shell's own list might have duplicates — preserve order and keep each entry only once
  const merged = [...new Set([...current, ...candidates])]
  if (merged.length === current.length) return { path: process.env.PATH ?? '', source: 'unchanged' }

  process.env.PATH = merged.join(delimiter)
  return { path: process.env.PATH, source }
}

/**
 * Finds a tool's actual path (the same job as `which`).
 * Being able to show the user where it is installed is what lets them work out "why can it not be found" on their own.
 */
export function whichTool(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'

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

type Env = Record<string, string | undefined>

/**
 * The fallback for when the shell cannot be used. Only common install locations.
 *
 * Windows (#14) has no login shell to ask, and mostly does not need one: a program started from
 * Explorer inherits the user's PATH from the registry. These are the per-user folders the tools'
 * own installers write to, for a PATH that is stale (a tool installed after Explorer started):
 * `npm i -g` (`%APPDATA%\npm`), Claude Code's native installer (`%USERPROFILE%\.local\bin`),
 * pnpm, Volta, Bun, Cargo and Scoop.
 */
export function fallbackDirs(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'win32') {
    const dirs: string[] = []
    if (env.APPDATA) dirs.push(win32.join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) dirs.push(win32.join(env.LOCALAPPDATA, 'pnpm'), win32.join(env.LOCALAPPDATA, 'Volta', 'bin'))
    const profile = env.USERPROFILE || home
    for (const sub of [['.local', 'bin'], ['.bun', 'bin'], ['.cargo', 'bin'], ['scoop', 'shims']]) {
      dirs.push(win32.join(profile, ...sub))
    }
    return dirs
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    join(home, '.local/bin'),
    join(home, '.bun/bin'),
    join(home, '.volta/bin'),
    join(home, '.cargo/bin'),
    join(home, 'Library/pnpm'),
  ]
}

/** Asks the login shell for PATH. It has to be interactive (-i) for .zshrc's nvm/mise init to take effect */
function loginShellPath(): string[] {
  // Windows: no login shell. A `SHELL` set there is Git Bash's, a POSIX path that cannot be run.
  if (process.platform === 'win32') return []
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
  const candidates = fromShell.length > 0 ? fromShell : fallbackDirs().filter((p) => existsSync(p))

  // The shell's own list might have duplicates — preserve order and keep each entry only once
  const merged = [...new Set([...current, ...candidates])]
  if (merged.length === current.length) return { path: process.env.PATH ?? '', source: 'unchanged' }

  process.env.PATH = merged.join(delimiter)
  return { path: process.env.PATH, source }
}

/**
 * Finds a tool's actual path (the same job as `which`).
 * Being able to show the user where it is installed is what lets them work out "why can it not be found" on their own.
 *
 * **Windows (#14)** finds a command by trying each PATHEXT extension in each folder, never by its
 * bare name: `npm i -g` writes `claude` (a sh script, for Git Bash), `claude.cmd` and `claude.ps1`
 * side by side, and only the `.cmd` is something Windows can start. The bare-name lookup returned
 * the sh script, spawning it failed with ENOENT, and both tools showed as "not installed". A
 * `.cmd` still cannot be spawned without a shell; `tool-launch.ts` turns it into the program it
 * starts.
 *
 * Only absolute PATH entries are searched on Windows: a relative one is resolved against the
 * working directory, which may be a cloned repository.
 */
export function whichTool(
  name: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform === 'win32') {
    // Lowercased: NTFS ignores case, and `claude.cmd` is the name npm actually wrote.
    const exts = /\.[^\\/.]+$/.test(name)
      ? ['']
      : (envVar(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean).map((e) => e.toLowerCase())
    for (const dir of (envVar(env, 'PATH') ?? '').split(';')) {
      if (!dir || !win32.isAbsolute(dir)) continue
      for (const ext of exts) {
        const candidate = win32.join(dir, name + ext)
        if (exists(candidate)) return candidate
      }
    }
    return null
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/** What Windows assumes when PATHEXT is not set */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * A Windows environment variable, whatever its case. `process.env` itself ignores case there, but
 * a copy of it (`{ ...process.env }`, an app's environment) is a plain object that keeps the
 * spelling Windows stored, which is usually `Path`.
 */
function envVar(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

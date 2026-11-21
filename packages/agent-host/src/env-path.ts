import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { familyOf } from './os.js'
import { findOnPath, wslDrives } from './os/rules.js'

/**
 * Aligns the GUI app's PATH with the user's actual one. A `.app` on macOS inherits only `/usr/bin:/bin:/usr/sbin:/sbin` (measured), so
 * `claude` and `codex` read "not installed". A static list cannot cover an agent tool anywhere (Homebrew, npm -g, nvm, volta, mise,
 * asdf), so the login shell runs once and reports the real PATH; on failure or a slow shell the static candidates apply
 */

type Env = Record<string, string | undefined>

/**
 * The fallback when the shell cannot be used: common install locations. Windows (#14) has no login shell and mostly needs none (Explorer
 * passes the registry PATH), but a PATH can be stale for a tool installed after Explorer started, so these are the per-user folders
 * of npm -g (`%APPDATA%\npm`), Claude Code's installer (`%USERPROFILE%\.local\bin`), pnpm, Volta, Bun, Cargo and Scoop
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

const PROBE_TIMEOUT_MS = 3000

/**
 * Asks the login shell for PATH. Interactive (-i) so .zshrc's nvm/mise init runs. Bounded (PA2): some shells ignore SIGTERM, and a config
 * waiting on a prompt would keep the host from reaching ready. In a session of its own (`detached`), as the keeper's `probe_shell` (#428):
 * an interactive shell in a terminal's background group is stopped (SIGTTOU) setting up job control, and its own group lets a timeout end what its
 * config started (a `sleep`, an agent, a prompt helper)
 */
export function probeLoginShell(
  platform: NodeJS.Platform = process.platform,
  env: Env = process.env,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): string[] {
  // Windows: no login shell (PA6). A `SHELL` set there is Git Bash's, a POSIX path that cannot be run.
  if (platform === 'win32') return []
  const shell = env.SHELL
  if (!shell || !existsSync(shell)) return []
  const r = spawnSync(shell, ['-ilc', 'command -p echo "__CC_PATH__:$PATH"'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    // SIGKILL: some shells ignore SIGTERM, and a hang here keeps the host from ever reaching ready
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
    // So that a shell init script does not pop up an interactive prompt
    env: { ...env, TERM: 'dumb', CI: '1' },
    // Honoured by spawnSync as by spawn (setsid; measured, Node 26), though its options type leaves it out
    ...({ detached: true } as object),
  })
  if (r.error && r.pid > 1) {
    try {
      process.kill(-r.pid, 'SIGKILL')
    } catch {
      // the group is already empty
    }
  }
  /*
   * Read even when cut off: a config that hangs after the marked line (a prompt helper, a background job holding the pipe) still
   * said the PATH; only the marked line counts, whatever spaces or CR surround it
   */
  const line = (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('__CC_PATH__:'))
  return line ? line.slice('__CC_PATH__:'.length).split(delimiter).filter(Boolean) : []
}

/** Augments PATH and returns the result; called once at host startup, and a no-op from `pnpm host`, whose PATH is already right */
/**
 * The login shell lookup costs about a second (terminal creation measured 1 to 4 s), and PATH cannot change while the process
 * lives, so it is asked once
 */
let cachedShellPath: string[] | null = null

export function __resetToolPathCache(): void {
  cachedShellPath = null
}

export function ensureToolPath(): { path: string; source: 'shell' | 'fallback' | 'unchanged' } {
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)

  cachedShellPath ??= probeLoginShell()
  const fromShell = cachedShellPath
  const source = fromShell.length > 0 ? 'shell' : 'fallback'
  const candidates = fromShell.length > 0 ? fromShell : fallbackDirs().filter((p) => existsSync(p))

  const merged = [...new Set([...current, ...candidates])]
  /*
   * "Unchanged" means the same list, not the same length: with duplicates in an inherited PATH and as many new folders, comparing
   * lengths dropped the new folders and kept the duplicates (a Windows runner, #14)
   */
  if (merged.length === current.length && merged.every((p, i) => p === current[i])) {
    return { path: process.env.PATH ?? '', source: 'unchanged' }
  }

  process.env.PATH = merged.join(delimiter)
  return { path: process.env.PATH, source }
}

/**
 * Finds a tool's actual path, as `which` does, so the user can see where it is installed. Windows (#14) tries each PATHEXT
 * extension in each folder, never the bare name: `npm i -g` writes `claude` (a sh script), `claude.cmd` and `claude.ps1` side
 * by side and only the `.cmd` starts, so the bare name found the script, spawning it failed ENOENT and both tools read "not
 * installed" (`tool-launch.ts` turns a `.cmd` into the program it starts). Only absolute PATH entries are searched on Windows
 * (a relative one resolves against the working directory, which may be a cloned repository), and no narrower than Windows' own
 * search, since a tool not found here is never spawned: quotes are stripped from an entry and a name counts when the name
 * itself is there (`presentOnWindows`), an App Execution Alias included. The rule is `findOnPath` (`os/rules.ts`), which the
 * in-memory OS follows too
 */
export function whichTool(
  name: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = platform === 'win32' ? presentOnWindows : existsSync,
  read: (path: string) => string | null = readOrNull,
): string | null {
  // Under WSL, where Windows' drives are (`wslDrives`): two small files, read at each lookup so nothing is kept to go stale
  const windowsDrives = platform === 'linux' ? wslDrives(read('/proc/sys/kernel/osrelease'), read('/etc/wsl.conf')) : null
  return findOnPath(name, env, familyOf(platform), exists, { windowsDrives })
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Whether a name in a PATH folder is there as Windows' search asks it: of the name itself, never where it leads. `existsSync`
 * follows a reparse point and an App Execution Alias (`winget.exe`, in `%LOCALAPPDATA%\Microsoft\WindowsApps`) leads somewhere
 * only process creation opens (measured on Windows 11: `existsSync` false, `lstat` a link)
 */
function presentOnWindows(path: string): boolean {
  if (existsSync(path)) return true
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

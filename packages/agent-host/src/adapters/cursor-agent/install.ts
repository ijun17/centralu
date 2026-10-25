import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { whichTool } from '../../env-path.js'
import { installsCliAsVersionFolders, type Platform } from '../../os.js'

/**
 * Where Cursor CLI is installed and how to start its ACP server (docs/plans/acp-adapter.md §3.2).
 *
 * Its launcher does not fit `tool-launch.ts`: on Windows `agent.cmd` first runs `versions\promote-staged.cmd` (which
 * moves a staged update into place), then PowerShell (`cursor-agent.ps1`), which picks the newest
 * `versions\<YYYY.MM.DD-…-hash>` and runs that folder's own `node.exe index.js` (measured, 2026.10.22-27dcf5f). The shim
 * reader would take the first quoted path, which is the promote script. So the newest version folder is found here, as
 * the launcher finds it, and its Node is started directly. The promote script is not run: it renames version folders,
 * and the person's next `agent` in a terminal promotes as before.
 *
 * A path is taken for Cursor's only when it sits in a Cursor install (a `versions` folder whose newest entry has
 * `index.js`): `agent` is a generic word, and another program of that name on PATH must not be started as Cursor.
 */

export type CursorInstall = { version: string; command: string; args: string[]; env: Record<string, string> }

type Fs = { exists(path: string): boolean; list(dir: string): string[]; real(path: string): string }

const realFs: Fs = {
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  real: (p) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  },
}

/** The launcher's own pattern: the legacy `YYYY.MM.DD-hash` and the newer `YYYY.MM.DD-HH-MM-SS-hash` */
const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/

/** Newest first, as the launcher orders them: by date, then (a choice of ours) by the build time the newer form adds */
export function newestVersion(names: readonly string[]): string | null {
  const key = (n: string) => {
    const m = VERSION.exec(n)
    if (!m) return null
    const pad = (s: string | undefined) => (s ?? '00').padStart(2, '0')
    return `${m[1]}${pad(m[2])}${pad(m[3])}${pad(m[4])}${pad(m[5])}${pad(m[6])}`
  }
  const dated = names.flatMap((n) => {
    const k = key(n)
    return k ? [{ n, k }] : []
  })
  dated.sort((a, b) => (a.k < b.k ? 1 : a.k > b.k ? -1 : 0))
  return dated[0]?.n ?? null
}

export function findCursor(env: NodeJS.ProcessEnv = process.env, platform?: Platform, fs: Fs = realFs): CursorInstall | null {
  if (installsCliAsVersionFolders(platform)) {
    const roots = [whichTool('agent', env, platform), whichTool('cursor-agent', env, platform)]
      .flatMap((p) => (p ? [win32.dirname(p)] : []))
      .concat(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'cursor-agent')] : [])
    for (const root of roots) {
      const version = newestVersion(fs.list(win32.join(root, 'versions')))
      if (!version) continue
      const dir = win32.join(root, 'versions', version)
      const node = win32.join(dir, 'node.exe')
      const entry = win32.join(dir, 'index.js')
      if (fs.exists(node) && fs.exists(entry)) return { version, command: node, args: [entry], env: { CURSOR_INVOKED_AS: 'agent.cmd' } }
    }
    return null
  }
  // macOS and Linux: `~/.local/bin/agent` links into `…/cursor-agent/versions/<version>/` (to be measured on each)
  for (const name of ['cursor-agent', 'agent']) {
    const found = whichTool(name, env, platform)
    if (!found) continue
    const real = fs.real(found)
    const dir = dirname(real)
    const version = dir.split(/[\\/]/).pop() ?? ''
    if (VERSION.test(version) && fs.exists(join(dir, 'index.js'))) return { version, command: real, args: [], env: {} }
  }
  return null
}

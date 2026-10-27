import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NormalizedEvent, PermissionPreset } from '@cc/protocol'
import type { AgentProcess, CreateSessionOpts } from '../contract.js'
import { loadRecording, type Recording } from '../frames/replay.test-helpers.js'
import { agyHome, INSTALL_MARKER, ownerTag, type AgyHome } from './agent-files.js'
import { AGY_RELEASE, type AgyArchive } from './release.js'

/**
 * What Antigravity's tests need of the disk, in the layer module's own helper (tooling/os-layer.js), so the tests of the
 * setup, the sign-in, the replay and the ACP shape stay off the OS: temporary data folders (never `~/.centralu`), what an
 * install and a sign-in leave there, and the recordings.
 */

/** The archive the tests stand in for (macOS arm64's): the profile is built for that platform in every test */
export const TEST_ARCHIVE: AgyArchive = AGY_RELEASE.archives['darwin-aarch64']

/** A temporary Centralu data folder, removed by `done` */
export function tempData(): { dir: string; home: AgyHome; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-agy-'))
  return { dir, home: agyHome(dir, AGY_RELEASE.version), done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** What a finished install leaves: the files and the marker naming the pinned archive */
export function fakeInstall(home: AgyHome, archive: AgyArchive = TEST_ARCHIVE): void {
  mkdirSync(home.versionDir, { recursive: true })
  for (const f of archive.files) writeFileSync(join(home.versionDir, f), 'stand-in')
  writeFileSync(join(home.versionDir, INSTALL_MARKER), JSON.stringify({ version: AGY_RELEASE.version, sha256: archive.sha256 }))
}

/** What the agent's sign-in leaves on disk: `auth.type` and a token file (whose content no one reads) */
export function fakeSignIn(home: AgyHome): void {
  const dir = join(home.geminiHome, 'antigravity-acp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ auth: { type: 'oauth-personal' } }))
  writeFileSync(join(dir, 'acp_token.json'), '{"decoy": true}')
}

/** The token file's path, as a read the agent might ask for */
export const tokenPath = (home: AgyHome) => join(home.geminiHome, 'antigravity-acp', 'acp_token.json')

/** The folders under the install's root whose names start with `prefix` (what an install or a sign-in left) */
export const leftovers = (home: AgyHome, prefix: string) => (existsSync(home.root) ? readdirSync(home.root).filter((n) => n.startsWith(prefix)) : [])

export const exists = (path: string) => existsSync(path)
export const readText = (path: string) => readFileSync(path, 'utf8')
export const inVersion = (home: AgyHome, name: string) => join(home.versionDir, name)
export const inRoot = (home: AgyHome, name: string) => join(home.root, name)

/** Makes a folder (and its parents) */
export const folder = (path: string) => mkdirSync(path, { recursive: true })
export const write = (path: string, text: string) => writeFileSync(path, text)
export const pathIn = (...parts: string[]) => join(...parts)
export const pathFrom = (from: string, to: string) => relative(from, to)
export { sep }
/** Node's POSIX path rules, the same on every OS */
export const posixPaths = posix
/** This machine's own name, as a network path may name it */
export const thisHost = () => hostname()
/** A symbolic link at `at` to `target`, or false where making one needs rights a test does not have (Windows) */
export function link(target: string, at: string): boolean {
  if (process.platform === 'win32') return false
  symlinkSync(target, at)
  return true
}

/** A second name `at` for the file `target` (a hardlink, which every OS lets a test make) */
export const hardLink = (target: string, at: string) => linkSync(target, at)

/** The drive letter the host process's own folder is on (a root-relative path such as the one starting with a backslash means that drive's root), upper case; Windows only */
export const processDrive = () => resolve(sep).slice(0, 1).toUpperCase()

/** A link at `at` to the folder `target` that every OS lets a test make: a junction on Windows (no right needed), a symbolic link elsewhere */
export function folderLink(target: string, at: string): void {
  symlinkSync(target, at, 'junction')
}

const hosts: (() => Promise<void>)[] = []

/** Another host process, as a leftover folder's name records its owner: a child that runs until `end` (or `endHosts`) */
export function otherHost(): { tag: string; end(): Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const end = async () => {
    child.stdin.end()
    await exited
  }
  hosts.push(end)
  return { tag: ownerTag(child.pid ?? 0), end }
}

/** Ends every host `otherHost` started (each test's `afterEach`) */
export async function endHosts(): Promise<void> {
  for (const end of hosts.splice(0)) await end()
}

/** One of the committed recordings of 1.4.3 (`recordings/antigravity-1.4.3/<name>.jsonl`) */
export function agyRecording(name: string): Recording {
  return loadRecording(fileURLToPath(new URL(`./recordings/antigravity-1.4.3/${name}.jsonl`, import.meta.url)))
}

/** A project folder with a file, and the agent's home inside it (as a session in Centralu's own data folder would be) */
export function readsWorld(): { project: string; agent: string; notes: string; token: string; outside: string; link(): string | null; done(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-agy-reads-')))
  const project = join(root, 'project')
  const agent = join(project, '.agent-home')
  mkdirSync(join(agent, 'antigravity-acp'), { recursive: true })
  const notes = join(project, 'notes.txt')
  const token = join(agent, 'antigravity-acp', 'acp_token.json')
  const outside = join(root, 'outside.txt')
  writeFileSync(notes, 'one\ntwo\nthree\n')
  writeFileSync(token, '{"decoy": true}')
  writeFileSync(outside, 'outside')
  return {
    project,
    agent,
    notes,
    token,
    outside,
    /** A link in the project to the token, or null where this OS user may not make links (Windows without the right) */
    link() {
      const at = join(project, 'innocent.json')
      try {
        symlinkSync(token, at)
        return at
      } catch {
        return null
      }
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  }
}

export type Driven = {
  events: NormalizedEvent[]
  /** Resolves on the first event `pick` accepts, counting those already seen */
  event(pick: (e: NormalizedEvent) => boolean): Promise<NormalizedEvent>
}

/** An event log with waits on it, as the scenario driver keeps one: nothing waits on a clock */
export function driven(): Driven & { emit(e: NormalizedEvent): void } {
  const events: NormalizedEvent[] = []
  const waiting: { pick(e: NormalizedEvent): boolean; resolve(e: NormalizedEvent): void }[] = []
  return {
    events,
    emit(e) {
      events.push(e)
      for (const w of [...waiting]) if (w.pick(e)) {
        waiting.splice(waiting.indexOf(w), 1)
        w.resolve(e)
      }
    },
    event(pick) {
      const seen = events.find(pick)
      return seen ? Promise.resolve(seen) : new Promise((resolve) => waiting.push({ pick, resolve }))
    },
  }
}

export const turnEnded = (e: NormalizedEvent) => e.type === 'turn_complete' || e.type === 'error' || (e.type === 'state_change' && e.state === 'waiting_input')

/** A session's options; its folder `/work` is not the recordings' `<cwd>`, so a card that names `<cwd>` read the agent's own */
export function sessionOpts(sessionId: string, preset: PermissionPreset = 'normal', more: Partial<CreateSessionOpts> = {}): CreateSessionOpts {
  return { sessionId, cwd: '/work', permissionPreset: preset, projectTrusted: true, ...more }
}

/** Every frame the adapter wrote to a process, parsed */
export function sentFrames(proc: AgentProcess): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  let buffer = ''
  proc.stdin.on('data', (d: Buffer) => {
    buffer += String(d)
    let n
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n)
      buffer = buffer.slice(n + 1)
      if (line.trim()) frames.push(JSON.parse(line) as Record<string, unknown>)
    }
  })
  return frames
}

/**
 * What the agent's launcher runs for its `BROWSER` (CPython 3.14 `webbrowser`, the agent's runtime): an entry holding `%s`
 * split as `shlex` does (here, single quotes and `\'` only, all a helper's command uses) with the address put for `%s`;
 * any other entry run with the address after it. No shell, as the launcher's `subprocess.Popen`. Resolves with the exit
 * code, which the launcher reads (not 0: it goes on to the default browser)
 */
export function runBrowser(browser: string, url: string): Promise<number | null> {
  const argv = browser.includes('%s') ? shlexSplit(browser).map((a) => a.replace('%s', url)) : [browser, url]
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code))
  })
}

function shlexSplit(text: string): string[] {
  const out: string[] = []
  let word: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) throw new Error(`unclosed quote in ${text}`)
      word = (word ?? '') + text.slice(i + 1, end)
      i = end
    } else if (c === '\\') {
      word = (word ?? '') + (text[++i] ?? '')
    } else if (c === ' ' || c === '\t') {
      if (word !== null) out.push(word)
      word = null
    } else {
      word = (word ?? '') + c
    }
  }
  if (word !== null) out.push(word)
  return out
}

/** This machine as the profile's platform: the helper a test runs is the one this OS gets */
export const HOST_TEST_PLATFORM = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
/** The archive of this machine's platform on x64, for a profile built for `HOST_TEST_PLATFORM` */
export const HOST_TEST_ARCHIVE: AgyArchive =
  AGY_RELEASE.archives[HOST_TEST_PLATFORM === 'win32' ? 'windows-x86_64' : HOST_TEST_PLATFORM === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64']

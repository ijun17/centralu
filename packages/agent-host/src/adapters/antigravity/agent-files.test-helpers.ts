import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
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
/** A symbolic link at `at` to `target`, or false where making one needs rights a test does not have (Windows) */
export function link(target: string, at: string): boolean {
  if (process.platform === 'win32') return false
  symlinkSync(target, at)
  return true
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

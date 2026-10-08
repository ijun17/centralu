import { randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Where a Claude process is started from on Windows (#353), and whether what npm left there can
 * run at all.
 *
 * Since #307 the host reads npm's `claude.cmd` and starts the program it names directly: npm's
 * `node_modules\@anthropic-ai\claude-code\bin\claude.exe`, which `install.cjs` made a second name
 * (a hard link) of the platform package's `claude.exe`. Windows lets a running program's names be
 * renamed, and deleted as long as another name remains, but never deletes the last name and never
 * writes over it. An npm update removes both of npm's names; with a Centralu session running from
 * one of them, the second removal is the last name and fails, and so does putting a new file there.
 * Claude Code's `install.cjs` then leaves npm's 500-byte placeholder and only sets an exit code:
 * the broken `claude` the owner found after an update (#353), which Windows reports as a 16-bit
 * program.
 *
 * So on Windows the host starts Claude from its own hard link, `<data>\tools\claude\<key>\claude.exe`,
 * a third name npm never touches. Measured on Windows 11 / NTFS with Node 24 (#353, a copy of
 * PING.EXE standing in):
 *
 *   running from                 delete the platform name   delete bin\claude.exe   new file at bin\claude.exe
 *   npm's bin\claude.exe         OK                         EPERM                   EBUSY
 *   Centralu's hard link         OK                         OK                      OK
 *
 * Writing over one of npm's names in place still fails while the link runs (EBUSY: it is the same
 * file), but nothing in an update does that: npm and `install.cjs` delete, then create. A link costs
 * no disk; when the data folder is on another volume (`EXDEV`) or the file system has no links
 * (`EPERM`) the program is copied instead. macOS and Linux replace a running executable without
 * complaint, so nothing here runs there.
 */

/** Smaller than any real Claude Code binary (about 250 MB) and larger than any placeholder (500 bytes in 2.1.x) */
export const PLACEHOLDER_MAX_BYTES = 1_000_000

/** What `start` throws when Claude Code's program is the npm placeholder: the message says what to do */
export class ClaudePlaceholderError extends Error {
  override readonly name = 'ClaudePlaceholderError'
}

/** The file operations used here, so a test can make one fail the way Windows does */
export type ExeFs = {
  stat(path: string): { size: number; mtimeMs: number }
  /** The first `n` bytes of a file */
  head(path: string, n: number): Buffer
  read(path: string): string
  link(from: string, to: string): void
  copy(from: string, to: string): void
  rename(from: string, to: string): void
  list(dir: string): string[]
  mkdir(dir: string): void
  /** A folder and what is in it. Throws on Windows while a program in it runs */
  removeDir(dir: string): void
  removeFile(path: string): void
}

export const realExeFs: ExeFs = {
  stat: (p) => statSync(p),
  head: (p, n) => {
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(n)
      const got = readSync(fd, buf, 0, n, 0)
      return buf.subarray(0, got)
    } finally {
      closeSync(fd)
    }
  },
  read: (p) => readFileSync(p, 'utf8'),
  link: (a, b) => linkSync(a, b),
  copy: (a, b) => copyFileSync(a, b),
  rename: (a, b) => renameSync(a, b),
  list: (d) => readdirSync(d),
  mkdir: (d) => void mkdirSync(d, { recursive: true }),
  removeDir: (d) => rmSync(d, { recursive: true, force: true }),
  removeFile: (p) => rmSync(p, { force: true }),
}

/**
 * Why this `.exe` cannot be what Claude Code meant to install, or null when it looks like a program.
 *
 * Every Windows program starts with `MZ`. npm's placeholder is a few lines of text that Windows
 * would start, as it does any non-PE file named `.exe`, as a 16-bit program and refuse. A file that
 * is large or starts with `MZ` passes: this only names the one failure we know, never guesses.
 */
export function placeholderProblem(exe: string, size: number, fs: ExeFs = realExeFs): string | null {
  if (size >= PLACEHOLDER_MAX_BYTES) return null
  let head: Buffer
  try {
    head = fs.head(exe, 2)
  } catch {
    return null
  }
  if (head.toString('latin1') === 'MZ') return null
  const pkg = dirname(dirname(exe))
  const installer = basename(dirname(exe)).toLowerCase() === 'bin' ? join(pkg, 'install.cjs') : null
  let canRerun = false
  if (installer) {
    try {
      fs.stat(installer)
      canRerun = true
    } catch {
      // not npm's layout: only reinstalling is advice we can stand behind
    }
  }
  return [
    `Claude Code is not installed completely: ${exe} is a ${size}-byte placeholder, not the Claude program (about 250 MB).`,
    "Claude Code's setup step puts the real program there after npm installs the package; it did not finish, usually because a running Claude Code held the file during an install or update.",
    canRerun
      ? `To fix it, close every Claude Code (Centralu's Claude sessions, terminals, editors) and run \`node "${installer}"\`, or reinstall with \`npm i -g @anthropic-ai/claude-code\` while no Claude Code is running.`
      : 'To fix it, close every Claude Code (Centralu\'s Claude sessions, terminals, editors) and reinstall it with `npm i -g @anthropic-ai/claude-code`.',
  ].join(' ')
}

/**
 * The folder name for one Claude Code binary: its version from npm's `package.json` and its size, or,
 * outside npm's layout, its size and modification time.
 *
 * Not `claude --version`: that runs npm's file, which is the very hold this avoids, and costs a
 * second of start-up on every session. Not a content hash either: reading 250 MB on every start is
 * seconds on a laptop. The version is what npm installed and changes with every update; the size
 * tells apart two builds that claim one version (x64 and arm64, a reinstall of a different build).
 * npm stamps every file it unpacks with the same time, so time is only used where npm is not
 * involved (a native install keeps the time it was downloaded).
 */
export function claudeKey(exe: string, stat: { size: number; mtimeMs: number }, fs: ExeFs = realExeFs): string {
  let version: string | null = null
  try {
    const pkg = JSON.parse(fs.read(join(dirname(dirname(exe)), 'package.json'))) as { name?: unknown; version?: unknown }
    if (pkg.name === '@anthropic-ai/claude-code' && typeof pkg.version === 'string' && pkg.version) version = pkg.version
  } catch {
    // not npm's layout
  }
  const raw = version ? `${version}-${stat.size}` : `${stat.size}-${Math.floor(stat.mtimeMs)}`
  return raw.replace(/[^A-Za-z0-9._-]/g, '_')
}

export type ClaudeRun = {
  /** What to start */
  path: string
  /** The link folder it runs from, or null when it runs from where it was found */
  key: string | null
}

/**
 * Whether Claude Code is started the Windows way on `platform` (#353): from a link of its own
 * (Windows locks a running program's file, so npm could not update one a session runs), spaced apart
 * (the sign-in lives in a file two starts race to refresh), and given time to exit when the host
 * leaves (Node's job object ends children with their parent). macOS and Linux need none of it.
 */
export function windowsStart(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

type Options = {
  /** Default: this host's */
  platform?: NodeJS.Platform
  /** The data folder (`CC_DATA_DIR`); the links live in `<data>/tools/claude` */
  root: () => string
  fs?: ExeFs
  log?: (line: string) => void
}

/**
 * The hard links one host made, and which of them a running session started from.
 *
 * A link is removed once no session of this host uses it and it is not the one new sessions start
 * from. A process still running from a removed link (a session winding down) is not disturbed:
 * while npm's names remain, Windows only drops the link's name; once they are gone it refuses to
 * delete the last name, and the link goes on a later sweep.
 */
export class ClaudeLinks {
  private readonly fs: ExeFs
  private readonly log: (line: string) => void
  private readonly uses = new Map<string, number>()
  /** The key new sessions start from: the last one prepared */
  private current: string | null = null

  constructor(private readonly opts: Options) {
    this.fs = opts.fs ?? realExeFs
    this.log = opts.log ?? ((line) => console.error(line))
  }

  get enabled(): boolean {
    return windowsStart(this.opts.platform)
  }

  private base(): string {
    return join(this.opts.root(), 'tools', 'claude')
  }

  /**
   * What to start for the `claude.exe` found at `exe`. Off Windows, or for anything but an `.exe`
   * (a `cli.js` through Node), `exe` itself.
   *
   * @throws ClaudePlaceholderError when the file is npm's placeholder
   */
  prepare(exe: string): ClaudeRun {
    const direct = { path: exe, key: null }
    if (!this.enabled || !/\.exe$/i.test(exe)) return direct
    let stat: { size: number; mtimeMs: number }
    try {
      stat = this.fs.stat(exe)
    } catch {
      return direct // gone: the spawn names the missing file
    }
    const problem = placeholderProblem(exe, stat.size, this.fs)
    if (problem) throw new ClaudePlaceholderError(problem)

    const key = claudeKey(exe, stat, this.fs)
    const dir = join(this.base(), key)
    const target = join(dir, 'claude.exe')
    const ready = (): boolean => {
      try {
        return this.fs.stat(target).size === stat.size
      } catch {
        return false
      }
    }
    if (ready()) return this.use(key, target)
    /*
     * Placed under a name of its own and renamed into place, so a second session preparing at the
     * same moment never starts a copy that is half written: the rename is atomic, and the loser
     * finds the winner's file in place.
     */
    const tmp = join(dir, `claude-${randomBytes(4).toString('hex')}.tmp`)
    try {
      this.fs.mkdir(dir)
      try {
        this.fs.link(exe, tmp)
      } catch (err) {
        // EXDEV: the data folder is on another volume. EPERM: a file system without links (FAT, some shares)
        this.log(`[claude] could not hard-link ${exe} (${code(err)}); copying it to ${dir}`)
        this.fs.copy(exe, tmp)
      }
      try {
        this.fs.rename(tmp, target)
      } catch (err) {
        this.fs.removeFile(tmp)
        if (!ready()) throw err
      }
      return this.use(key, target)
    } catch (err) {
      try {
        this.fs.removeFile(tmp)
      } catch {
        // nothing was written
      }
      this.log(`[claude] could not place claude.exe in ${dir} (${code(err)}); starting it from ${exe}, which an update cannot replace while it runs`)
      return direct
    }
  }

  private use(key: string, path: string): ClaudeRun {
    if (key !== this.current) {
      this.current = key
      this.sweep()
    }
    return { path, key }
  }

  /** A session started from this link */
  acquire(key: string | null): void {
    if (key) this.uses.set(key, (this.uses.get(key) ?? 0) + 1)
  }

  /** That session's process is gone; links nobody uses any more are removed */
  release(key: string | null): void {
    if (!key) return
    const left = (this.uses.get(key) ?? 1) - 1
    if (left > 0) this.uses.set(key, left)
    else this.uses.delete(key)
    this.sweep()
  }

  /**
   * Removes every link folder that is neither in use by a session of this host nor the one new
   * sessions start from. Called at host start (nothing is in use yet), whenever the current key
   * changes, and whenever a session's process ends.
   */
  sweep(): void {
    if (!this.enabled) return
    let names: string[]
    try {
      names = this.fs.list(this.base())
    } catch {
      return // never made one
    }
    for (const name of names) {
      if (name === this.current || this.uses.has(name)) continue
      try {
        this.fs.removeDir(join(this.base(), name))
      } catch {
        // A process still runs from it and npm's names are gone (Windows refuses the last name); a later sweep gets it
      }
    }
  }

  /** The key the program at `exe` would get, without placing anything: what host start keeps */
  keep(exe: string | null): void {
    if (!this.enabled || !exe || !/\.exe$/i.test(exe)) return
    try {
      this.current = claudeKey(exe, this.fs.stat(exe), this.fs)
    } catch {
      // not there: nothing to keep
    }
  }
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? String(err)
}

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
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
 *
 * Finding the placeholder, the host runs the package's own `install.cjs` (#1645), once per package
 * per host start, with its own Node and a time limit, beside the host's loop (every start path awaits
 * `ClaudeLinks.ensure`): it is the step npm meant to run, nothing else. What it leaves is believed only
 * when it is the size of the platform program it was copied from (or runs `--version`): a copy cut
 * short by the limit is large, starts with `MZ` and is still not the program.
 * Measured on Claude Code 2.1.296: on a placeholder it links the platform program over it and prints
 * nothing; when a running program holds the file it prints `Failed to place binary: EBUSY` and exits
 * 1 with the placeholder untouched. A held file is reported, never freed: no process is stopped.
 */

/** Smaller than any real Claude Code binary (about 250 MB) and larger than any placeholder (500 bytes in 2.1.x) */
export const PLACEHOLDER_MAX_BYTES = 1_000_000

/** How long the package's own setup step may run: a link is instant, a copy of the 250 MB program is not */
export const INSTALLER_TIMEOUT_MS = 30_000

/** How long `claude.exe --version` may take when the repaired program cannot be proven by its size */
export const VERSION_TIMEOUT_MS = 10_000

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
  /**
   * Runs the package's own `install.cjs` with this host's Node, in its folder, and waits for it
   * without stopping the host. `status` is its exit code, or null when it did not run to the end;
   * `output` is what it printed (or why it did not finish). A run past the limit is killed.
   */
  runInstaller(installer: string, timeoutMs: number): Promise<{ status: number | null; output: string }>
  /** The size of the platform package's program that `install.cjs` places (found the way it does), or null when there is none */
  nativeSize(installer: string): number | null
  /** Runs a program with a limit; `status` is its exit code, null when it could not run or was killed */
  runProgram(path: string, args: string[], timeoutMs: number): Promise<{ status: number | null }>
}

/** `execFile` as a promise that never rejects: no shell, stdin closed, the child killed past the limit */
function runNode(file: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim()
      if (!err) return resolve({ status: 0, output })
      if (err.killed) return resolve({ status: null, output: `it did not finish within ${Math.round(timeoutMs / 1000)} seconds` })
      resolve(typeof err.code === 'number' ? { status: err.code, output } : { status: null, output: err.message })
    })
    child.stdin?.end()
  })
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
  runInstaller: (installer, timeoutMs) => runNode(process.execPath, [installer], dirname(installer), timeoutMs),
  /*
   * Where `install.cjs` takes the program from: the platform package its `package.json` lists, resolved
   * from the package's own folder. Only Windows repairs, so the platform is win32 and the file claude.exe.
   */
  nativeSize: (installer) => {
    try {
      const pkg = createRequire(installer).resolve(`@anthropic-ai/claude-code-win32-${process.arch}/package.json`)
      return statSync(join(dirname(pkg), 'claude.exe')).size
    } catch {
      return null
    }
  },
  runProgram: async (path, args, timeoutMs) => ({ status: (await runNode(path, args, undefined, timeoutMs)).status }),
}

/** Claude Code's own setup step beside `bin/claude.exe` in npm's layout, or null when there is none */
export function installerFor(exe: string, fs: ExeFs = realExeFs): string | null {
  if (basename(dirname(exe)).toLowerCase() !== 'bin') return null
  const installer = join(dirname(dirname(exe)), 'install.cjs')
  try {
    fs.stat(installer)
    return installer
  } catch {
    return null // not npm's layout: only reinstalling is advice we can stand behind
  }
}

/**
 * Why this `.exe` cannot be what Claude Code meant to install, or null when it looks like a program.
 *
 * Every Windows program starts with `MZ`. npm's placeholder is a few lines of text that Windows
 * would start, as it does any non-PE file named `.exe`, as a 16-bit program and refuse. A file that
 * is large or starts with `MZ` passes: this only names the one failure we know, never guesses.
 */
export function placeholderProblem(exe: string, size: number, fs: ExeFs = realExeFs, tried: string | null = null): string | null {
  if (size >= PLACEHOLDER_MAX_BYTES) return null
  let head: Buffer
  try {
    head = fs.head(exe, 2)
  } catch {
    return null
  }
  if (head.toString('latin1') === 'MZ') return null
  return [
    `Claude Code is not installed completely: ${exe} is a ${size}-byte placeholder, not the Claude program (about 250 MB).`,
    "Claude Code's setup step puts the real program there after npm installs the package; it did not finish, usually because a running Claude Code held the file during an install or update.",
    ...(tried ? [tried] : []),
    fixAdvice(installerFor(exe, fs)),
  ].join(' ')
}

function fixAdvice(installer: string | null): string {
  return installer
    ? `To fix it, close every Claude Code (Centralu's Claude sessions, terminals, editors) and run \`node "${installer}"\`, or reinstall with \`npm i -g @anthropic-ai/claude-code\` while no Claude Code is running.`
    : 'To fix it, close every Claude Code (Centralu\'s Claude sessions, terminals, editors) and reinstall it with `npm i -g @anthropic-ai/claude-code`.'
}

/** What the setup step left that is large enough to look like the program but is not proven to be (a copy cut short) */
function unprovenProblem(exe: string, size: number, why: string, tried: string, installer: string): string {
  return [`Claude Code is not installed completely: ${exe} is ${size} bytes and ${why}.`, tried, fixAdvice(installer)].join(' ')
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
  /** How long the package's setup step may run; default `INSTALLER_TIMEOUT_MS` */
  installerTimeoutMs?: number
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
  /** The setup step of each package this host has started, running or done: once per host start, never in a loop */
  private readonly repairs = new Map<string, Promise<void>>()
  /** What the setup step did, once it ended: what the message adds about it, and the program it left that is not proven */
  private readonly outcomes = new Map<string, { note: string; unproven: { size: number; mtimeMs: number; why: string } | null }>()
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
   * `prepare`, after repairing npm's placeholder if that is what `exe` is. Every start path awaits this,
   * so the setup step runs beside the host's loop, never in it.
   */
  async ensure(exe: string): Promise<ClaudeRun> {
    await this.repair(exe)
    return this.prepare(exe)
  }

  /**
   * What to start for the `claude.exe` found at `exe`. Off Windows, or for anything but an `.exe`
   * (a `cli.js` through Node), `exe` itself.
   *
   * @throws ClaudePlaceholderError when the file is npm's placeholder, or a setup step left a file that is not proven to be the program
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
    const installer = installerFor(exe, this.fs)
    const outcome = installer ? this.outcomes.get(installer) : undefined
    let problem = placeholderProblem(exe, stat.size, this.fs, outcome?.note ?? null)
    const bad = outcome?.unproven
    // The very file the setup step left, unchanged since: a person who fixed it by hand has a different one
    if (!problem && installer && outcome && bad && bad.size === stat.size && bad.mtimeMs === stat.mtimeMs) problem = unprovenProblem(exe, stat.size, bad.why, outcome.note, installer)
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

  /**
   * Runs the package's own setup step, once per package per host start, when `exe` is npm's placeholder
   * and `install.cjs` is beside it (the step that was meant to put the program there; nothing else runs
   * and nothing is fetched). Starts that arrive meanwhile wait for the same run. Never stops a process:
   * a file a running Claude Code holds stays a placeholder and the message says so. Never rejects.
   */
  private repair(exe: string): Promise<void> {
    if (!this.enabled || !/\.exe$/i.test(exe)) return Promise.resolve()
    let size: number
    try {
      size = this.fs.stat(exe).size
    } catch {
      return Promise.resolve()
    }
    if (placeholderProblem(exe, size, this.fs) === null) return Promise.resolve()
    const installer = installerFor(exe, this.fs)
    if (!installer) return Promise.resolve()
    let run = this.repairs.get(installer)
    if (!run) {
      run = this.runSetupStep(exe, installer).catch((err) => {
        this.log(`[claude] the setup step could not be run: ${code(err)}`)
        this.outcomes.set(installer, { note: `Centralu tried to run that setup step (\`node "${installer}"\`) and could not: ${code(err)}.`, unproven: null })
      })
      this.repairs.set(installer, run)
    }
    return run
  }

  private async runSetupStep(exe: string, installer: string): Promise<void> {
    this.log(`[claude] ${exe} is npm's placeholder; running Claude Code's own setup step, ${installer}`)
    const run = await this.fs.runInstaller(installer, this.opts.installerTimeoutMs ?? INSTALLER_TIMEOUT_MS)
    const step = `Centralu ran that setup step itself (\`node "${installer}"\`)`
    const verdict = await this.proven(exe, installer)
    if (verdict.ok) {
      this.log(`[claude] repaired ${exe}`)
      this.outcomes.set(installer, { note: `Centralu already ran that setup step once since it started (\`node "${installer}"\`) and does not run it again.`, unproven: null })
      return
    }
    const ran = run.status === null ? run.output : run.status === 0 ? '' : `exit code ${run.status}: ${firstLine(run.output)}`
    if (verdict.stat) {
      // As large as a program but not proven to be one: a copy cut short by the time limit or by a failure
      this.log(`[claude] the setup step left ${verdict.stat.size} bytes at ${exe} that are not proven to be the program (${verdict.why})${ran ? `; ${ran}` : ''}`)
      this.outcomes.set(installer, { note: `${step} and it did not finish the copy${ran ? `: ${ran}` : ''}.`, unproven: { ...verdict.stat, why: verdict.why } })
    } else if (/\b(EBUSY|EPERM|EACCES)\b/.test(run.output)) {
      this.log(`[claude] the setup step could not replace ${exe}; a running program holds it: ${firstLine(run.output)}`)
      this.outcomes.set(installer, { note: `${step} and the file is still a placeholder: it could not be replaced, usually because a running Claude Code held it.`, unproven: null })
    } else {
      const why = ran || firstLine(run.output) || 'it left the placeholder in place'
      this.log(`[claude] the setup step did not repair ${exe}: ${why}`)
      this.outcomes.set(installer, { note: `${step} and it did not repair the file: ${why}.`, unproven: null })
    }
  }

  /**
   * Whether the file at `exe` is the program. Not "large enough": a copy cut by the time limit is large.
   * It must be the size of the platform package's program it was made from; where that cannot be found,
   * it must run `--version` and exit 0.
   */
  private async proven(exe: string, installer: string): Promise<{ ok: true } | { ok: false; stat?: { size: number; mtimeMs: number }; why: string }> {
    let stat: { size: number; mtimeMs: number }
    try {
      stat = this.fs.stat(exe)
    } catch {
      return { ok: false, why: 'the file is gone' }
    }
    if (placeholderProblem(exe, stat.size, this.fs) !== null) return { ok: false, why: 'it is still the placeholder' }
    const native = this.fs.nativeSize(installer)
    if (native !== null) return stat.size === native ? { ok: true } : { ok: false, stat, why: `not the ${native} bytes of the Claude program it was copied from` }
    const version = await this.fs.runProgram(exe, ['--version'], VERSION_TIMEOUT_MS)
    return version.status === 0 ? { ok: true } : { ok: false, stat, why: 'it does not run (`--version` failed)' }
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

/** The first line of what the setup step printed: the error, before its hint */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
  return line.length > 240 ? `${line.slice(0, 240)}...` : line
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? String(err)
}

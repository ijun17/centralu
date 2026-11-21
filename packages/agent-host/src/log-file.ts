import { closeSync, existsSync, fchmodSync, openSync, statSync, writeSync } from 'node:fs'
import { traitsFor } from './os.js'
import { realOs } from './os/real.js'

/**
 * Records the host's output to a file. The Tauri supervisor passes stderr through (`Stdio::inherit`), but a `.app` launched from
 * Finder sends it to /dev/null, and `host-errors.log` is crash-only: a session that went quietly wrong (codex saying why on stderr,
 * the screen saying only "codex app-server exited") left nothing to go on. So all of stderr lands here, from a terminal or from Finder.
 */

/** Once one file exceeds this, one generation is rolled off */
export const MAX_LOG_BYTES = 8 * 1024 * 1024

/**
 * Rolls the file off to `.1` once it overflows. One generation, as a log is useful when it is recent and piling up would silently
 * eat the person's folder; logging goes on when the roll fails, as a large file is better than no log at all.
 */
export function rotateIfLarge(path: string, maxBytes: number = MAX_LOG_BYTES): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return false
    realOs().files.renameSync(path, `${path}.1`)
    return true
  } catch {
    return false
  }
}

/** The file's current size (0 if it does not exist) */
function sizeOf(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

/**
 * One log file appended to synchronously, created `0600`, and rolled off to `.1` when it overflows: the host's log (`teeStderrToFile`)
 * and an app's log (`AppLog` in apps/external) are both this, so they roll and protect their files the same way. Every failure is
 * swallowed: failing to write a log is not a reason to stop what is being logged.
 */
export class RollingFile {
  private fd: number | null = null
  private written: number
  private closed = false

  constructor(
    private readonly path: string,
    private readonly maxBytes: number = MAX_LOG_BYTES,
  ) {
    rotateIfLarge(path, maxBytes)
    this.written = sizeOf(path)
    try {
      this.fd = openSync(path, 'a', 0o600)
      // The mode above is only for a file this call creates; a log an older build made is 0644 and is narrowed here
      if (traitsFor().modesGuardFiles) fchmodSync(this.fd, 0o600)
    } catch {
      /* a file that could not be narrowed is still written to; one that could not be opened has no fd */
    }
  }

  /** Whether the file could be opened (a file that could not goes quiet; it does not throw) */
  get isOpen(): boolean {
    return this.fd !== null
  }

  write(text: string): void {
    if (this.closed) return
    try {
      if (this.fd !== null) writeSync(this.fd, text)
      this.written += Buffer.byteLength(text)
      if (this.written >= this.maxBytes) this.roll()
    } catch {
      /* even if the write fails, whatever is being logged goes on */
    }
  }

  close(): void {
    this.closed = true
    this.closeFd()
  }

  private closeFd(): void {
    try {
      if (this.fd !== null) closeSync(this.fd)
    } catch {
      /* If it was already closed, that is fine */
    }
    this.fd = null
  }

  private roll(): void {
    // A closed fd number is never held, also when the rename fails (permissions, disk): the OS soon reissues it to another file
    // (SQLite's WAL, a pty), and the next writeSync would silently corrupt that file with log lines
    this.closeFd()
    try {
      realOs().files.renameSync(this.path, `${this.path}.1`)
    } catch {
      /* If the rollover fails, keep writing to the same file — a large file beats no log */
    }
    try {
      this.fd = openSync(this.path, 'a', 0o600)
    } catch {
      /* If it cannot be opened, only the file side goes quiet — whatever else the text goes to is still alive */
    }
    // Reset to 0 even on failure — otherwise a rollover is attempted again on every line
    this.written = 0
  }
}

/**
 * Each line the file takes, with the time it was written in front (#1784, #2377), so lines are placed against each other and against
 * the store. A write can end mid-line: what the next one goes on with is not stamped again, and a blank line stays blank
 */
export function lineStamps(now: () => Date = () => new Date()): (text: string) => string {
  let atLineStart = true
  return (text) => {
    const at = now().toISOString()
    const out = text.split('\n').map((part, i) => ((i > 0 || atLineStart) && part.trim() !== '' ? `${at} ${part}` : part)).join('\n')
    if (text) atLineStart = text.endsWith('\n')
    return out
  }
}

/**
 * Mirrors stderr into a file without intercepting it: a terminal still sees it in development. Failures are swallowed, as failing
 * to log is no reason to kill the host, the parent of every session. Written synchronously: a buffered stream loses the last lines,
 * the ones wanted, when the process ends abruptly; the fd stays open, so no write reopens the file.
 */
export function teeStderrToFile(path: string, maxBytes: number = MAX_LOG_BYTES): () => void {
  const file = new RollingFile(path, maxBytes)
  if (!file.isOpen) return () => {}

  const original = process.stderr.write.bind(process.stderr)
  const stamp = lineStamps()

  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    try {
      file.write(stamp(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')))
    } catch {
      /* If it fails to write to the file, the original path below is still alive */
    }
    return original(chunk as never, enc as never, cb as never)
  }) as typeof process.stderr.write

  return () => {
    process.stderr.write = original
    file.close()
  }
}

/**
 * The startup line: the log states which build produced it, so which commit the running app was built from is never guessed from
 * the binary's mtime, and one file holding several runs shows at a glance where this one begins.
 */
export function startupBanner(info: { build: string; db: string; pid: number }): string {
  return [
    '',
    '='.repeat(72),
    '[agent-host] started',
    `  build ${info.build}`,
    `  node  ${process.version}`,
    `  pid   ${info.pid}`,
    `  db    ${info.db}`,
    '='.repeat(72),
  ].join('\n')
}

/** Unlike the crash log, this is an "always on" log — distinguished by its file name */
export function hostLogPath(dataDir: string): string {
  return `${dataDir}/host.log`
}

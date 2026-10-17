import { closeSync, existsSync, fchmodSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { modesGuardFiles } from './os.js'

/**
 * **Records the host's output to a file.**
 *
 * Not having this cost a whole day. The Tauri supervisor passes the host's stderr through with
 * `Stdio::inherit`, but a `.app` launched from Finder has stderr going **nowhere at all**
 * (/dev/null). So asking why a session did not start left nothing to go on beyond the screen's
 * message, and that message happened to obscure the real cause ("codex app-server exited"). The
 * actual cause was that codex was stating it clearly on stderr, but that line had nowhere to land.
 *
 * `host-errors.log` existed, but that is **crash-only** — it is created only when an unhandled
 * rejection or exception occurs. In a case like this one, where nothing crashed and things merely
 * went quietly wrong, that file was never even created.
 *
 * So all of stderr is transcribed here. It ends up in the same place whether launched from a
 * terminal or from Finder.
 */

/** Once one file exceeds this, one generation is rolled off */
export const MAX_LOG_BYTES = 8 * 1024 * 1024

/**
 * Rolls the file off to `.1` once it overflows. The reason for keeping only one generation: a log
 * is **useful when it is recent**, and letting it accumulate indefinitely would silently eat up the
 * user's folder. Logging must continue even if the rollover itself fails — a large file is better
 * than no log at all.
 */
export function rotateIfLarge(path: string, maxBytes: number = MAX_LOG_BYTES): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return false
    renameSync(path, `${path}.1`)
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
 * One log file that is appended to **synchronously**, created `0600`, and rolled off to `.1` when it overflows. The host's
 * log (`teeStderrToFile`) and an app's log (`AppLog` in apps/external) are both this, so they roll and protect their
 * files the same way: they were two copies, and the copy for apps opened its file `0644`.
 *
 * Every failure is **swallowed.** Failing to write a log is not a reason to stop what is being logged.
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
      if (modesGuardFiles()) fchmodSync(this.fd, 0o600)
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
    /*
     * **A closed fd number must never be held onto.**
     *
     * If rename fails after close (permissions, disk), the dead number used to be left sitting in
     * fd. The OS soon reissues that number to a different file — SQLite WAL, a pty, whatever — so
     * the next writeSync silently corrupts **someone else's file** with log lines. So even on the
     * failure path, it must always be cleared and reopened.
     */
    this.closeFd()
    try {
      renameSync(this.path, `${this.path}.1`)
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
 * Also flows stderr into a file (**mirrors it, without intercepting it**).
 *
 * It still goes out on the original stderr too — if it disappeared from view when launched from a
 * terminal, that would be more inconvenient during development. The file is "one more audience,"
 * not a replacement.
 *
 * Failures are **swallowed.** Failing to log is not a reason to kill the host (this process is the
 * parent of every session).
 *
 * **Written synchronously.** Leaving buffering to the stream would lose the last few lines whole
 * when the process ends abruptly — and those are exactly the lines we wanted to see. Since the fd
 * is kept open and only writeSync is called, there is no cost to reopening the file every time
 * either — the host's stderr is quiet to begin with.
 */
export function teeStderrToFile(path: string, maxBytes: number = MAX_LOG_BYTES): () => void {
  const file = new RollingFile(path, maxBytes)
  if (!file.isOpen) return () => {}

  const original = process.stderr.write.bind(process.stderr)

  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    try {
      file.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
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
 * The startup line. Makes the log itself state **which build produced it.**
 *
 * Answering "which commit was the running app built from" used to require matching the binary's
 * mtime against commit timestamps. If the log states it outright, that whole guessing game
 * disappears.
 *
 * Marks the start of a process **visibly** — since one file has multiple runs appended in
 * sequence, it has to be obvious at a glance where this run begins.
 */
export function startupBanner(info: { build: string; db: string; pid: number }): string {
  return [
    '',
    '='.repeat(72),
    `[agent-host] started ${new Date().toISOString()}`,
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

/** Appends a single line without keeping the file handle open (for when the stream cannot be trusted, as right before exit) */
export function appendLine(path: string, line: string): void {
  try {
    const fd = openSync(path, 'a', 0o600)
    try {
      writeSync(fd, line.endsWith('\n') ? line : `${line}\n`)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* If even the log cannot be written, do not throw again here */
  }
}

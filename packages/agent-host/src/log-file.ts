import { closeSync, existsSync, openSync, renameSync, statSync, writeSync } from 'node:fs'

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
  rotateIfLarge(path, maxBytes)
  let written = sizeOf(path)
  let fd: number | null = null
  try {
    fd = openSync(path, 'a')
  } catch {
    return () => {}
  }

  const original = process.stderr.write.bind(process.stderr)

  const roll = () => {
    /*
     * **A closed fd number must never be held onto.**
     *
     * If rename fails after close (permissions, disk), the dead number used to be left sitting in
     * fd. The OS soon reissues that number to a different file — SQLite WAL, a pty, whatever — so
     * the next writeSync silently corrupts **someone else's file** with log lines. So even on the
     * failure path, it must always be cleared and reopened.
     */
    try {
      if (fd !== null) closeSync(fd)
    } catch {
      /* If it was already closed, that is fine */
    }
    fd = null
    try {
      renameSync(path, `${path}.1`)
    } catch {
      /* If the rollover fails, keep writing to the same file — a large file beats no log */
    }
    try {
      fd = openSync(path, 'a')
    } catch {
      /* If it cannot be opened, only the file side goes quiet — the original stderr path is still alive */
    }
    // Reset to 0 even on failure — otherwise a rollover is attempted again on every line
    written = 0
  }

  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      if (fd !== null) writeSync(fd, text)
      written += Buffer.byteLength(text)
      if (written >= maxBytes) roll()
    } catch {
      /* If it fails to write to the file, the original path below is still alive */
    }
    return original(chunk as never, enc as never, cb as never)
  }) as typeof process.stderr.write

  return () => {
    process.stderr.write = original
    try {
      if (fd !== null) closeSync(fd)
    } catch {
      /* If it was already closed, that is fine */
    }
    fd = null
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
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, line.endsWith('\n') ? line : `${line}\n`)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* If even the log cannot be written, do not throw again here */
  }
}

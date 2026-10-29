/**
 * Small helpers every `centralu serve` command uses: the log line (`say`), running a program for its
 * output, a process check, and waiting.
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { renameWaitsForReaders } from './platform.mjs'

/**
 * Where `say` writes: stderr, except in a detached launcher, which nobody reads the stderr of and
 * which writes serve.log instead (`runDetachedChild`).
 */
let sink = (text) => process.stderr.write(text)

/** Writes a line to stderr, prefixed so it reads apart from the host's own log lines */
export function say(line) {
  sink(`[centralu serve] ${line}\n`)
}

/**
 * The one line `--detach`, `--stop` and `--autostart` answer with on stdout, `{ v: 1, [key]: value }`, its `message` said
 * on stderr as well. Returns the exit code: 0 when `value.ok`, else 1.
 */
export function answerLine(write, key, value) {
  if (value.message) say(value.message)
  write(`${JSON.stringify({ v: 1, [key]: value })}\n`)
  return value.ok ? 0 : 1
}

/** Points `say` at `write` from here on (a detached launcher's serve.log) */
export function sayTo(write) {
  sink = write
}

/** Blocks this thread for `ms`, for the synchronous callers that cannot await (a rename that is retried) */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** What a rename over a file says on Windows while another handle has the target open (a reader, a virus scanner) */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * `rename`, tried again for up to `budgetMs` while the system refuses it because someone has the target open (#1041;
 * `retry`: Windows only, `renameWaitsForReaders`). With `retry` off, and for any other error, it is one try. Backs off 10, 20, 40 ... 200 ms between tries; the last
 * error is thrown when the budget is spent.
 *
 * `mayTry`, when given, is asked before every try, the first too, and a false answer ends it with its error (#1405
 * review): a writer under a lock checks there that the lock is still its own, so a retry seconds later cannot land a
 * write after another writer took the lock over.
 */
export function renameRetrying(from, to, { retry = renameWaitsForReaders(), rename = renameSync, sleep = sleepSync, budgetMs = 5_000, now = Date.now, mayTry = null } = {}) {
  const t0 = now()
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    const refusal = mayTry?.()
    if (refusal) throw refusal
    try {
      return rename(from, to)
    } catch (e) {
      if (!retry || !BUSY_CODES.has(e?.code) || now() - t0 + delay > budgetMs) throw e
    }
    sleep(delay)
  }
}

/**
 * Replaces `file` with `text` at once: written to a temporary file beside it, then renamed over it, so a reader finds
 * the old file or the new one and never half of one. `mode` and `flag` are the temporary file's: a private file is
 * created with its mode from the first byte, and with `wx`, never written into a file that is already there.
 * On Windows a rename fails while a reader has the target open, so it is retried (`renameRetrying`); when it still
 * fails, the temporary file is removed and the error thrown, the old file untouched.
 */
export function replaceFile(file, text, { mode = 0o666, flag = 'w', ...rename } = {}) {
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, flag, mode)
  try {
    writeFileSync(fd, text)
  } finally {
    closeSync(fd)
  }
  try {
    renameRetrying(tmp, file, rename)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export function runCaptured(command, args, env) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      return resolve({ code: null, stdout, stderr: e.message })
    }
    child.stdout.on('data', (b) => (stdout += String(b)))
    child.stderr.on('data', (b) => (stderr += String(b)))
    child.once('error', (e) => resolve({ code: null, stdout, stderr: e.message }))
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** The last lines of a file, for a reason; empty when it cannot be read */
export function tail(file, n = 15) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n')
  } catch {
    return ''
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function waitUntil(pred, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await sleep(200)
  }
  return pred()
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

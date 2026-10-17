/**
 * Small helpers every `centralu serve` command uses: the log line (`say`), running a program for its
 * output, a process check, and waiting.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Where `say` writes: stderr, except in a detached launcher, which nobody reads the stderr of and
 * which writes serve.log instead (`runDetachedChild`).
 */
let sink = (text) => process.stderr.write(text)

/** Writes a line to stderr, prefixed so it reads apart from the host's own log lines */
export function say(line) {
  sink(`[centralu serve] ${line}\n`)
}

/** Points `say` at `write` from here on (a detached launcher's serve.log) */
export function sayTo(write) {
  sink = write
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

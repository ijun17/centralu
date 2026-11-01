// The board's one door to the operating system for starting programs (#1599, docs/plans/os-layer.md §2.4): `gh` for
// GitHub, `git` for the checkout, Node for the judges and pre-pr, and project.json's conflict commands. Every module
// of this app starts a program through `runProgram` here, never through node:child_process itself.
//
// Tests only: `PROJECT_BOARD_FAKE_PROGRAMS` names a module whose exports, each named for a program (`gh`), answer it
// in this process instead of starting it: `(args, { input, cwd, env }) => { code, stdout, stderr }`. A fake `gh` on
// PATH costs a process start per call (on Windows a launcher and Node, about 60 ms), and a merge queue test makes
// dozens; in this process a call costs well under a millisecond. Whatever the module does not name is started as
// always. The real start (quoting, PATH lookup, a launcher, stdin) keeps tests of its own that start real programs.
import { execFile as startProgram, spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const fakes = process.env.PROJECT_BOARD_FAKE_PROGRAMS ? await import(pathToFileURL(process.env.PROJECT_BOARD_FAKE_PROGRAMS).href) : {}

/** The fake answering `file`, by its name without a folder or `.exe` (`gh`, `C:\x\gh.exe`), or null */
const fakeFor = (file) => {
  const name = basename(String(file)).replace(/\.exe$/i, '')
  return Object.hasOwn(fakes, name) && typeof fakes[name] === 'function' ? fakes[name] : null
}

/**
 * node:child_process's `execFile(file, args, options, callback)`, through this door. A faked program answers after the
 * caller has had the turn to write its input (`child.stdin.end(input)`), and fails as a started one would: an `Error`
 * whose `code` is the exit code, with stdout and stderr passed to the callback.
 */
export function execFile(file, args, options, callback) {
  const fake = fakeFor(file)
  if (!fake) return startProgram(file, args, options, callback)
  let input
  const stdin = { on: () => stdin, end: (text) => void (input = text === undefined ? input : String(text)), write: (text) => void (input = (input ?? '') + String(text)) }
  setImmediate(() => {
    let out
    try {
      out = fake(args, { input: input ?? null, cwd: options?.cwd, env: options?.env ?? process.env })
    } catch (e) {
      out = { code: 1, stdout: '', stderr: String(e?.stack ?? e) }
    }
    const { code = 0, stdout = '', stderr = '' } = out ?? {}
    if (code === 0) return callback(null, stdout, stderr)
    const error = Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr}`), { code, killed: false })
    callback(error, stdout, stderr)
  })
  return { stdin, pid: undefined, kill: () => false }
}

/**
 * `execFile`'s contract (`callback(error, stdout, stderr)`, the same error) over `spawn`, for a child that leads a process group
 * of its own (`detached`): execFile passes spawn only some of its options, and that one is not among them, so a group
 * kill (`stopTree`) would find no group and end the child alone.
 */
function spawnDetached(file, args, { maxBuffer, killSignal, ...options }, callback) {
  const child = spawn(file, args, options)
  const out = { stdout: '', stderr: '' }
  let error = null
  let done = false
  const finish = () => {
    if (done) return
    done = true
    callback(error, out.stdout, out.stderr)
  }
  for (const name of ['stdout', 'stderr']) {
    child[name].setEncoding('utf8')
    child[name].on('data', (text) => {
      out[name] += text
      if (error || out[name].length <= maxBuffer) return
      out[name] = out[name].slice(0, maxBuffer)
      error = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      child.kill(killSignal)
    })
  }
  child.once('error', (e) => {
    error ??= e
    if (child.pid === undefined) finish() // it did not start: nothing else will come
  })
  child.once('close', (code, signal) => {
    if (!error && (code || signal)) error = Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}
${out.stderr}`), { code, signal, killed: child.killed })
    finish()
  })
  return child
}

/** Stops a process and everything it started (tsc, vitest and pnpm run under a script); resolves when it has exited. */
export function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    if (process.platform === 'win32') startProgram(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], () => {})
    else {
      try {
        // Started detached (`tree`), so it leads a process group of its own
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  })
}

/**
 * Runs `file` without a shell: `{ stdout, stderr }`, or a rejection with node's error plus `stdout` and `stderr` as
 * strings, so each caller keeps its own message for `code` and `killed`. Other options go to `execFile`.
 * - `timeoutMs` (or `signal`, then `aborted`) ends the run, which is then `timedOut` and `killed` whatever the child wrote or
 *   exited with: a forced end exits with a code, and a caller reading that or stderr would miss the time-out (#1842).
 * - `tree` ends the child and all it started, not the child alone (its grandchildren would hold the pipes and the call
 *   would wait), and stops waiting 5 s after a child's exit for the pipes of a process it left running.
 * - `input` goes to stdin; a child that stops reading it is not a crash here.
 */
export function runProgram(file, args, { timeoutMs, input, maxBuffer = 64 * 1024 * 1024, tree = false, signal, ...options } = {}) {
  return new Promise((resolve, reject) => {
    let stoppedBy = null
    let timer
    let lingering
    const detached = tree && process.platform !== 'win32' // so that it leads a process group of its own, which stopTree ends whole
    const child = (detached ? spawnDetached : execFile)(file, args, { maxBuffer, ...options, detached }, (error, stdout, stderr) => {
      clearTimeout(timer)
      clearTimeout(lingering)
      signal?.removeEventListener('abort', onAbort)
      if (!error) return resolve({ stdout, stderr })
      if (stoppedBy) Object.assign(error, { [stoppedBy]: true, killed: true })
      reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
    })
    const stop = (why) => {
      if (stoppedBy) return
      stoppedBy = why
      // As node's own time-out does: let go of the pipes first, so a process the child started and left holding them cannot keep the call waiting
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (tree) void stopTree(child)
      else child.kill(options.killSignal)
    }
    const onAbort = () => stop('aborted')
    // 0 is no limit, as in node; a longer one than a timer takes would fire at once
    if (timeoutMs) timer = setTimeout(() => stop('timedOut'), Math.min(2_147_483_647, timeoutMs))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    if (tree)
      child.once('exit', () => {
        lingering = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }, 5_000)
        lingering.unref()
      })
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

// The board's one door to the operating system for starting programs (#1599, docs/plans/os-layer.md §2.4): `gh` for
// GitHub, `git` for the checkout, Node for the judges and pre-pr, and project.json's conflict commands. Every module
// of this app starts a program through `runProgram` here, never through node:child_process itself.
//
// Tests only: `PROJECT_BOARD_FAKE_PROGRAMS` names a module whose exports, each named for a program (`gh`), answer it
// in this process instead of starting it: `(args, { input, cwd, env }) => { code, stdout, stderr }`. A fake `gh` on
// PATH costs a process start per call (on Windows a launcher and Node, about 60 ms), and a merge queue test makes
// dozens; in this process a call costs well under a millisecond. Whatever the module does not name is started as
// always. The real start (quoting, PATH lookup, a launcher, stdin) keeps tests of its own that start real programs.
import { spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const fakes = process.env.PROJECT_BOARD_FAKE_PROGRAMS ? await import(pathToFileURL(process.env.PROJECT_BOARD_FAKE_PROGRAMS).href) : {}

/** The fake answering `file`, by its name without a folder or `.exe` (`gh`, `C:\x\gh.exe`), or null */
const fakeFor = (file) => {
  const name = basename(String(file)).replace(/\.exe$/i, '')
  return Object.hasOwn(fakes, name) && typeof fakes[name] === 'function' ? fakes[name] : null
}

/** Stops a process and everything it started (tsc, vitest and pnpm run under a script); resolves when it has exited. */
export function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    if (process.platform === 'win32') spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else {
      try {
        process.kill(-child.pid, 'SIGKILL') // started detached (`tree`), so it leads a process group of its own
      } catch {
        child.kill('SIGKILL')
      }
    }
  })
}

/**
 * Runs `file` without a shell: `{ stdout, stderr }`, or a rejection with node's execFile error (`code`, `signal`, `killed`, 'ENOENT',
 * 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') plus `stdout` and `stderr` as strings, so each caller keeps its own message. Other options go to spawn.
 * `timeoutMs` (0: none) or `signal` ends the run, which is then `timedOut` or `aborted` and `killed` whatever the child wrote or exited
 * with (a forced end exits with a code: #1842), after letting go of the pipes a process the child left running may hold.
 * `tree` ends all the child started too, and waits 5 s at most after its exit for such pipes. `input` goes to stdin.
 */
export function runProgram(file, args, { timeoutMs, input, maxBuffer = 64 * 1024 * 1024, tree = false, signal, ...options } = {}) {
  let child
  const run = new Promise((resolve, reject) => {
    const out = { stdout: '', stderr: '' }
    let error = null
    let stoppedBy = null
    let done = false
    let timer, lingering
    const end = (code, sig) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(lingering)
      signal?.removeEventListener('abort', onAbort)
      if (!error && (code || sig)) error = Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n${out.stderr}`), { code, signal: sig })
      if (!error) return resolve(out)
      reject(Object.assign(error, out, { killed: Boolean(stoppedBy || child.killed), ...(stoppedBy && { [stoppedBy]: true }) }))
    }
    const fake = fakeFor(file)
    if (fake) {
      let fed = null
      const stdin = { on: () => stdin, end: (text) => void (fed = text === undefined ? fed : String(text)), write: (text) => void (fed = (fed ?? '') + String(text)) }
      child = { stdin, pid: undefined, kill: () => false, once: () => {} }
      setImmediate(() => {
        let answer
        try {
          answer = fake(args, { input: fed, cwd: options.cwd, env: options.env ?? process.env })
        } catch (e) {
          answer = { code: 1, stderr: String(e?.stack ?? e) }
        }
        Object.assign(out, { stdout: answer?.stdout ?? '', stderr: answer?.stderr ?? '' })
        end(answer?.code ?? 0, null)
      })
    } else {
      // Detached so that it leads a process group of its own, which stopTree ends whole (Windows has taskkill /T instead)
      child = spawn(file, args, { ...options, detached: tree && process.platform !== 'win32' })
      for (const name of ['stdout', 'stderr']) {
        child[name].setEncoding('utf8')
        child[name].on('data', (text) => {
          out[name] += text
          if (error || out[name].length <= maxBuffer) return
          out[name] = out[name].slice(0, maxBuffer)
          error = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
          child.kill(options.killSignal)
        })
      }
      child.once('error', (e) => {
        error ??= e
        if (child.pid === undefined) end(null, null) // it did not start: nothing else will come
      })
      child.once('close', end)
    }
    const release = () => [child.stdout, child.stderr].forEach((pipe) => pipe?.destroy())
    const stop = (why) => {
      if (stoppedBy) return
      stoppedBy = why
      release()
      if (tree) void stopTree(child)
      else child.kill(options.killSignal)
    }
    const onAbort = () => stop('aborted')
    // 0 is no limit, as in node; a longer one than a timer takes would fire at once
    if (timeoutMs) timer = setTimeout(() => stop('timedOut'), Math.min(2_147_483_647, timeoutMs))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    if (tree) child.once('exit', () => (lingering = setTimeout(release, 5_000).unref()))
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
  return Object.assign(run, { child })
}

/** `execFile(file, args, options, callback)`'s shape over runProgram, for the tests that feed the child's stdin themselves; `options.timeout` is the limit */
export function execFile(file, args, { timeout, ...options } = {}, callback) {
  const run = runProgram(file, args, { timeoutMs: timeout, ...options })
  run.then(({ stdout, stderr }) => callback(null, stdout, stderr), (e) => callback(e, e.stdout ?? '', e.stderr ?? ''))
  return run.child
}

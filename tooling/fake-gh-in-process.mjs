// The fake `gh` answered inside the board app's process (tooling/fake-gh.test-helpers.ts `fakeGh(…, { inProcess: true })`,
// the app's system.mjs `PROJECT_BOARD_FAKE_PROGRAMS`, #1599): the same script the started fake runs, given what a started
// program has of its own, and nothing of the app's.
//
// - Its stdin is the call's input, as fd 0: `fs.readFileSync(0)`, `fs.readSync(0, …)` and `/dev/stdin` read it. Any other
//   use of fd 0 is an error, never the app's own stdin (in the app, its channel to Centralu).
// - Its `process` and `console` have only what is listed in `GIVEN`; reading anything else is an error that names it,
//   not `undefined`, so a script that needs more says so instead of misbehaving.
// - Its output is the call's: `process.stdout`, `process.stderr` and `console` never reach the app's own streams.
//
// What it does not model: a timeout, a program not found (ENOENT), concurrency (each call answers whole, in order) and
// reading stdin as a stream; tooling/project-board-system.test.ts holds the started program to those.
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import process from 'node:process'

const realRequire = createRequire(import.meta.url)
const EXIT = Symbol('exit')
const GIVEN = {
  process: 'argv, env, stdin (fd 0), stdout, stderr, exit, exitCode, cwd and platform',
  console: 'log, info, error and warn',
  'process.stdin': 'fd: read it with fs.readFileSync(0) or fs.readSync(0, …)',
}

/** `target` with only its own members: reading any other is an error naming it; only `exitCode` may be set */
function strict(target, what) {
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'symbol' || Object.hasOwn(t, key)) return Reflect.get(t, key)
      throw new Error(`${what}.${key} is not given to a script in the in-process fake gh (tooling/fake-gh-in-process.mjs), which gives ${GIVEN[what]}`)
    },
    set(t, key, value) {
      if (key !== 'exitCode') throw new Error(`${what}.${String(key)} cannot be set in the in-process fake gh`)
      t.exitCode = value
      return true
    },
  })
}

/** node:fs for the script, whose fd 0 is `input`: what a started program reads as its stdin */
function fsWithStdin(input) {
  const fs = realRequire('node:fs')
  let at = 0
  const isStdin = (p) => p === 0 || p === '/dev/stdin'
  return new Proxy(fs, {
    get(t, key) {
      const real = Reflect.get(t, key)
      if (key === 'readFileSync') {
        return (p, options) => {
          if (!isStdin(p)) return real.call(t, p, options)
          const rest = input.subarray(at)
          at = input.length
          const encoding = typeof options === 'string' ? options : options?.encoding
          return encoding ? rest.toString(encoding) : Buffer.from(rest)
        }
      }
      if (key === 'readSync') {
        return (fd, buffer, ...more) => {
          if (fd !== 0) return real.call(t, fd, buffer, ...more)
          // (fd, buffer, offset, length, position) or (fd, buffer, { offset, length })
          const o = typeof more[0] === 'object' && more[0] !== null ? more[0] : { offset: more[0], length: more[1] }
          const offset = o.offset ?? 0
          const length = Math.min(o.length ?? buffer.byteLength - offset, input.length - at)
          input.copy(buffer, offset, at, at + length)
          at += length
          return length
        }
      }
      if (typeof real !== 'function') return real
      return (p, ...more) => {
        if (isStdin(p)) throw new Error(`fs.${String(key)} on stdin is not given by the in-process fake gh: read it with fs.readFileSync(0) or fs.readSync(0, …)`)
        return real.call(t, p, ...more)
      }
    },
  })
}

/**
 * The fake as `system.mjs` calls it: `(args, { input, cwd, env }) => { code, stdout, stderr }`, running `script` (the
 * started fake's own text) once per call.
 */
export function inProcessGh(script) {
  const body = new Function('process', 'console', 'require', script)
  return function gh(args, { input = null, cwd, env = {} } = {}) {
    let stdout = ''
    let stderr = ''
    let exited = null
    const out = { write: (s) => ((stdout += String(s)), true) }
    const err = { write: (s) => ((stderr += String(s)), true) }
    const given = {
      argv: [process.execPath, 'gh', ...args],
      env: { ...env },
      stdin: strict({ fd: 0 }, 'process.stdin'),
      stdout: out,
      stderr: err,
      exitCode: undefined,
      exit: (code) => {
        exited = code ?? given.exitCode ?? 0
        throw EXIT
      },
      cwd: () => cwd ?? process.cwd(),
      platform: process.platform,
    }
    const fs = fsWithStdin(Buffer.from(input ?? ''))
    const require = (id) => (id === 'fs' || id === 'node:fs' ? fs : realRequire(id))
    const line = (stream) => (...parts) => void stream.write(parts.map(String).join(' ') + '\n')
    const console = strict({ log: line(out), info: line(out), error: line(err), warn: line(err) }, 'console')
    let code
    try {
      body(strict(given, 'process'), console, require)
      code = given.exitCode ?? 0
    } catch (e) {
      if (e === EXIT) code = exited
      else {
        stderr += String(e && e.stack ? e.stack : e)
        code = 1
      }
    }
    return { code, stdout, stderr }
  }
}

// The board's one door to the operating system for starting programs (#1599, docs/plans/os-layer.md §2.4): `gh` for
// GitHub, `git` for the checkout, Node for the judges and pre-pr, and project.json's conflict commands. Every module
// of this app starts a program through `execFile` or `spawn` here, never through node:child_process itself.
//
// Tests only: `PROJECT_BOARD_FAKE_PROGRAMS` names a module whose exports, each named for a program (`gh`), answer it
// in this process instead of starting it: `(args, { input, cwd, env }) => { code, stdout, stderr }`. A fake `gh` on
// PATH costs a process start per call (on Windows a launcher and Node, about 60 ms), and a merge queue test makes
// dozens; in this process a call costs well under a millisecond. Whatever the module does not name is started as
// always. The real start (quoting, PATH lookup, a launcher, stdin) keeps tests of its own that start real programs.
import { execFile as startProgram, spawn as spawnProgram } from 'node:child_process'
import { basename } from 'node:path'
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

/** node:child_process's `spawn`, through this door; never faked (pre-pr's long run, read as it goes) */
export const spawn = (...args) => spawnProgram(...args)

import { mkdtempSync, realpathSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { endLeftoverFakes, fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
// @ts-expect-error -- a plain .mjs of tooling without types
import { inProcessGh as untypedInProcessGh } from './fake-gh-in-process.mjs'
import { SLOW, eventually } from './test-timing.js'

/**
 * The board app's door to the OS for starting programs (.centralu/apps/project-board/system.mjs, #1599): what the merge
 * queue and release tests no longer exercise, since their fake `gh` answers in the app's own process. These tests start
 * real programs: the fake `gh` through its launcher (on Windows an `.exe` that starts Node, with Windows' quoting of the
 * arguments), found on the PATH, fed its input on stdin. And they hold the in-process fake to the started one: the same
 * script, the same calls, the same answers.
 */
const SYSTEM = new URL('../.centralu/apps/project-board/system.mjs', import.meta.url).href

type ExecFile = (file: string, args: string[], options: Record<string, unknown>, callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void) => { stdin: { on(e: string, f: () => void): unknown; end(s?: string): void } }
type Failure = Error & { code?: unknown; killed?: boolean; timedOut?: boolean; aborted?: boolean; stdout: string; stderr: string }
type RunOptions = { timeoutMs?: number; input?: string; maxBuffer?: number; tree?: boolean; signal?: AbortSignal }
type System = { execFile: ExecFile; runProgram(file: string, args: string[], options?: RunOptions): Promise<{ stdout: string; stderr: string }> }
type Gh = (args: string[], call: { input?: string | null; cwd?: string; env?: Record<string, string> }) => { code: number; stdout: string; stderr: string }

/** system.mjs as the app loads it, with `env` set while it is read (it reads PROJECT_BOARD_FAKE_PROGRAMS then) */
async function system(env: Record<string, string> = {}): Promise<System> {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  // A query of its own: a fresh copy of the module, read with this environment
  return (await import(/* @vite-ignore */ `${SYSTEM}?t=${Math.random()}`)) as System
}

/** One call through `execFile`, as github.mjs makes it: the answer, or the failure's exit code */
function call(sys: System, args: string[], env: Record<string, string>, input?: string) {
  return new Promise<{ code: unknown; stdout: string; stderr: string }>((resolve) => {
    const child = sys.execFile('gh', args, { env, windowsHide: true, timeout: 30_000 * SLOW }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr) }),
    )
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

// Echoes what it was given; `fail <n>` exits with n after writing to both streams; `log` writes through console
const ANSWER = String.raw`
if (args[0] === 'log') { console.log('logged', 1); console.error('to stderr'); process.exit(0) }
if (args[0] === 'fail') { process.stdout.write('partial'); process.stderr.write('gh: no such thing (HTTP 404)\n'); process.exit(Number(args[1])) }
st.n = (st.n ?? 0) + 1
save()
process.stdout.write(JSON.stringify({ args, stdin, n: st.n, prompt: process.env.GH_PROMPT_DISABLED ?? null }))
`

let root = ''
let gh: FakeGh
afterEach(() => {
  vi.unstubAllEnvs()
  rmFakeDir(root)
})
afterAll(() => {
  endLeftoverFakes()
}, 60_000 * SLOW)

function make() {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-board-system-')))
  gh = fakeGh(root, ANSWER, { inProcess: true })
  return gh
}

// What the app's callers send: spaces, quotes, a GraphQL query over lines, shell and cmd.exe characters, non-ASCII
const AWKWARD = ['api', 'graphql', '-f', 'query=query { a(b: "c d") }\n  { e }', '-F', 'n=1', '--jq', '.a | "x y"', 'a&b|c^d%PATH%', '"quoted"', '', 'é 한 😀', 'back\\slash\\']

describe("the board app's door for starting programs", { timeout: 60_000 * SLOW }, () => {
  it('starts gh from the PATH with every argument as written, and its input on stdin', async () => {
    make()
    const env = gh.env({ GH_PROMPT_DISABLED: '1' })
    // Not faked: PROJECT_BOARD_FAKE_PROGRAMS is in `env` (the program's), not in the app's own environment
    const sys = await system()
    const r = await call(sys, AWKWARD, env, '{"body":"line one\\nline two é"}')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ args: AWKWARD, stdin: null, n: 1, prompt: '1' })
    const withInput = await call(sys, ['api', '--input', '-'], env, '{"body":"line one\\nline two é"}')
    expect(JSON.parse(withInput.stdout).stdin).toBe('{"body":"line one\\nline two é"}')
    expect(gh.calls().map((c) => c.args)).toEqual([AWKWARD, ['api', '--input', '-']])
  })

  it('fails as a started program does: the exit code, and what it wrote on both streams', async () => {
    make()
    const sys = await system()
    expect(await call(sys, ['fail', '3'], gh.env())).toEqual({ code: 3, stdout: 'partial', stderr: 'gh: no such thing (HTTP 404)\n' })
  })

  it('says ENOENT for a program the PATH does not have', async () => {
    make()
    const sys = await system()
    const r = await call(sys, ['x'], { ...gh.env(), PATH: join(root, 'nowhere') })
    expect(r.code).toBe('ENOENT')
  })

  it('answers in the app process, with the same script, exactly as the started gh does', async () => {
    make()
    const env = gh.env({ GH_PROMPT_DISABLED: '1' })
    const started = await system()
    const inProcess = await system({ PROJECT_BOARD_FAKE_PROGRAMS: env.PROJECT_BOARD_FAKE_PROGRAMS! })
    const cases: Array<[string[], string | undefined]> = [
      [AWKWARD, undefined],
      [['api', '--input', '-', 'repos/x/y/issues'], '{"title":"a \\"b\\" é"}\n'],
      [['fail', '3'], undefined],
      [['fail', '0'], undefined],
      [['log'], undefined],
    ]
    for (const [args, input] of cases) {
      gh.setState({})
      const a = await call(started, args, env, input)
      gh.setState({})
      const b = await call(inProcess, args, env, input)
      expect(b, JSON.stringify(args)).toEqual(a)
    }
    // Each call logged once, the same way: started, then in process, case by case
    const log = gh.calls()
    expect(log).toHaveLength(cases.length * 2)
    for (let i = 0; i < cases.length; i++) expect(log[2 * i + 1]).toEqual(log[2 * i])
  })

  it('answers a faked program only by its name, and starts any other', async () => {
    make()
    const sys = await system({ PROJECT_BOARD_FAKE_PROGRAMS: gh.env().PROJECT_BOARD_FAKE_PROGRAMS! })
    // A started program has a process id; one answered in this process has none
    const pid = (child: unknown) => (child as { pid?: number }).pid
    let started: unknown
    const node = await new Promise<string>((resolve, reject) => {
      started = sys.execFile(process.execPath, ['-e', 'process.stdout.write("real")'], {}, (e, out) => (e ? reject(e) : resolve(out)))
    })
    expect(node).toBe('real')
    expect(pid(started)).toEqual(expect.any(Number))
    // gh.exe and a full path name the same program, and neither is started
    let byName: unknown
    let byPath: unknown
    const r = await new Promise<string>((resolve) => {
      byName = sys.execFile('gh', ['x'], { env: gh.env() }, (_e, out) => resolve(out))
    })
    const viaPath = await new Promise<string>((resolve) => {
      byPath = sys.execFile(join(gh.bin, process.platform === 'win32' ? 'gh.exe' : 'gh'), ['y'], { env: gh.env() }, (_e, out) => resolve(out))
    })
    expect(JSON.parse(r).args).toEqual(['x'])
    expect(JSON.parse(viaPath).args).toEqual(['y'])
    expect([pid(byName), pid(byPath)]).toEqual([undefined, undefined])
    expect(gh.calls()).toHaveLength(2)
  })

})

/** What `runProgram` rejects with, or fails the test when it resolves */
const failureOf = async (run: Promise<unknown>) => {
  try {
    await run
  } catch (e) {
    return e as Failure
  }
  throw new Error('it did not fail')
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const NODE = process.execPath

describe("the board app's runProgram", { timeout: 60_000 * SLOW }, () => {
  it('answers stdout and stderr, and puts the input on stdin', async () => {
    const sys = await system()
    const echo = 'process.stdin.pipe(process.stdout); process.stderr.write("seen")'
    const input = '{"body":"line one\\nline two é 한"}'
    expect(await sys.runProgram(NODE, ['-e', echo], { input })).toEqual({ stdout: input, stderr: 'seen' })
    // A child that never reads its input is not a crash here: its exit code is the answer
    const failed = await failureOf(sys.runProgram(NODE, ['-e', 'process.exit(3)'], { input: 'x'.repeat(8 * 1024 * 1024) }))
    expect(failed.code).toBe(3)
  })

  it('rejects with the exit code and both streams as strings, ENOENT for a program that is not there', async () => {
    const sys = await system()
    const failed = await failureOf(sys.runProgram(NODE, ['-e', 'process.stdout.write("part"); process.stderr.write("bad\\n"); process.exit(5)']))
    expect([failed.code, failed.stdout, failed.stderr, failed.killed, failed.timedOut]).toEqual([5, 'part', 'bad\n', false, undefined])
    const missing = await failureOf(sys.runProgram(join(tmpdir(), 'cc-no-such-program-here'), []))
    expect([missing.code, missing.stdout, missing.stderr]).toEqual(['ENOENT', '', ''])
  })

  it('refuses output past maxBuffer, and takes more than node\'s own 1 MB without one', async () => {
    const sys = await system()
    const write = (n: number) => `process.stdout.write("x".repeat(${n}))`
    const failed = await failureOf(sys.runProgram(NODE, ['-e', write(5000)], { maxBuffer: 1000 }))
    expect(failed.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(failed.timedOut).toBeUndefined()
    expect((await sys.runProgram(NODE, ['-e', write(3 * 1024 * 1024)])).stdout).toHaveLength(3 * 1024 * 1024)
  })

  it('reports a time-out as the time-out, whatever the child wrote and however it ended (#1842)', async () => {
    const sys = await system()
    // It says something that reads like a failure of its own, then hangs: the caller maps `killed` before it reads the code or stderr
    const hang = 'process.stderr.write("fatal: the child own message\\n"); setInterval(() => {}, 1000)'
    for (const tree of [false, true]) {
      const failed = await failureOf(sys.runProgram(NODE, ['-e', hang], { timeoutMs: 1000 * SLOW, tree }))
      expect([failed.timedOut, failed.killed, failed.aborted], `tree ${tree}`).toEqual([true, true, undefined])
    }
    // Not ended early: a run that finishes in time is no time-out, and its timer does not keep the process
    expect((await sys.runProgram(NODE, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 60_000 * SLOW })).stdout).toBe('ok')
  })

  it('lets go of the pipes at a time-out, so a process the child left running does not hold the call (#1842)', async () => {
    const sys = await system()
    // The child starts a detached grandchild that keeps its pipes for 60 s, and hangs: git's helpers and a cmd.exe shim's pnpm do this
    const parent = `
      const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: true })
      g.unref()
      process.stdout.write(String(g.pid))
      setInterval(() => {}, 1000)`
    const started = Date.now()
    const failed = await failureOf(sys.runProgram(NODE, ['-e', parent], { timeoutMs: 2000 * SLOW }))
    expect(failed.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(30_000)
    // A grandchild's id is only in stdout when the pipe was still open when it was written
    if (failed.stdout) process.kill(Number(failed.stdout))
  })

  it('takes a time-out of 0 as no limit, as node does', async () => {
    const sys = await system()
    expect((await sys.runProgram(NODE, ['-e', 'setTimeout(() => process.stdout.write("late"), 1500)'], { timeoutMs: 0 })).stdout).toBe('late')
  })

  it('ends the whole process tree on a time-out, or an abort, with `tree`: the child and what it started', async () => {
    const sys = await system()
    // The child starts a grandchild that holds its pipes and prints its id; without the tree's end the call would wait for it
    const parent = `
      const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
      process.stdout.write(String(g.pid))
      setInterval(() => {}, 1000)`
    const grandchild = async (stdout: string) => {
      const pid = Number(stdout)
      expect(pid).toBeGreaterThan(0)
      await eventually(() => !alive(pid), 15_000)
    }
    const timedOut = await failureOf(sys.runProgram(NODE, ['-e', parent], { timeoutMs: 2000 * SLOW, tree: true }))
    expect(timedOut.timedOut).toBe(true)
    await grandchild(timedOut.stdout)
    const controller = new AbortController()
    const run = failureOf(sys.runProgram(NODE, ['-e', parent], { tree: true, signal: controller.signal }))
    await sleep(2000 * SLOW)
    controller.abort()
    const aborted = await run
    expect([aborted.aborted, aborted.killed, aborted.timedOut]).toEqual([true, true, undefined])
    await grandchild(aborted.stdout)
    // Already aborted: it is stopped at once, not started to run
    const early = await failureOf(sys.runProgram(NODE, ['-e', 'setInterval(() => {}, 1000)'], { tree: true, signal: AbortSignal.abort() }))
    expect(early.aborted).toBe(true)
  })

  it('does not wait for ever for the pipes of a process the child left running, with `tree`', async () => {
    const sys = await system()
    // The child ends at once; a grandchild it leaves holds the pipes for 60 s
    const parent = `
      const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: true })
      g.unref()
      process.stdout.write('done ' + g.pid)`
    const started = Date.now()
    const { stdout } = await sys.runProgram(NODE, ['-e', parent], { tree: true })
    expect(stdout).toMatch(/^done \d+$/)
    expect(Date.now() - started).toBeLessThan(30_000)
    // It was left running by design: end it now rather than wait out its 60 s
    process.kill(Number(stdout.slice(5)))
  })

  // node's execFile does not pass `detached` on to spawn, so a group kill found no group and ended the child alone (Linux, macOS)
  it.skipIf(process.platform === 'win32')('starts a tree run as the leader of a process group of its own, and any other in its parent\'s', async () => {
    const sys = await system()
    const probe = 'try { process.kill(-process.pid, 0); process.stdout.write("leader") } catch { process.stdout.write("member") }'
    expect((await sys.runProgram(NODE, ['-e', probe], { tree: true })).stdout).toBe('leader')
    expect((await sys.runProgram(NODE, ['-e', probe])).stdout).toBe('member')
  })

  it('stopTree answers at once for a process that has ended', async () => {
    const sys = (await system()) as System & { stopTree(child: unknown): Promise<void> }
    const done = await new Promise<unknown>((resolve) => {
      const c = sys.execFile(NODE, ['-e', ''], {}, () => resolve(c))
    })
    await sys.stopTree(done)
  })
})

const inProcessGh = untypedInProcessGh as (script: string) => Gh

describe('the in-process fake gh: what a script is given', () => {
  it("reads the call's input as its stdin, by fd 0 however it reads it, and never the app's own", () => {
    const gh = inProcessGh(String.raw`
const fs = require('node:fs')
if (process.argv[2] === 'whole') process.stdout.write(fs.readFileSync(0, { encoding: 'utf8' }))
if (process.argv[2] === 'chunks') {
  const b = Buffer.alloc(3)
  let n
  while ((n = fs.readSync(0, b, 0, 3, null)) > 0) process.stdout.write(b.subarray(0, n).toString() + '|')
}
if (process.argv[2] === 'stat') fs.fstatSync(0)
`)
    expect(gh(['whole'], { input: 'é {"a":1}\n' }).stdout).toBe('é {"a":1}\n')
    expect(gh(['chunks'], { input: 'abcdefg' }).stdout).toBe('abc|def|g|')
    expect(gh(['whole'], {}).stdout).toBe('')
    const stat = gh(['stat'], { input: 'x' })
    expect(stat.code).toBe(1)
    expect(stat.stderr).toContain('fs.fstatSync on stdin is not given by the in-process fake gh')
  })

  it('has a process and a console of only what it lists: anything else is an error naming it, not undefined', () => {
    const gh = inProcessGh(String.raw`
if (process.argv[2] === 'given') { process.stdout.write([process.platform === require('node:process').platform, process.cwd()].join(' ')); process.exitCode = 4 }
if (process.argv[2] === 'time') process.hrtime()
if (process.argv[2] === 'stream') process.stdin.on('data', () => {})
if (process.argv[2] === 'table') console.table([])
if (process.argv[2] === 'set') process.title = 'x'
`)
    expect(gh(['given'], { cwd: '/w' })).toEqual({ code: 4, stdout: 'true /w', stderr: '' })
    for (const [arg, named] of [['time', 'process.hrtime'], ['stream', 'process.stdin.on'], ['table', 'console.table'], ['set', 'process.title']]) {
      const r = gh([arg!], {})
      expect(r.code, arg).toBe(1)
      expect(r.stderr, arg).toContain(named)
      expect(r.stdout, arg).toBe('')
    }
  })
})

describe("the board app's clock", () => {
  it('is the one the queue reads, which only a stepped test moves on; the lease reads the system clock', async () => {
    vi.resetModules()
    const clock = (await import(/* @vite-ignore */ `${new URL('../.centralu/apps/project-board/clock.mjs', import.meta.url).href}?t=${Math.random()}`)) as {
      now(): number
      systemNow(): number
      advanceClock(ms: number): void
    }
    const before = Date.now()
    expect(clock.now()).toBeGreaterThanOrEqual(before)
    clock.advanceClock(60_000)
    expect(clock.now() - Date.now()).toBeGreaterThanOrEqual(59_000)
    expect(Math.abs(clock.systemNow() - Date.now())).toBeLessThan(1_000)
  })
})

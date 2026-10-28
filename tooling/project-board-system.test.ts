import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { endLeftoverFakes, fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
// @ts-expect-error -- a plain .mjs of tooling without types
import { inProcessGh as untypedInProcessGh } from './fake-gh-in-process.mjs'
import { SLOW } from './test-timing.js'

/**
 * The board app's door to the OS for starting programs (.centralu/apps/project-board/system.mjs, #1599): what the merge
 * queue and release tests no longer exercise, since their fake `gh` answers in the app's own process. These tests start
 * real programs: the fake `gh` through its launcher (on Windows an `.exe` that starts Node, with Windows' quoting of the
 * arguments), found on the PATH, fed its input on stdin. And they hold the in-process fake to the started one: the same
 * script, the same calls, the same answers.
 */
const SYSTEM = new URL('../.centralu/apps/project-board/system.mjs', import.meta.url).href

type ExecFile = (file: string, args: string[], options: Record<string, unknown>, callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void) => { stdin: { on(e: string, f: () => void): unknown; end(s?: string): void } }
type System = { execFile: ExecFile }
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

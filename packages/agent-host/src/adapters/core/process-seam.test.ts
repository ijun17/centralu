import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpawnSpec } from '../contract.js'
import type { FrameRecorder } from '../frames/recorder.js'
import { fakeAgentCli, goneWithin, helperPid, killLeftovers, ownCli } from '../fake-agent-cli.test-helpers.js'
import { GateRequests, type GateAnswer } from './gate.js'
import { SessionProcess, startToolProcess, stopToolProcess, type ToolLaunch } from './tool-process.js'
import { SLOW } from '../../../../../tooling/test-timing.js'

/**
 * The process seam (docs/plans/session-core.md §7.2 PR 3): one start and one stop for every tool, and what Antigravity
 * needs of it as measured on `agy` 1.4.7 (#1654): a launch asked again for each new process, an id learned after the
 * start, and a Stop that denies every open gate request before the process hears of it.
 */

// Real processes below: a node start costs seconds on a loaded machine
vi.setConfig({ testTimeout: 30_000 * SLOW })

const recorded: string[] = []
const recorder: FrameRecorder = { frame: (direction, line) => recorded.push(`${direction}:${line}`), exit: () => recorded.push('exit') }
vi.mock('../frames/recorder.js', () => ({ frameRecorder: () => recorder }))
beforeEach(() => {
  recorded.length = 0
})

/** A process as far as the seam goes; `log` is what was done to it, in order */
class FakeProc extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  constructor(
    readonly log: string[],
    readonly name = 'p',
    /** What it does on stdin's end: exit at once, or nothing (a wedged tool) */
    endsOnEof = true,
  ) {
    super()
    this.stdin.on('finish', () => {
      log.push(`${name}:eof`)
      if (endsOnEof) this.exit(0)
    })
    this.stdin.resume()
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.log.push(`${this.name}:${signal}`)
    this.killed = true
    if (signal === 'SIGKILL') this.exit(null, signal)
    return true
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

describe('starting a tool', () => {
  const spec: AgentSpawnSpec = { command: 'tool', args: ['serve'], cwd: '/work', env: {} }

  it('started here, ends with this host, whatever the tool asked (#1654 Q3: every tool)', () => {
    const specs: AgentSpawnSpec[] = []
    startToolProcess({ ...spec, endsWithHost: false }, { spawn: (s) => (specs.push(s), new FakeProc([])) })
    expect(specs).toEqual([{ ...spec, endsWithHost: true }])
  })

  it('under the keeper, is the keeper’s, which outlives the host by design: no host watch', () => {
    const specs: AgentSpawnSpec[] = []
    const local = vi.fn()
    startToolProcess({ ...spec, endsWithHost: true }, { spawn: local, source: { spawn: (s) => (specs.push(s), new FakeProc([])) } })
    expect(specs).toEqual([spec])
    expect(local).not.toHaveBeenCalled()
  })

  it('records a session’s process before anyone reads it, and a lookup process not at all', () => {
    const tapped = new FakeProc([])
    startToolProcess(spec, { sessionId: 's1', spawn: () => tapped })
    tapped.stdout.write('{"a":1}\n')
    const plain = new FakeProc([])
    startToolProcess(spec, { spawn: () => plain })
    plain.stdout.write('{"b":1}\n')
    expect(recorded).toEqual(['in:{"a":1}'])
  })
})

describe('stopping a tool', () => {
  it('ends its stdin and waits: a tool that ends on that is not killed', async () => {
    const log: string[] = []
    await stopToolProcess(new FakeProc(log), { graceMs: 5_000 })
    expect(log).toEqual(['p:eof'])
  })

  it('kills the tree of a tool still there after the bound', async () => {
    const log: string[] = []
    await stopToolProcess(new FakeProc(log, 'p', false), { graceMs: 20 })
    expect(log).toEqual(['p:eof', 'p:SIGKILL'])
  })

  it('waits for nothing when the caller already saw it end', async () => {
    const proc = new FakeProc([], 'p', false)
    await stopToolProcess(proc, { graceMs: 60_000, exited: true })
    expect(proc.stdin.writableEnded).toBe(true)
    expect(proc.killed).toBe(false)
  })
})

describe("a session's process across its replacements (agy)", () => {
  function session(resume: string | null = null) {
    const log: string[] = []
    const asked: ({ externalId: string } | null)[] = []
    let n = 0
    const launch: ToolLaunch = async (r) => {
      asked.push(r)
      log.push('launch')
      return { command: 'agy', args: r ? ['--conversation', r.externalId] : [], env: {} }
    }
    const procs: FakeProc[] = []
    const sp = new SessionProcess('Antigravity', launch, { spawn: () => (procs.push(new FakeProc(log, `p${++n}`)), procs.at(-1)!) }, resume)
    return { sp, log, asked, procs }
  }

  it('asks the launch again for each process, on the conversation whose id the tool said after it started', async () => {
    const { sp, asked } = session()
    await sp.start()
    // agy says its id only in `init`, after the first input
    sp.noteExternalId('conv-1')
    await sp.relaunch()
    expect(asked).toEqual([null, { externalId: 'conv-1' }])
    expect(sp.externalId).toBe('conv-1')
  })

  it('goes on with a resumed conversation from its first process', async () => {
    const { sp, asked } = session('conv-0')
    await sp.start()
    expect(asked).toEqual([{ externalId: 'conv-0' }])
  })

  it('ends the process before it launches the next', async () => {
    const { sp, log } = session()
    await sp.start()
    await sp.relaunch()
    expect(log).toEqual(['launch', 'p1:eof', 'launch'])
  })

  it('starts again after its process ended on its own (agy exits on SIGINT), and not while one runs', async () => {
    const { sp, procs } = session()
    await sp.start()
    await expect(sp.start()).rejects.toThrow(/already running/)
    procs[0]!.exit(1)
    const next = await sp.start()
    expect(next).toBe(procs[1])
  })

  it('says a tool that is not installed', async () => {
    const sp = new SessionProcess('Antigravity', async () => null, { spawn: () => new FakeProc([]) }, null)
    await expect(sp.start()).rejects.toMatchObject({ code: 'tool_not_installed' })
  })

  it('denies every open gate request before a Stop signals the process: agy does not act on SIGINT while a hook waits', async () => {
    const { sp, procs } = session()
    await sp.start()
    const answers = [sp.gates.wait('call-1'), sp.gates.wait('call-2')]
    let openAtSignal = -1
    procs[0]!.kill = (signal) => ((openAtSignal = sp.gates.size), signal === 'SIGINT')
    expect(sp.interrupt()).toBe(true)
    expect(openAtSignal).toBe(0)
    expect(await Promise.all(answers)).toEqual([
      { decision: 'deny', reason: 'The turn was stopped.' },
      { decision: 'deny', reason: 'The turn was stopped.' },
    ])
  })

  it('denies every open gate request before it closes the process, and every one asked after', async () => {
    const { sp, log } = session()
    await sp.start()
    const answer = sp.gates.wait('call-1').then((a) => (log.push('denied'), a))
    await sp.close()
    expect(await answer).toEqual({ decision: 'deny', reason: 'The session is closing.' })
    expect(log.indexOf('denied')).toBeLessThan(log.indexOf('p1:eof'))
    expect(sp.current).toBeNull()
    expect(await sp.gates.wait('call-2')).toEqual({ decision: 'deny', reason: 'The session is closing.' })
    await expect(sp.start()).rejects.toThrow(/closed/)
  })

  it('denies every open gate request when a Stop or a relaunch begins, before the process is signalled', async () => {
    const { sp, log } = session()
    await sp.start()
    const stopped = sp.gates.wait('call-1').then((a) => (log.push('denied-stop'), a))
    const done = sp.stop('The user stopped.')
    expect(sp.gates.size).toBe(0)
    expect(await stopped).toEqual({ decision: 'deny', reason: 'The user stopped.' })
    await done
    expect(log.indexOf('denied-stop')).toBeLessThan(log.indexOf('p1:eof'))
    await sp.start()
    const restarted = sp.gates.wait('call-2')
    const relaunched = sp.relaunch()
    expect(await restarted).toEqual({ decision: 'deny', reason: 'The session is restarting.' })
    await relaunched
  })

  it('denies a gate request a process asks while it is being stopped, at once, and takes requests again once the next one runs', async () => {
    const log: string[] = []
    const procs: FakeProc[] = []
    const sp = new SessionProcess('Antigravity', async () => ({ command: 'agy', args: [], env: {} }), { graceMs: 300, spawn: () => (procs.push(new FakeProc(log, `p${procs.length + 1}`, false)), procs.at(-1)!) }, null)
    await sp.start()
    const done = sp.stop()
    // The tool ignores stdin's end and is still there for the grace: its hook asks now
    await vi.waitFor(() => expect(log).toContain('p1:eof'))
    expect(await sp.gates.wait('late')).toEqual({ decision: 'deny', reason: 'The turn was stopped.' })
    expect(sp.gates.size).toBe(0)
    await done
    await sp.start()
    void sp.gates.wait('next')
    expect(sp.gates.size).toBe(1)
    await sp.close()
  })

  /** A session whose launch waits until `go()` (agy is looked for, its plugin root written) */
  function slowSession() {
    const log: string[] = []
    const waiting: (() => void)[] = []
    let n = 0
    const launch: ToolLaunch = (r) =>
      new Promise((resolve) => waiting.push(() => resolve({ command: 'agy', args: r ? ['--conversation', r.externalId] : [], env: {} })))
    const procs: FakeProc[] = []
    const sp = new SessionProcess('Antigravity', launch, { spawn: () => (procs.push(new FakeProc(log, `p${++n}`)), procs.at(-1)!) }, null)
    const go = async () => {
      while (waiting.length === 0) await new Promise((r) => setImmediate(r))
      waiting.shift()!()
    }
    return { sp, log, procs, go }
  }

  it('stops what a start still waiting for its launch starts, when a Stop comes meanwhile', async () => {
    const { sp, log, go } = slowSession()
    const started = sp.start()
    const stopped = sp.stop()
    await go()
    await started
    await stopped
    expect(log).toEqual(['p1:eof'])
    expect(sp.current).toBeNull()
  })

  it('starts nothing once closed while a launch was asked for', async () => {
    const { sp, procs, go } = slowSession()
    const started = sp.start()
    // The launch has been asked for
    await new Promise((r) => setImmediate(r))
    const closed = sp.close()
    await go()
    await expect(started).rejects.toThrow(/closed/)
    await closed
    expect(procs).toEqual([])
  })

  it('leaves one process after two relaunches asked at once (a model and an effort change)', async () => {
    const { sp, procs, go } = slowSession()
    const first = sp.start()
    await go()
    await first
    const a = sp.relaunch()
    const b = sp.relaunch()
    await go()
    await a
    await go()
    await b
    expect(procs.map((p) => p.exitCode === null)).toEqual([false, false, true])
    expect(sp.current).toBe(procs[2])
  })

  it('keeps the id the current process said, not a late one from the process it replaced', async () => {
    const { sp, procs } = session()
    await sp.start()
    await sp.relaunch()
    sp.noteExternalId('conv-new', procs[1])
    sp.noteExternalId('conv-old', procs[0])
    expect(sp.externalId).toBe('conv-new')
  })
})

describe('the open gate requests', () => {
  it('give each its answer once', async () => {
    const gates = new GateRequests()
    const answer = gates.wait('a')
    expect(gates.answer('a', { decision: 'allow' })).toBe(true)
    expect(gates.answer('a', { decision: 'deny', reason: 'late' })).toBe(false)
    expect(await answer).toEqual({ decision: 'allow' })
  })

  it('deny one asked again, so no hook is left waiting', async () => {
    const gates = new GateRequests()
    const first = gates.wait('a')
    const second = gates.wait('a')
    gates.answer('a', { decision: 'allow' })
    const answers: GateAnswer[] = await Promise.all([first, second])
    expect(answers.map((a) => a.decision)).toEqual(['deny', 'allow'])
  })
})

describe('a real tool through the seam, on this OS', () => {
  const started: number[] = []
  afterEach(() => killLeftovers(started))

  it('is stopped with the helper it started, the tool ending on stdin’s end', async () => {
    const proc = startToolProcess({ ...fakeAgentCli(), env: process.env })
    const helper = await helperPid(proc.stdout)
    started.push(helper, ownCli(proc))
    await stopToolProcess(proc, { graceMs: 10_000 * SLOW })
    expect(proc.killed).toBe(false)
    expect(await goneWithin(proc.pid!, 10_000 * SLOW)).toBe(true)
    expect(await goneWithin(helper, 10_000 * SLOW)).toBe(true)
  })

  it('is stopped with the helper it started, the tool deaf to stdin’s end and to SIGTERM', async () => {
    const cli = fakeAgentCli({ ignoreTerm: true })
    const deaf = { command: cli.command, args: cli.args.map((a) => a.replace("process.stdin.on('end', () => process.exit(0))", '')) }
    const proc = startToolProcess({ ...deaf, env: process.env })
    const helper = await helperPid(proc.stdout)
    started.push(helper, ownCli(proc))
    await stopToolProcess(proc, { graceMs: 200 })
    expect(proc.killed).toBe(true)
    expect(await goneWithin(proc.pid!, 10_000 * SLOW)).toBe(true)
    expect(await goneWithin(helper, 10_000 * SLOW)).toBe(true)
  })
})

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { CoreSession } from './ledger.js'
import type { CoreIo, RunningTurn, ToolWire, TurnEnding, TurnInput } from './seam.js'

/**
 * The ledger once, on a scripted wire in memory (docs/plans/session-core.md §6.2, §7.2 PR 5): no frames, no real process.
 * The main test is model-based: random sequences of inputs, Stops, the tool's turn ends, exits and the close, run against
 * the ledger and against a small model of what it promises, for two kinds of tool: one prompt at a time (ACP), and a tool
 * whose Stop ends its process and whose id comes late (`agy`, §8). A tool that takes input mid-turn has a ledger of its own
 * (`mid-turn-ledger.test.ts`).
 */

/** A process as far as the ledger goes: ends on stdin's end, on SIGKILL, and (the `agy` measurement) on SIGINT */
class FakeProc extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 1
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  constructor(readonly name: string) {
    super()
    this.stdin.on('finish', () => this.exit(0))
    this.stdin.resume()
  }
  stderrTail(): string {
    return `${this.name} last words`
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    if (signal === 'SIGKILL' || signal === 'SIGINT') this.exit(null, signal)
    return true
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

type Kind = 'acp' | 'agy'

const TURNS: Record<Kind, ToolWire['turns']> = {
  acp: { interruptEndsProcess: false },
  agy: { interruptEndsProcess: true },
}

/** A wire that writes nothing: it says what it was asked, and the test ends its turns */
class ScriptedWire implements ToolWire {
  readonly label = 'Tool'
  readonly install = 'Install it with its installer.'
  /** The tool was removed since the session started: its launch answers null, or its program is not there */
  gone: 'no' | 'launch' | 'spawn' = 'no'
  readonly turns: ToolWire['turns']
  readonly log: string[] = []
  readonly launches: ({ externalId: string } | null)[] = []
  readonly opens: ({ externalId: string } | null)[] = []
  /** What the wire was asked to write, `<text>@<process>` */
  readonly writes: string[] = []
  readonly turnsSeen: RunningTurn[] = []
  readonly ios: CoreIo[] = []
  /** `agy`: the id comes in `init`, after the first input, not from `open` */
  private readonly idLate: boolean
  private saidId = new Set<CoreIo>()

  constructor(
    kind: Kind,
    readonly spawned: FakeProc[] = [],
    turns: Partial<ToolWire['turns']> = {},
  ) {
    this.turns = { ...TURNS[kind], ...turns }
    this.idLate = kind === 'agy'
  }

  readonly launch = async (resume: { externalId: string } | null) => {
    this.launches.push(resume)
    if (this.gone === 'launch') return null
    return { command: 'tool', args: resume ? ['--conversation', resume.externalId] : [], env: {} }
  }

  async open(io: CoreIo, resume: { externalId: string } | null): Promise<{ externalId: string | null }> {
    this.ios.push(io)
    this.opens.push(resume)
    // A real wire waits for the tool's first answer, so a start that failed is heard while it opens
    if (this.gone === 'spawn') await new Promise((r) => setImmediate(r))
    if (this.idLate) return { externalId: null }
    return { externalId: resume?.externalId ?? 'conv-1' }
  }

  get io(): CoreIo | undefined {
    return this.ios.at(-1)
  }

  startTurn(input: TurnInput, turn: RunningTurn): void {
    const io = this.ios.at(-1)
    if (!io) throw new Error('no process')
    this.writes.push(`${input.text}@${(io.process as unknown as FakeProc).name}`)
    io.inputAccepted(input.id)
    if (!this.turnsSeen.includes(turn)) this.turnsSeen.push(turn)
    if (this.idLate && !this.saidId.has(io)) {
      this.saidId.add(io)
      io.externalId(this.opens.at(-1)?.externalId ?? 'conv-1')
    }
  }

  interrupt(): void {
    this.log.push('interrupt')
  }

  turnOver(why?: string): void {
    this.log.push(why === undefined ? 'turnOver' : `turnOver:${why}`)
  }

  releaseCards(): void {
    this.log.push('releaseCards')
  }

  async close(opts: { turnRunning: boolean }): Promise<void> {
    this.log.push(`close:${opts.turnRunning}`)
  }

  /** Ends the turn the core started last */
  end(ending: TurnEnding): void {
    this.turnsSeen.at(-1)?.end(ending)
  }
}

/** Lets the ledger's own awaits (a launch, an open, a stop) run out */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

function world(kind: Kind, opts: { stopConfirmMs?: number; resume?: string | null; turns?: Partial<ToolWire['turns']> } = {}) {
  const spawned: FakeProc[] = []
  const wire = new ScriptedWire(kind, spawned, opts.turns)
  const events: NormalizedEvent[] = []
  const session = new CoreSession(
    {
      sessionId: 's1',
      resumeExternalId: opts.resume ?? null,
      start: {
        spawn: () => {
          const proc = new FakeProc(`p${spawned.length + 1}`)
          spawned.push(proc)
          // As Node's spawn says a program that is not there: an `error` on the next tick, never an `exit`
          if (wire.gone === 'spawn') process.nextTick(() => proc.emit('error', Object.assign(new Error('spawn tool ENOENT'), { code: 'ENOENT' })))
          return proc
        },
      },
      stopConfirmMs: opts.stopConfirmMs ?? 60_000,
    },
    (e) => events.push(e),
    wire,
  )
  return { wire, events, session, spawned }
}

/** The events the ledger owns, in a short form */
function said(events: readonly NormalizedEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.type === 'state_change') return [e.state === 'working' ? 'working' : `waiting:${e.reason ?? ''}`]
    if (e.type === 'turn_complete') return ['complete']
    if (e.type === 'session_live') return [`live:${e.reason ?? ''}`]
    if (e.type === 'error') return [e.error.code === 'adapter_crashed' ? 'crashed' : e.error.message.includes('still queued') ? 'undelivered' : `error:${e.error.retryable}`]
    return []
  })
}

type Action = { do: 'send' } | { do: 'stop' } | { do: 'end'; how: 'complete' | 'interrupted' | 'failed' | 'refused' } | { do: 'exit' } | { do: 'dispose' }

/** What the ledger promises, as plainly as it can be said */
class Model {
  phase: 'ready' | 'closed' = 'ready'
  running: string[] | null = null
  stopAsked = false
  queue: string[] = []
  outcome = new Map<string, 'complete' | 'fail'>()
  said: string[] = []
  writes: string[] = []
  proc = 1
  procAlive = true

  constructor(private readonly kind: Kind) {}

  step(a: Action, name: string): void {
    switch (a.do) {
      case 'send':
        if (this.phase === 'closed') this.outcome.set(name, 'fail')
        else this.queue.push(name)
        break
      case 'stop':
        if (this.phase !== 'ready' || !this.running) break
        this.stopAsked = true
        // `agy`: SIGINT ends the process, and its exit ends the turn it stopped
        if (this.kind === 'agy') {
          this.procAlive = false
          this.end('interrupted')
        }
        break
      case 'end':
        if (this.phase === 'ready' && this.running) this.end(a.how)
        break
      case 'exit':
        if (this.phase === 'closed' || !this.procAlive) break
        this.procAlive = false
        this.phase = 'closed'
        if (this.queue.length) this.said.push('undelivered')
        for (const q of this.queue.splice(0)) this.outcome.set(q, 'fail')
        if (this.running) for (const r of this.running) this.outcome.set(r, 'fail')
        this.said.push(this.running ? 'crashed' : 'live:asleep')
        this.running = null
        break
      case 'dispose':
        if (this.phase === 'closed') break
        this.phase = 'closed'
        if (this.queue.length) this.said.push('undelivered')
        for (const q of [...this.queue.splice(0), ...(this.running ?? [])]) this.outcome.set(q, 'fail')
        this.running = null
    }
    this.drain()
  }

  private end(how: 'complete' | 'interrupted' | 'failed' | 'refused'): void {
    const inputs = this.running ?? []
    const failed = how === 'failed' || (how === 'interrupted' && this.stopAsked)
    this.said.push(how === 'complete' ? 'complete' : how === 'interrupted' ? `waiting:${this.stopAsked ? 'interrupted' : 'interrupted_by_tool'}` : `error:${how === 'failed'}`)
    for (const i of inputs) this.outcome.set(i, failed ? 'fail' : 'complete')
    this.running = null
    this.stopAsked = false
  }

  private drain(): void {
    while (this.phase === 'ready' && this.queue.length) {
      if (this.running) return
      if (!this.procAlive) {
        // Only a tool whose Stop ends its process gets here: the next input starts a new one on the same conversation
        this.proc++
        this.procAlive = true
      }
      const next = this.queue.shift() ?? ''
      if (!this.running) {
        this.running = []
        this.said.push('working')
      }
      this.running.push(next)
      this.writes.push(`${next}@p${this.proc}`)
    }
  }
}

/** mulberry32: a small seeded generator, so a failing sequence can be run again from its seed */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function actions(next: () => number, length: number): Action[] {
  const out: Action[] = []
  for (let i = 0; i < length; i++) {
    const r = next()
    if (r < 0.35) out.push({ do: 'send' })
    else if (r < 0.5) out.push({ do: 'stop' })
    else if (r < 0.85) out.push({ do: 'end', how: (['complete', 'interrupted', 'failed', 'refused'] as const)[Math.floor(next() * 4)] ?? 'complete' })
    else if (r < 0.95) out.push({ do: 'exit' })
    else out.push({ do: 'dispose' })
  }
  return out
}

const ENDINGS: Record<'complete' | 'interrupted' | 'failed' | 'refused', TurnEnding> = {
  complete: { how: 'complete' },
  interrupted: { how: 'interrupted' },
  failed: { how: 'failed', error: { code: 'internal', message: 'Tool: no answer', retryable: true }, inputError: new Error('no answer') },
  refused: { how: 'failed', error: { code: 'internal', message: 'Tool refused', retryable: false }, inputError: null },
}

async function runAgainstModel(kind: Kind, seed: number): Promise<void> {
  const w = world(kind)
  await w.session.ready
  const model = new Model(kind)
  const outcome = new Map<string, 'complete' | 'fail'>()
  const steps = actions(rng(seed), 14)
  for (const [i, a] of steps.entries()) {
    const name = `m${i}`
    if (a.do === 'send') {
      w.session.sendTracked(name).then(
        () => outcome.set(name, 'complete'),
        () => outcome.set(name, 'fail'),
      )
    } else if (a.do === 'stop') w.session.interrupt()
    else if (a.do === 'end') w.wire.end(ENDINGS[a.how])
    else if (a.do === 'exit') {
      const live = w.spawned.at(-1)
      if (live && live.exitCode === null && live.signalCode === null) live.exit(1)
    } else await w.session.dispose()
    model.step(a, name)
    await settle()
  }
  const context = `${kind} seed ${seed}: ${JSON.stringify(steps)}`
  expect(said(w.events), context).toEqual(model.said)
  expect(w.wire.writes, context).toEqual(model.writes)
  expect(Object.fromEntries(outcome), context).toEqual(Object.fromEntries(model.outcome))
  await w.session.dispose()
}

describe('the ledger against its model', () => {
  for (const kind of ['acp', 'agy'] as const) {
    it(`keeps what it promises for a ${kind} tool over random inputs, Stops, turn ends, exits and the close`, async () => {
      for (let seed = 1; seed <= 150; seed++) await runAgainstModel(kind, seed)
    })
  }
})

describe('the ledger, case by case', () => {
  it('says a Stop the tool has not acted on, once its bound has passed, and nothing for one it ended in time', async () => {
    const w = world('acp', { stopConfirmMs: 5 })
    await w.session.ready
    w.session.send('a')
    w.session.interrupt()
    w.session.interrupt()
    await new Promise((r) => setTimeout(r, 40))
    expect(w.events.filter((e) => e.type === 'notice')).toHaveLength(1)
    w.wire.end({ how: 'interrupted' })
    w.session.send('b')
    w.session.interrupt()
    w.wire.end({ how: 'interrupted' })
    await new Promise((r) => setTimeout(r, 40))
    expect(w.events.filter((e) => e.type === 'notice')).toHaveLength(1)
    // Every Stop pressed reaches the tool (ACP sends `session/cancel` each time); the timer runs once a turn
    expect(w.wire.log.filter((l) => l === 'interrupt')).toHaveLength(3)
    await w.session.dispose()
  })

  it('releases the cards on a Stop, at the turn’s end, on an exit and on the close; ends the calls a closed turn left open', async () => {
    const w = world('acp')
    await w.session.ready
    w.session.send('a')
    w.session.interrupt()
    w.wire.end({ how: 'interrupted' })
    w.session.send('b')
    await w.session.dispose()
    expect(w.wire.log).toEqual([
      'interrupt',
      'releaseCards',
      'turnOver',
      'releaseCards',
      'releaseCards',
      'turnOver:Centralu stopped this session while the call ran',
      'close:true',
    ])
    const crashed = world('acp')
    await crashed.session.ready
    crashed.spawned[0]?.exit(1)
    expect(crashed.wire.log).toEqual(['releaseCards'])
  })

  it("names the input the last turn took by the host's name, and accepts each as the wire writes it", async () => {
    const w = world('acp')
    await w.session.ready
    const seen: string[] = []
    w.session.send('a', { id: 'name-a' })
    void w.session.sendTracked('b', { accepted: () => seen.push('b:accepted'), complete: () => seen.push('b:complete'), fail: () => seen.push('b:fail') })
    expect(seen).toEqual([])
    w.wire.end({ how: 'complete' })
    expect(w.session.turnInputs()).toEqual(['name-a'])
    expect(seen).toEqual(['b:accepted'])
    w.wire.end({ how: 'complete' })
    expect(w.session.turnInputs()).toEqual([])
    expect(seen).toEqual(['b:accepted', 'b:complete'])
    await w.session.dispose()
  })

  it("puts the process's last words in a crash, after the marker that keeps them from being read as the turn's failure", async () => {
    const w = world('acp')
    await w.session.ready
    w.session.send('a')
    w.spawned[0]?.exit(3)
    expect(w.events.find((e) => e.type === 'error')).toMatchObject({ error: { code: 'adapter_crashed', message: 'Tool exited (code 3). stderr: p1 last words', retryable: true } })
  })

  it('takes a failed start and the exit after it as one end', async () => {
    const w = world('acp')
    await w.session.ready
    w.spawned[0]?.emit('error', new Error('spawn tool ENOENT'))
    w.spawned[0]?.exit(1)
    expect(said(w.events)).toEqual(['live:asleep'])
  })

  it('a crash while opening is a crash, not sleep', async () => {
    const wire = new ScriptedWire('acp')
    let started: FakeProc | undefined
    wire.open = async (io) => {
      started = io.process as unknown as FakeProc
      started.exit(1)
      throw new Error('Tool exited')
    }
    const events: NormalizedEvent[] = []
    const session = new CoreSession({ sessionId: 's1', resumeExternalId: null, start: { spawn: () => new FakeProc('p1') } }, (e) => events.push(e), wire)
    await expect(session.ready).rejects.toThrow('Tool exited')
    expect(said(events)).toEqual(['crashed'])
    expect(started?.exitCode).toBe(1)
  })

  it('fails what is sent to a closed session, with no event', async () => {
    const w = world('acp')
    await w.session.ready
    await w.session.dispose()
    await expect(w.session.sendTracked('late')).rejects.toThrow('Tool session is closed')
    expect(w.events).toEqual([])
  })
})

describe('a tool whose Stop ends its process (agy, session-core.md §8)', () => {
  it('queues what is sent mid-turn, and after a Stop starts a new process on the conversation the first one named in init', async () => {
    const w = world('agy')
    await w.session.ready
    expect(w.session.externalId).toBeNull()
    w.session.send('one')
    w.session.send('two')
    expect(w.wire.writes).toEqual(['one@p1'])
    expect(w.session.externalId).toBe('conv-1')
    w.session.interrupt()
    expect(w.spawned[0]?.signalCode).toBe('SIGINT')
    await settle()
    expect(w.wire.writes).toEqual(['one@p1', 'two@p2'])
    expect(w.wire.launches).toEqual([null, { externalId: 'conv-1' }])
    expect(w.wire.opens).toEqual([null, { externalId: 'conv-1' }])
    expect(said(w.events)).toEqual(['working', 'waiting:interrupted', 'working'])
    await w.session.dispose()
  })

  it("starts nothing new until an input comes, and ignores an id a replaced process says late", async () => {
    const w = world('agy', { resume: 'conv-7' })
    await w.session.ready
    w.session.send('one')
    const first = w.wire.io
    w.session.interrupt()
    await settle()
    expect(w.spawned).toHaveLength(1)
    w.session.send('two')
    await settle()
    expect(w.spawned).toHaveLength(2)
    first?.externalId('stale')
    expect(w.session.externalId).toBe('conv-7')
    expect(w.wire.launches).toEqual([{ externalId: 'conv-7' }, { externalId: 'conv-7' }])
    await w.session.dispose()
  })

  it('denies the gate requests open when a Stop comes, before the process hears it, and those asked after the close', async () => {
    const w = world('agy')
    await w.session.ready
    w.session.send('one')
    const gates = w.wire.io?.gates
    const asked = gates?.wait('r1')
    let openAtSignal: number | undefined
    w.spawned[0]?.once('exit', () => (openAtSignal = gates?.size))
    w.session.interrupt()
    expect(await asked).toMatchObject({ decision: 'deny' })
    expect(openAtSignal).toBe(0)
    await w.session.dispose()
    expect(await gates?.wait('r2')).toMatchObject({ decision: 'deny' })
  })

  it('a new process that ends while it opens is a crash, and one that cannot open is stopped, not left running', async () => {
    for (const how of ['exits', 'throws'] as const) {
      const w = world('agy')
      await w.session.ready
      w.session.send('one')
      w.session.interrupt()
      const open = w.wire.open.bind(w.wire)
      w.wire.open = async (io, resume) => {
        if (how === 'exits') (io.process as unknown as FakeProc).exit(1)
        await open(io, resume)
        throw new Error('no init')
      }
      const waiting = w.session.sendTracked('two')
      await expect(waiting).rejects.toThrow()
      await settle()
      expect(said(w.events)).toEqual(['working', 'waiting:interrupted', 'undelivered', 'crashed'])
      expect(w.spawned[1]?.exitCode).not.toBeNull()
    }
  })

  it('fails the input a wire could not write, and goes on with the next', async () => {
    const w = world('acp')
    await w.session.ready
    const start = w.wire.startTurn.bind(w.wire)
    w.wire.startTurn = (input, turn) => {
      if (input.text === 'bad') throw new Error('cannot write')
      start(input, turn)
    }
    await expect(w.session.sendTracked('bad')).rejects.toThrow('cannot write')
    w.session.send('good')
    expect(w.wire.writes).toEqual(['good@p1'])
    expect(said(w.events)).toEqual(['working', 'error:true', 'working'])
    await w.session.dispose()
  })

  it('says a tool removed since the start is not installed, with how to install it, when a new process finds it gone', async () => {
    for (const gone of ['launch', 'spawn'] as const) {
      const w = world('agy')
      await w.session.ready
      w.session.send('one')
      w.session.interrupt()
      w.wire.gone = gone
      await expect(w.session.sendTracked('two')).rejects.toThrow('still queued')
      await settle()
      const errors = w.events.filter((e) => e.type === 'error')
      expect(errors, gone).toMatchObject([
        { error: { code: 'internal', retryable: false } },
        { error: { code: 'tool_not_installed', message: 'Tool is not installed. Install it with its installer.', retryable: false } },
      ])
    }
  })

  it('an exit of its own, not after a Stop, is still a crash in a turn and asleep when idle', async () => {
    const busy = world('agy')
    await busy.session.ready
    busy.session.send('one')
    busy.spawned[0]?.exit(1)
    expect(said(busy.events)).toEqual(['working', 'crashed'])
    const idle = world('agy')
    await idle.session.ready
    idle.spawned[0]?.exit(0)
    expect(said(idle.events)).toEqual(['live:asleep'])
  })
})

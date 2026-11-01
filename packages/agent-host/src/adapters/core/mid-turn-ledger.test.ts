import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL } from '../contract.js'
import { MidTurnLedger } from './mid-turn-ledger.js'
import type { MidTurnInput, MidTurnWire } from './seam.js'

/**
 * The ledger for a tool that takes input mid-turn, on a scripted wire in memory (docs/plans/session-core.md §4.2, §7.2 PR 6):
 * the tool names its turns and says which took an input; the test plays the tool. Codex's own tests drive the same rules
 * through its frames (`codex/*.test.ts`).
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setImmediate(r))

type Write = { inputs: readonly MidTurnInput[]; texts: string[]; queued: boolean; reply: ReturnType<typeof deferred<unknown>> }

class Wire implements MidTurnWire {
  readonly label = 'Tool'
  ledger!: MidTurnLedger
  readonly opened = deferred()
  readonly writes: Write[] = []
  readonly interrupts: string[] = []
  readonly log: string[] = []
  refuseStop: string | null = null
  /** The tool has named the conversation (`hasConversation`) */
  conversation = false

  constructor(private readonly said: string[]) {}

  open(): Promise<void> {
    return this.opened.promise
  }

  hasConversation(): boolean {
    return this.conversation
  }

  write(inputs: readonly MidTurnInput[], queued: boolean): { answer: Promise<unknown>; blocking?: boolean } {
    const reply = deferred<unknown>()
    this.writes.push({ inputs, texts: inputs.map((i) => i.text), queued, reply })
    this.said.push(`write:${inputs.map((i) => i.text).join('+')}`)
    return { answer: reply.promise, blocking: !queued && inputs[0]?.text === '/compact' }
  }

  refusal(err: Error) {
    return { code: 'internal' as const, message: `refused: ${err.message}`, retryable: true }
  }

  interrupt(turnId: string): Promise<unknown> {
    this.interrupts.push(turnId)
    return this.refuseStop ? Promise.reject(new Error(this.refuseStop)) : Promise.resolve()
  }

  releaseCards(): void {
    this.log.push('releaseCards')
  }

  connectionEnded(): void {
    this.log.push('connectionEnded')
  }

  async close(): Promise<void> {
    this.log.push('close')
  }

  async detach(): Promise<void> {
    this.log.push('detach')
  }

  /** The tool answers write `n`, naming the turn that took it */
  answer(n: number, turnId: string | null): void {
    const w = this.writes[n]!
    this.ledger.taken(w.inputs, turnId)
    w.reply.resolve(undefined)
  }
}

function setup() {
  const events: NormalizedEvent[] = []
  const said: string[] = []
  const wire = new Wire(said)
  const ledger = new MidTurnLedger('s1', (e) => {
    events.push(e)
    said.push(e.type === 'state_change' ? `${e.state}:${e.reason ?? ''}` : e.type)
  }, wire)
  wire.ledger = ledger
  const observe = (name: string) => ({ accepted: () => said.push(`${name}:accepted`), complete: () => said.push(`${name}:complete`), fail: (e: Error) => said.push(`${name}:fail ${e.message}`) })
  return { events, said, wire, ledger, observe }
}

async function ready() {
  const s = setup()
  s.wire.opened.resolve()
  await s.ledger.ready
  return s
}

describe('a tool that takes input mid-turn: the queue', () => {
  it('holds what is sent while the conversation opens and writes it one by one once open', async () => {
    const { wire, ledger } = setup()
    ledger.send('a')
    ledger.send('b')
    await tick()
    expect(wire.writes).toEqual([])
    wire.opened.resolve()
    await ledger.ready
    expect(wire.writes.map((w) => [w.texts, w.queued])).toEqual([[['a'], false], [['b'], false]])
  })

  it('a Stop while it opens drops what was sent, fails the tracked, and says the stop itself, as no turn will (#168)', async () => {
    const { wire, ledger, said, observe } = setup()
    ledger.send('a')
    void ledger.sendTracked('b', observe('b')).catch(() => {})
    ledger.interrupt()
    expect(said).toEqual(['b:fail The parent note was stopped before it finished', 'waiting_input:interrupted'])
    ledger.send('c')
    wire.opened.resolve()
    await ledger.ready
    expect(wire.writes.map((w) => w.texts)).toEqual([['c']])
  })

  it('a Stop once the tool named the conversation, still opening, keeps what was sent: a turn may run there (an adopted one)', async () => {
    const { wire, ledger, said, observe } = setup()
    wire.conversation = true
    ledger.send('a')
    void ledger.sendTracked('b', observe('b')).catch(() => {})
    ledger.interrupt()
    expect(said).toEqual(['b:fail The parent note was stopped before it finished'])
    ledger.taken([], 'adopted')
    wire.opened.resolve()
    await ledger.ready
    expect(wire.writes.map((w) => w.texts)).toEqual([['a']])
    ledger.interrupt()
    expect(wire.interrupts).toEqual(['adopted'])
  })

  it('writes what is sent on a later tick, so a Stop in the same tick keeps a tracked input from going', async () => {
    const { wire, ledger } = await ready()
    ledger.send('a')
    const b = ledger.sendTracked('b')
    ledger.interrupt()
    await expect(b).rejects.toThrow('stopped')
    await tick()
    expect(wire.writes.map((w) => w.texts)).toEqual([['a']])
  })

  it('holds what is sent behind a blocking turn and sends it as one message before that turn’s end is said', async () => {
    const { wire, ledger, said } = await ready()
    ledger.send('/compact')
    await tick()
    ledger.turnStarted('compact-1')
    ledger.send('a')
    ledger.send('/compact')
    await tick()
    expect(wire.writes).toHaveLength(1)
    expect(ledger.steerable()).toBeNull()
    ledger.turnEnded('compact-1', { how: 'complete' })
    expect(wire.writes[1]).toMatchObject({ texts: ['a', '/compact'], queued: true })
    expect(said.slice(-2)).toEqual(['write:a+/compact', 'turn_complete'])
  })

  it('a refused message that waited behind a blocking turn fails every tracked input still waiting, not only its own', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('x', observe('x')).catch(() => {})
    await tick()
    wire.answer(0, 't1')
    ledger.send('/compact')
    await tick()
    ledger.send('a')
    ledger.turnEnded('compact-1', { how: 'complete' })
    expect(wire.writes[2]).toMatchObject({ texts: ['a'], queued: true })
    wire.writes[2]!.reply.reject(new Error('busy'))
    await tick()
    expect(said.slice(-2)).toEqual(['x:fail busy', 'error'])
  })

  it('a blocking turn that fails to start lets what waited go, then says the refusal', async () => {
    const { wire, ledger, said } = await ready()
    ledger.send('/compact')
    await tick()
    ledger.send('a')
    await tick()
    wire.writes[0]!.reply.reject(new Error('no compact'))
    await tick()
    expect(said.slice(-2)).toEqual(['write:a', 'error'])
  })
})

describe('a tool that takes input mid-turn: turns and receipts', () => {
  it('binds a tracked input to the turn the tool names, and completes it once that turn’s end is said', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a'))
    await tick()
    wire.answer(0, 't1')
    expect(said).toEqual(['write:a', 'a:accepted'])
    expect(ledger.steerable()).toBe('t1')
    ledger.turnEnded('t1', { how: 'complete' })
    expect(said.slice(-2)).toEqual(['turn_complete', 'a:complete'])
    expect(ledger.steerable()).toBeNull()
  })

  it('an answer that comes after its turn ended completes the input then, and does not bring the turn back for a Stop', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a'))
    await tick()
    ledger.turnEnded('before', { how: 'complete' })
    ledger.turnEnded('t1', { how: 'complete' })
    expect(said).not.toContain('a:complete')
    wire.answer(0, 't1')
    expect(said.slice(-1)).toEqual(['a:complete'])
    ledger.interrupt()
    expect(wire.interrupts).toEqual([])
  })

  it('a Stop fails tracked inputs at once and stops their turns; a turn named after it is stopped as ours, any other is the tool’s', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await tick()
    wire.answer(0, 't1')
    ledger.turnStarted('t1')
    void ledger.sendTracked('b', observe('b')).catch(() => {})
    await tick()
    ledger.interrupt()
    expect(said.filter((s) => s.includes(':fail'))).toHaveLength(2)
    expect(wire.interrupts).toEqual(['t1'])
    expect(wire.log).toEqual(['releaseCards'])
    wire.answer(1, 't2')
    expect(wire.interrupts).toEqual(['t1', 't2'])
    ledger.turnEnded('t2', { how: 'interrupted' })
    ledger.turnEnded('t3', { how: 'interrupted' })
    expect(said.filter((s) => s.startsWith('waiting_input'))).toEqual(['waiting_input:interrupted', `waiting_input:${INTERRUPTED_BY_TOOL}`])
  })

  // #1829: a turn whose end was lost (or one adopted with no id), its card answered by the Stop, read as running for good
  it('a Stop with no turn running and nothing in flight says the stop itself, as no turn will', async () => {
    const { wire, ledger, said } = await ready()
    ledger.stopByPerson()
    expect(wire.interrupts).toEqual([])
    expect(said).toEqual(['waiting_input:interrupted'])
    // A write still unanswered may yet start a turn, whose end says it
    ledger.send('a')
    await tick()
    ledger.stopByPerson()
    expect(said).toEqual(['waiting_input:interrupted', 'write:a'])
  })

  it('a write refused after a Stop failed its tracked input says nothing more: that Stop already did', async () => {
    const { wire, ledger, events, observe } = await ready()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await tick()
    ledger.interrupt()
    wire.writes[0]!.reply.reject(new Error('busy'))
    await tick()
    expect(events).toEqual([])
    expect(wire.log).toEqual(['releaseCards'])
  })

  it('a late answer for an input already completed changes nothing, even one that names no turn', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a'))
    await tick()
    // The input's own item named its turn before the write was answered
    ledger.taken(wire.writes[0]!.inputs, 't1')
    ledger.turnEnded('t1', { how: 'complete' })
    void ledger.sendTracked('b', observe('b')).catch(() => {})
    await tick()
    wire.answer(0, null)
    expect(said.filter((s) => s.startsWith('b:'))).toEqual([])
    expect(ledger.steerable()).toBeNull()
  })

  it('an answer that names no turn for a tracked input fails it, as nothing will say it finished', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await tick()
    wire.answer(0, null)
    expect(said.slice(-1)).toEqual(['a:fail Tool did not identify the turn accepting the parent note'])
  })

  it('an error of the tool’s own fails the tracked inputs still waiting, and with none waiting releases nothing', async () => {
    const { wire, ledger, said, observe } = await ready()
    ledger.failed(new Error('thread broke'))
    expect(wire.log).toEqual([])
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await tick()
    ledger.failed(new Error('thread broke'))
    expect(said.slice(-1)).toEqual(['a:fail thread broke'])
    expect(wire.log).toEqual(['releaseCards'])
  })

  it('late answers for several turns that already ended each complete their input, and bring none back for a Stop', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a'))
    void ledger.sendTracked('b', observe('b'))
    await tick()
    ledger.turnEnded('t1', { how: 'complete' })
    ledger.turnEnded('t2', { how: 'complete' })
    wire.answer(0, 't1')
    wire.answer(1, 't2')
    expect(said.filter((s) => s.endsWith(':complete'))).toEqual(['a:complete', 'b:complete'])
    expect(ledger.steerable()).toBeNull()
  })

  it('a turn named after a Stop is stopped quietly: a refusal means it had ended, and nothing runs to say "still running"', async () => {
    const { wire, ledger, events, observe } = await ready()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await tick()
    ledger.interrupt()
    wire.refuseStop = 'no such turn'
    wire.answer(0, 't2')
    await tick()
    expect(wire.interrupts).toEqual(['t2'])
    expect(events).toEqual([])
  })

  it('an interrupt the tool made on its own completes the inputs of that turn', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a'))
    await tick()
    wire.answer(0, 't1')
    ledger.turnEnded('t1', { how: 'interrupted' })
    expect(said.slice(-2)).toEqual([`waiting_input:${INTERRUPTED_BY_TOOL}`, 'a:complete'])
  })

  it('says a Stop the tool refused as a notice, with the turn still running', async () => {
    const { wire, ledger, events } = await ready()
    ledger.send('a')
    await tick()
    ledger.turnStarted('t1')
    wire.refuseStop = 'not now'
    ledger.interrupt()
    await tick()
    expect(events.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('Could not stop: not now. The turn is still running.') })
  })

  it('a turn that failed fails the tracked inputs with its error before the error is said', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await tick()
    wire.answer(0, 't1')
    ledger.turnEnded('t1', { how: 'failed', error: { code: 'internal', message: 'model refused', retryable: false } })
    expect(said.slice(-2)).toEqual(['a:fail model refused', 'error'])
  })

  it('a write the tool refused is said; it stops the session only when an input of that write was tracked', async () => {
    const { wire, ledger, events, said, observe } = await ready()
    ledger.send('a')
    await tick()
    wire.writes[0]!.reply.reject(new Error('busy'))
    await tick()
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { message: 'refused: busy' } })
    expect(wire.log).toEqual([])
    void ledger.sendTracked('b', observe('b')).catch(() => {})
    await tick()
    wire.writes[1]!.reply.reject(new Error('busy'))
    await tick()
    expect(said.slice(-2)).toEqual(['b:fail busy', 'error'])
    expect(wire.log).toEqual(['releaseCards'])
  })
})

describe('a tool that takes input mid-turn: the exit and the close', () => {
  const states = {
    'idle': async () => {},
    'a turn running': async (_w: Wire, l: MidTurnLedger) => l.turnStarted('t1'),
    'a write unanswered': async (_w: Wire, l: MidTurnLedger) => {
      l.send('a')
      await tick()
    },
    'a message sent in the same tick': async (_w: Wire, l: MidTurnLedger) => l.send('a'),
    'a blocking turn': async (w: Wire, l: MidTurnLedger) => {
      l.send('/compact')
      await tick()
      w.writes[0]!.reply.resolve(undefined)
      await tick()
    },
  }
  for (const [state, enter] of Object.entries(states)) {
    it(`an exit with ${state} is ${state === 'idle' ? 'sleep' : 'a crash'} (#1397)`, async () => {
      const { wire, ledger, events } = await ready()
      await enter(wire, ledger)
      ledger.exited(false, 'Tool exited (code 1)')
      expect(events.at(-1)).toEqual(
        state === 'idle'
          ? { type: 'session_live', sessionId: 's1', live: false, reason: 'asleep' }
          : { type: 'error', sessionId: 's1', error: { code: 'adapter_crashed', message: 'Tool exited (code 1)', retryable: true } },
      )
    })
  }

  it('an exit while it opens is a crash, and one this side caused says nothing; either way tracked inputs fail', async () => {
    const opening = setup()
    void opening.ledger.sendTracked('a', opening.observe('a')).catch(() => {})
    opening.ledger.exited(false, 'Tool exited (code 1)')
    expect(opening.said).toEqual(['a:fail The session process ended before the parent note finished', 'error'])
    expect(opening.wire.log).toEqual(['connectionEnded'])
    const closed = await ready()
    closed.ledger.exited(true, 'Tool exited (code 0)')
    expect(closed.events).toEqual([])
  })

  it('the close says what never went, in the words of where it waited', async () => {
    const opening = setup()
    opening.ledger.send('a')
    await opening.ledger.dispose()
    expect(opening.events).toEqual([expect.objectContaining({ type: 'error', error: expect.objectContaining({ message: expect.stringContaining('were sent while it was opening') }) })])
    expect(opening.wire.log).toEqual(['connectionEnded', 'close'])
    const blocked = await ready()
    blocked.ledger.send('/compact')
    await tick()
    blocked.ledger.send('b')
    await blocked.ledger.dispose()
    expect(blocked.events.at(-1)).toMatchObject({ type: 'error', error: { message: expect.stringContaining('were sent during compaction') } })
    const swapped = setup()
    swapped.ledger.send('a')
    await swapped.ledger.detach()
    expect(swapped.events.at(-1)).toMatchObject({ type: 'error', error: { message: expect.stringContaining('as Centralu restarted') } })
    expect(swapped.ledger.closed).toBe(true)
  })

  it('an opening that finishes after the close (an answer read before the process exits) leaves it closed', async () => {
    const { wire, ledger } = setup()
    ledger.send('a')
    const closing = ledger.dispose()
    wire.opened.resolve()
    await closing
    await ledger.ready
    await tick()
    expect(ledger.closed).toBe(true)
    expect(wire.writes).toEqual([])
  })

  it('a tracked input sent in the same tick as the close fails and is not written', async () => {
    const { wire, ledger, said, observe } = await ready()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await ledger.dispose()
    await tick()
    expect(said).toEqual(['a:fail The session process ended before the parent note finished'])
    expect(wire.writes).toEqual([])
  })

  it('a tracked input sent while it opened fails with why the opening ended, after a host swap let go of it', async () => {
    const { wire, ledger, said, observe } = setup()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await ledger.detach()
    wire.opened.reject(new Error('request abandoned: this host let go of codex'))
    await tick()
    expect(said.at(-1)).toBe('a:fail request abandoned: this host let go of codex')
  })
})

/** A wire that writes its own inputs (Claude: the SDK's input stream), with the policies Claude gives the ledger (§4.3) */
function ownInputs(policy: { byAnswer: boolean; ms?: number; inFlight?: boolean }) {
  const said: string[] = []
  const answers: ReturnType<typeof deferred<unknown>>[] = []
  const wire: MidTurnWire = {
    label: 'Tool',
    interrupt: () => {
      const answer = deferred<unknown>()
      answers.push(answer)
      return answer.promise
    },
    stop: { byAnswer: policy.byAnswer, bound: policy.ms ? { ms: policy.ms, notice: (s) => `not confirmed after ${s} s` } : null },
    stopRefused: () => said.push('stopRefused'),
    idleStop: () => said.push('idleStop'),
    releaseCards: () => said.push('releaseCards'),
    inFlight: () => policy.inFlight ?? false,
    exitWords: 'gone with the process',
    connectionEnded: () => said.push('connectionEnded'),
  }
  const ledger = new MidTurnLedger('s1', (e) => {
    said.push(e.type === 'state_change' ? `${e.state}:${e.reason ?? ''}` : e.type === 'notice' ? `notice:${e.text}` : e.type === 'session_live' ? `live:${e.reason}` : e.type)
  }, wire)
  const observe = (name: string) => ({ accepted: () => said.push(`${name}:accepted`), complete: () => said.push(`${name}:complete`), fail: (e: Error) => said.push(`${name}:fail ${e.message}`) })
  return { said, answers, ledger, observe }
}

describe('a tool that writes its own inputs, on the ledger with its policies', () => {
  it('is ready at once; the receipts it takes complete after the turn_complete among the events it says itself', () => {
    const { said, ledger, observe } = ownInputs({ byAnswer: true })
    expect(ledger.closed).toBe(false)
    const r = ledger.track(observe('a'), '00000000-0000-4000-8000-000000000001')
    expect(r.id).toBe('00000000-0000-4000-8000-000000000001')
    ledger.turnStarted('t')
    ledger.accept(r.id)
    expect(ledger.turnRunning).toBe(true)
    ledger.turnEnded(null, null)
    expect(ledger.turnRunning).toBe(false)
    ledger.said([{ type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }, { type: 'turn_complete', sessionId: 's1' }, { type: 'notice', sessionId: 's1', level: 'info', text: 'after' }], [r.id])
    expect(said).toEqual(['a:accepted', 'usage_update', 'turn_complete', 'a:complete', 'notice:after'])
  })

  it('a Stop confirmed by the answer is said once for two Stops; the bound is said once with its words, and a late answer still confirms', async () => {
    vi.useFakeTimers()
    try {
      const { said, answers, ledger } = ownInputs({ byAnswer: true, ms: 10_000 })
      ledger.turnStarted('t')
      ledger.stopByPerson()
      ledger.stopByPerson()
      vi.advanceTimersByTime(10_000)
      expect(said.filter((x) => x.startsWith('notice'))).toEqual(['notice:not confirmed after 10 s'])
      answers[0]!.resolve(undefined)
      answers[1]!.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(said.filter((x) => x.startsWith('waiting_input'))).toEqual(['waiting_input:interrupted'])
      vi.advanceTimersByTime(20_000)
      expect(said.filter((x) => x.startsWith('notice'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a refused Stop under a bound gives the turn its own ending back and says why, unless another Stop may still land', async () => {
    const { said, answers, ledger } = ownInputs({ byAnswer: true, ms: 10_000 })
    ledger.turnStarted('t')
    ledger.stopByPerson()
    ledger.stopByPerson()
    answers[0]!.reject(new Error('no'))
    await tick()
    expect(said).not.toContain('stopRefused')
    answers[1]!.reject(new Error('still no'))
    await tick()
    expect(said.slice(-2)).toEqual(['stopRefused', 'notice:Could not stop: still no. The turn is still running.'])
  })

  it('confirmed only by the turn\'s end (Codex with a bound, §9.2): the answer says nothing, and the end lets the bound go', async () => {
    vi.useFakeTimers()
    try {
      const { said, answers, ledger } = ownInputs({ byAnswer: false, ms: 10_000 })
      ledger.turnStarted('t')
      ledger.stopByPerson()
      answers[0]!.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(said).not.toContain('waiting_input:interrupted')
      ledger.turnEnded('t', { how: 'interrupted' })
      vi.advanceTimersByTime(20_000)
      expect(said.filter((x) => x.startsWith('notice') || x.startsWith('waiting_input'))).toEqual(['waiting_input:interrupted'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the turn\'s end said by the tool confirms a waiting Stop; a failure among its events lets it go without a word', () => {
    const a = ownInputs({ byAnswer: true, ms: 10_000 })
    a.ledger.turnStarted('t')
    a.ledger.stopByPerson()
    a.ledger.said([])
    a.ledger.confirmStop()
    expect(a.said.at(-1)).toBe('waiting_input:interrupted')
    const b = ownInputs({ byAnswer: true, ms: 10_000 })
    b.ledger.turnStarted('t')
    b.ledger.stopByPerson()
    b.ledger.said([{ type: 'error', sessionId: 's1', error: { code: 'internal', message: 'x', retryable: true } }])
    b.ledger.confirmStop()
    expect(b.said).not.toContain('waiting_input:interrupted')
  })

  it('a Stop with no turn tells the tool (`idleStop`) before it is said stopped', () => {
    const { said, ledger } = ownInputs({ byAnswer: true, ms: 10_000 })
    ledger.stopByPerson()
    expect(said).toEqual(['releaseCards', 'idleStop', 'waiting_input:interrupted'])
  })

  it('an exit is a crash with the wire\'s own work in flight, read before the receipts fail, and asleep without; inputs fail in its words', () => {
    const busy = ownInputs({ byAnswer: true, inFlight: true })
    void busy.ledger.track(busy.observe('a')).done.catch(() => {})
    busy.ledger.exited(false, 'it crashed')
    expect(busy.said).toEqual(['a:fail gone with the process', 'connectionEnded', 'error'])
    const idle = ownInputs({ byAnswer: true })
    idle.ledger.exited(false, 'it crashed')
    expect(idle.said).toEqual(['connectionEnded', 'live:asleep'])
  })

  it('the close says nothing more and fails what waits in its words', () => {
    const { said, ledger, observe } = ownInputs({ byAnswer: true })
    void ledger.track(observe('a')).done.catch(() => {})
    ledger.close(new Error('closed'))
    expect(ledger.closed).toBe(true)
    expect(said).toEqual(['a:fail closed'])
  })
})

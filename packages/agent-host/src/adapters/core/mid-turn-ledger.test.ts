import { describe, expect, it } from 'vitest'
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

  constructor(private readonly said: string[]) {}

  open(): Promise<void> {
    return this.opened.promise
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
    expect(opening.wire.log).toEqual(['close', 'connectionEnded'])
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

  it('a tracked input sent while it opened fails with why the opening ended, after a host swap let go of it', async () => {
    const { wire, ledger, said, observe } = setup()
    void ledger.sendTracked('a', observe('a')).catch(() => {})
    await ledger.detach()
    wire.opened.reject(new Error('request abandoned: this host let go of codex'))
    await tick()
    expect(said.at(-1)).toBe('a:fail request abandoned: this host let go of codex')
  })
})

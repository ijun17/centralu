import { describe, expect, it } from 'vitest'
import type { Asker } from '../mail/asked-by.js'
import { AskedGate, type AskedGateHost } from './asked-gate.js'
import { HostCards } from './host-cards.js'

const ASKER: Asker = { threadId: 't1', name: 'Fix login', project: 'Acme', trusted: true }

type Out = { text: string; isError?: boolean }
const refused = (text: string): Out => ({ text, isError: true })

function world(over: { asker?: () => Asker | null; answer?: 'allow' | 'deny' | null; afterAsk?: () => void } = {}) {
  const asked: string[] = []
  const covered: boolean[] = []
  const host: AskedGateHost = {
    askedBy: over.asker ?? (() => ASKER),
    ask: async (_id, question) => {
      asked.push(question)
      over.afterAsk?.()
      return over.answer === undefined ? 'allow' : over.answer
    },
    cover: async (_id, run) => {
      covered.push(true)
      return run()
    },
  }
  return { gate: new AskedGate(host), asked, covered }
}
const ran = () => {
  const calls: number[] = []
  return { calls, run: async (): Promise<Out> => (calls.push(1), { text: 'did it' }) }
}

describe('the gate around the orchestrator’s steps (§9.7)', () => {
  it('a step that changes something asks first, and runs once the person allows it', async () => {
    const w = world()
    const r = ran()
    expect(await w.gate.when('orc', { name: 'rename_session', args: { sessionId: 's' } }, undefined, r.run, refused)).toEqual({ text: 'did it' })
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).toContain('Session "Fix login" in project "Acme" asked the orchestrator to run rename_session')
    expect(r.calls).toHaveLength(1)
    expect(w.covered).toEqual([true])
  })

  it('Deny, and no answer, run nothing and say so', async () => {
    for (const answer of ['deny', null] as const) {
      const w = world({ answer })
      const r = ran()
      const out = await w.gate.when('orc', { name: 'delete_session', args: {} }, undefined, r.run, refused)
      expect(out.isError).toBe(true)
      expect(r.calls).toEqual([])
    }
  })

  it('a read, and a turn that is not a request, run at once with no card', async () => {
    const w = world()
    const r = ran()
    await w.gate.when('orc', { name: 'list_sessions', args: {} }, undefined, r.run, refused)
    const none = world({ asker: () => null })
    await none.gate.when('orc', { name: 'delete_session', args: {} }, undefined, r.run, refused)
    expect(w.asked).toEqual([])
    expect(none.asked).toEqual([])
    expect(r.calls).toHaveLength(2)
  })

  it('an Allow that comes after the request’s turn has ended runs nothing: it was for that turn', async () => {
    let now: Asker | null = ASKER
    const w = world({ asker: () => now, afterAsk: () => void (now = null) })
    const r = ran()
    const out = await w.gate.when('orc', { name: 'delete_session', args: {} }, undefined, r.run, refused)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('the turn this was asked in has ended')
    expect(r.calls).toEqual([])
  })

  it('a step too long to show whole is neither asked about nor run: a card that hid part of it would not be a fair question', async () => {
    const w = world()
    const r = ran()
    const out = await w.gate.when('orc', { name: 'Bash', args: { command: 'echo ' + 'x'.repeat(3_000) } }, undefined, r.run, refused)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('too long to show the person')
    expect(w.asked).toEqual([])
    expect(r.calls).toEqual([])
  })

  it('the step’s result keeps its own shape: an app tool gets an app tool’s refusal, not a tool output', async () => {
    const w = world({ answer: 'deny' })
    const out = await w.gate.when('orc', { name: 'server.tool', args: {} }, undefined, async () => ({ content: [{ type: 'text', text: 'ran' }], isError: false }), (text) => ({
      content: [{ type: 'text', text }],
      isError: true,
    }))
    expect(out).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('did not allow it') }] })
  })

  it('the CLI’s own steps ask the same way: a command is asked about, a read is not', async () => {
    const w = world({ answer: 'deny' })
    expect(await w.gate.askCli('orc', 'Bash', { command: 'echo pwned > file' })).toMatchObject({ allowed: false })
    expect(w.asked[0]).toContain('asked the orchestrator to run Bash {"command":"echo pwned > file"}')
    expect(await w.gate.askCli('orc', 'Read', { file_path: 'a' })).toEqual({ allowed: true, asked: false })
    expect(w.asked).toHaveLength(1)
    // Allowed on the card: it runs, and the CLI is told the person was asked
    const allowing = world({ answer: 'allow' })
    expect(await allowing.gate.askCli('orc', 'Bash', { command: 'ls' })).toEqual({ allowed: true, asked: true })
  })

  it('a step that would outlive the turn is refused without a question: a subagent, a scheduled prompt, a watched command', async () => {
    const w = world({ answer: 'allow' })
    for (const tool of ['Agent', 'Task', 'CronCreate', 'ScheduleWakeup', 'Workflow', 'Monitor']) {
      const r = await w.gate.askCli('orc', tool, { prompt: 'x' })
      expect(r, tool).toMatchObject({ allowed: false, message: expect.stringContaining('would go on after this turn') })
    }
    expect(w.asked).toEqual([])
    // And in a turn that is nobody’s request they are the CLI’s own, as before
    const none = world({ asker: () => null })
    expect(await none.gate.askCli('orc', 'Agent', {})).toEqual({ allowed: true, asked: false })
  })
})

// The cover itself is HostCards': what the manager test cannot show is its edges
describe('the Allow covers one call, not the session', () => {
  it('is kept by the call’s own async work and ends with the call and with its signal', async () => {
    const cards = new HostCards({ meta: new Map(), autoBoundaryOpen: () => false } as never)
    const detail = { kind: 'other', raw: 'x' } as never
    const pending = (p: Promise<unknown>) => Promise.race([p.then(() => 'answered'), new Promise((r) => setTimeout(() => r('pending'), 30))])
    const aborted = new AbortController()
    let later: (() => Promise<unknown>) | undefined
    await cards.cover(
      'orc',
      async () => {
        // Inside the call: answered by the Allow; a card of another session, or one that insists (`uncovered`), is not
        expect(await pending(cards.askHost('orc', detail))).toBe('answered')
        expect(await pending(cards.askHost('other', detail))).toBe('pending')
        expect(await pending(cards.askHost('orc', detail, undefined, { uncovered: true }))).toBe('pending')
        later = () => cards.askHost('orc', detail)
        aborted.abort()
        // Its signal fired: the step is over for the person's purposes, whatever it is still doing
        expect(await pending(later())).toBe('pending')
        return { text: '' }
      },
      aborted.signal,
    )
    // After the call returned, the work it left behind is not covered
    expect(await pending(later!())).toBe('pending')
    expect(await pending(cards.askHost('orc', detail))).toBe('pending')
  })
})

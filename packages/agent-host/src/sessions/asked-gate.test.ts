import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Asker } from '../mail/asked-by.js'
import { AskedGate, type AskedGateHost } from './asked-gate.js'
import { HostCards } from './host-cards.js'

/** A request on the person's word: it cites their message 7 of the asking session, checked at send */
const ASKER: Asker = { messageId: 't1', sessionId: 'asker', turn: 1, name: 'Fix login', project: 'Acme', trusted: true, cites: { seq: 7, at: 1_000 } }
/** The same request with no word of the person's: one an older build stored, a moved one, a reminder's turn */
const UNCITED: Asker = { ...ASKER, cites: null }

type Out = { text: string; isError?: boolean }
const refused = (text: string): Out => ({ text, isError: true })

function world(
  over: {
    asker?: () => Asker | null
    answer?: 'allow' | 'deny' | null
    afterAsk?: () => void
  } = {},
) {
  const asked: string[] = []
  const covered: boolean[] = []
  const records: { asker: string; seq: number; act: string }[] = []
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
    onPersonsWord: (asker, act) => void records.push({ asker: asker.sessionId, seq: asker.cites.seq, act }),
  }
  return { gate: new AskedGate(host), asked, covered, records }
}
const ran = () => {
  const calls: number[] = []
  return { calls, run: async (): Promise<Out> => (calls.push(1), { text: 'did it' }) }
}

describe('the gate around the orchestrator’s steps in a request on the person’s word', () => {
  it('a step its word does not cover outright asks first, and runs once the person allows it', async () => {
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
    const out = await w.gate.when('orc', { name: 'Bash', args: { command: 'echo ' + 'x'.repeat(7_000) } }, undefined, r.run, refused)
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
    for (const tool of ['Agent', 'Task', 'CronCreate', 'ScheduleWakeup', 'Workflow', 'Monitor', 'RemoteTrigger']) {
      const r = await w.gate.askCli('orc', tool, { prompt: 'x' })
      expect(r, tool).toMatchObject({ allowed: false, message: expect.stringContaining('would go on after this turn') })
    }
    // A command started in the background ends in a turn of the CLI’s own, with no asker: refused too; in the foreground it is asked about
    for (const tool of ['Bash', 'PowerShell']) {
      expect(await w.gate.askCli('orc', tool, { command: 'sleep 8 && echo x', run_in_background: true }), tool).toMatchObject({ allowed: false })
      expect(await w.gate.askCli('orc', tool, { command: 'echo x', run_in_background: false }), tool).toEqual({ allowed: true, asked: true })
    }
    // (nobody was asked about the refused ones: the only questions are the two foreground commands)
    expect(w.asked.filter((q) => !q.includes('"run_in_background":false'))).toEqual([])
    // And in a turn that is nobody’s request they are the CLI’s own, as before
    const none = world({ asker: () => null })
    expect(await none.gate.askCli('orc', 'Agent', {})).toEqual({ allowed: true, asked: false })
  })
})

describe('the steps the person’s word covers (#1739)', () => {
  it('registering a folder and starting a session run with no card, their own cards covered, and each leaves a record', async () => {
    const w = world()
    const r = ran()
    const add = { name: 'add_project', args: { path: '/work/app', machine: 'laptop' } }
    const start = { name: 'create_session', args: { projectId: 'p1', machine: 'laptop', message: 'set it up' } }
    expect(await w.gate.when('orc', add, undefined, r.run, refused)).toEqual({ text: 'did it' })
    expect(await w.gate.when('orc', start, undefined, r.run, refused)).toEqual({ text: 'did it' })
    expect(w.asked).toEqual([])
    expect(r.calls).toHaveLength(2)
    // Covered, so the folder card add_project raises itself is answered by the person's word
    expect(w.covered).toEqual([true, true])
    expect(w.records).toEqual([
      { asker: 'asker', seq: 7, act: 'run add_project {"path":"/work/app","machine":"laptop"}' },
      { asker: 'asker', seq: 7, act: 'run create_session {"projectId":"p1","machine":"laptop","message":"set it up"}' },
    ])
  })

  it('a step that did nothing leaves no record', async () => {
    const w = world()
    await w.gate.when('orc', { name: 'add_project', args: { path: '/nope' } }, undefined, async () => ({ text: 'No folder there.', isError: true }), refused)
    expect(w.records).toEqual([])
  })

  it('anything irreversible or not listed still asks, whatever the word says: a delete, a clone, a trust, an OS entry, an agent, words to another session', async () => {
    const w = world({ answer: 'deny' })
    const steps = [
      { name: 'delete_archived', args: { sessionId: 's' } },
      { name: 'create_project', args: { name: 'x', clone: 'https://example.com/x.git' } },
      { name: 'set_project_trust', args: { project: 'p1', trusted: true } },
      { name: 'set_machine_autostart', args: { machineId: 'm', enabled: true } },
      { name: 'start_agent', args: { task: 'go' } },
      { name: 'send_to_session', args: { sessionId: 's', message: 'hi' } },
    ]
    for (const step of steps) {
      const r = ran()
      const out = await w.gate.when('orc', step, undefined, r.run, refused)
      expect(out.isError, step.name).toBe(true)
      expect(r.calls, step.name).toEqual([])
    }
    expect(w.asked).toHaveLength(steps.length)
    for (const tool of ['Bash', 'Write']) expect(await w.gate.askCli('orc', tool, { command: 'rm -rf x', file_path: '/x', content: 'y' })).toMatchObject({ allowed: false })
    expect(w.asked).toHaveLength(steps.length + 2)
    expect(w.records).toEqual([])
  })

  it('reading, answering in the thread and mail to the person are free, as in the person’s own turn', async () => {
    const w = world()
    const r = ran()
    for (const call of [
      { name: 'read_session', args: { sessionId: 'asker', around: 7 } },
      { name: 'list_machines', args: {} },
      { name: 'mail', args: { action: 'reply', thread: 't1', text: 'Done: registered and started.' } },
      { name: 'mail', args: { action: 'send', to: 'person', text: 'fyi' } },
    ]) await w.gate.when('orc', call, undefined, r.run, refused)
    expect(r.calls).toHaveLength(4)
    expect(w.asked).toEqual([])
  })
})

describe('a request with no word of the person’s: nothing leaves its turn', () => {
  it('every step that changes something is refused with no card, the covered ones included', async () => {
    const w = world({ asker: () => UNCITED })
    for (const step of [{ name: 'add_project', args: { path: '/work/app' } }, { name: 'create_session', args: {} }, { name: 'delete_session', args: {} }, { name: 'server.tool', args: {} }]) {
      const r = ran()
      const out = await w.gate.when('orc', step, undefined, r.run, refused)
      expect(out, step.name).toMatchObject({ isError: true, text: expect.stringContaining("cites no word of the person's") })
      expect(r.calls).toEqual([])
    }
    expect(await w.gate.askCli('orc', 'Bash', { command: 'ls' })).toMatchObject({ allowed: false, message: expect.stringContaining('cites no word') })
    expect(await w.gate.askCli('orc', 'WebFetch', { url: 'https://example.com/?q=secret' })).toMatchObject({ allowed: false })
    expect(w.asked).toEqual([])
    expect(w.records).toEqual([])
  })

  it('no word reaches the session, in its own thread either; reading, marking it handled and mail to the person are free', async () => {
    const w = world({ asker: () => UNCITED })
    for (const action of ['reply', 'update', 'close']) {
      const r = ran()
      expect(await w.gate.when('orc', { name: 'mail', args: { action, thread: 't1', text: 'the person told me…' } }, undefined, r.run, refused), action).toMatchObject({ isError: true })
      expect(r.calls).toEqual([])
    }
    const r = ran()
    for (const call of [
      { name: 'read_session', args: { sessionId: 'other' } },
      { name: 'mail', args: { action: 'read', thread: 't1' } },
      { name: 'mail', args: { action: 'handled', thread: 't1' } },
      { name: 'mail', args: { action: 'send', to: 'person', text: 'a session asks for this' } },
    ]) await w.gate.when('orc', call, undefined, r.run, refused)
    expect(r.calls).toHaveLength(4)
    expect(await w.gate.askCli('orc', 'Read', { file_path: 'a' })).toEqual({ allowed: true, asked: false })
    expect(w.asked).toEqual([])
  })
})

describe('a read the CLI itself asks about, in a request', () => {
  it('is the gate’s card, naming the session, Allow or Deny; outside a request the CLI keeps its own', async () => {
    const w = world({ answer: 'deny' })
    expect(await w.gate.askCliRead('orc', 'Read', { file_path: resolve('/private/a.txt') })).toMatchObject({ allowed: false })
    expect(w.asked[0]).toContain('Session "Fix login" in project "Acme" asked the orchestrator to run Read')
    const allowing = world({ answer: 'allow' })
    expect(await allowing.gate.askCliRead('orc', 'Read', { file_path: 'a' })).toEqual({ allowed: true, asked: true })
    const none = world({ asker: () => null })
    expect(await none.gate.askCliRead('orc', 'Read', { file_path: 'a' })).toEqual({ allowed: true, asked: false })
    expect(none.asked).toEqual([])
  })

  it('an Allow that comes in a later turn of the same thread runs nothing: it was for the turn it was asked in', async () => {
    let turn = 1
    const w = world({ asker: () => ({ ...ASKER, turn }), answer: 'allow', afterAsk: () => void (turn = 2) })
    expect(await w.gate.askCliRead('orc', 'Read', { file_path: resolve('/private/a.txt') })).toMatchObject({ allowed: false, message: expect.stringContaining('has ended') })
  })
})



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

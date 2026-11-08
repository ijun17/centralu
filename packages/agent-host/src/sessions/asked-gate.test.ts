import { describe, expect, it } from 'vitest'
import type { Asker } from '../mail/asked-by.js'
import { AskedGate, type AskedGateHost } from './asked-gate.js'
import { HostCards } from './host-cards.js'

/** A request that cites the person's message 7 of the asking session, checked at send */
const ASKER: Asker = { messageId: 't1', sessionId: 'asker', turn: 1, name: 'Fix login', project: 'Acme', trusted: true, cites: { seq: 7, at: 1_000 } }
/** The same request citing nothing the person wrote */
const UNCITED: Asker = { ...ASKER, cites: null }

type Out = { text: string; isError?: boolean }
const refused = (text: string): Out => ({ text, isError: true })

function world(
  over: {
    asker?: () => Asker | null
    answer?: 'allow' | 'deny' | null
    afterAsk?: () => void
    /** Whether work handed on goes to a session no looser than the asking one (the manager's `noLooser`) */
    noLooser?: boolean
  } = {},
) {
  const asked: string[] = []
  const covered: boolean[] = []
  const records: { asker: string; seq: number | null; act: string }[] = []
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
    noLooser: () => over.noLooser ?? true,
    done: (asker, act) => void records.push({ asker: asker.sessionId, seq: asker.cites?.seq ?? null, act }),
  }
  return { gate: new AskedGate(host), asked, covered, records }
}
const ran = () => {
  const calls: number[] = []
  return { calls, run: async (): Promise<Out> => (calls.push(1), { text: 'did it' }) }
}

describe('the gate around the Assistant’s steps (§9.7)', () => {
  it('a step that changes something asks first, and runs once the person allows it', async () => {
    const w = world()
    const r = ran()
    expect(await w.gate.when('orc', { name: 'delete_session', args: { sessionId: 's' } }, undefined, r.run, refused)).toEqual({ text: 'did it' })
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).toContain('Session "Fix login" in project "Acme" asked the Assistant to run delete_session')
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
    expect(w.asked[0]).toContain('asked the Assistant to run Bash {"command":"echo pwned > file"}')
    expect(await w.gate.askCli('orc', 'Read', { file_path: 'a' })).toEqual({ allowed: true, asked: false })
    expect(w.asked).toHaveLength(1)
    // Allowed on the card: it runs, and the CLI is told the person was asked
    const allowing = world({ answer: 'allow' })
    expect(await allowing.gate.askCli('orc', 'Bash', { command: 'ls' })).toEqual({ allowed: true, asked: true })
  })

  it('a step of the CLI’s own is recorded once the CLI says it ran, not when the person allowed it', async () => {
    const w = world({ answer: 'allow' })
    expect(await w.gate.askCli('orc', 'Bash', { command: 'false' })).toEqual({ allowed: true, asked: true })
    // Allowed, and then it failed or a rule of the CLI's stopped it: the CLI never says it ran, so there is no record
    expect(w.records).toEqual([])
    w.gate.cliDone('orc', 'Bash', { command: 'ls' })
    expect(w.records).toEqual([{ asker: 'asker', seq: 7, act: 'run Bash {"command":"ls"}' }])
    // A read, and a turn that is nobody's request, are not recorded
    w.gate.cliDone('orc', 'Read', { file_path: 'a' })
    world({ asker: () => null }).gate.cliDone('orc', 'Bash', { command: 'ls' })
    expect(w.records).toHaveLength(1)
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

describe('a step that can be undone runs, cited or not, and every step that changed something is recorded (#1739)', () => {
  const undoable = [
    { name: 'add_project', args: { path: '/work/app', machine: 'laptop' } },
    { name: 'rename_session', args: { sessionId: 's', name: 'n' } },
    { name: 'set_project_trust', args: { project: 'p1', trusted: true } },
  ]
  /** Work handed on, which runs without the request's card unless it goes to a session looser than the asking one, wherever that session is */
  const handsOn = [
    { name: 'create_session', args: { project: 'Acme', firstMessage: 'set it up' } },
    // #1739's own case: a session on a linked machine
    { name: 'create_session', args: { project: 'laptop/app', firstMessage: 'set it up there' } },
    { name: 'start_agent', args: { task: 'go' } },
    { name: 'ask_project', args: { project: 'Other', session: 's', task: 'go' } },
    { name: 'handoff_session', args: { sessionId: 's' } },
    { name: 'send_to_session', args: { sessionId: 's', text: 'hi' } },
    { name: 'agent_session', args: { action: 'send', sessionId: 's', text: 'hi' } },
    { name: 'mail', args: { action: 'send', to: 'session:h/s2', text: 'hi' } },
  ]

  it('registering, renaming, trusting, and work handed on to a session no looser than the asking one take no request card, cited or not; their own cards are not answered for them', async () => {
    for (const asker of [ASKER, UNCITED]) {
      const w = world({ asker: () => asker })
      const r = ran()
      for (const step of [...undoable, ...handsOn]) expect(await w.gate.when('orc', step, undefined, r.run, refused), step.name).toEqual({ text: 'did it' })
      expect(w.asked).toEqual([])
      expect(r.calls).toHaveLength(undoable.length + handsOn.length)
      // Nothing covered: a trust card, a project's card or a start's consent asks as in the person's own turn
      expect(w.covered).toEqual([])
      expect(w.records.map((x) => x.seq)).toEqual([...undoable, ...handsOn].map(() => asker.cites?.seq ?? null))
    }
  })

  it('work handed to a session looser than the asking one asks, and so do an answer for the person and a session stopped or deleted', async () => {
    const out = world({ noLooser: false, answer: 'deny' })
    for (const step of handsOn) expect(await out.gate.when('orc', step, undefined, ran().run, refused), step.name).toMatchObject({ isError: true })
    expect(out.asked).toHaveLength(handsOn.length)
    const within = world({ noLooser: true, answer: 'deny' })
    // No looser, the same steps run without the card
    for (const step of handsOn) expect(await within.gate.when('orc', step, undefined, ran().run, refused), step.name).toEqual({ text: 'did it' })
    const never = [
      { name: 'answer_question', args: { sessionId: 's', answers: ['yes'] } },
      { name: 'agent_session', args: { action: 'stop', sessionId: 's' } },
      { name: 'mail', args: { action: 'reply', thread: 'another-thread', text: 'x' } },
    ]
    for (const step of never) expect(await within.gate.when('orc', step, undefined, ran().run, refused), step.name).toMatchObject({ isError: true })
    expect(within.asked).toHaveLength(never.length)
  })

  it('only what cannot be undone asks, cited or not: a delete, an uninstall, an OS entry, an update applied, a command, a file written, an app’s step', async () => {
    const floor = [
      { name: 'delete_session', args: { sessionId: 's' } },
      { name: 'delete_all_archived', args: {} },
      { name: 'uninstall_machine', args: { machineId: 'm' } },
      { name: 'set_machine_autostart', args: { machineId: 'm', enabled: true } },
      { name: 'update_centralu', args: { action: 'apply' } },
      { name: 'server.queue_merge', args: { pr: 1 } },
      // A command nobody has said can be undone asks until someone does
      { name: 'some_command_added_later', args: {} },
    ]
    for (const asker of [ASKER, UNCITED]) {
      const w = world({ asker: () => asker, answer: 'deny' })
      for (const step of floor) {
        const r = ran()
        expect(await w.gate.when('orc', step, undefined, r.run, refused), step.name).toMatchObject({ isError: true })
        expect(r.calls, step.name).toEqual([])
      }
      for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'mcp__other__drop']) expect(await w.gate.askCli('orc', tool, { command: 'rm -rf x', file_path: '/x' }), tool).toMatchObject({ allowed: false })
      expect(w.asked).toHaveLength(floor.length + 5)
      expect(w.records).toEqual([])
      // The floor is the line: a rename, which can be undone, runs in the same turn without asking
      const rename = ran()
      await w.gate.when('orc', { name: 'rename_session', args: { sessionId: 's', name: 'n' } }, undefined, rename.run, refused)
      expect(rename.calls).toHaveLength(1)
      expect(w.asked).toHaveLength(floor.length + 5)
    }
  })

  it('a read, an answer in the thread, a failed step and a refused one leave no record; a step the person allowed does', async () => {
    const w = world({ asker: () => UNCITED })
    const r = ran()
    await w.gate.when('orc', { name: 'read_session', args: { sessionId: 's' } }, undefined, r.run, refused)
    await w.gate.when('orc', { name: 'mail', args: { action: 'reply', thread: 't1', text: 'done' } }, undefined, r.run, refused)
    await w.gate.when('orc', { name: 'add_project', args: { path: '/nope' } }, undefined, async () => ({ text: 'No folder there.', isError: true }), refused)
    expect(w.records).toEqual([])
    await w.gate.when('orc', { name: 'delete_session', args: { sessionId: 's' } }, undefined, r.run, refused)
    expect(w.records).toEqual([{ asker: 'asker', seq: null, act: 'run delete_session {"sessionId":"s"}' }])
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

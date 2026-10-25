import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Asker } from '../mail/asked-by.js'
import { AskedGate, type AskedGateHost } from './asked-gate.js'
import { HostCards } from './host-cards.js'

const ASKER: Asker = { threadId: 't1', sessionId: 'asker', turn: 1, name: 'Fix login', project: 'Acme', trusted: true }

type Out = { text: string; isError?: boolean }
const refused = (text: string): Out => ({ text, isError: true })

function world(
  over: {
    asker?: () => Asker | null
    answer?: 'allow' | 'deny' | null
    afterAsk?: () => void
    folders?: string[]
    projects?: Record<string, string | null>
    /** What each asking session reaches, where it differs between askers */
    reachOf?: (sessionId: string) => { folders: string[]; project: string | null }
    projectName?: string
    /** The gate has seen the orchestrator's conversation begin (the usual case) */
    begun?: boolean
  } = {},
) {
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
    reach: (id) => ({ ...(over.reachOf?.(id) ?? { folders: over.folders ?? [], project: 'p1' }), ...(over.projectName ? { projectName: over.projectName } : {}) }),
    projectOf: (id) => over.projects?.[id],
  }
  const gate = new AskedGate(host)
  if (over.begun !== false) gate.beginConversation('orc')
  return { gate, asked, covered }
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

/*
 * What a request's turn reads that the asker could not read itself (found by the second review of #1516): reading is free, but the orchestrator answers
 * in the asker's thread, and the asker reads the answer. After such a read the answer asks the person, showing its words.
 */
describe('a reply after a read outside the asker’s reach (§9.7)', () => {
  const HOME = resolve('/work/acme')
  const INSIDE = resolve('/work/acme/src/a.ts')
  const OUTSIDE = resolve('/private/secret.txt')
  const reply = (text = 'the file says: hunter2') => ({ action: 'reply', thread: 't1', text })
  const send = (w: ReturnType<typeof world>, args: Record<string, unknown>, name = 'mail') => {
    const r = ran()
    return w.gate.when('orc', { name, args }, undefined, r.run, refused).then((out) => ({ out, r }))
  }
  const read = (w: ReturnType<typeof world>, name: string, args: Record<string, unknown>) => w.gate.askCli('orc', name, args)

  it('a reply asks, showing its words whole and naming the asker; Deny sends nothing', async () => {
    const w = world({ folders: [HOME], answer: 'deny' })
    expect(await read(w, 'Read', { file_path: OUTSIDE })).toEqual({ allowed: true, asked: false })
    const { out, r } = await send(w, reply('x'.repeat(1_500) + ' hunter2'))
    expect(out.isError).toBe(true)
    expect(r.calls).toEqual([])
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).toContain('Session "Fix login" in project "Acme" asked the orchestrator to answer it')
    expect(w.asked[0]).toContain(`Read of ${JSON.stringify(OUTSIDE)}`)
    expect(w.asked[0]).toContain('x'.repeat(1_500) + ' hunter2')
    expect(out.text).toContain('Nothing was sent')
  })

  it('Allow sends it; the next turn of the same thread asks again, since the conversation still has what it read', async () => {
    let turn = 1
    const w = world({ asker: () => ({ ...ASKER, turn }), folders: [HOME], answer: 'allow' })
    await read(w, 'Read', { file_path: OUTSIDE })
    expect((await send(w, reply())).r.calls).toHaveLength(1)
    expect(w.asked).toHaveLength(1)
    turn = 2
    expect((await send(w, reply())).r.calls).toHaveLength(1)
    expect(w.asked).toHaveLength(2)
  })

  it('reads in reach leave the reply free: a file in the asker’s folders, a session of its project, the asker itself', async () => {
    const w = world({ folders: [HOME], projects: { s2: 'p1', asker: 'p1' } })
    await read(w, 'Read', { file_path: INSIDE })
    await read(w, 'Grep', { pattern: 'x', path: resolve('/work/acme/src') })
    await read(w, 'Glob', { pattern: '**/*.ts', path: HOME })
    await w.gate.when('orc', { name: 'read_session', args: { sessionId: 's2' } }, undefined, ran().run, refused)
    await w.gate.when('orc', { name: 'read_session', args: { sessionId: 'asker' } }, undefined, ran().run, refused)
    const { r } = await send(w, reply())
    expect(r.calls).toHaveLength(1)
    expect(w.asked).toEqual([])
  })

  it('each way out of reach counts: another project’s conversation, recall, the list, a path that climbs out, a relative path, a pattern aimed elsewhere', async () => {
    const outs: [string, Record<string, unknown>][] = [
      ['read_session', { sessionId: 's9' }],
      ['read_session', { sessionId: 'nobody' }],
      ['recall', { query: 'password' }],
      ['list_sessions', {}],
      ['list_archive', {}],
      ['agent_session', { action: 'status', sessionId: 's9' }],
      ['Read', { file_path: resolve('/work/acme/../private/x.txt') }],
      ['Read', { file_path: 'secret.txt' }],
      ['Grep', { pattern: 'x' }],
      ['Glob', { pattern: `${resolve('/private').replace(/\\/g, '/')}/*.txt`, path: HOME }],
      ['Glob', { pattern: '../private/*.txt', path: HOME }],
      // (as the CLI writes a path on Windows)
      ['Glob', { pattern: `${resolve('/private')}\\*.txt`, path: HOME }],
    ]
    for (const [name, args] of outs) {
      const w = world({ folders: [HOME], projects: { s9: 'p2' } })
      if (name === 'Read' || name === 'Grep' || name === 'Glob') await read(w, name, args)
      else await w.gate.when('orc', { name, args }, undefined, ran().run, refused)
      const { r } = await send(w, reply())
      expect(r.calls, `${name} ${JSON.stringify(args)}`).toHaveLength(1)
      expect(w.asked, `${name} ${JSON.stringify(args)}`).toHaveLength(1)
    }
  })

  it('every word back into the thread asks, except marking it handled; mail to the person was never the asker’s', async () => {
    const w = world({ folders: [HOME], answer: 'allow' })
    await read(w, 'Read', { file_path: OUTSIDE })
    await send(w, { action: 'update', thread: 't1', state: 'review', outcome: 'the file says hunter2' })
    await send(w, { action: 'close', thread: 't1', outcome: 'done' })
    expect(w.asked).toHaveLength(2)
    await send(w, { action: 'handled', thread: 't1' })
    expect(w.asked).toHaveLength(2)
    await send(w, { action: 'send', to: 'person', text: 'the file says hunter2' })
    expect(w.asked).toHaveLength(2)
  })

  it('a reply too long to show whole is refused, not asked about in part', async () => {
    const w = world({ folders: [HOME], answer: 'allow' })
    await read(w, 'Read', { file_path: OUTSIDE })
    const { out, r } = await send(w, reply('x'.repeat(7_000)))
    expect(out.isError).toBe(true)
    expect(out.text).toContain('too long to show the person')
    expect(w.asked).toEqual([])
    expect(r.calls).toEqual([])
  })

  it('a turn that is not a request remembers nothing', async () => {
    const w = world({ asker: () => null, folders: [HOME] })
    await read(w, 'Read', { file_path: OUTSIDE })
    expect((await send(w, reply())).r.calls).toHaveLength(1)
    expect(w.asked).toEqual([])
  })
})

describe('a read the CLI itself asks about, in a request (§9.7)', () => {
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
    const w = world({ asker: () => ({ ...ASKER, turn }), folders: [], answer: 'allow', afterAsk: () => void (turn = 2) })
    expect(await w.gate.askCliRead('orc', 'Read', { file_path: resolve('/private/a.txt') })).toMatchObject({ allowed: false, message: expect.stringContaining('has ended') })
  })
})


describe('what the orchestrator’s whole conversation has read (§9.7)', () => {
  const HOME = resolve('/work/acme')
  const OTHER_HOME = resolve('/work/zed')
  const OUTSIDE = resolve('/private/secret.txt')
  const reply = (text = 'the file says: hunter2', thread = 't1') => ({ action: 'reply', thread, text })
  const send = (w: ReturnType<typeof world>, args: Record<string, unknown>, name = 'mail') => {
    const r = ran()
    return w.gate.when('orc', { name, args }, undefined, r.run, refused).then((out) => ({ out, r }))
  }

  it('a read in one turn is still read in the next turn of the same request: the reply asks', async () => {
    let turn = 1
    const w = world({ asker: () => ({ ...ASKER, turn }), folders: [HOME], answer: 'allow' })
    await w.gate.askCli('orc', 'Read', { file_path: OUTSIDE })
    turn = 2
    const { r } = await send(w, reply())
    expect(r.calls).toHaveLength(1)
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).toContain(`Read of ${JSON.stringify(OUTSIDE)}`)
  })

  it('and a read in the person’s own turn, or in another session’s request, reaches a later request’s reply', async () => {
    let asker: Asker | null = null
    const w = world({ asker: () => asker, folders: [HOME], answer: 'allow' })
    // The person's turn: the hook tells the gate, nothing is asked
    w.gate.seen('orc', 'Read', { file_path: OUTSIDE })
    asker = ASKER
    const { r } = await send(w, reply())
    expect(r.calls).toHaveLength(1)
    expect(w.asked).toHaveLength(1)

    // A read by the host's own tools in the person's turn goes through the gate's `when`, with no asker
    let later: Asker | null = null
    const viaTool = world({ asker: () => later, folders: [HOME], answer: 'allow' })
    await viaTool.gate.when('orc', { name: 'recall', args: { query: 'x' } }, undefined, ran().run, refused)
    later = ASKER
    await send(viaTool, reply())
    expect(viaTool.asked).toHaveLength(1)
  })

  it('what it read is judged against whoever asks now: a file of the other asker’s folder is out of reach for this one', async () => {
    let asker: Asker = ASKER
    const w = world({ asker: () => asker, answer: 'allow', reachOf: (id) => ({ folders: [id === 'asker' ? HOME : OTHER_HOME], project: id === 'asker' ? 'p1' : 'p2' }) })
    w.gate.seen('orc', 'Read', { file_path: resolve('/work/zed/notes.txt') })
    // Its own folder's file: free
    asker = { ...ASKER, sessionId: 'zed', threadId: 't2' }
    expect((await send(w, reply('fine', 't2'))).r.calls).toHaveLength(1)
    expect(w.asked).toEqual([])
    // Another session's request: the file is not in its reach
    asker = ASKER
    await send(w, reply())
    expect(w.asked).toHaveLength(1)
  })

  it('a conversation this host did not see begin is not known to have read nothing; a new conversation starts clean', async () => {
    const w = world({ begun: false, folders: [HOME] })
    await send(w, reply())
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).toContain('from before this host started')
    w.gate.beginConversation('orc')
    w.gate.seen('orc', 'Read', { file_path: OUTSIDE })
    await send(w, reply())
    expect(w.asked).toHaveLength(2)
    w.gate.beginConversation('orc')
    await send(w, reply())
    expect(w.asked).toHaveLength(2)
  })

  it('a mail thread other than the request’s counts as read out of reach; its own thread does not', async () => {
    const own = world({ folders: [HOME] })
    await own.gate.when('orc', { name: 'mail', args: { action: 'read', thread: ' t1 ' } }, undefined, ran().run, refused)
    await own.gate.when('orc', { name: 'mail', args: { action: 'inbox' } }, undefined, ran().run, refused)
    await send(own, reply())
    expect(own.asked).toEqual([])
    const other = world({ folders: [HOME] })
    await other.gate.when('orc', { name: 'mail', args: { action: 'read', thread: 't9' } }, undefined, ran().run, refused)
    await send(other, reply())
    expect(other.asked).toHaveLength(1)
    expect(other.asked[0]).toContain('mail of "t9"')
  })

  it('after a recorded read any mail to a session asks with its whole text: a new thread to the asker, a padded thread id, update and close in another thread', async () => {
    const long = 'y'.repeat(900) + ' hunter2'
    const w = world({ folders: [HOME], answer: 'deny' })
    w.gate.seen('orc', 'Read', { file_path: OUTSIDE })
    for (const args of [
      { action: 'send', to: 'session:asker', text: long },
      { action: 'reply', thread: ' t1', text: long },
      { action: 'reply', thread: 't1 ', text: long },
      { action: 'reply', thread: 't7', text: long },
      { action: 'update', thread: 't7', state: 'review', outcome: long },
      { action: 'close', thread: 't7', outcome: long },
    ]) {
      const { r, out } = await send(w, args)
      expect(r.calls, JSON.stringify(args)).toEqual([])
      expect(out.text).toContain('Nothing was sent')
    }
    expect(w.asked).toHaveLength(6)
    for (const q of w.asked) {
      expect(q).toContain('Session "Fix login" in project "Acme" asked the orchestrator to')
      expect(q).toContain(long)
      expect(q).toContain('Read of')
    }
    // The person is not a session: free, and marking handled carries no words
    await send(w, { action: 'send', to: ' person ', text: long })
    await send(w, { action: 'handled', thread: ' t1' })
    expect(w.asked).toHaveLength(6)
  })

  it('without a recorded read a padded id of the request’s own thread is the same thread, and a send to a session asks as before', async () => {
    const w = world({ folders: [HOME], answer: 'allow' })
    expect((await send(w, reply('ok', ' t1 '))).r.calls).toHaveLength(1)
    expect(w.asked).toEqual([])
    await send(w, { action: 'send', to: 'session:asker', text: 'hello' })
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0]).not.toContain('has read what this session could not')
  })

  it('other steps that pass words on show them whole after a recorded read, not cut', async () => {
    const w = world({ folders: [HOME], answer: 'allow' })
    await w.gate.when('orc', { name: 'send_to_session', args: { sessionId: 's', text: 'z'.repeat(1_000) } }, undefined, ran().run, refused)
    expect(w.asked[0]).toContain('(1000 characters)')
    w.gate.seen('orc', 'Read', { file_path: OUTSIDE })
    await w.gate.when('orc', { name: 'send_to_session', args: { sessionId: 's', text: 'z'.repeat(1_000) } }, undefined, ran().run, refused)
    expect(w.asked[1]).toContain('z'.repeat(1_000))
    expect(w.asked[1]).not.toContain('characters)')
  })

  it('a project’s own state counts when it is another project’s or none is named; a machine’s activity always counts', async () => {
    const outs: [string, Record<string, unknown>][] = [
      ['project_git_status', { project: 'zed' }],
      ['list_app_errors', { app: 'board' }],
      ['list_app_runs', { app: 'board', project: 'p9' }],
      ['app_usage', { app: 'board' }],
      ['machine_activity', { machine: 'laptop' }],
    ]
    for (const [name, args] of outs) {
      const w = world({ folders: [HOME] })
      await w.gate.when('orc', { name, args }, undefined, ran().run, refused)
      await send(w, reply())
      expect(w.asked, name).toHaveLength(1)
    }
    // Its own project, by id or by name (any case), is in reach
    const mine = world({ folders: [HOME], projectName: 'Acme' })
    await mine.gate.when('orc', { name: 'project_git_status', args: { project: 'p1' } }, undefined, ran().run, refused)
    await mine.gate.when('orc', { name: 'project_git_status', args: { project: 'ACME' } }, undefined, ran().run, refused)
    await mine.gate.when('orc', { name: 'list_app_errors', args: { app: 'board', project: 'acme' } }, undefined, ran().run, refused)
    await send(mine, reply())
    expect(mine.asked).toEqual([])
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

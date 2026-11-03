/**
 * A session asking the orchestrator, over the real manager (#1447, #1739, docs/plans/cited-requests.md): a request reaches it on the person's
 * word only, and wakes it with host fields only; in the turn it starts every step the word does not cover raises the person's card naming the
 * session, under `auto` too, with Allow or Deny only. Without the word the request goes to the person. A turn that is not a session's request is
 * as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORCHESTRATOR_CHANGE, type ProjectInfo, type SessionInfo } from '@cc/protocol'
import type { CreateSessionOpts } from '../adapters/contract.js'
import type { MailRow } from '../dev-services/store/mailbox.js'
import { PERSON } from '../mail/address.js'
import type { HostMail } from '../mail/host-mail.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { FakeHandle, managerWorld } from './manager.test-helpers.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { commandsFor } from './orchestrator-tools.js'

let w: ReturnType<typeof managerWorld>
let m: HostMail
let read: ReturnType<typeof mailReader>
/** The mail's clock, from the wall clock's now: the person's message a request cites is stamped with the wall clock */
let clock = { t: Date.now() }
let dirs: string[] = []
let orc: SessionInfo
/** The options the orchestrator was launched with */
let orcOpts: CreateSessionOpts | null = null

beforeEach(async () => {
  w = managerWorld()
  w.mgr.useWindowRpc((method, params) => w.rpc(method, params))
  clock = { t: Date.now() }
  dirs = []
  m = wireHostMail(w.mgr, w.store, { now: () => clock.t, orchestratorHasMailCommand: () => commandsFor('orchestrator').includes('mail') })
  read = mailReader(w.store)
  // The delivery's first sweep is awaited: nothing of it is left running when the store closes
  const sweep = vi.spyOn(m.delivery, 'sweep')
  m.delivery.start()
  await sweep.mock.results[0]?.value
  sweep.mockRestore()
  // Claude's adapter runs a request's turn under a narrower mode (`gatesSteps`); the fake one has no CLI to narrow, and says it can
  w.adapter.capabilities.gatesSteps = true
  // The orchestrator runs without asking: the preset that would answer every card by itself
  orc = await w.mgr.createSession({ projectId: null, cwd: tmpdir(), tool: 'claude', permissionPreset: 'auto', kind: 'orchestrator' })
  orcOpts = w.adapter.lastOpts
})
afterEach(async () => {
  m.delivery.stop()
  await w.mgr.disposeAll()
  w.store.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

async function project(label: string, trusted: boolean): Promise<ProjectInfo> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `cc-asked-${label}-`)))
  dirs.push(dir)
  const p = (await w.rpc('projects.add', { path: dir })) as ProjectInfo
  if (trusted) await w.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
  return (await w.rpc('projects.list', {}) as ProjectInfo[]).find((x) => x.id === p.id)!
}
/** A session of the project, named, so the person's first message does not name it */
const sessionIn = async (p: ProjectInfo) => {
  const s = (await w.rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
  await w.rpc('sessions.rename', { sessionId: s.id, name: `Asker in ${p.name}` })
  return w.mgr.sessionInfo(s.id)!
}
const handleOf = (id: string): FakeHandle => {
  const h = w.adapter.handleOf(id)
  if (!h) throw new Error(`no process for ${id}`)
  return h
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}
const due = async (sessionId: string) => {
  clock.t += 3_000
  await m.delivery.process(addressOf(sessionId))
  await settle()
}
/** The person types in the session (the composer's path, `agents.send`), so a request of it may cite their word */
const personSays = async (to: SessionInfo, text: string) => {
  await w.rpc('agents.send', { sessionId: to.id, text })
  await settle()
  // The mail's clock catches up with the wall clock the message was stamped by
  clock.t = Date.now()
}
/** A request on the person's word: the person asks the session, and the session cites it (docs/plans/cited-requests.md) */
const askOrchestrator = async (from: SessionInfo, text: string, cite = true) => {
  if (cite) await personSays(from, `please: ${text}`)
  return w.mgr.runOrchestratorTool(from.id, 'mail', { action: 'send', to: 'orchestrator', text, ...(cite ? { cite: true } : {}) })
}
/** The session's requests to the orchestrator: messages from it with a row for the orchestrator, oldest first */
const requestsOf = (asker: SessionInfo): MailRow[] => read.between(addressOf(asker.id), addressOf(orc.id), 'message')
/** What the orchestrator sent the asker */
const wordsTo = (asker: SessionInfo): string[] => read.between(addressOf(orc.id), addressOf(asker.id)).map((x) => x.body)
const run = (command: string, args: Record<string, unknown> = {}) => w.mgr.runOrchestratorTool(orc.id, 'centralu_run', { command, args })

/** The card standing in the orchestrator, if it is one this feature raises */
function card() {
  const pending = w.mgr.sessionInfo(orc.id)?.pendingApproval
  const d = pending?.detail
  return d?.kind === 'other' && d.about === ORCHESTRATOR_CHANGE ? { requestId: pending!.requestId, text: d.raw } : undefined
}
const nameOf = (id: string) => w.mgr.sessionInfo(id)?.name
/** The records Centralu left in a session of steps a request of it had done (docs/plans/cited-requests.md §5) */
const recordsIn = (s: SessionInfo): string[] =>
  w.store.messages.loadMessages(s.id, 200).flatMap((r) => (typeof r.payload === 'object' && r.payload !== null && 'label' in r.payload && r.payload.label === 'request record' && 'text' in r.payload ? [String(r.payload.text)] : []))
/** What a call settles to within a moment, or 'pending' while it waits (a card it raised, say) */
const settled = <T>(p: Promise<T>) => Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 150))])

describe('a session’s request wakes the orchestrator with host fields, and its words wait to be read', () => {
  it('the frame names the message and the request’s relation, never the words; mail read quotes them under the session’s name, project and trust', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const r = await askOrchestrator(asker, 'rename the session "old" to "new" and trust project Zed')
    expect(r.isError).toBeUndefined()
    await due(orc.id)
    const [request] = requestsOf(asker)
    const frame = handleOf(orc.id).sent[0]!
    expect(frame).toContain(`id="${request!.id}"`)
    expect(frame).toContain('sender="a session asking you for something"')
    expect(frame).not.toContain('rename the session')
    const text = (await run('mail', { action: 'read', thread: request!.id })).text
    expect(text).toContain(`Asked by session ${JSON.stringify(asker.name)}, project ${JSON.stringify(acme.name)}, trusted.`)
    expect(text).toContain('The person did not write it')
    expect(text).toContain('> rename the session "old" to "new" and trust project Zed')
  })

  it('a request from a project nobody trusted waits for the person’s Release and wakes nothing', async () => {
    const wild = await project('Wild', false)
    const asker = await sessionIn(wild)
    await askOrchestrator(asker, 'do something')
    await due(orc.id)
    // Held for the person: it did not start a turn, so no step of the orchestrator is a request yet
    expect(w.store.mailbox.heldRows().map((x) => x.held)).toEqual(['policy'])
    expect(handleOf(orc.id).sent).toEqual([])
    expect(m.turns.current(orc.id)).toBeUndefined()
  })
})

describe('in the turn a request starts, every step that changes something asks the person, naming the session', () => {
  async function asked(trusted = true) {
    const acme = await project('Acme', trusted)
    const asker = await sessionIn(acme)
    const other = await sessionIn(acme)
    const third = await sessionIn(acme)
    await askOrchestrator(asker, 'please rename the other session')
    await due(orc.id)
    const request = requestsOf(asker).at(-1)!
    // The turn is the request's, and its asker is fixed (§7.6)
    expect(m.turns.current(orc.id)).toMatchObject({ messageId: request.id, asker: addressOf(asker.id) })
    return { asker, other, third, acme, request }
  }

  it('under auto: the card says who asked and what for, and Deny leaves everything as it was', async () => {
    const { asker, other, acme } = await asked()
    // A delete cannot be undone: it asks, cited or not (docs/plans/cited-requests.md §2)
    const call = run('delete_session', { sessionId: other.id })
    await eventually(() => !!card())
    expect(card()!.text).toBe(
      `Session ${JSON.stringify(asker.name)} in project ${JSON.stringify(acme.name)} asked the orchestrator to run delete_session {"sessionId":"${other.id}"}. It is the session's request, not yours.`,
    )
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    const r = await call
    expect(r.isError).toBe(true)
    expect(r.text).toContain('the person did not allow it')
    expect(nameOf(other.id)).toBe(other.name)
  })

  it('Allow does it, once: the next step asks again, and an old window’s “always” is only an Allow', async () => {
    const { other, third } = await asked()
    const first = run('delete_session', { sessionId: other.id })
    await eventually(() => !!card())
    w.mgr.respondApproval(orc.id, card()!.requestId, 'always')
    expect((await first).isError).toBeFalsy()
    expect(nameOf(other.id)).toBeUndefined()

    const second = run('delete_session', { sessionId: third.id })
    await eventually(() => !!card())
    expect(nameOf(third.id)).toBe(third.name)
    w.mgr.respondApproval(orc.id, card()!.requestId, 'allow')
    await second
    expect(nameOf(third.id)).toBeUndefined()
  })

  it('a step that can be undone takes no card, the one it raises itself covered: trusting a project, recorded where the session asked', async () => {
    const { asker, acme } = await asked()
    const wild = await project('Wild', false)
    // Were the trust card raised, the call would wait on it for good
    const r = await Promise.race([run('set_project_trust', { project: wild.id, trusted: true }), new Promise<'pending'>((res) => setTimeout(() => res('pending'), 3_000))])
    expect(r).not.toBe('pending')
    expect(w.mgr.sessionInfo(orc.id)?.pendingApproval ?? null).toBeNull()
    expect(((await w.rpc('projects.list', {})) as ProjectInfo[]).find((p) => p.id === wild.id)?.trusted).toBe(true)
    expect(acme.trusted).toBe(true)
    expect(recordsIn(asker)).toEqual([expect.stringContaining("the orchestrator did this for this session's request: run set_project_trust")])
  })

  it('reading and answering the request need no card, and nor does mail to anyone else, which is recorded', async () => {
    const { asker, other, request } = await asked()
    const reply = await settled(run('mail', { action: 'reply', thread: request.id, text: 'done: it is renamed' }))
    expect(reply).toMatchObject({ text: expect.stringContaining(`It answers ${request.id}`) })
    // Reading is free (what it read can matter to the answer after it: see the test on reads out of the asker's reach)
    expect(await settled(run('mail', { action: 'read', thread: request.id }))).toMatchObject({ text: expect.stringContaining('> please rename the other session') })
    expect(await settled(run('mail', { action: 'inbox' }))).not.toBe('pending')
    expect(await settled(w.mgr.runOrchestratorTool(orc.id, 'list_sessions', {}))).toMatchObject({ text: expect.stringContaining(other.id) })
    expect(card()).toBeUndefined()
    expect(wordsTo(asker)).toEqual(['done: it is renamed'])

    // A word to another session goes, and the asking session shows it went
    expect(await settled(run('mail', { action: 'send', to: other.id, text: 'a word to the other session' }))).toMatchObject({ text: expect.stringContaining('Sent') })
    expect(card()).toBeUndefined()
    expect(read.between(addressOf(orc.id), addressOf(other.id)).map((x) => x.body)).toEqual(['a word to the other session'])
    expect(recordsIn(asker)).toEqual([expect.stringContaining('run mail')])
  })

  it('the turn’s end is reported to the session that asked, and the next step is the orchestrator’s own again', async () => {
    const { asker, other, request } = await asked()
    handleOf(orc.id).finishTurn()
    await settle()
    // Centralu's report (S12), replying to the request, for the session that asked
    await eventually(() => read.reportsOn(request.id).length > 0)
    expect(read.reportsOn(request.id)).toEqual([expect.objectContaining({ sender: 'centralu', kind: 'report', replyTo: request.id })])
    expect(read.row(read.reportsOn(request.id)[0]!.id, addressOf(asker.id))).toBeDefined()
    // The request is settled, so the session may ask again (a request still open would hold its one open request for good)
    expect(read.row(request.id, addressOf(orc.id))).toMatchObject({ settled: 'reported' })
    expect((await askOrchestrator(asker, 'and one more thing')).isError).toBeUndefined()
    // No request is going now, so a step is not asked about
    const r = await settled(run('rename_session', { sessionId: other.id, name: 'Quiet' }))
    expect(r).not.toBe('pending')
    expect(nameOf(other.id)).toBe('Quiet')
  })
})

describe('a turn that is not a session’s request is as it was', () => {
  it('the person’s own turn: the same step runs with no card', async () => {
    const acme = await project('Acme', true)
    const other = await sessionIn(acme)
    handleOf(orc.id).send('the person typed')
    expect(m.turns.current(orc.id)?.messageId ?? null).toBeNull()
    const r = await settled(run('rename_session', { sessionId: other.id, name: 'By the person' }))
    expect(r).not.toBe('pending')
    expect(nameOf(other.id)).toBe('By the person')
  })

  it('work the person gave the orchestrator: its steps are the person’s', async () => {
    const acme = await project('Acme', true)
    const other = await sessionIn(acme)
    const task = m.service.task(PERSON, addressOf(orc.id), { text: 'rename it', origin: 'person', delivered: false })
    await due(orc.id)
    // A turn the mail started, whose asker is nobody: the person's task is no session's request
    expect(m.turns.current(orc.id)).toMatchObject({ by: 'mail', starter: task.id, asker: null })
    expect(m.hooks.askedBy!(orc.id)).toBeNull()
    const r = await settled(run('rename_session', { sessionId: other.id, name: 'Given by the person' }))
    expect(r).not.toBe('pending')
    expect(nameOf(other.id)).toBe('Given by the person')
  })
})

describe('the CLI’s own steps in a request’s turn (§9.7)', () => {
  async function asked() {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askOrchestrator(asker, 'please write a file')
    return { asker, acme }
  }

  it('the orchestrator is given the way to ask for its CLI’s steps; an ordinary session is not', async () => {
    const acme = await project('Acme', true)
    const ordinary = await sessionIn(acme)
    expect(w.adapter.handleOf(ordinary.id)).toBeTruthy()
    expect(w.adapter.lastOpts?.requestTurn).toBeUndefined()
    // The orchestrator’s own launch carried it
    expect(orcOpts?.requestTurn).toBeDefined()
  })

  it('in a session’s request a command or a file written asks the person, naming the session; Deny is the model’s answer, and reading is free', async () => {
    const { asker, acme } = await asked()
    const turn = orcOpts!.requestTurn!
    // Not a request’s turn yet: nothing is asked, and the CLI keeps its own mode
    expect(turn.active()).toBe(false)
    await due(orc.id)
    expect(turn.active()).toBe(true)

    expect(await turn.ask('Read', { file_path: 'a.txt' })).toEqual({ allowed: true, asked: false })
    expect(card()).toBeUndefined()
    const bash = turn.ask('Bash', { command: 'echo pwned > file' })
    await eventually(() => !!card())
    expect(card()!.text).toBe(
      `Session ${JSON.stringify(asker.name)} in project ${JSON.stringify(acme.name)} asked the orchestrator to run Bash {"command":"echo pwned > file"}. It is the session's request, not yours.`,
    )
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    expect(await bash).toMatchObject({ allowed: false, message: expect.stringContaining('the person did not allow it') })

    const write = turn.ask('Write', { file_path: 'b.txt', content: 'x' })
    await eventually(() => !!card())
    w.mgr.respondApproval(orc.id, card()!.requestId, 'allow')
    expect(await write).toEqual({ allowed: true, asked: true })

    // A subagent or a scheduled prompt would go on after the turn: refused, with no card
    expect(await turn.ask('Agent', { prompt: 'do it' })).toMatchObject({ allowed: false, message: expect.stringContaining('would go on after this turn') })
    expect(card()).toBeUndefined()

    // The turn ends: it is not a request’s turn, and the CLI’s steps are the orchestrator’s own again
    handleOf(orc.id).finishTurn()
    await settle()
    expect(turn.active()).toBe(false)
  })

  it('where the orchestrator’s tool cannot narrow a turn, a session cannot ask it: refused, in words, before anything is written', async () => {
    w.adapter.capabilities.gatesSteps = false
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const r = await askOrchestrator(asker, 'please write a file')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('cannot ask the person for each step of a request yet')
    expect(requestsOf(asker)).toEqual([])
    expect(w.store.mailbox.feedOf(addressOf(asker.id), { limit: 10 })).toEqual([])
  })
})

describe('who asked is fixed when the turn begins (§9.7)', () => {
  it('a session that goes to the trash in the middle of its request does not lift the gate: the next step still asks, naming it', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const other = await sessionIn(acme)
    await askOrchestrator(asker, 'please rename the other session')
    await due(orc.id)
    const [request] = requestsOf(asker)
    expect(m.turns.current(orc.id)).toMatchObject({ messageId: request!.id, asker: addressOf(asker.id) })
    // The asker is gone from the mailbox: its request no longer waits for an answer
    m.service.partyGone(addressOf(asker.id))
    expect(read.row(request!.id, addressOf(orc.id))?.settled).not.toBeNull()

    const call = run('delete_session', { sessionId: other.id })
    await eventually(() => !!card())
    expect(card()!.text).toContain(`Session ${JSON.stringify(asker.name)} in project ${JSON.stringify(acme.name)} asked the orchestrator to run delete_session`)
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    expect((await call).isError).toBe(true)
    expect(nameOf(other.id)).toBe(other.name)
  })

  it('and does not unhide a request held for the person', async () => {
    const wild = await project('Wild', false)
    const asker = await sessionIn(wild)
    await askOrchestrator(asker, 'SECRET-WORDS do something')
    await due(orc.id)
    const [request] = requestsOf(asker)
    expect(w.store.mailbox.heldRows().map((x) => x.held)).toEqual(['policy'])
    m.service.partyGone(addressOf(asker.id))
    // Its row is gone with its sender: nothing the orchestrator can read
    const r = await run('mail', { action: 'read', thread: request!.id })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('Refused (unknown_message)') })
    expect(r.text).not.toContain('SECRET-WORDS')
    expect((await run('mail', { action: 'inbox' })).text).not.toContain('SECRET-WORDS')
  })
})

describe('what the session gets back of the orchestrator’s turn (§9.7)', () => {
  it('not its last response, which was for the person, and no pointer to read its conversation', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askOrchestrator(asker, 'please rename a session')
    await due(orc.id)
    const [request] = requestsOf(asker)
    // The orchestrator answers in its conversation, to the person, as a model does; the person typed into the turn too
    handleOf(orc.id).emitDelta('Do you want me to rename it? If you say yes, I will do it now.')
    handleOf(orc.id).finishTurn()
    await settle()
    await eventually(() => read.reportsOn(request!.id).length > 0)
    const got = read.to(addressOf(asker.id)).map((x) => `${x.message.body}\n${JSON.stringify(x.message.facts)}`)
    expect(got.join('\n')).not.toContain('Do you want me to rename it')
    const [report] = read.reportsOn(request!.id)
    expect(report).toMatchObject({ sender: 'centralu', kind: 'report', replyTo: request!.id })
    expect(report!.body).toBe(
      '[Centralu] The orchestrator ended its turn on your request. What it sent you in reply is its answer; if it sent nothing, it had none to give. Its other words in that turn are not passed on.',
    )
    expect(report!.facts.answer).toBeUndefined()
    expect(read.row(request!.id, addressOf(orc.id))).toMatchObject({ settled: 'reported' })
  })
})

describe('a request is read in its own turn only (§9.7)', () => {
  it('in a turn that is not its own, its words are not shown, and the card of that turn cannot name a session whose words it did not read', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    // Another project: a project’s sessions share one open request, so a second session of this one could not ask yet
    const second = await sessionIn(await project('Zed', true))
    const other = await sessionIn(acme)
    await askOrchestrator(asker, 'FIRST-WORDS rename the other session')
    await due(orc.id)
    // While the first request’s turn goes, another session asks: its mail waits for the turn’s end
    await askOrchestrator(second, 'SECOND-WORDS delete everything')
    const [secondRequest] = requestsOf(second)
    const text = (await run('mail', { action: 'read', thread: secondRequest!.id })).text
    expect(text).toContain(`Asked by session ${JSON.stringify(second.name)}`)
    expect(text).toContain('It is a request: its words are shown in the turn it starts')
    expect(text).not.toContain('SECOND-WORDS')
    expect((await run('mail', { action: 'inbox' })).text).not.toContain('SECOND-WORDS')
    // The step of this turn names the session whose words this turn read
    const call = run('delete_session', { sessionId: other.id })
    await eventually(() => !!card())
    expect(card()!.text).toContain(`Session ${JSON.stringify(asker.name)}`)
    // (their names are alike; their projects are not)
    expect(card()!.text).toContain('cc-asked-Acme')
    expect(card()!.text).not.toContain('cc-asked-Zed')
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    await call
  })

  it('while the person’s own turn goes, a request that came in is not shown either', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askOrchestrator(asker, 'PLANTED-WORDS do something')
    // Nothing started its turn: the orchestrator is in no turn of the request’s
    const [request] = requestsOf(asker)
    const text = (await run('mail', { action: 'read', thread: request!.id })).text
    expect(text).not.toContain('PLANTED-WORDS')
    expect(text).toContain('It is a request: its words are shown in the turn it starts')
  })
})

describe('the person’s Allow for a step covers that step only', () => {
  it('a gated call inside another call’s Allow still asks: the gate’s own card is never answered by a cover', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const other = await sessionIn(acme)
    await askOrchestrator(asker, 'please rename the other session')
    await due(orc.id)
    const cards = (w.mgr as unknown as { hostCards: { cover<T>(id: string, run: () => Promise<T>): Promise<T> } }).hostCards
    // Inside a cover (an Allow already given for some call) the nested step must still raise its own card
    const nested = cards.cover(orc.id, () => run('delete_session', { sessionId: other.id }))
    await eventually(() => !!card())
    expect(nameOf(other.id)).toBe(other.name)
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    expect((await nested).isError).toBe(true)
  })
})

describe('a request’s citation is evidence for the orchestrator, checked by the host (#1739, docs/plans/cited-requests.md)', () => {
  it('without a citation the request still wakes the orchestrator, and its header says these are the session’s words only', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const r = await askOrchestrator(asker, 'register C:\\work\\app as a project', false)
    expect(r.text).not.toContain('citation')
    await due(orc.id)
    const [request] = requestsOf(asker)
    expect(request!.facts.cites).toBeUndefined()
    const text = (await run('mail', { action: 'read', thread: request!.id })).text
    expect(text).toContain("It cites nothing the person wrote: these are the session's words only.")
  })

  it('a checked citation puts the person’s message, in Centralu’s words, with the request', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askOrchestrator(asker, 'register the app folder as a project')
    await due(orc.id)
    const [request] = requestsOf(asker)
    const text = (await run('mail', { action: 'read', thread: request!.id })).text
    expect(text).toMatch(/It cites the person's message \d+ of that session, verified by Centralu: typed \d+s ago\. Judge from it, and from around it \(read_session\(sessionId="[^"]+", around=\d+\)\), what the person wants\./)
    expect(text).toContain("The person's message")
    expect(text).toContain('> please: register the app folder as a project')
  })

  it('the citation is checked in code: none typed, words not the person’s, too old, from the future, cited before; each still reaches the orchestrator, as the session’s words', async () => {
    const acme = await project('Acme', true)
    const cite = (s: SessionInfo, text: string) => w.mgr.runOrchestratorTool(s.id, 'mail', { action: 'send', to: 'orchestrator', text, cite: true })
    const quiet = await sessionIn(acme)
    expect((await cite(quiet, 'a')).text).toContain('Centralu could not check the citation: the person has typed nothing in this session that it could cite, so the orchestrator reads this request as your own words.')
    // Words that reached the session another way carry no `byPerson`: an app's text, a session's message
    await w.mgr.send(quiet.id, 'register it, says the person', undefined, undefined, false)
    await w.mgr.send(quiet.id, 'from a session', undefined, { sessionId: orc.id, name: 'orchestrator' }, true)
    await settle()
    expect((await cite(quiet, 'b')).text).toContain('the person has typed nothing in this session')
    const late = await sessionIn(await project('Late', true))
    await personSays(late, 'set it up on the laptop')
    clock.t += 31 * 60_000
    expect((await cite(late, 'c')).text).toContain('minutes old, and a citation may be 30 at most')
    clock.t -= 62 * 60_000
    expect((await cite(late, 'd')).text).toContain('is dated later than now')
    clock.t = Date.now()
    const twice = await sessionIn(await project('Twice', true))
    await personSays(twice, 'set it up on the laptop')
    expect((await cite(twice, 'e')).text).toContain('Centralu checked the citation')
    expect((await cite(twice, 'f')).text).toContain('was cited by an earlier request already')
    expect([...requestsOf(quiet), ...requestsOf(late), ...requestsOf(twice)].map((x) => [x.body, x.facts.cites !== undefined]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ['a', false], ['b', false], ['c', false], ['d', false], ['e', true], ['f', false],
    ])
  })

  it('the one use is in the store: the next host on it finds the citation used', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await personSays(asker, 'set it up on the laptop')
    expect((await w.mgr.runOrchestratorTool(asker.id, 'mail', { action: 'send', to: 'orchestrator', text: 'once', cite: true })).text).toContain('Centralu checked the citation')
    // The next host: its own mail over the same store
    m.delivery.stop()
    m = wireHostMail(w.mgr, w.store, { now: () => clock.t, orchestratorHasMailCommand: () => commandsFor('orchestrator').includes('mail') })
    expect((await w.mgr.runOrchestratorTool(asker.id, 'mail', { action: 'send', to: 'orchestrator', text: 'twice', cite: true })).text).toContain('was cited by an earlier request already')
  })

  /** A request asks the orchestrator to register a folder; the orchestrator does it in the request's turn */
  async function registered(cite: boolean): Promise<SessionInfo> {
    const acme = await project(`Acme${cite}`, true)
    const asker = await sessionIn(acme)
    await askOrchestrator(asker, 'register the app folder as a project', cite)
    await due(orc.id)
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'cc-asked-folder-')))
    dirs.push(folder)
    // (it reads the folder's git facts first, so it is given longer than `settled` gives; a card would hold it for good)
    const r = await Promise.race([run('add_project', { path: folder }), new Promise<'pending'>((res) => setTimeout(() => res('pending'), 10_000))])
    expect(r).toMatchObject({ text: expect.any(String) })
    expect(r).not.toMatchObject({ isError: true })
    expect(w.mgr.sessionInfo(orc.id)?.pendingApproval ?? null).toBeNull()
    expect(((await w.rpc('projects.list', {})) as ProjectInfo[]).some((p) => p.path === folder)).toBe(true)
    expect(recordsIn(asker)).toEqual([
      cite ? expect.stringMatching(/^On your message from 1 min ago \("please: register the app folder as a project"\), the orchestrator did this for this session's request: run add_project/) : expect.stringMatching(/^For this session's request, which cites no message of yours, the orchestrator did this: run add_project/),
    ])
    return asker
  }

  it('registering an existing folder takes no card on the person’s word, and the asking session shows what was done and on which word', async () => {
    await registered(true)
  })

  it('nor without it: the session’s own words, recorded as such', async () => {
    await registered(false)
  })
})

/**
 * A session asking the orchestrator, over the real manager (#1447, docs/plans/mailbox.md §9.7): the request wakes it with host fields only,
 * and in the turn it starts every step that changes something raises the person's card naming the session, under `auto` too, with Allow or
 * Deny only. A turn that is not a session's request is as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORCHESTRATOR_CHANGE, type ProjectInfo, type SessionInfo } from '@cc/protocol'
import type { CreateSessionOpts } from '../adapters/contract.js'
import { askedBy, askerFacts, type AskedByHost } from '../mail/asked-by.js'
import { parseAddress } from '../mail/address.js'
import { delegationRecorder, reportRecorder, turnRecorder } from '../mail/delegation.js'
import { MailDelivery } from '../mail/delivery.js'
import { mailRelations } from '../mail/relations.js'
import { MailService } from '../mail/service.js'
import { MailTool } from '../mail/tool.js'
import { MailTurns } from '../mail/turns.js'
import { COMMAND_CALLS, PLAIN_CALLS } from '../mail/frame.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { FakeHandle, managerWorld } from './manager.test-helpers.js'
import { commandsFor } from './orchestrator-tools.js'

let w: ReturnType<typeof managerWorld>
let mail: MailService
let delivery: MailDelivery
let turns: MailTurns
let clock = { t: 1_800_000_000_000 }
let dirs: string[] = []
let orc: SessionInfo
/** The options the orchestrator was launched with */
let orcOpts: CreateSessionOpts | null = null

const HOST = 'hub-aaaaaaaa'

beforeEach(async () => {
  w = managerWorld()
  w.mgr.useWindowRpc((method, params) => w.rpc(method, params))
  clock = { t: 1_800_000_000_000 }
  dirs = []
  mail = new MailService(w.store.mail, {
    hostId: () => HOST,
    now: () => clock.t,
    policy: mailRelations({
      session: (id) => w.mgr.sessionInfo(id),
      orchestratorAsks: () => w.mgr.orchestratorAsks(),
      ...w.mgr.mailSeats(() => commandsFor('orchestrator').includes('mail')),
      inThread: (threadId, address) => w.store.mail.participants(threadId).some((p) => p.address === address && p.leftAt === null),
    }),
  })
  turns = new MailTurns(w.store.mail, {
    now: () => clock.t,
    askerOf: (threadId) => {
      const thread = w.store.mail.thread(threadId)
      return thread ? mail.requestedBy(thread) : undefined
    },
  })
  const host: AskedByHost = {
    session: (id) => {
      const s = w.mgr.sessionInfo(id)
      return s && { name: s.name, projectId: s.projectId }
    },
    project: (id) => w.store.projects.listProjects().find((p) => p.id === id),
  }
  delivery = new MailDelivery(mail, w.store.mail, w.mgr.mailSessions(), {
    now: () => clock.t,
    schedule: () => () => {},
    turns,
    untrustedAsker: (address) => {
      const from = parseAddress(address)
      return from?.kind === 'session' && !askerFacts(host, from.sessionId).trusted
    },
  })
  const tool = new MailTool(
    mail,
    w.store.mail,
    (id) => (w.mgr.toolProfileOf(id) === 'orchestrator' ? COMMAND_CALLS : PLAIN_CALLS),
    (id) => askerFacts(host, id),
    () => w.mgr.orchestratorId(),
    (id) => turns.current(id)?.threadId ?? null,
  )
  w.mgr.useMail({
    askedBy: (id) => askedBy(host, turns, id),
    sessionGone: (id) => void mail.sessionGone(id),
    sessionChanged: (id) => delivery.poke(id),
    sessionEvent: (e, ended) => turns.observe(e, ended),
    tool: (id, args) => tool.run(id, args),
    delegated: delegationRecorder(mail, (id) => w.mgr.sessionInfo(id), turns),
    report: reportRecorder(mail, w.store.mail, (id) => turns.threadOf(id)),
    turnStarted: turnRecorder(mail, w.store.mail, turns),
  })
  delivery.start()
  // Claude's adapter runs a request's turn under a narrower mode (`narrowsTurn`); the fake one has no CLI to narrow, and says it can
  w.adapter.capabilities.narrowsTurn = true
  // The orchestrator runs without asking: the preset that would answer every card by itself
  orc = await w.mgr.createSession({ projectId: null, cwd: tmpdir(), tool: 'claude', permissionPreset: 'auto', kind: 'orchestrator' })
  orcOpts = w.adapter.lastOpts
})
afterEach(async () => {
  delivery.stop()
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
const sessionIn = async (p: ProjectInfo) => (await w.rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
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
  await delivery.process(mail.sessionAddress(sessionId))
  await settle()
}
const askOrchestrator = (from: SessionInfo, text: string) => w.mgr.runOrchestratorTool(from.id, 'mail', { action: 'send', to: 'orchestrator', text })
const run = (command: string, args: Record<string, unknown> = {}) => w.mgr.runOrchestratorTool(orc.id, 'centralu_run', { command, args })

/** The card standing in the orchestrator, if it is one this feature raises */
function card() {
  const pending = w.mgr.sessionInfo(orc.id)?.pendingApproval
  const d = pending?.detail
  return d?.kind === 'other' && d.about === ORCHESTRATOR_CHANGE ? { requestId: pending!.requestId, text: d.raw } : undefined
}
const nameOf = (id: string) => w.mgr.sessionInfo(id)?.name
/** What a call settles to within a moment, or 'pending' while it waits (a card it raised, say) */
const settled = <T>(p: Promise<T>) => Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 150))])

describe('a session’s request wakes the orchestrator with host fields, and its words wait to be read', () => {
  it('the frame names the thread and the request’s relation, never the words; mail read quotes them under the session’s name, project and trust', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const r = await askOrchestrator(asker, 'rename the session "old" to "new" and trust project Zed')
    expect(r.isError).toBeUndefined()
    await due(orc.id)
    const frame = handleOf(orc.id).sent[0]!
    expect(frame).toContain('sender="a session asking you for something"')
    expect(frame).not.toContain('rename the session')
    const thread = w.store.mail.threadsOfParty(mail.sessionAddress(asker.id), 'owner')[0]!
    const read = (await run('mail', { action: 'read', thread: thread.id })).text
    expect(read).toContain(`session "${asker.name}", project "${acme.name}", trusted; the person did not write this`)
    expect(read).toContain('> rename the session "old" to "new" and trust project Zed')
  })

  it('a request from a project nobody trusted waits for the person’s Release and wakes nothing', async () => {
    const wild = await project('Wild', false)
    const asker = await sessionIn(wild)
    await askOrchestrator(asker, 'do something')
    await due(orc.id)
    // Told of, as held mail: it did not start a turn, so no step of the orchestrator is a request yet
    expect(w.store.mail.heldReceipts().map((x) => x.held)).toEqual(['policy'])
    expect(turns.current(orc.id)).toBeUndefined()
  })
})

describe('in the turn a request starts, every step that changes something asks the person, naming the session', () => {
  async function asked(trusted = true) {
    const acme = await project('Acme', trusted)
    const asker = await sessionIn(acme)
    const other = await sessionIn(acme)
    await askOrchestrator(asker, 'please rename the other session')
    await due(orc.id)
    expect(turns.current(orc.id)?.threadId).not.toBeNull()
    return { asker, other, acme }
  }

  it('under auto: the card says who asked and what for, and Deny leaves everything as it was', async () => {
    const { asker, other, acme } = await asked()
    const before = nameOf(other.id)
    const call = run('rename_session', { sessionId: other.id, name: 'Renamed by request' })
    await eventually(() => !!card())
    expect(card()!.text).toBe(
      `Session ${JSON.stringify(asker.name)} in project ${JSON.stringify(acme.name)} asked the orchestrator to run rename_session {"sessionId":"${other.id}","name":"Renamed by request"}. It is the session's request, not yours.`,
    )
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    const r = await call
    expect(r.isError).toBe(true)
    expect(r.text).toContain('the person did not allow it')
    expect(nameOf(other.id)).toBe(before)
  })

  it('Allow does it, once: the next step asks again, and an old window’s “always” is only an Allow', async () => {
    const { other } = await asked()
    const first = run('rename_session', { sessionId: other.id, name: 'First' })
    await eventually(() => !!card())
    w.mgr.respondApproval(orc.id, card()!.requestId, 'always')
    expect((await first).isError).toBeFalsy()
    expect(nameOf(other.id)).toBe('First')

    const second = run('rename_session', { sessionId: other.id, name: 'Second' })
    await eventually(() => !!card())
    expect(nameOf(other.id)).toBe('First')
    w.mgr.respondApproval(orc.id, card()!.requestId, 'allow')
    await second
    expect(nameOf(other.id)).toBe('Second')
  })

  it('a step that asks on its own is one card, not two: trusting a project is the person’s one Allow', async () => {
    const { acme } = await asked()
    const wild = await project('Wild', false)
    const call = run('set_project_trust', { project: wild.id, trusted: true })
    await eventually(() => !!card())
    expect(card()!.text).toContain('asked the orchestrator to run set_project_trust')
    w.mgr.respondApproval(orc.id, card()!.requestId, 'allow')
    // Were the trust card raised too, the call would wait on it for good
    const r = await Promise.race([call, new Promise<'pending'>((res) => setTimeout(() => res('pending'), 3_000))])
    expect(r).not.toBe('pending')
    expect(card()).toBeUndefined()
    expect(((await w.rpc('projects.list', {})) as ProjectInfo[]).find((p) => p.id === wild.id)?.trusted).toBe(true)
    expect(acme.trusted).toBe(true)
  })

  it('reading and answering in the thread need no card; mail to anyone else does', async () => {
    const { asker, other } = await asked()
    const thread = w.store.mail.threadsOfParty(mail.sessionAddress(asker.id), 'owner')[0]!
    expect(await settled(w.mgr.runOrchestratorTool(orc.id, 'list_sessions', {}))).toMatchObject({ text: expect.stringContaining(other.id) })
    expect(await settled(run('mail', { action: 'inbox' }))).toMatchObject({ text: expect.stringContaining(thread.id) })
    const reply = await settled(run('mail', { action: 'reply', thread: thread.id, text: 'done: it is renamed' }))
    expect(reply).toMatchObject({ text: expect.stringContaining('Posted') })
    expect(card()).toBeUndefined()

    // A word to another session, or to a thread that is not this request, is a step that reaches someone: it asks
    const sent = run('mail', { action: 'send', to: other.id, text: 'a word to the other session' })
    await eventually(() => !!card())
    expect(card()!.text).toContain('asked the orchestrator to run mail')
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    expect((await sent).isError).toBe(true)
    expect(w.store.mail.threadsOfParty(mail.sessionAddress(orc.id), 'owner')).toEqual([])
  })

  it('the turn’s end is reported to the session that asked, and the next step is the orchestrator’s own again', async () => {
    const { asker, other } = await asked()
    handleOf(orc.id).finishTurn()
    await settle()
    const thread = w.store.mail.threadsOfParty(mail.sessionAddress(asker.id), 'owner')[0]!
    await eventually(() => w.store.mail.messagesAfter(thread.id, 0).some((m) => m.kind === 'report' && m.sender === 'centralu'))
    // The thread is answered, so the session may ask again (a request still `running` would hold its one open request for good)
    expect(w.store.mail.thread(thread.id)?.state).toBe('review')
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
    expect(turns.current(orc.id)?.threadId ?? null).toBeNull()
    const r = await settled(run('rename_session', { sessionId: other.id, name: 'By the person' }))
    expect(r).not.toBe('pending')
    expect(nameOf(other.id)).toBe('By the person')
  })

  it('a thread the person gave the orchestrator: its steps are the person’s', async () => {
    const acme = await project('Acme', true)
    const other = await sessionIn(acme)
    mail.open('person', { kind: 'assign', subject: 'rename', body: 'rename it', assignee: mail.sessionAddress(orc.id) })
    await due(orc.id)
    expect(turns.current(orc.id)?.threadId).toBeTruthy()
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

    expect(await turn.ask('Read', { file_path: 'a.txt' })).toEqual({ allowed: true })
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
    expect(await write).toEqual({ allowed: true })

    // The turn ends: it is not a request’s turn, and the CLI’s steps are the orchestrator’s own again
    handleOf(orc.id).finishTurn()
    await settle()
    expect(turn.active()).toBe(false)
  })

  it('where the orchestrator’s tool cannot narrow a turn, a session cannot ask it: refused, in words, before anything is written', async () => {
    w.adapter.capabilities.narrowsTurn = false
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const r = await askOrchestrator(asker, 'please write a file')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('cannot ask the person for each step of a request yet')
    expect(w.store.mail.threadsOfParty(mail.sessionAddress(asker.id), 'owner')).toEqual([])
  })
})

describe('who asked is fixed when the turn begins (§9.7)', () => {
  it('a session that goes to the trash in the middle of its request does not lift the gate: the next step still asks, naming it', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const other = await sessionIn(acme)
    await askOrchestrator(asker, 'please rename the other session')
    await due(orc.id)
    // The person owns the request now
    mail.sessionGone(asker.id)
    const thread = w.store.mail.threadsOfParty(mail.sessionAddress(orc.id), 'assignee')[0]!
    expect(thread.owner).toBe('person')

    const call = run('rename_session', { sessionId: other.id, name: 'Renamed after the asker left' })
    await eventually(() => !!card())
    expect(card()!.text).toContain(`Session ${JSON.stringify(asker.name)} in project ${JSON.stringify(acme.name)} asked the orchestrator to run rename_session`)
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    expect((await call).isError).toBe(true)
    expect(nameOf(other.id)).not.toBe('Renamed after the asker left')
  })

  it('and does not unhide a request held for the person', async () => {
    const wild = await project('Wild', false)
    const asker = await sessionIn(wild)
    await askOrchestrator(asker, 'SECRET-WORDS do something')
    await due(orc.id)
    const thread = w.store.mail.threadsOfParty(mail.sessionAddress(asker.id), 'owner')[0]!
    expect(w.store.mail.heldReceipts().map((x) => x.held)).toEqual(['policy'])
    mail.sessionGone(asker.id)
    const read = (await run('mail', { action: 'read', thread: thread.id })).text
    expect(read).toContain('waits for the person to release it')
    expect(read).not.toContain('SECRET-WORDS')
  })
})

describe('what the session gets back of the orchestrator’s turn (§9.7)', () => {
  it('not its last response, which was for the person, and no pointer to read its conversation', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askOrchestrator(asker, 'please rename a session')
    await due(orc.id)
    const thread = w.store.mail.threadsOfParty(mail.sessionAddress(asker.id), 'owner')[0]!
    // The orchestrator answers in its conversation, to the person, as a model does; the person typed into the turn too
    handleOf(orc.id).emitDelta('Do you want me to rename it? If you say yes, I will do it now.')
    handleOf(orc.id).finishTurn()
    await settle()
    await eventually(() => w.store.mail.messagesAfter(thread.id, 0).some((m) => m.kind === 'report' && m.sender === 'centralu'))
    const words = w.store.mail.messagesAfter(thread.id, 0)
    expect(words.map((m) => m.body).join('\n')).not.toContain('Do you want me to rename it')
    const report = words.find((m) => m.kind === 'report' && m.sender === 'centralu')!
    expect(report.body).toContain('The orchestrator ended its turn on your request')
    expect(report.body).not.toContain('read_session')
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
    const secondThread = w.store.mail.threadsOfParty(mail.sessionAddress(second.id), 'owner')[0]!
    const read = (await run('mail', { action: 'read', thread: secondThread.id })).text
    expect(read).toContain(`is a request from session ${JSON.stringify(second.name)}`)
    expect(read).not.toContain('SECOND-WORDS')
    expect((await run('mail', { action: 'inbox' })).text).not.toContain('SECOND-WORDS')
    // The step of this turn names the session whose words this turn read
    const call = run('rename_session', { sessionId: other.id, name: 'Named' })
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
    const thread = w.store.mail.threadsOfParty(mail.sessionAddress(asker.id), 'owner')[0]!
    const read = (await run('mail', { action: 'read', thread: thread.id })).text
    expect(read).not.toContain('PLANTED-WORDS')
    expect(read).toContain('Its words are not shown in this turn')
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
    const nested = cards.cover(orc.id, () => run('rename_session', { sessionId: other.id, name: 'Nested' }))
    await eventually(() => !!card())
    expect(nameOf(other.id)).not.toBe('Nested')
    w.mgr.respondApproval(orc.id, card()!.requestId, 'deny')
    expect((await nested).isError).toBe(true)
  })
})

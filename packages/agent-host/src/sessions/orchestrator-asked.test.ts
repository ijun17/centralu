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
      ...w.mgr.mailSeats(() => commandsFor('orchestrator').includes('mail')),
      inThread: (threadId, address) => w.store.mail.participants(threadId).some((p) => p.address === address && p.leftAt === null),
    }),
  })
  turns = new MailTurns(w.store.mail, { now: () => clock.t })
  const host: AskedByHost = {
    hostId: () => HOST,
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
  )
  w.mgr.useMail({
    askedBy: (id) => askedBy(host, turns, w.store.mail, id),
    sessionGone: (id) => void mail.sessionGone(id),
    sessionChanged: (id) => delivery.poke(id),
    sessionEvent: (e, ended) => turns.observe(e, ended),
    tool: (id, args) => tool.run(id, args),
    delegated: delegationRecorder(mail, (id) => w.mgr.sessionInfo(id), turns),
    report: reportRecorder(mail, w.store.mail),
    turnStarted: turnRecorder(mail, w.store.mail, turns),
  })
  delivery.start()
  // The orchestrator runs without asking: the preset that would answer every card by itself
  orc = await w.mgr.createSession({ projectId: null, cwd: tmpdir(), tool: 'claude', permissionPreset: 'auto', kind: 'orchestrator' })
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
      `Session "${asker.name}" in project "${acme.name}" asked the orchestrator to run rename_session {"sessionId":"${other.id}","name":"Renamed by request"}. It is the session's request, not yours.`,
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

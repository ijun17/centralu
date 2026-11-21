/**
 * A session asking the Assistant, over the real manager (#1447, #1739, #2411, docs/plans/cited-requests.md): every request wakes it with host
 * fields only, says whether it cites the person's message, which the host checked, and tells it to judge the request. In the turn it starts the
 * Assistant's steps run as in the person's own turn: no card of the request's, and the cards a step raises itself ask as they do there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectInfo, SessionInfo } from '@cc/protocol'
import type { CreateSessionOpts } from '../adapters/contract.js'
import type { MailRow } from '../dev-services/store/mailbox.js'
import { PERSON } from '../mail/address.js'
import type { HostMail } from '../mail/host-mail.js'
import { wakesMessage } from '../mail/rules.js'
import { JUDGE_REQUEST } from '../mail/tool.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { FakeHandle, managerWorld } from './manager.test-helpers.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { commandsFor } from './centralu-tools.js'

let w: ReturnType<typeof managerWorld>
let m: HostMail
let read: ReturnType<typeof mailReader>
/** The mail's clock, from the wall clock's now: the person's message a request cites is stamped with the wall clock */
let clock = { t: Date.now() }
let orc: SessionInfo
/** The options the Assistant was launched with */
let orcOpts: CreateSessionOpts | null = null

beforeEach(async () => {
  w = managerWorld()
  w.mgr.useWindowRpc((method, params) => w.rpc(method, params))
  clock = { t: Date.now() }
  m = wireHostMail(w.mgr, w.store, { now: () => clock.t, assistantHasMailCommand: () => commandsFor('assistant').includes('mail') })
  read = mailReader(w.store)
  // The delivery's first sweep is awaited: nothing of it is left running when the store closes
  const sweep = vi.spyOn(m.delivery, 'sweep')
  m.delivery.start()
  await sweep.mock.results[0]?.value
  sweep.mockRestore()
  // The Assistant runs without asking: the preset that would answer every card by itself
  orc = await w.mgr.createSession({ projectId: null, cwd: tmpdir(), tool: 'claude', permissionPreset: 'auto', kind: 'orchestrator' })
  orcOpts = w.adapter.lastOpts
})
afterEach(async () => {
  m.delivery.stop()
  await w.mgr.tenure.disposeAll()
  w.store.close()
})

async function project(label: string, trusted: boolean): Promise<ProjectInfo> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `cc-asked-${label}-`)))
  const p = (await w.rpc('projects.add', { path: dir })) as ProjectInfo
  if (trusted) await w.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
  return (await w.rpc('projects.list', {}) as ProjectInfo[]).find((x) => x.id === p.id)!
}
/** A session of the project, named, so the person's first message does not name it */
const sessionIn = async (p: ProjectInfo, permissionPreset?: SessionInfo['permissionPreset']) => {
  const s = (await w.rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude', ...(permissionPreset ? { permissionPreset } : {}) })) as SessionInfo
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
const askAssistant = async (from: SessionInfo, text: string, cite = true) => {
  if (cite) await personSays(from, `please: ${text}`)
  return w.mgr.runCentraluTool(from.id, 'mail', { action: 'send', to: 'assistant', text, ...(cite ? { cite: true } : {}) })
}
/** The session's requests to the Assistant: messages from it with a row for the Assistant, oldest first */
const requestsOf = (asker: SessionInfo): MailRow[] => read.between(addressOf(asker.id), addressOf(orc.id), 'message')
/** What the Assistant sent the asker */
const wordsTo = (asker: SessionInfo): string[] => read.between(addressOf(orc.id), addressOf(asker.id)).map((x) => x.body)
const run = (command: string, args: Record<string, unknown> = {}) => w.mgr.runCentraluTool(orc.id, 'centralu_run', { command, args })
/** One of the Assistant's own tools, called directly rather than as a command */
const tool = (name: string, args: Record<string, unknown>) => w.mgr.runCentraluTool(orc.id, name, args)
/** The card standing in the Assistant, if any */
const pending = () => w.mgr.sessionInfo(orc.id)?.pendingApproval ?? null
const nameOf = (id: string) => w.mgr.sessionInfo(id)?.name
/** What a call settles to within a moment, or 'pending' while it waits (a card it raised, say) */
const settled = <T>(p: Promise<T>) => Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 150))])

describe('a session’s request wakes the Assistant with host fields, and its words wait to be read', () => {
  it('the frame names the message and the request’s relation, never the words; mail read quotes them under the session’s name, project, trust and the judgement asked of the Assistant', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const r = await askAssistant(asker, 'rename the session "old" to "new" and trust project Zed')
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
    expect(text).toContain(JUDGE_REQUEST)
    expect(text.indexOf(JUDGE_REQUEST)).toBeLessThan(text.indexOf('> rename the session "old" to "new" and trust project Zed'))
  })

  it('a request from a project nobody trusted waits for the person’s Release and wakes nothing', async () => {
    const wild = await project('Wild', false)
    const asker = await sessionIn(wild)
    await askAssistant(asker, 'do something')
    await due(orc.id)
    // Held for the person: it did not start a turn
    expect(w.store.mailbox.heldRows().map((x) => x.held)).toEqual(['policy'])
    expect(handleOf(orc.id).sent).toEqual([])
    expect(m.turns.current(orc.id)).toBeUndefined()
  })

  it('whatever tool the Assistant runs on: one that cannot hook each step of its CLI takes requests too (#2411)', async () => {
    w.adapter.capabilities.gatesSteps = false
    const asker = await sessionIn(await project('Acme', true))
    const r = await askAssistant(asker, 'please look at CI')
    expect(r.isError).toBeUndefined()
    expect(requestsOf(asker)).toHaveLength(1)
  })
})

describe('in the turn a request starts, the Assistant’s steps run as in the person’s own turn (#2411)', () => {
  async function asked(askerPreset?: SessionInfo['permissionPreset']) {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme, askerPreset)
    const other = await sessionIn(acme)
    await askAssistant(asker, 'please look at the other session')
    await due(orc.id)
    const request = requestsOf(asker).at(-1)!
    expect(m.turns.current(orc.id)).toMatchObject({ messageId: request.id, asker: addressOf(asker.id) })
    return { asker, other, acme, request }
  }

  it('the Assistant’s CLI is launched with nothing in front of its steps but its own preset: a command or a file edit is not put to the person for a request', () => {
    expect(orcOpts).toBeDefined()
    expect(orcOpts).not.toHaveProperty('requestTurn')
  })

  it('under auto, steps a stricter asker could not take itself run with no card, and the asking session gets no record of them', async () => {
    const { asker, other, acme } = await asked('safe')
    // Work handed to a session looser than the `safe` asker
    expect(await settled(tool('send_to_session', { sessionId: other.id, text: 'look at the login page' }))).not.toMatchObject({ isError: true })
    // A new session gets the project's default within the seat's own, not the asker's preset
    expect(await settled(tool('create_session', { project: acme.id, firstMessage: 'start on it' }))).not.toMatchObject({ isError: true })
    expect(w.mgr.listSessions().filter((x) => x.projectId === acme.id && x.id !== asker.id && x.id !== other.id)).toMatchObject([{ permissionPreset: 'auto' }])
    // Background work cleared, which cannot be undone and asks nobody in the person's own turn either
    expect(await settled(run('clear_background_tasks', { sessionId: other.id }))).toMatchObject({ text: expect.stringContaining('nothing changed') })
    expect(pending()).toBeNull()
    const notices = w.store.messages.loadMessages(asker.id, 200).filter((r) => typeof r.payload === 'object' && r.payload !== null && 'label' in r.payload && r.payload.label === 'request record')
    expect(notices).toEqual([])
  })

  it('a step’s own card still asks, as in the person’s own turn: registering a folder raises the project’s card, and Deny leaves it unregistered', async () => {
    await asked()
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'cc-asked-folder-')))
    const call = run('add_project', { path: folder })
    await eventually(() => pending()?.detail.kind === 'project_add', 10_000)
    w.mgr.inputs.respondApproval(orc.id, pending()!.requestId, 'deny')
    expect((await call).isError).toBe(true)
    expect(((await w.rpc('projects.list', {})) as ProjectInfo[]).some((p) => p.path === folder)).toBe(false)
  })

  it('reading and answering the request need no card', async () => {
    const { asker, other, request } = await asked()
    const reply = await settled(run('mail', { action: 'reply', thread: request.id, text: 'done: it is renamed' }))
    expect(reply).toMatchObject({ text: expect.stringContaining(`It answers ${request.id}`) })
    expect(await settled(run('mail', { action: 'read', thread: request.id }))).toMatchObject({ text: expect.stringContaining('> please look at the other session') })
    expect(await settled(w.mgr.runCentraluTool(orc.id, 'list_sessions', {}))).toMatchObject({ text: expect.stringContaining(other.id) })
    expect(pending()).toBeNull()
    expect(wordsTo(asker)).toEqual(['done: it is renamed'])
  })

  it('the turn’s end is reported to the session that asked, which may ask again', async () => {
    const { asker, request } = await asked()
    handleOf(orc.id).finishTurn()
    await settle()
    // Centralu's report (S12), replying to the request, for the session that asked
    await eventually(() => read.reportsOn(request.id).length > 0)
    expect(read.reportsOn(request.id)).toEqual([expect.objectContaining({ sender: 'centralu', kind: 'report', replyTo: request.id })])
    expect(read.row(read.reportsOn(request.id)[0]!.id, addressOf(asker.id))).toBeDefined()
    expect(read.row(request.id, addressOf(orc.id))).toMatchObject({ settled: 'reported' })
    expect((await askAssistant(asker, 'and one more thing')).isError).toBeUndefined()
  })
})

describe('a turn that is not a session’s request carries no judgement of one', () => {
  it('work the person gave the Assistant: its steps are the person’s, and reading it shows no request’s header', async () => {
    const acme = await project('Acme', true)
    const other = await sessionIn(acme)
    const task = m.service.task(PERSON, addressOf(orc.id), { text: 'rename it', origin: 'person', delivered: false })
    await due(orc.id)
    // A turn the mail started, whose asker is nobody: the person's task is no session's request
    expect(m.turns.current(orc.id)).toMatchObject({ by: 'mail', starter: task.id, asker: null })
    const text = (await run('mail', { action: 'read', thread: task.id })).text
    expect(text).toContain('> rename it')
    expect(text).not.toContain(JUDGE_REQUEST)
    const r = await settled(run('rename_session', { sessionId: other.id, name: 'Given by the person' }))
    expect(r).not.toBe('pending')
    expect(nameOf(other.id)).toBe('Given by the person')
  })
})

describe('a request held for the person', () => {
  it('stays hidden when its sender goes to the trash', async () => {
    const wild = await project('Wild', false)
    const asker = await sessionIn(wild)
    await askAssistant(asker, 'SECRET-WORDS do something')
    await due(orc.id)
    const [request] = requestsOf(asker)
    expect(w.store.mailbox.heldRows().map((x) => x.held)).toEqual(['policy'])
    m.service.stops.partyGone(addressOf(asker.id))
    // Its row is gone with its sender: nothing the Assistant can read
    const r = await run('mail', { action: 'read', thread: request!.id })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('Refused (unknown_message)') })
    expect(r.text).not.toContain('SECRET-WORDS')
    expect((await run('mail', { action: 'inbox' })).text).not.toContain('SECRET-WORDS')
  })
})

describe('what the session gets back of the Assistant’s turn (§9.7)', () => {
  it('not its last response, which was for the person, and no pointer to read its conversation', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askAssistant(asker, 'please rename a session')
    await due(orc.id)
    const [request] = requestsOf(asker)
    // The Assistant answers in its conversation, to the person, as a model does; the person typed into the turn too
    handleOf(orc.id).emitDelta('Do you want me to rename it? If you say yes, I will do it now.')
    handleOf(orc.id).finishTurn()
    await settle()
    await eventually(() => read.reportsOn(request!.id).length > 0)
    const got = read.to(addressOf(asker.id)).map((x) => `${x.message.body}\n${JSON.stringify(x.message.facts)}`)
    expect(got.join('\n')).not.toContain('Do you want me to rename it')
    const [report] = read.reportsOn(request!.id)
    expect(report).toMatchObject({ sender: 'centralu', kind: 'report', replyTo: request!.id })
    expect(report!.body).toBe(
      '[Centralu] The Assistant ended its turn on your request. What it sent you in reply is its answer; if it sent nothing, it had none to give. Its other words in that turn are not passed on.',
    )
    expect(report!.facts.answer).toBeUndefined()
    expect(read.row(request!.id, addressOf(orc.id))).toMatchObject({ settled: 'reported' })
  })
})

/**
 * The sender of a request always learns that it will not be answered (owner, #1186): a stop of the request's turn, or a quit found at the next start,
 * tells it once, by the stop notice alone (mailbox.md §10.6.1, §10.6.3). A crash is `turnsLost`'s (`lost`, mail/stop-notices.test.ts)
 */
describe('a request whose turn is stopped or cut by a quit', () => {
  const meta = (id: string) => (w.mgr as unknown as { meta: Map<string, { interruption?: unknown }> }).meta.get(id)!
  const stopNotices = (asker: SessionInfo) => read.to(addressOf(asker.id)).filter((x) => x.message.kind === 'notice' && x.message.facts.unanswered)
  /** An asker's request, delivered into the Assistant's turn it started, which is still running */
  const requestRunning = async () => {
    const asker = await sessionIn(await project('Acme', true))
    await askAssistant(asker, 'please rename a session')
    await due(orc.id)
    const [request] = requestsOf(asker)
    expect(w.mgr.sessionInfo(orc.id)?.state).toBe('working')
    return { asker, request: request! }
  }
  /** The next start found the Assistant's request turn cut by a quit (`asker` too, when `askerCut`), and the mailbox is ready (`HostMail.afterReady`) */
  const quitFound = async (asker: SessionInfo, askerCut: boolean) => {
    meta(orc.id).interruption = { reason: 'quit', at: Date.now() }
    if (askerCut) meta(asker.id).interruption = { reason: 'quit', at: Date.now() }
    m.afterReady()
    await settle()
  }
  const notAnswered = (request: MailRow) => `Centralu quit while ${nameOf(orc.id)} worked on ${request.id}, so it did not answer. The person decides whether it goes on; ask again later if you still need the answer.`

  it("the person's Stop: the request is released, and the asker reads the stop notice once; no report besides", async () => {
    const { asker, request } = await requestRunning()
    handleOf(orc.id).emitEvent({ type: 'state_change', sessionId: orc.id, state: 'waiting_input', reason: 'interrupted' })
    await eventually(() => stopNotices(asker).length === 1)
    await settle()
    // A stop goes through the stop notice (§10.6.3): released with the stop's cause and marked told by it, the request still open for a reply
    expect(stopNotices(asker).map((n) => n.message.facts.unanswered)).toEqual([[{ id: request.id, recipient: addressOf(orc.id), why: 'stopped' }]])
    expect(read.row(request.id, addressOf(orc.id))).toMatchObject({ settled: null, releasedWhy: 'stopped', toldAt: expect.any(Number) })
    expect(read.reportsOn(request.id)).toEqual([])
  })

  it('a quit while the asker was at rest: the stop notice at the next start tells it its request was not answered, and wakes it; no report besides', async () => {
    const { asker, request } = await requestRunning()
    await quitFound(asker, false)
    expect(read.reportsOn(request.id)).toEqual([])
    expect(stopNotices(asker)).toHaveLength(1)
    const notice = stopNotices(asker)[0]!.message
    // Owed a reply and at rest: woken (mailbox.md §10.6.1)
    expect(notice.facts).toEqual({ unanswered: [{ id: request.id, recipient: addressOf(orc.id), why: 'quit' }] })
    expect(wakesMessage(notice)).toBe(true)
    expect(notice.body).toBe(notAnswered(request))
    // Released with the quit and marked told by the notice: the asker reads of this quit once
    expect(read.row(request.id, addressOf(orc.id))).toMatchObject({ releasedWhy: 'quit', toldAt: expect.any(Number) })
  })

  it('a quit that cut the asker too: the stop notice tells it, quietly, that its request was not answered', async () => {
    const { asker, request } = await requestRunning()
    await quitFound(asker, true)
    expect(read.reportsOn(request.id)).toEqual([])
    expect(stopNotices(asker)).toHaveLength(1)
    const notice = stopNotices(asker)[0]!.message
    // It waits for the person's Continue: a wake would start a turn with nobody there
    expect(notice.facts).toEqual({ quiet: true, unanswered: [{ id: request.id, recipient: addressOf(orc.id), why: 'quit' }] })
    expect(wakesMessage(notice)).toBe(false)
    expect(notice.body).toBe(notAnswered(request))
    expect(read.row(request.id, addressOf(orc.id))).toMatchObject({ releasedWhy: 'quit', toldAt: expect.any(Number) })
  })
})

describe('a request is read in its own turn only (§9.7)', () => {
  it('in a turn that is not its own, neither its words nor the judgement asked for them are shown', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    // Another project: a project’s sessions share one open request, so a second session of this one could not ask yet
    const second = await sessionIn(await project('Zed', true))
    await askAssistant(asker, 'FIRST-WORDS rename the other session')
    await due(orc.id)
    // While the first request’s turn goes, another session asks: its mail waits for the turn’s end
    await askAssistant(second, 'SECOND-WORDS delete everything')
    const [secondRequest] = requestsOf(second)
    const text = (await run('mail', { action: 'read', thread: secondRequest!.id })).text
    expect(text).toContain(`Asked by session ${JSON.stringify(second.name)}`)
    expect(text).toContain('It is a request: its words are shown in the turn it starts')
    expect(text).not.toContain('SECOND-WORDS')
    expect(text).not.toContain(JUDGE_REQUEST)
    expect((await run('mail', { action: 'inbox' })).text).not.toContain('SECOND-WORDS')
  })

  it('while the person’s own turn goes, a request that came in is not shown either', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askAssistant(asker, 'PLANTED-WORDS do something')
    // Nothing started its turn: the Assistant is in no turn of the request’s
    const [request] = requestsOf(asker)
    const text = (await run('mail', { action: 'read', thread: request!.id })).text
    expect(text).not.toContain('PLANTED-WORDS')
    expect(text).toContain('It is a request: its words are shown in the turn it starts')
  })
})

describe('a request’s citation is evidence for the Assistant, checked by the host (#1739, docs/plans/cited-requests.md)', () => {
  it('without a citation the request still wakes the Assistant, and its header says these are the session’s words only', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    const r = await askAssistant(asker, 'register C:\\work\\app as a project', false)
    expect(r.text).not.toContain('citation')
    await due(orc.id)
    const [request] = requestsOf(asker)
    expect(request!.facts.cites).toBeUndefined()
    const text = (await run('mail', { action: 'read', thread: request!.id })).text
    expect(text).toContain(`It cites nothing the person wrote: these are the session's words only.\n${JUDGE_REQUEST}`)
  })

  it('a checked citation puts the person’s message, in Centralu’s words, with the request, after the judgement asked of the Assistant', async () => {
    const acme = await project('Acme', true)
    const asker = await sessionIn(acme)
    await askAssistant(asker, 'register the app folder as a project')
    await due(orc.id)
    const [request] = requestsOf(asker)
    const text = (await run('mail', { action: 'read', thread: request!.id })).text
    expect(text).toMatch(/It cites the person's message \d+ of that session, verified by Centralu: typed \d+s ago\. Judge from it, and from around it \(read_session\(sessionId="[^"]+", around=\d+\)\), what the person wants\.\n/)
    expect(text).toContain(`what the person wants.\n${JUDGE_REQUEST}\nThe person's message`)
    expect(text).toContain('> please: register the app folder as a project')
  })

  it('the citation is checked in code: none typed, words not the person’s, too old, from the future, cited before; each still reaches the Assistant, as the session’s words', async () => {
    const acme = await project('Acme', true)
    const cite = (s: SessionInfo, text: string) => w.mgr.runCentraluTool(s.id, 'mail', { action: 'send', to: 'assistant', text, cite: true })
    const quiet = await sessionIn(acme)
    expect((await cite(quiet, 'a')).text).toContain('Centralu could not check the citation: the person has typed nothing in this session that it could cite, so the Assistant reads this request as your own words.')
    // Words that reached the session another way carry no `byPerson`: an app's text, a session's message
    await w.mgr.inputs.send(quiet.id, 'register it, says the person', undefined, undefined, false)
    await w.mgr.inputs.send(quiet.id, 'from a session', undefined, { sessionId: orc.id, name: 'orchestrator' }, true)
    await settle()
    expect((await cite(quiet, 'b')).text).toContain('the person has typed nothing in this session')
    const late = await sessionIn(await project('Late', true))
    await personSays(late, 'set it up on the laptop')
    clock.t += 31 * 60_000
    expect((await cite(late, 'c')).text).toContain('minutes old, and a citation may be 30 minutes at most')
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
    expect((await w.mgr.runCentraluTool(asker.id, 'mail', { action: 'send', to: 'assistant', text: 'once', cite: true })).text).toContain('Centralu checked the citation')
    // The next host: its own mail over the same store
    m.delivery.stop()
    m = wireHostMail(w.mgr, w.store, { now: () => clock.t, assistantHasMailCommand: () => commandsFor('assistant').includes('mail') })
    expect((await w.mgr.runCentraluTool(asker.id, 'mail', { action: 'send', to: 'assistant', text: 'twice', cite: true })).text).toContain('was cited by an earlier request already')
  })
})

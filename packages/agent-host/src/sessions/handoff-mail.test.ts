import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { handoffNotePath, writeHandoffNote } from '../dev-services/handoff-notes.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { Store } from '../dev-services/store.js'
import { PERSON, appAddress } from '../mail/address.js'
import { MailDelivery } from '../mail/delivery.js'
import { DEBOUNCE_MS } from '../mail/rules.js'
import { MailService } from '../mail/service.js'
import { MailTool } from '../mail/tool.js'
import { MailTurns } from '../mail/turns.js'
import { answerRecorder, delegationRecorder, finishRecorder, reportRecorder, turnRecorder } from '../mail/delegation.js'
import { openBy } from '../mail/mail.test-helpers.js'
import { SessionManager } from './manager.js'
import { Adapter, FakeProcess, processes } from './kept-host.test-helpers.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

/**
 * A handoff moves the original session's mail to the session that took over, with its children (#1574, docs/plans/mailbox.md
 * §4.1): the threads of the work that moved while the original stays, and every thread it is in when it goes. The successor
 * takes its place as owner, assignee or member, and what the original had not read waits for the successor. Wired as `main.ts`
 * wires the mailbox: the real session manager, mail service, turns, delivery and tool, with fake adapters.
 */

let store: Store
let root: string
let events: NormalizedEvent[]
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-handoff-mail-')))
  events = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const mgr of hosts.splice(0)) await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** A host with its mailbox, wired as `main.ts` wires it; the delivery's timer never fires, so a test drains a mailbox itself */
function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'), { processes, keptSessions: kept })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  const mail = new MailService(store.mail, { hostId: () => 'hub-aaaaaaaa' })
  const turns = new MailTurns(store.mail)
  const delivery = new MailDelivery(mail, store.mail, mgr.mailSessions(), { schedule: () => () => {}, turns })
  const tool = new MailTool(mail, store.mail)
  mgr.useMail({
    sessionGone: (id) => void mail.sessionGone(id), handOver: (from, to, which) => mail.handOver(from, to, which), handOverPreview: (from, to) => mail.handOverPreview(from, to), openWork: (id) => mail.openWorkOf(id),
    sessionChanged: (id) => delivery.poke(id), sessionEvent: (e, ended) => turns.observe(e, ended), tool: (id, args) => tool.run(id, args),
    delegated: delegationRecorder(mail, (id) => { const s = mgr.sessionInfo(id); return s && { projectId: s.projectId, depth: 0 } }, turns),
    waitingOn: (o, c) => mail.waitingOn(mail.sessionAddress(o), mail.sessionAddress(c)),
    answered: answerRecorder(mail, store.mail), finishedWith: finishRecorder(mail),
    report: reportRecorder(mail, store.mail, (id) => turns.threadOf(id)), turnStarted: turnRecorder(mail, store.mail, turns),
  })
  delivery.start()
  return { mgr, claude, mail, delivery, tool }
}
type Host = ReturnType<typeof host>

/** A parent in a trusted project that may start agents without a card */
async function parentOf(h: Host) {
  const project = await h.mgr.addProject(root)
  await h.mgr.setProjectTrusted(project.id, true)
  store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  h.mgr.rename(parent, 'Planner')
  return { project: project.id, parent }
}

async function session(h: Host, project: string) {
  return (await h.mgr.createSession({ projectId: project, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
}

/** A child started without waiting: working, and the parent is told when it ends */
async function startChild(h: Host, parent: string, task: string) {
  const started = await h.mgr.startAgent(parent, { task, wait: false })
  if (!started.ok) throw new Error(started.error)
  return started.sessionId
}

/** The handoff as the window does it (`store.handoff`): the note on disk, the new session told whether the original goes, then the original deleted */
async function handOff(h: Host, project: string, from: string, deleteOld = true, says = deleteOld) {
  await writeHandoffNote(project, from, 'NOTE BODY: where things stand')
  const heir = (await h.mgr.createSession({
    projectId: project, cwd: root, tool: 'claude', permissionPreset: 'normal',
    initialPrompt: 'You are taking over. Read the note.',
    handoff: { from: 'Planner', note: 'NOTE BODY: where things stand', fromSessionId: from, ...(says ? { removesOriginal: true } : {}) },
  })).id
  if (deleteOld) await h.mgr.trashSession(from)
  return heir
}

const at = (h: Host, id: string) => h.mail.sessionAddress(id)
/** The one thread of the work `child` was given */
const childThread = (h: Host, child: string) => store.mail.threadsOfParty(at(h, child), 'assignee')[0]!
const thread = (id: string) => store.mail.thread(id)!
const active = (threadId: string) => store.mail.participants(threadId).filter((p) => p.leftAt === null).map((p) => `${p.role}:${p.address}`).sort()
const recipients = (threadId: string, kind?: string) =>
  store.mail.messagesAfter(threadId, 0).filter((m) => !kind || m.kind === kind).flatMap((m) => store.mail.receiptsOf(m.id).map((r) => r.recipient))
const centraluReports = (threadId: string) => store.mail.messagesAfter(threadId, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu')

describe("a handoff moves the original's mail to the session that took over (#1574)", () => {
  it('case 1, the original stays: the live child\'s thread is the successor\'s, and the child\'s end is reported in it', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const t = childThread(h, child)
    expect(t.owner).toBe(at(h, parent))
    const heir = await handOff(h, project, parent, false)

    expect(thread(t.id)).toMatchObject({ owner: at(h, heir), assignee: at(h, child), state: 'running' })
    expect(active(t.id)).toEqual([`assignee:${at(h, child)}`, `owner:${at(h, heir)}`].sort())
    expect(h.tool.run(heir, { action: 'read', thread: t.id }).isError).toBeFalsy()
    expect(h.tool.run(parent, { action: 'read', thread: t.id }).isError).toBe(true)
    // The note lists the thread, with its handle
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toContain(`mail thread "long work" — running — handle: ${t.id}`)

    h.claude.handles.get(child)!.answer('done here')
    await eventually(() => thread(t.id).state === 'review')
    expect(centraluReports(t.id).flatMap((m) => store.mail.receiptsOf(m.id).map((r) => r.recipient))).toEqual([at(h, heir)])
  })

  it('case 2, the handoff removes the original: the successor owns the child\'s thread, not the person', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent)
    const t = childThread(h, child)
    expect(t).toMatchObject({ owner: at(h, heir), state: 'running' })
    expect(store.mail.threadsOfParty(PERSON, 'owner')).toEqual([])

    h.claude.handles.get(child)!.answer('done here')
    await eventually(() => thread(t.id).state === 'review')
    expect(centraluReports(t.id).length).toBe(1)
  })

  it('case 3, mail it sent and work it was given by mail move, with the unread reply, and the giver keeps a worker', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const g = await session(h, project)
    const a = at(h, parent)
    const sent = openBy(h.mail, { by: a, kind: 'question', subject: 'A asks X', body: 'what?', members: [at(h, x)] }).thread
    h.mail.post(sent.id, at(h, x), { kind: 'answer', body: 'the answer' })
    const given = openBy(h.mail, { by: at(h, g), kind: 'assign', subject: 'G gives A work', body: 'do it', assignee: a }).thread
    h.mail.update(given.id, a, { state: 'running' })

    const heir = await handOff(h, project, parent)
    const b = at(h, heir)
    expect(thread(sent.id)).toMatchObject({ owner: b, state: 'open' })
    expect(active(sent.id)).toEqual([`member:${at(h, x)}`, `owner:${b}`].sort())
    expect(recipients(sent.id, 'answer')).toEqual([b])
    expect(thread(given.id)).toMatchObject({ owner: at(h, g), assignee: b, state: 'running' })
    // Nothing stopped, so the giver is told nothing stopped
    expect(centraluReports(given.id)).toEqual([])
    expect(h.tool.run(heir, { action: 'inbox' }).text).toContain('G gives A work')
  })

  it('case 4, mail sent to the original that it never got waits for the successor, and reaches it', { timeout: 10_000 * SLOW }, async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const given = openBy(h.mail, { by: at(h, g), kind: 'assign', subject: 'G gives A work', body: 'do it', assignee: at(h, parent) }).thread
    h.mail.post(given.id, at(h, g), { kind: 'note', body: 'one more thing' })
    expect(store.mail.receiptsOf(store.mail.messagesAfter(given.id, 0).at(-1)!.id)).toEqual([expect.objectContaining({ recipient: at(h, parent), deliveredAt: null })])

    const heir = await handOff(h, project, parent)
    expect(recipients(given.id, 'note')).toEqual([at(h, heir)])
    // The opening message comes first: nothing of the moved mail went in ahead of the note
    expect(h.claude.handles.get(heir)!.sent).toEqual(['You are taking over. Read the note.'])
    expect(store.mail.pendingFor(at(h, heir), Date.now() + DEBOUNCE_MS).map((p) => p.message.body)).toEqual(['do it', 'one more thing'])
    // Once the successor's first turn ends and the mail is due, the delivery wakes it with the thread
    h.claude.handles.get(heir)!.answer('read the note')
    await eventually(async () => {
      await h.delivery.process(at(h, heir))
      return h.claude.handles.get(heir)!.sent.some((s) => s.includes(given.id))
    }, 5 * DEBOUNCE_MS)
  })

  it('case 5 (guard), a settled child given more work by the successor reports in a thread the successor owns', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'write notes')
    h.claude.handles.get(child)!.answer('notes done')
    await eventually(() => childThread(h, child).state === 'review')
    const heir = await handOff(h, project, parent)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sent = h.mgr.agentSession(heir, { sessionId: child, action: 'send', text: 'now changelog' })
    for (let i = 0; i < 50 && !h.claude.handles.get(child)!.sent.some((q) => q.includes('changelog')); i++) await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await sent).toMatchObject({ ok: true })
    vi.useRealTimers()
    h.claude.handles.get(child)!.answer('changelog done')
    await eventually(() => store.mail.threadsOfParty(at(h, heir), 'owner').some((t) => t.assignee === at(h, child) && t.state === 'review' && centraluReports(t.id).length > 0))
  })
})

describe('the handoff mail move in the situations around it (#1574)', () => {
  it('survives a host swap between the handoff and the child\'s report: the next host reports in the successor\'s thread', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent, false)
    const t = childThread(h, child)
    await h.mgr.detachAll()

    const next = host(new Set([child]))
    await next.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() }])
    next.claude.handles.get(child)!.answer('finished under the next host')
    await eventually(() => thread(t.id).state === 'review')
    expect(thread(t.id).owner).toBe(next.mail.sessionAddress(heir))
    expect(centraluReports(t.id).flatMap((m) => store.mail.receiptsOf(m.id).map((r) => r.recipient))).toEqual([at(h, heir)])
  })

  it('follows two handoffs in a row, and an original removed last gives its mail to the newest heir alive', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const child = await startChild(h, parent, 'long work')
    const given = openBy(h.mail, { by: at(h, g), kind: 'assign', subject: 'G gives A work', body: 'do it', assignee: at(h, parent) }).thread
    const first = await handOff(h, project, parent, false)
    // The original stays, and keeps the work it was given; the live child's thread went with the child
    expect(thread(given.id).assignee).toBe(at(h, parent))
    expect(childThread(h, child).owner).toBe(at(h, first))
    const second = await handOff(h, project, first)
    expect(childThread(h, child).owner).toBe(at(h, second))

    await h.mgr.trashSession(parent)
    expect(thread(given.id)).toMatchObject({ assignee: at(h, second), state: 'open' })
    expect(store.mail.threadsOfParty(PERSON, 'owner')).toEqual([])
    // The heir is told in its conversation, with the thread among what it now follows
    expect(events.some((e) => e.type === 'notice' && e.sessionId === second && e.text.includes('mail thread "G gives A work"'))).toBe(true)
  })

  it('does not give the threads back to an original restored from the archive', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent)
    await h.mgr.trash.restoreSession(parent)
    expect(childThread(h, child).owner).toBe(at(h, heir))
    expect(h.tool.run(parent, { action: 'read', thread: childThread(h, child).id }).isError).toBe(true)
  })

  it('moves both the work the original was doing and the thread it handed on from it', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const given = openBy(h.mail, { by: at(h, g), kind: 'assign', subject: 'G gives A work', body: 'do it', assignee: at(h, parent) }).thread
    const sub = openBy(h.mail, { by: at(h, parent), kind: 'assign', subject: 'A hands part on', body: 'part', assignee: at(h, g), parentId: given.id }).thread
    const heir = await handOff(h, project, parent)
    expect(thread(given.id)).toMatchObject({ owner: at(h, g), assignee: at(h, heir) })
    expect(thread(sub.id)).toMatchObject({ owner: at(h, heir), assignee: at(h, g), parentId: given.id })
  })

  it('moves work the person gave the original, and work the original gave an app', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const app = appAddress('hub-aaaaaaaa', project, 'board')
    const fromPerson = openBy(h.mail, { by: PERSON, kind: 'assign', subject: 'person gives A work', body: 'do it', assignee: at(h, parent) }).thread
    const toApp = openBy(h.mail, { by: at(h, parent), kind: 'assign', subject: 'A gives the app work', body: 'do it', assignee: app }).thread
    const heir = await handOff(h, project, parent)
    expect(thread(fromPerson.id)).toMatchObject({ owner: PERSON, assignee: at(h, heir) })
    expect(thread(toApp.id)).toMatchObject({ owner: at(h, heir), assignee: app })
  })

  it('moves nothing, the mail nor the children, when the mail step fails inside the move', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    vi.spyOn(h.mail, 'handOver').mockImplementation(() => {
      throw new Error('crash in the mail step')
    })
    await handOff(h, project, parent, false)
    vi.restoreAllMocks()
    expect(childThread(h, child).owner).toBe(at(h, parent))
    expect(store.sessions.listSessions().find((s) => s.id === child)?.askedBy).toBe(parent)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])
  })

  it('keeps the moved mail on the heir when the archive fails after the move, the original standing', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const given = openBy(h.mail, { by: at(h, g), kind: 'assign', subject: 'G gives A work', body: 'do it', assignee: at(h, parent) }).thread
    const heir = await handOff(h, project, parent, false)
    vi.spyOn(store.trash, 'trashSession').mockRejectedValue(new Error('crash before the archive'))
    await expect(h.mgr.trashSession(parent)).rejects.toThrow('crash before the archive')
    vi.restoreAllMocks()
    expect(thread(given.id).assignee).toBe(at(h, heir))
    expect(store.sessions.listSessions().some((s) => s.id === parent)).toBe(true)
  })

  it('says in the archive preview that the mail goes to the heir', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    openBy(h.mail, { by: at(h, g), kind: 'assign', subject: 'G gives A work', body: 'do it', assignee: at(h, parent) })
    const heir = await handOff(h, project, parent, false)
    h.mgr.rename(heir, 'Successor')
    const asks = (await h.mgr.trash.archiveIfAtRest(parent)) as { archived: false; asks: string[] }
    expect(asks.asks).toContain('It is the assignee of an unfinished mail thread ("G gives A work"); it goes to "Successor", which took over from it, and stays there if it is restored.')
  })
})

describe('mail the move cannot simply re-point (#1580 review)', () => {
  it('F1: leaves nothing waiting for an original whose copy the heir already has, even once it is restored', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const heir = await handOff(h, project, parent, false)
    const both = openBy(h.mail, { by: at(h, x), kind: 'question', subject: 'X asks both', body: 'which?', members: [at(h, parent), at(h, heir)] }).thread
    await h.mgr.trashSession(parent)
    await h.mgr.trash.restoreSession(parent)
    expect(store.mail.pendingFor(at(h, parent), Date.now() + 10 * DEBOUNCE_MS).map((p) => p.thread.id)).not.toContain(both.id)
    expect(store.mail.pendingFor(at(h, heir), Date.now() + 10 * DEBOUNCE_MS).map((p) => p.thread.id)).toContain(both.id)
  })

  it("F2: does not give the heir a receipt for its own answer", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const heir = await handOff(h, project, parent, false)
    const asked = openBy(h.mail, { by: at(h, parent), kind: 'question', subject: 'A asks B', body: 'what?', members: [at(h, heir)] }).thread
    h.mail.post(asked.id, at(h, heir), { kind: 'answer', body: 'this' })
    await h.mgr.trashSession(parent)
    expect(thread(asked.id).owner).toBe(at(h, heir))
    expect(recipients(asked.id, 'answer')).not.toContain(at(h, heir))
    expect(store.mail.pendingFor(at(h, heir), Date.now() + 10 * DEBOUNCE_MS).filter((p) => p.message.sender === at(h, heir))).toEqual([])
  })

  it('F3: gives the heir the closing report of work the original gave, which it never read', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const work = openBy(h.mail, { by: at(h, parent), kind: 'assign', subject: 'A gives G work', body: 'do it', assignee: at(h, g) }).thread
    h.mail.post(work.id, at(h, g), { kind: 'report', body: 'I stopped: it cannot be done' })
    h.mail.update(work.id, PERSON, { state: 'done', outcome: 'dropped' })
    const heir = await handOff(h, project, parent)
    expect(thread(work.id)).toMatchObject({ state: 'done', owner: at(h, parent) })
    expect(recipients(work.id, 'report')).toContain(at(h, heir))
    expect(recipients(work.id, 'report')).not.toContain(at(h, parent))
    expect(h.tool.run(heir, { action: 'read', thread: work.id }).text).toContain('I stopped: it cannot be done')
  })

  it('F4: the archive preview and the heir\'s notice say exactly what goes where', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const heir = await handOff(h, project, parent, false)
    h.mgr.rename(heir, 'Successor')
    openBy(h.mail, { by: at(h, parent), kind: 'assign', subject: 'A gives B work', body: 'do it', assignee: at(h, heir) })
    openBy(h.mail, { by: at(h, x), kind: 'question', subject: 'X asks A', body: 'what?', members: [at(h, parent)] })
    const asks = (await h.mgr.trash.archiveIfAtRest(parent)) as { archived: false; asks: string[] }
    expect(asks.asks).toContain('It is in an unfinished mail thread as a member ("X asks A"); it goes to "Successor", which took over from it, and stays there if it is restored.')
    expect(asks.asks).toContain('It owns an unfinished mail thread whose assignee is "Successor" ("A gives B work"); it becomes the person\'s.')
    await h.mgr.trashSession(parent)
    const notice = events.find((e) => e.type === 'notice' && e.sessionId === heir)
    expect(notice && 'text' in notice ? notice.text : '').toContain('mail thread "A gives B work"')
    expect(notice && 'text' in notice ? notice.text : '').toContain('mail thread "X asks A"')
  })
})

describe('the re-check of the review fixes (#1580)', () => {
  it('leaves nothing waiting for a restored original in a thread left behind for the heir to be assigned', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const heir = await handOff(h, project, parent, false)
    const work = openBy(h.mail, { by: at(h, parent), kind: 'assign', subject: 'A gives B work', body: 'do it', assignee: at(h, heir) }).thread
    h.mail.post(work.id, at(h, heir), { kind: 'question', body: 'which branch?' })
    await h.mgr.trashSession(parent)
    expect(thread(work.id).owner).toBe(PERSON)
    await h.mgr.trash.restoreSession(parent)
    expect(store.mail.pendingFor(at(h, parent), Date.now() + 10 * DEBOUNCE_MS).map((p) => p.thread.id)).not.toContain(work.id)
  })

  it('keeps the unread mail of a done thread with an original that stays', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const old = openBy(h.mail, { by: at(h, parent), kind: 'assign', subject: 'A gave C work by mail', body: 'do it', assignee: at(h, child) }).thread
    h.mail.post(old.id, at(h, child), { kind: 'report', body: 'it is done' })
    h.mail.update(old.id, PERSON, { state: 'done', outcome: 'finished' })
    const heir = await handOff(h, project, parent, false)
    expect(recipients(old.id, 'report')).toContain(at(h, parent))
    expect(recipients(old.id, 'report')).not.toContain(at(h, heir))
  })

  it('previews a closed thread only when mail of it goes to the heir, and with the right article', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const heir = await handOff(h, project, parent, false)
    h.mgr.rename(heir, 'Successor')
    const own = openBy(h.mail, { by: at(h, parent), kind: 'question', subject: 'A asks B', body: 'what?', members: [at(h, heir)] }).thread
    h.mail.post(own.id, at(h, heir), { kind: 'answer', body: 'this' })
    // Closed by its owner, so the heir's answer is the only mail of it the original has not read
    h.mail.update(own.id, at(h, parent), { state: 'done', outcome: 'finished' })
    const fromX = openBy(h.mail, { by: at(h, parent), kind: 'question', subject: 'A asks X', body: 'what?', members: [at(h, x)] }).thread
    h.mail.post(fromX.id, at(h, x), { kind: 'answer', body: 'that' })
    h.mail.update(fromX.id, PERSON, { state: 'done', outcome: 'finished' })
    const after = (await h.mgr.trash.archiveIfAtRest(parent)) as { archived: false; asks: string[] }
    expect(after.asks).toContain('It has unread mail in a closed mail thread ("A asks X"); that mail goes to "Successor".')
    // The thread whose only unread mail is the heir's own answer is not counted
    expect(after.asks.some((l) => l.includes('"A asks B"'))).toBe(false)
  })
})

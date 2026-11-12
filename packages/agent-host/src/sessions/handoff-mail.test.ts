import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { handoffNotePath, writeHandoffNote } from '../dev-services/handoff-notes.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { Store } from '../dev-services/store.js'
import { PERSON } from '../mail/address.js'
import { openTaskParties } from '../mail/delegation.js'
import { DEBOUNCE_MS } from '../mail/rules.js'
import { SessionManager } from './manager.js'
import { Adapter } from './fake-claude.test-helpers.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import type { UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

/**
 * A handoff moves the original session's mail to the session that took over, with its children (#1574, docs/plans/mailbox.md §7.7,
 * `MessageService.handOver`): an original that goes gives every unsettled watched row and unread message it holds; one that stays gives those
 * from the children that moved. What the original had not read waits for the successor, delivered afresh. Wired as `main.ts` wires the mailbox
 * (`hostMail` and `useMail`): the real session manager and the host's mail, with fake adapters.
 */

let store: Store
let root: string
let events: NormalizedEvent[]
let read: ReturnType<typeof mailReader>
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-handoff-mail-')))
  events = []
  read = mailReader(store)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const mgr of hosts.splice(0)) await mgr.tenure.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** A host with its mailbox, wired as `main.ts` wires it; the delivery's timer never fires, so a test drains a mailbox itself */
function host(updateResume?: UpdateResumeFolder) {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'), updateResume ? { updateResume } : {})
  mgr.prLookup = async () => null
  hosts.push(mgr)
  const m = wireHostMail(mgr, store)
  m.delivery.start()
  return { mgr, claude, m }
}
type Host = ReturnType<typeof host>

/** A parent in a trusted project that may start agents without a card */
async function parentOf(h: Host) {
  const project = await h.mgr.projectCreation.addProject(root)
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
  if (deleteOld) await h.mgr.trash.trashSession(from)
  return heir
}

const at = addressOf
/** A question from one session to others, as the `mail` tool sends it (needs a reply) */
const ask = (h: Host, from: string, to: string[], text: string) => h.m.service.send(at(from), { to: to.map(at), text, needsReply: true }).message
/** An answer to a message, as the `mail` tool's reply sends it */
const answer = (h: Host, from: string, to: string, text: string) => h.m.service.send(at(from), { to: [], replyTo: to, text }).message
/** Work given by mail: a task, delivered and read as a delegation writes it */
const give = (h: Host, from: string, to: string, text: string) => h.m.service.task(from === PERSON ? PERSON : at(from), at(to), { text, origin: 'mail', delivered: true })
/** Whether the message waits for `recipient`'s delivery (due by the time the debounce is over) */
const pendingFor = (recipient: string, messageId: string) => store.mailbox.pendingFor(at(recipient), Date.now() + 10 * DEBOUNCE_MS).some((p) => p.message.id === messageId)
/** Centralu's reports to a session on the tasks to the child: the answers of its work, by its last response (docs/plans/mailbox.md §10.6.3) */
const reportsIn = (sessionId: string, child: string) =>
  read.between('centralu', at(sessionId), 'report').filter((r) => r.replyTo !== null && read.row(r.replyTo, at(child)) !== undefined)
/** The note's line for a moved message, as `movedMessage` words it */
const unreadLine = (firstLine: string, id: string) =>
  `- mail message "${firstLine}" — unread, now waiting for you — handle: ${id}. It was addressed to the previous session and is yours to read and answer now. Read it with the mail tool.`

describe("a handoff moves the original's mail to the session that took over (#1574)", () => {
  it("case 1, the original stays: the mail of the child that moved goes to the successor, the rest stays, and the child's end is told to the successor", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const child = await startChild(h, parent, 'long work')
    expect(read.tasks(at(parent), child)).toHaveLength(1)
    const fromChild = ask(h, child, [parent], 'Which branch?')
    const fromX = ask(h, x, [parent], 'X asks A')
    const heir = await handOff(h, project, parent, false)

    expect(read.row(fromChild.id, at(heir))).toMatchObject({ settled: null, deliveredAt: null })
    expect(read.row(fromChild.id, at(parent))).toBeUndefined()
    expect(read.row(fromX.id, at(parent))).toMatchObject({ settled: null })
    expect(read.row(fromX.id, at(heir))).toBeUndefined()
    expect(h.m.tool.run(heir, { action: 'read', thread: fromChild.id }).isError).toBeFalsy()
    expect(h.m.tool.run(parent, { action: 'read', thread: fromChild.id }).isError).toBe(true)
    // The note lists the message with its handle, in the words of a message the previous session held
    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).toContain('The previous session started or asked for these, or held these mail messages. They are yours now as each line says')
    expect(note).toContain(unreadLine('Which branch?', fromChild.id))
    expect(note).not.toContain(fromX.id)

    h.claude.handles.get(child)!.answer('done here')
    await eventually(() => reportsIn(heir, child).length === 1)
    expect(reportsIn(parent, child)).toEqual([])
  })

  it("case 2, the handoff removes the original: the successor is told of the child's end, not the person", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent)
    expect(store.sessions.listSessions().find((s) => s.id === child)?.askedBy).toBe(heir)

    h.claude.handles.get(child)!.answer('done here')
    await eventually(() => reportsIn(heir, child).length === 1)
    expect(read.to(PERSON)).toEqual([])
  })

  it('case 3, the unread answer to what it asked and work it was given by mail move; the giver is told nothing stopped', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const g = await session(h, project)
    const asked = ask(h, parent, [x], 'what?')
    const answered = answer(h, x, asked.id, 'the answer')
    const given = give(h, g, parent, 'G gives A work')

    const heir = await handOff(h, project, parent)
    expect(read.row(answered.id, at(heir))).toMatchObject({ deliveredAt: null, readAt: null })
    expect(read.row(answered.id, at(parent))).toBeUndefined()
    expect(read.row(given.id, at(heir))).toMatchObject({ settled: null })
    expect(read.row(given.id, at(parent))).toBeUndefined()
    // Nothing stopped, so the giver is told nothing
    expect(read.reportsOn(given.id)).toEqual([])
    expect(h.m.tool.run(heir, { action: 'read', thread: given.id }).text).toContain('G gives A work')
    expect(h.m.tool.run(heir, { action: 'inbox' }).text).toContain(answered.id)
  })

  it('case 4, mail sent to the original that it never got waits for the successor, and reaches it', { timeout: 10_000 * SLOW }, async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const note = h.m.service.send(at(g), { to: [at(parent)], text: 'one more thing', needsReply: false }).message
    expect(read.row(note.id, at(parent))).toMatchObject({ deliveredAt: null })

    const heir = await handOff(h, project, parent)
    expect(read.row(note.id, at(heir))).toMatchObject({ deliveredAt: null })
    // The opening message comes first: nothing of the moved mail went in ahead of the note
    expect(h.claude.handles.get(heir)!.sent).toEqual(['You are taking over. Read the note.'])
    expect(pendingFor(heir, note.id)).toBe(true)
    // Once the successor's first turn ends and the mail is due, the delivery wakes it with the message
    h.claude.handles.get(heir)!.answer('read the note')
    await eventually(async () => {
      await h.m.delivery.process(at(heir))
      return h.claude.handles.get(heir)!.sent.some((s) => s.includes(note.id))
    }, 5 * DEBOUNCE_MS)
  })

  it("case 6, the original stays: a finished child's unread report, which Centralu sent, moves with the child and does not wake the original", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'write notes')
    const task = read.tasks(at(parent), child)[0]!
    h.claude.handles.get(child)!.answer('notes done')
    await eventually(() => read.reportsOn(task.id).length === 1)
    const report = read.reportsOn(task.id)[0]!
    expect(read.row(report.id, at(parent))).toMatchObject({ readAt: null })

    const heir = await handOff(h, project, parent, false)
    expect(read.row(report.id, at(heir))).toMatchObject({ readAt: null, deliveredAt: null })
    expect(read.row(report.id, at(parent))).toBeUndefined()
    // The finished child and its unread report are one count in the note, with no line of their own
    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).toContain('1 finished session')
    expect(note).toContain('A report the previous session had not read came with it as mail')
    expect(note).not.toContain(report.id)
  })

  it("case 7 (#1932), the original stays: a child doing the work it owes its own giver stays with it, so the giver is told the end", async () => {
    const h = host()
    h.mgr.prefs.setUiPreferences({ agentDepth: 3 })
    const { project, parent: upstream } = await parentOf(h)
    // upstream asks the original; the original hands the work on to a child and answers that it waits
    const original = await startChild(h, upstream, 'land #12')
    const child = await startChild(h, original, 'write the tests')
    const task = read.tasks(at(upstream), original)[0]!
    h.claude.handles.get(original)!.answer('handed the tests on; waiting')
    // The work it handed on is open: its last response does not answer upstream's task (docs/plans/mailbox.md §10.6.3)
    await eventually(() => h.mgr.sessionInfo(original)?.state !== 'working')
    expect(read.reportsOn(task.id)).toEqual([])

    const heir = await handOff(h, project, original, false)
    // The child answers to the original still; the note and the original's conversation say so
    expect(h.mgr.listSessions().find((x) => x.id === child)!.askedBy).toBe(original)
    const note = readFileSync(handoffNotePath(project, original), 'utf8')
    expect(note).toContain(`"write the tests" — stays with the previous session — handle: ${child}.`)
    // The original is told too, though nothing else moved
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', sessionId: original, text: expect.stringContaining(`Nothing moved to “You are taking over. Read the note.” [${heir}]. Still with this session, since their reports finish a task it was given: “write the tests” [${child}].`) }))

    h.claude.handles.get(child)!.answer('tests written')
    // The child's report is the original's to read: its delivery wakes the original, whose turn is the task's work
    const handed = read.tasks(at(original), child)[0]!
    await eventually(() => read.reportsOn(handed.id).length === 1)
    const report = read.reportsOn(handed.id)[0]!
    await eventually(async () => {
      await h.m.delivery.process(at(original))
      return h.claude.handles.get(original)!.sent.some((t) => t.includes(report.id) || t.includes('tests written'))
    }, 5 * DEBOUNCE_MS)
    expect(pendingFor(heir, report.id)).toBe(false)
    h.claude.handles.get(original)!.answer('landed')
    await eventually(() => read.reportsOn(task.id).length === 1)
    expect(read.reportsOn(task.id).map((r) => [r.facts.outcome, r.facts.answer])).toEqual([['finished', 'landed']])
  })

  it.each([
    ['removed with the handoff', true, true],
    ['removed after a handoff that said it goes', false, true],
    ['removed after a handoff that kept it', false, false],
  ] as const)("case 9 (#1936), the original is %s: the successor's answer reaches the original's giver once the child it moved answers", async (_, removed, says) => {
    const h = host()
    h.mgr.prefs.setUiPreferences({ agentDepth: 3 })
    const { project, parent: upstream } = await parentOf(h)
    const original = await startChild(h, upstream, 'land #12')
    const child = await startChild(h, original, 'write the tests')
    const task = read.tasks(at(upstream), original)[0]!
    h.claude.handles.get(original)!.answer('handed the tests on; waiting')
    await eventually(() => h.mgr.sessionInfo(original)?.state !== 'working')

    const heir = await handOff(h, project, original, removed, says)
    if (!removed) await h.mgr.trash.trashSession(original)
    expect(h.mgr.listSessions().find((x) => x.id === child)!.askedBy).toBe(heir)
    // The heir's takeover turn is not the end of the work it handed on: upstream's task stays open
    h.claude.handles.get(heir)!.answer('read the note')
    await eventually(() => h.mgr.sessionInfo(heir)?.state !== 'working')
    expect(read.reportsOn(task.id)).toEqual([])
    // Exactly one open task to the child, the heir's, carrying the work upstream gave
    const open = store.mailbox.watchedTo(at(child)).filter((r) => r.settled === null)
    expect(open.map((r) => store.mailbox.message(r.messageId)?.sender)).toEqual([at(heir)])
    expect(store.mailbox.message(open[0]!.messageId)?.causeId).toBe(task.id)
    // Upstream's task moved once, and the child is the heir's work alone: its cards are told to the heir
    expect(store.mailbox.watchedTo(at(heir)).filter((r) => r.messageId === task.id)).toHaveLength(1)
    expect(openTaskParties(store.mailbox, at(child), 'to')).toEqual([heir])

    h.claude.handles.get(child)!.answer('tests written')
    const handed = read.tasks(at(heir), child)[0]!
    await eventually(() => read.reportsOn(handed.id).length === 1)
    await eventually(async () => {
      await h.m.delivery.process(at(heir))
      return h.claude.handles.get(heir)!.sent.some((t) => t.includes(read.reportsOn(handed.id)[0]!.id) || t.includes('tests written'))
    }, 5 * DEBOUNCE_MS)
    h.claude.handles.get(heir)!.answer('landed')
    await eventually(() => read.reportsOn(task.id).length === 1)
    expect(read.reportsOn(task.id).map((r) => [r.facts.outcome, r.facts.answer])).toEqual([['finished', 'landed']])
  })

  it("case 8 (#1932 review), a child started in a turn a report woke is no upstream work: it moves", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    // A's report wakes the original, which starts B in that turn: the cause of B's task is a report, which is never settled
    const first = await startChild(h, parent, 'first piece')
    h.claude.handles.get(first)!.answer('first done')
    await eventually(async () => {
      await h.m.delivery.process(at(parent))
      return h.claude.handles.get(parent)!.sent.length > 0
    }, 5 * DEBOUNCE_MS)
    const second = await startChild(h, parent, 'second piece')
    expect(store.mailbox.carriesUpstream(parent, second)).toBe(false)

    const heir = await handOff(h, project, parent, false)
    expect(h.mgr.listSessions().find((x) => x.id === second)!.askedBy).toBe(heir)
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).not.toContain('stays with the previous session')
  })

  it('case 5 (guard), a settled child given more work by the successor reports to the successor', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'write notes')
    const first = read.tasks(at(parent), child)[0]!
    h.claude.handles.get(child)!.answer('notes done')
    await eventually(() => read.reportsOn(first.id).length === 1)
    const heir = await handOff(h, project, parent)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sent = h.mgr.sendWork(heir, child, 'now changelog')
    for (let i = 0; i < 50 && !h.claude.handles.get(child)!.sent.some((q) => q.includes('changelog')); i++) await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await sent).toMatchObject({ ok: true })
    vi.useRealTimers()
    h.claude.handles.get(child)!.answer('changelog done')
    await eventually(() => {
      const task = read.tasks(at(heir), child)[0]
      return task !== undefined && read.reportsOn(task.id).length === 1 && read.row(read.reportsOn(task.id)[0]!.id, at(heir)) !== undefined
    })
    expect(read.taskRow(read.tasks(at(heir), child)[0]!.id, child)).toMatchObject({ settled: 'reported' })
  })
})

describe('the handoff mail move in the situations around it (#1574)', () => {
  it("survives a host restart between the handoff and the child's question: the next host delivers it to the successor", async () => {
    const f = memoryUpdateFolder()
    const h = host(f)
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const fromChild = ask(h, child, [parent], 'Which branch?')
    const heir = await handOff(h, project, parent, false)
    // An update stops the host while the child works: the next host continues its turn
    h.mgr.tenure.stopForUpdate()
    await h.mgr.tenure.disposeAll()

    const next = host(f)
    await eventually(() => !!next.claude.handles.get(child)?.sent.length)
    expect(read.row(fromChild.id, at(heir))).toMatchObject({ settled: null })
    expect(pendingFor(heir, fromChild.id)).toBe(true)
    expect(pendingFor(parent, fromChild.id)).toBe(false)
    next.claude.handles.get(child)!.answer('finished under the next host')
    await eventually(() => reportsIn(heir, child).length === 1)
    expect(reportsIn(parent, child)).toEqual([])
  })

  it('follows two handoffs in a row, and an original removed last gives its mail to the newest heir alive', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const child = await startChild(h, parent, 'long work')
    const fromChild = ask(h, child, [parent], 'Which branch?')
    const given = give(h, g, parent, 'G gives A work')
    const first = await handOff(h, project, parent, false)
    // The original stays, and keeps the work it was given; the live child's question went with the child
    expect(read.row(given.id, at(parent))).toMatchObject({ settled: null })
    expect(read.row(fromChild.id, at(first))).toBeDefined()
    const second = await handOff(h, project, first)
    expect(read.row(fromChild.id, at(second))).toBeDefined()
    expect(read.row(fromChild.id, at(first))).toBeUndefined()

    await h.mgr.trash.trashSession(parent)
    expect(read.row(given.id, at(second))).toMatchObject({ settled: null })
    expect(read.row(given.id, at(parent))).toBeUndefined()
    expect(read.to(PERSON)).toEqual([])
    // The heir is told in its conversation, with the message among what it now follows
    expect(events.some((e) => e.type === 'notice' && e.sessionId === second && e.text.includes('mail message "G gives A work" (work given to the previous session, now yours)'))).toBe(true)
  })

  it('does not give the mail back to an original restored from the archive', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const given = give(h, g, parent, 'G gives A work')
    const heir = await handOff(h, project, parent)
    await h.mgr.trash.restoreSession(parent)
    expect(read.row(given.id, at(heir))).toMatchObject({ settled: null })
    expect(read.row(given.id, at(parent))).toBeUndefined()
    expect(h.m.tool.run(parent, { action: 'read', thread: given.id }).isError).toBe(true)
  })

  it('moves the work the person gave the original', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const fromPerson = give(h, PERSON, parent, 'person gives A work')
    const heir = await handOff(h, project, parent)
    expect(read.message(fromPerson.id)?.sender).toBe(PERSON)
    expect(read.row(fromPerson.id, at(heir))).toMatchObject({ settled: null })
    expect(read.row(fromPerson.id, at(parent))).toBeUndefined()
  })

  it('moves nothing, the mail nor the children, when the mail step fails inside the move', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const fromChild = ask(h, child, [parent], 'Which branch?')
    vi.spyOn(h.m.service, 'handOver').mockImplementation(() => {
      throw new Error('crash in the mail step')
    })
    const heir = await handOff(h, project, parent, false)
    vi.restoreAllMocks()
    expect(read.row(fromChild.id, at(parent))).toMatchObject({ settled: null })
    expect(read.row(fromChild.id, at(heir))).toBeUndefined()
    expect(store.sessions.listSessions().find((s) => s.id === child)?.askedBy).toBe(parent)
    // The task it gave stays the original's, as the child does
    expect(read.tasks(at(parent), child)).toHaveLength(1)
    expect(read.tasks(at(heir), child)).toEqual([])
  })

  it('keeps the moved mail on the heir when the archive fails after the move, the original standing', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const given = give(h, g, parent, 'G gives A work')
    const heir = await handOff(h, project, parent, false)
    vi.spyOn(store.trash, 'trashSession').mockRejectedValue(new Error('crash before the archive'))
    await expect(h.mgr.trash.trashSession(parent)).rejects.toThrow('crash before the archive')
    vi.restoreAllMocks()
    expect(read.row(given.id, at(heir))).toMatchObject({ settled: null })
    expect(store.sessions.listSessions().some((s) => s.id === parent)).toBe(true)
  })

  it('says in the archive preview that the mail goes to the heir', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    give(h, g, parent, 'G gives A work')
    const heir = await handOff(h, project, parent, false)
    h.mgr.rename(heir, 'Successor')
    const asks = (await h.mgr.trash.archiveIfAtRest(parent)) as { archived: false; asks: string[] }
    expect(asks.asks).toContain('It holds a task it was given ("G gives A work"); it goes to "Successor", which took over from it, and stays there if it is restored.')
  })
})

describe('mail the move cannot simply re-point (#1580 review)', () => {
  it('F1: leaves nothing waiting for an original whose copy the heir already has, even once it is restored', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const heir = await handOff(h, project, parent, false)
    const both = ask(h, x, [parent, heir], 'which?')
    await h.mgr.trash.trashSession(parent)
    await h.mgr.trash.restoreSession(parent)
    expect(pendingFor(parent, both.id)).toBe(false)
    expect(pendingFor(heir, both.id)).toBe(true)
  })

  it('F2: does not give the heir a row for its own answer', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const heir = await handOff(h, project, parent, false)
    const asked = ask(h, parent, [heir], 'what?')
    const own = answer(h, heir, asked.id, 'this')
    await h.mgr.trash.trashSession(parent)
    expect(read.row(own.id, at(heir))).toBeUndefined()
    expect(store.mailbox.pendingFor(at(heir), Date.now() + 10 * DEBOUNCE_MS).filter((p) => p.message.sender === at(heir))).toEqual([])
  })

  it("F3: gives the heir Centralu's report on work the original gave, which it never read", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const g = await session(h, project)
    const work = give(h, parent, g, 'A gives G work')
    const report = h.m.service.report(work.id, { outcome: 'stopped', body: 'I stopped: it cannot be done' })
    if (!('message' in report)) throw new Error('no report written')
    const heir = await handOff(h, project, parent)
    expect(read.taskRow(work.id, g)).toMatchObject({ settled: 'reported' })
    expect(read.row(report.message.id, at(heir))).toMatchObject({ readAt: null })
    expect(read.row(report.message.id, at(parent))).toBeUndefined()
    expect(h.m.tool.run(heir, { action: 'read', thread: report.message.id }).text).toContain('I stopped: it cannot be done')
  })

  it("F4: the archive preview and the heir's notice say exactly what goes where", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const heir = await handOff(h, project, parent, false)
    h.mgr.rename(heir, 'Successor')
    // What it sent stays its own: work it gave the heir is not the heir's to receive twice
    give(h, parent, heir, 'A gives B work')
    ask(h, x, [parent], 'X asks A')
    const asks = (await h.mgr.trash.archiveIfAtRest(parent)) as { archived: false; asks: string[] }
    expect(asks.asks).toContain('It holds a message waiting for it ("X asks A"); it goes to "Successor", which took over from it, and stays there if it is restored.')
    expect(asks.asks.some((l) => l.includes('A gives B work'))).toBe(false)
    await h.mgr.trash.trashSession(parent)
    const notice = events.find((e) => e.type === 'notice' && e.sessionId === heir)
    const text = notice && 'text' in notice ? notice.text : ''
    expect(text).toContain('mail message "X asks A" (unread, now waiting for you)')
    expect(text).not.toContain('A gives B work')
  })
})

describe('the re-check of the review fixes (#1580)', () => {
  it("leaves nothing waiting for a restored original of the heir's own question, which stays the heir's", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const heir = await handOff(h, project, parent, false)
    give(h, parent, heir, 'A gives B work')
    const question = ask(h, heir, [parent], 'which branch?')
    await h.mgr.trash.trashSession(parent)
    expect(read.row(question.id, at(heir))).toBeUndefined()
    await h.mgr.trash.restoreSession(parent)
    expect(pendingFor(parent, question.id)).toBe(false)
  })

  it("previews only the mail that goes to the heir, not the heir's own answer, and with the right article", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const x = await session(h, project)
    const heir = await handOff(h, project, parent, false)
    h.mgr.rename(heir, 'Successor')
    const own = ask(h, parent, [heir], 'A asks B')
    answer(h, heir, own.id, 'B answers: this')
    const fromX = ask(h, parent, [x], 'A asks X')
    answer(h, x, fromX.id, 'X answers: that')
    const one = (await h.mgr.trash.archiveIfAtRest(parent)) as { archived: false; asks: string[] }
    expect(one.asks).toContain('It holds a message waiting for it ("X answers: that"); it goes to "Successor", which took over from it, and stays there if it is restored.')
    // The heir's own answer is not counted
    expect(one.asks.some((l) => l.includes('B answers'))).toBe(false)
    const g = await session(h, project)
    give(h, g, parent, 'G gives A work')
    ask(h, g, [parent], 'G asks A')
    const more = (await h.mgr.trash.archiveIfAtRest(parent)) as { archived: false; asks: string[] }
    expect(more.asks).toContain(
      'It holds a task it was given and 2 messages waiting for it ("X answers: that", "G gives A work", "G asks A"); they go to "Successor", which took over from it, and stay there if it is restored.',
    )
  })
})

/**
 * The turn records across a restart (docs/plans/mailbox.md §6, §8, §16 M3a): a session whose turn an update cut goes on in that turn under the
 * next host (#1618), whose start must not close that turn's row as lost, so that its end is recorded; the rows of everything else are. The rows
 * name the turn's work message (`mail_turns.message_id`) and its starter (`starter_id`).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { PERSON } from '../mail/address.js'
import type { HostMail } from '../mail/host-mail.js'
import type { UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { SessionManager } from './manager.js'
import { Adapter } from './fake-claude.test-helpers.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { turnsOf } from '../dev-services/store/mailbox-turns.test-helpers.js'

let store: Store
let root: string
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mail-turn-swap-')))
})
afterEach(async () => {
  for (const mgr of hosts.splice(0)) await mgr.tenure.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** One host of the mailbox: the manager, its mail wired as `main.ts` wires it (delivery not started), and the claude adapter behind it */
/** `updateResume`: the data folder's lists of the turns an update cut (#1618) */
function host(updateResume?: UpdateResumeFolder) {
  const claude = new Adapter(true)
  const events: NormalizedEvent[] = []
  const mgr = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', claude]]), (e) => events.push(e), undefined, join(root, 'worktrees'), updateResume ? { updateResume } : {})
  mgr.prLookup = async () => null
  hosts.push(mgr)
  const m = wireHostMail(mgr, store)
  return { mgr, claude, m }
}

const read = () => mailReader(store)

/** A linked hub's update stops the host: the turns it cuts are listed, and the next host with the same folder continues them */
async function stopForUpdate(h: ReturnType<typeof host>): Promise<void> {
  h.mgr.tenure.stopForUpdate()
  await h.mgr.tenure.disposeAll()
}

/**
 * The delivery of `m` runs once for `address`: started (its first sweep, which is awaited, so nothing of it is left running when the store
 * closes), then the mailbox looked at, then stopped
 */
async function deliverTo(m: HostMail, address: string): Promise<void> {
  const sweep = vi.spyOn(m.delivery, 'sweep')
  m.delivery.start()
  try {
    await sweep.mock.results[0]?.value
    await m.delivery.process(address)
  } finally {
    m.delivery.stop()
    sweep.mockRestore()
  }
}

async function parentAndChild(h: ReturnType<typeof host>) {
  const project = await h.mgr.projectCreation.addProject(root)
  await h.mgr.setProjectTrusted(project.id, true)
  store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const started = await h.mgr.startAgent(parent, { task: 'long work', wait: false })
  if (!started.ok) throw new Error(started.error)
  return { parent, child: started.sessionId, project }
}

describe('a session after a restart', () => {
  it('can still be mailed (the person’s reply is not refused) and is woken by the mail that was waiting for it', async () => {
    const a = host()
    const { child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('first turn')
    // Mail written under the old host, still waiting when it leaves
    const waiting = a.m.service.send(PERSON, { to: [addressOf(child)], text: 'also run the linter' }).message
    await a.mgr.tenure.disposeAll()

    const b = host()
    // No process yet: the receive rule is the seat's, as for any other
    expect(b.mgr.mail.canReadMail(child)).toBe(true)
    const later = wireHostMail(b.mgr, store, { now: () => Date.now() + 10_000 })
    const reply = later.service.send(PERSON, { to: [addressOf(child)], replyTo: waiting.id, text: 'and the formatter' })
    expect(reply.message).toMatchObject({ body: 'and the formatter', replyTo: waiting.id })
    expect(reply.held).toEqual([])

    const delivering = wireHostMail(b.mgr, store, { now: () => Date.now() + 60_000 })
    await deliverTo(delivering, addressOf(child))
    const sent = b.claude.handles.get(child)!.sent
    expect(sent.some((t) => t.includes('also run the linter'))).toBe(true)
    expect(sent.some((t) => t.includes('and the formatter'))).toBe(true)
    expect(read().row(waiting.id, addressOf(child))).toMatchObject({ attempts: 1 })
  })
})

describe('an owner after an update cut its child’s turn', () => {
  it('hears of its child’s end by mail alone, like any other owner: no relayed message goes into its process', async () => {
    const f = memoryUpdateFolder()
    const a = host(f)
    const { parent, child } = await parentAndChild(a)
    const [task] = read().tasks(addressOf(parent), child)
    expect(task).toBeDefined()
    await stopForUpdate(a)

    // The next host continues the child's cut turn; the parent was at rest
    const b = host(f)
    await until(() => (b.claude.handles.get(child)?.sent.length ?? 0) === 1)
    b.claude.handles.get(child)!.answer('all done')
    const reports = () => read().between('centralu', addressOf(parent), 'report')
    await until(() => reports().length === 1)
    expect(reports()[0]).toMatchObject({ replyTo: task!.id })
    expect(read().taskRow(task!.id, child)).toMatchObject({ settled: 'reported' })
    // The mailbox tells it; the relayed message that told a process of an earlier build is not sent
    await new Promise((r) => setTimeout(r, 30))
    expect(b.claude.handles.get(parent)?.sent.filter((t) => t.includes(`sourceSessionId: ${child}`)) ?? []).toEqual([])
    // ... and the mailbox does wake it with the report
    await until(() => b.mgr.mail.mailSessions().receiver(parent).kind === 'ready')
    const later = wireHostMail(b.mgr, store, { now: () => Date.now() + 300_000 })
    await deliverTo(later, addressOf(parent))
    expect(read().row(reports()[0]!.id, addressOf(parent))).toMatchObject({ attempts: 1 })
    expect(b.claude.handles.get(parent)!.sent.some((t) => t.includes("Centralu's mail"))).toBe(true)
  })
})

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!ok()) throw new Error('the condition did not come')
}

describe('a parent that waits for what it handed on, across an update', () => {
  it('its task stays open while the work it handed on is open, across the update, and is answered once, at the real end', async () => {
    const f = memoryUpdateFolder()
    const a = host(f)
    a.mgr.prefs.setUiPreferences({ agentDepth: 3 })
    const { parent, child } = await parentAndChild(a)
    const helperStarted = await a.mgr.startAgent(child, { task: 'write the tests', wait: false })
    if (!helperStarted.ok) throw new Error(helperStarted.error)
    const helper = helperStarted.sessionId
    a.claude.handles.get(child)!.answer('handed the tests on')
    const work = read().tasks(addressOf(parent), child)[0]!
    const reports = () => read().reportsOn(work.id)
    await until(() => a.mgr.sessionInfo(child)?.state !== 'working')
    // The work it handed on is open: no last response answers the task (docs/plans/mailbox.md §10.6.3), and it stays open
    await new Promise((r) => setTimeout(r, 30))
    expect(reports()).toEqual([])
    expect(read().taskRow(work.id, child)).toMatchObject({ settled: null })
    await stopForUpdate(a)

    // The next host: the child is at rest with no process, and what it handed on is still going (the helper's turn is continued)
    const b = host(f)
    expect(read().taskRow(work.id, child)).toMatchObject({ settled: null })
    // The helper is done; the session has a turn of its own, and ends it
    const handed = read().tasks(addressOf(child), helper)[0]!
    b.m.service.report(handed.id, { outcome: 'finished', body: '[Centralu] The helper finished.' })
    await b.mgr.inputs.send(child, 'carry on', undefined, { sessionId: parent, name: 'parent' })
    b.claude.handles.get(child)!.answer('all done')
    await until(() => reports().length === 1)
    expect(reports().map((m) => [m.facts.outcome, m.facts.answer])).toEqual([['finished', 'all done']])
    expect(read().taskRow(work.id, child)).toMatchObject({ settled: 'reported' })
    // Once: nothing follows
    await new Promise((r) => setTimeout(r, 30))
    expect(reports()).toHaveLength(1)
    // Nor a notice of a turn that "ended in the swap"
    expect(read().to(addressOf(parent)).some((x) => x.message.body.includes('swap'))).toBe(false)
  })

  it('a session at rest whose helper is gone holds its task for nothing: the next start answers it with its last response', async () => {
    const a = host()
    a.mgr.prefs.setUiPreferences({ agentDepth: 3 })
    const { parent, child } = await parentAndChild(a)
    const helperStarted = await a.mgr.startAgent(child, { task: 'write the tests', wait: false })
    if (!helperStarted.ok) throw new Error(helperStarted.error)
    const helper = helperStarted.sessionId
    a.claude.handles.get(child)!.answer('handed the tests on')
    await until(() => a.mgr.sessionInfo(child)?.state !== 'working' && read().tasks(addressOf(child), helper).length === 1)
    const work = read().tasks(addressOf(parent), child)[0]!
    expect(read().reportsOn(work.id)).toEqual([])
    // The helper's session was archived while the old host served: its task is gone
    a.m.service.stops.partyGone(addressOf(helper))
    expect(read().taskRow(read().tasks(addressOf(child), helper)[0]!.id, helper)).toMatchObject({ settled: 'gone' })
    await a.mgr.tenure.disposeAll()

    const b = host()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      b.m.afterReady()
      await vi.advanceTimersByTimeAsync(61_000)
    } finally {
      b.m.delivery.stop()
      vi.useRealTimers()
    }
    expect(read().reportsOn(work.id).map((m) => [m.facts.outcome, m.facts.answer])).toEqual([['finished', 'handed the tests on']])
    expect(read().taskRow(work.id, child)).toMatchObject({ settled: 'reported' })
  })
})

describe('the turn of a session an update cut', () => {
  it('stays open across the update, and its end is recorded by the next host; the open rows of the rest are closed lost', async () => {
    const f = memoryUpdateFolder()
    const a = host(f)
    const { parent, child } = await parentAndChild(a)
    const task = read().tasks(addressOf(parent), child)[0]!
    // The turn is the task's: its work message and its starter
    expect(turnsOf(store, child)).toEqual([expect.objectContaining({ startedBy: 'caller', endedAt: null, messageId: task.id, starterId: task.id })])
    // A turn of a session the update did not list (its turn went with the old host)
    store.mailbox.startTurn({ sessionId: 'gone-with-the-old-host', turnSeq: 1, messageId: null, starterId: null, startedBy: 'person', startedAt: 1 })
    await stopForUpdate(a)

    const b = host(f)
    // What the delivery does when it starts
    b.m.turns.closeStale()
    expect(turnsOf(store, child)).toEqual([expect.objectContaining({ startedBy: 'caller', endedAt: null, outcome: null, messageId: task.id })])
    expect(turnsOf(store, 'gone-with-the-old-host')).toEqual([expect.objectContaining({ outcome: 'lost' })])
    // Read back with its work message and starter (§8.2 step 6)
    expect(b.m.turns.current(child)).toMatchObject({ by: 'caller', messageId: task.id, starter: task.id })

    await until(() => (b.claude.handles.get(child)?.sent.length ?? 0) === 1)
    b.claude.handles.get(child)!.answer('finished under the new host')
    expect(turnsOf(store, child)).toEqual([expect.objectContaining({ startedBy: 'caller', outcome: 'empty', endedAt: expect.any(Number) })])
    expect(b.m.turns.current(child)).toBeUndefined()
    // Its end is the task's: reported once, under the new host
    expect(read().reportsOn(task.id)).toHaveLength(1)
  })

  it('is closed lost when the session is not in its turn any more: the update found it at rest', async () => {
    const f = memoryUpdateFolder()
    const a = host(f)
    const { child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('finished before the update')
    // The old host did not see the end (a crash): the row is still open in the store
    store.mailbox.startTurn({ sessionId: child, turnSeq: 9, messageId: null, starterId: null, startedBy: 'caller', startedAt: 1 })
    await stopForUpdate(a)
    const b = host(f)
    b.m.turns.closeStale()
    expect(turnsOf(store, child).find((t) => t.turnSeq === 9)).toMatchObject({ outcome: 'lost' })
  })
})

describe('a mail turn cut by a plain restart (#1916)', () => {
  it('ends lost under the next host, and the asker is told its question was cut, once; the question is not given again', async () => {
    const a = host()
    const project = await a.mgr.projectCreation.addProject(root)
    await a.mgr.setProjectTrusted(project.id, true)
    const asker = (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    const helper = (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    const question = a.m.service.send(addressOf(asker), { to: [addressOf(helper)], text: 'what does the build need?' }).message
    const due = wireHostMail(a.mgr, store, { now: () => Date.now() + 60_000 })
    await deliverTo(due, addressOf(helper))
    expect(a.claude.handles.get(helper)!.sent.some((t) => t.includes(question.id))).toBe(true)
    expect(due.turns.current(helper)).toMatchObject({ by: 'mail', starter: question.id })
    // The host stops in the turn, and not for an update: the turn is not continued
    await a.mgr.tenure.disposeAll()

    const b = host()
    await deliverTo(b.m, addressOf(helper))
    expect(turnsOf(store, helper)).toEqual([expect.objectContaining({ startedBy: 'mail', outcome: 'lost' })])
    expect(b.claude.handles.get(helper)?.sent ?? []).toEqual([])
    const told = read().between('centralu', addressOf(asker), 'notice')
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ facts: { unanswered: [{ id: question.id, recipient: addressOf(helper), why: 'lost' }] } })
    expect(read().row(question.id, addressOf(helper))).toMatchObject({ releasedWhy: 'lost', settled: null })
    // A later start tells nobody again: the turn is closed
    await deliverTo(wireHostMail(b.mgr, store), addressOf(helper))
    expect(read().between('centralu', addressOf(asker), 'notice')).toHaveLength(1)
  })

  /*
   * #1916 review: the asker also started the session (`askedBy`), so it could hear of the same cut turn twice. The task it gave was reported when
   * its turn ended; the quit found at the next start goes through the stop notice alone (mailbox.md §10.6.1, `HostMail.afterReady`, before its
   * delivery closes the turn): the asker is owed a reply, so the notice listing its question is the one word it gets, with no starter notice and
   * no quit report besides
   */
  it('tells an asker that also started the session once, by the stop notice: no starter notice, and no quit report', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('first turn')
    const reports = () => read().between('centralu', addressOf(parent), 'report')
    await until(() => reports().length === 1)
    const question = a.m.service.send(addressOf(parent), { to: [addressOf(child)], text: 'what does the build need?' }).message
    const due = wireHostMail(a.mgr, store, { now: () => Date.now() + 60_000 })
    await deliverTo(due, addressOf(child))
    expect(due.turns.current(child)).toMatchObject({ by: 'mail', starter: question.id })
    await a.mgr.tenure.disposeAll()

    const b = host()
    await until(() => b.mgr.sessionInfo(child)?.interruption?.reason === 'quit')
    // The parent was in a turn of its own (the report woke it), which the same quit cut: it waits for the person's Continue
    expect(b.mgr.sessionInfo(parent)?.interruption?.reason).toBe('quit')
    const sweep = vi.spyOn(b.m.delivery, 'sweep')
    b.m.afterReady()
    await sweep.mock.results[0]?.value
    sweep.mockRestore()
    b.m.delivery.stop()
    // Told quietly, as the same quit cut it: a wake would start a turn with nobody there
    expect(read().between('centralu', addressOf(parent), 'notice').map((n) => n.facts)).toEqual([{ unanswered: [{ id: question.id, recipient: addressOf(child), why: 'quit' }], quiet: true }])
    expect(read().row(question.id, addressOf(child))).toMatchObject({ releasedWhy: 'quit', toldAt: expect.any(Number) })
    expect(reports()).toHaveLength(1)
  })
})

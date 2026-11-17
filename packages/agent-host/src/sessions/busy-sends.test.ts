/**
 * A send to a session that cannot take it now is mail (docs/plans/mailbox.md §10.6.2, §10.6.3), over the real manager: no note / queue / fork
 * choice comes back, the call answers `mailed` at once, the task joins the running turn and each sender's task is answered on its own by that
 * turn's last response (the reviewer's S3b, S4b), and a stop releases it through the stop notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostMail } from '../mail/host-mail.js'
import { PERSON } from '../mail/address.js'
import { crossWorld, type CrossHandle, type CrossWorld, sendWork } from './cross-project.test-helpers.js'
import { addressOf as addr, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { turnsOf } from '../dev-services/store/mailbox-turns.test-helpers.js'

let w: CrossWorld
let m: HostMail
let read: ReturnType<typeof mailReader>
const clock = { t: 0 }

beforeEach(async () => {
  w = await crossWorld()
  clock.t = Date.now()
  m = wireHostMail(w.mgr, w.store, { now: () => clock.t })
  m.delivery.start()
  read = mailReader(w.store)
})
afterEach(async () => {
  m.delivery.stop()
  vi.restoreAllMocks()
  await w.dispose()
})

const handleOf = (id: string): CrossHandle => w.adapters.get('claude')!.handles.get(id)!
/** The mail due for a session goes now (the debounce passed) */
const deliverDue = async (sessionId: string) => {
  clock.t += 3_000
  await m.delivery.process(addr(sessionId))
}
/** The same, past the 30 s between two wakes */
const wakeDue = async (sessionId: string) => {
  clock.t += 31_000
  await m.delivery.process(addr(sessionId))
}

async function childInTurn(): Promise<{ parent: string; child: string }> {
  w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  const parent = await w.callerSession()
  const started = await w.mgr.startAgent(parent, { task: 'long job', wait: false })
  const child = started.ok ? started.sessionId : ''
  await w.until(() => w.mgr.sessionInfo(child)?.state === 'working')
  // The tool says it took a tracked input at once, as Claude does
  handleOf(child).acceptsAtOnce = true
  return { parent, child }
}

describe('a send to a busy session is mail (§10.6.2)', () => {
  it('agent_session send to a child in a turn answers mailed at once, with no choice; the task joins the running turn (§10.6.3)', async () => {
    const { parent, child } = await childInTurn()
    const turns = turnsOf(w.store, child)
    const r = await sendWork(w.mgr, parent, child, 'use Chromium')
    expect(r).toMatchObject({ ok: true, state: 'mailed', sessionId: child, messageId: expect.any(String) })
    const task = read.tasks(addr(parent), child).find((t) => t.body === 'use Chromium')!
    expect(task).toMatchObject({ id: r?.ok && r.state === 'mailed' ? r.messageId : '', origin: 'agent_session' })
    // Into the running turn: no turn of its own
    await deliverDue(child)
    expect(handleOf(child).sent.at(-1)).toContain(task.id)
    expect(handleOf(child).sent.at(-1)).toContain('use Chromium')
    expect(turnsOf(w.store, child)).toHaveLength(turns.length)
    expect(read.taskRow(task.id, child)).toMatchObject({ deliveredAt: expect.any(Number), turnSeq: turns.at(-1)!.turnSeq })
  })

  /*
   * The deep review's cases (S3b, S4b) under step 3: tasks given into one turn at different times each get one answer, their own, from the last
   * response of the turn that ran them. S2, S3 and S4 are sessions/last-response.test.ts's "two tasks of one sender", H1 and H2
   */
  describe('each sender is told of its own work, once', () => {
    /** The session's turn ends with `text`, and the mail due for it then goes as a wake */
    const turnEnds = async (id: string, text: string) => {
      handleOf(id).answer(text)
      await w.until(() => w.mgr.sessionInfo(id)?.state !== 'working')
      await wakeDue(id)
    }
    /** The answers on a task, oldest first */
    const answered = (taskId: string) => read.reportsOn(taskId).map((r) => r.facts.answer)

    it('S3b: two senders into one turn at different times each get their own answer, once, from that turn', async () => {
      const { parent, child } = await childInTurn()
      const [first] = read.tasks(addr(parent), child)
      const orc = await w.mgr.assistant()
      await w.mgr.runCentraluTool(orc.id, 'send_to_session', { sessionId: child, text: 'check the build', reportBack: true })
      await deliverDue(child)
      const r = await sendWork(w.mgr, parent, child, 'and the docs')
      const follow = r?.ok && r.state === 'mailed' ? r.messageId : ''
      await deliverDue(child)
      const [asked] = read.tasks(addr(orc.id), child)
      expect(handleOf(child).sent.join(' ')).toContain(asked!.id)
      expect(handleOf(child).sent.join(' ')).toContain(follow)
      await turnEnds(child, 'All three done.')
      await w.until(() => answered(asked!.id).length > 0 && answered(follow).length > 0)
      // A later turn answers none of them again
      await w.mgr.inputs.send(child, 'one more thing')
      await turnEnds(child, 'Later.')
      expect([answered(first!.id), answered(asked!.id), answered(follow)]).toEqual([['All three done.'], ['All three done.'], ['All three done.']])
    })

    /** Two sessions of the caller's project, and a session of the target's that the person is working in */
    async function twoAskers(): Promise<{ b: string; c: string; there: string }> {
      w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      const b = await w.callerSession()
      const c = await w.callerSession()
      const there = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      await w.mgr.inputs.send(there, 'the person works here')
      await w.until(() => w.mgr.sessionInfo(there)?.state === 'working')
      handleOf(there).acceptsAtOnce = true
      return { b, c, there }
    }

    it("S4b: an ask_project that comes after another joined the person's turn joins it too, and each asker is told once", async () => {
      const { b, c, there } = await twoAskers()
      await w.mgr.askProject(b, { project: w.target.id, session: there, task: 'what does parse() return?' })
      const [fromB] = read.tasks(addr(b), there)
      await deliverDue(there)
      expect(handleOf(there).sent.join(' ')).toContain(fromB!.id)
      await w.mgr.askProject(c, { project: w.target.id, session: there, task: 'which branch is it on?' })
      const [fromC] = read.tasks(addr(c), there)
      await deliverDue(there)
      expect(handleOf(there).sent.join(' ')).toContain(fromC!.id)
      await turnEnds(there, 'A tree, on main.')
      await w.until(() => answered(fromB!.id).length > 0 && answered(fromC!.id).length > 0)
      expect([answered(fromB!.id), answered(fromC!.id)]).toEqual([['A tree, on main.'], ['A tree, on main.']])
      // The person's own message is answered by no report
      expect(read.to(PERSON).filter((x) => x.message.kind === 'report')).toEqual([])
    })
  })

  it("option B: a delegated task given as mail shows as its sender's message in the receiver's conversation, the agent reads the mail frame once, and other mail keeps the line", async () => {
    const { parent, child } = await childInTurn()
    const r = await sendWork(w.mgr, parent, child, 'use Chromium')
    const id = r?.ok && r.state === 'mailed' ? r.messageId : ''
    handleOf(child).answer('Started.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    const shown = (since: number) => w.store.messages.loadMessagesFrom(child, since, 50).map((row) => ({ role: row.role, payload: row.payload as { text?: string; from?: unknown } }))
    const sent = handleOf(child).sent.length
    let since = w.store.messages.nextSeq(child) - 1
    await wakeDue(child)
    // The agent gets one input, the mail frame with the task's id and its words
    expect(handleOf(child).sent).toHaveLength(sent + 1)
    expect(handleOf(child).sent.at(-1)).toContain(id)
    // The person sees the sender's words as its message, as for its direct send, and no mail line
    const task = shown(since)
    expect(task.filter((row) => row.role === 'user').map((row) => row.payload)).toEqual([expect.objectContaining({ text: 'use Chromium', from: { sessionId: parent, name: w.mgr.sessionInfo(parent)!.name } })])
    expect(JSON.stringify(task)).not.toContain('1 message from')
    // Other mail: the line, and no message of the sender's
    handleOf(child).answer('Done.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    m.service.send(addr(parent), { to: [addr(child)], text: 'which branch?', needsReply: true })
    since = w.store.messages.nextSeq(child) - 1
    await wakeDue(child)
    const other = shown(since)
    expect(other.filter((row) => row.role === 'user')).toEqual([])
    expect(JSON.stringify(other)).toContain('1 message from')
  })

  it('ask_project to a session the person is working in answers mailed at once, with no choice', async () => {
    const caller = await w.callerSession()
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const there = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    await w.mgr.inputs.send(there, 'the person works here')
    await w.until(() => w.mgr.sessionInfo(there)?.state === 'working')
    const r = await w.mgr.askProject(caller, { project: w.target.id, session: there, task: 'what does parse() return?' })
    expect(r).toMatchObject({ ok: true, state: 'mailed', project: w.target.name, sessionId: there })
    expect(read.tasks(addr(caller), there)).toEqual([expect.objectContaining({ body: 'what does parse() return?', origin: 'ask_project' })])
  })

  it("the Assistant's send_to_session to a session the person is working in answers sent as mail, with no choice; a report only when asked (#2258)", async () => {
    const orc = await w.mgr.assistant()
    const there = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    await w.mgr.inputs.send(there, 'the person works here')
    await w.until(() => w.mgr.sessionInfo(there)?.state === 'working')
    handleOf(there).acceptsAtOnce = true
    const r = await w.mgr.runCentraluTool(orc.id, 'send_to_session', { sessionId: there, text: 'check the build', reportBack: true })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('is busy, so this went to it as mail')
    expect(r.text).toContain('you are told by mail when that turn ends')
    expect(read.tasks(addr(orc.id), there)).toEqual([expect.objectContaining({ body: 'check the build', origin: 'send_to_session' })])
    // Without reportBack it is a note: a message that needs no reply, and nobody is told when its turn ends
    const note = await w.mgr.runCentraluTool(orc.id, 'send_to_session', { sessionId: there, text: 'and the lint' })
    expect(note.text).toContain('is busy, so this went to it as mail')
    expect(note.text).not.toContain('you are told')
    expect(read.tasks(addr(orc.id), there)).toHaveLength(1)
    expect(read.between(addr(orc.id), addr(there), 'message')).toEqual([expect.objectContaining({ body: 'and the lint', origin: 'send_to_session', needsReply: false })])
    // Both reach the model as words, under the header that says the Assistant acts for the person
    handleOf(there).answer('Done.')
    await w.until(() => w.mgr.sessionInfo(there)?.state !== 'working')
    await deliverDue(there)
    // One wake: the task, and the note with it, which is no one's work
    const given = handleOf(there).sent.at(-1)
    expect(given).toContain("carry it out as the person's request. Report back when done:\n> check the build")
    expect(given).toContain("carry it out as the person's request. No answer is owed:\n> and the lint")
  })

  it("the Assistant's send_to_session without reportBack to a session at rest is a note: it goes in at once as the Assistant's message, and its turn's end tells nobody (#2258)", async () => {
    const orc = await w.mgr.assistant()
    const there = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    await w.mgr.inputs.send(there, 'the person was here')
    handleOf(there).acceptsAtOnce = true
    handleOf(there).answer('Hello.')
    await w.until(() => w.mgr.sessionInfo(there)?.state !== 'working')
    const shown = (since: number) => w.store.messages.loadMessagesFrom(there, since, 50).filter((row) => row.role === 'user').map((row) => row.payload)
    const note = async (text: string) => {
      const since = w.store.messages.nextSeq(there) - 1
      expect(await w.mgr.runCentraluTool(orc.id, 'send_to_session', { sessionId: there, text })).toEqual({ text: `Sent: ${there}`, isError: false })
      const [written] = read.between(addr(orc.id), addr(there), 'message').filter((n) => n.body === text)
      expect(written).toMatchObject({ origin: 'send_to_session', needsReply: false })
      // Less than the 30 s between two wakes: a send tool's words go in when the last turn is over, as its direct send did
      await deliverDue(there)
      expect(handleOf(there).sent.at(-1)).toContain(written!.id)
      // The model reads the words themselves, as the person's request the Assistant sent
      expect(handleOf(there).sent.at(-1)).toContain(`> ${text}`)
      expect(handleOf(there).sent.at(-1)).toContain("from the Assistant, which acts for the person in Centralu: carry it out as the person's request. No answer is owed:")
      expect(shown(since)).toEqual([expect.objectContaining({ text, from: { sessionId: orc.id, name: w.mgr.sessionInfo(orc.id)!.name } })])
      handleOf(there).answer('Done.')
      await w.until(() => w.mgr.sessionInfo(there)?.state !== 'working')
    }
    await note('check the build')
    await note('and the lint')
    expect(read.tasks(addr(orc.id), there)).toEqual([])
    expect(read.to(addr(orc.id)).filter((x) => x.message.kind === 'report')).toEqual([])
  })

  it('agent_session stop withdraws a mailed task that was not delivered yet', async () => {
    const { parent, child } = await childInTurn()
    w.mgr.sessionInfo(child)!.pendingApproval = { requestId: 'r1', detail: { kind: 'other', title: 'x' } } as never
    const r = await sendWork(w.mgr, parent, child, 'later')
    expect(r).toMatchObject({ state: 'mailed' })
    const task = read.tasks(addr(parent), child).find((t) => t.body === 'later')!
    w.mgr.sessionInfo(child)!.pendingApproval = null
    // Its own delegation runs too: the stop withdraws what it sent and was not given yet, and stops the turn
    const stopped = await w.mgr.agentSession(parent, { sessionId: child, action: 'stop' })
    expect(stopped).toMatchObject({ ok: true, state: 'stopped' })
    expect(read.taskRow(task.id, child)).toMatchObject({ settled: 'withdrawn', deliveredAt: null })
  })

  it('a session that stops in the turn the mailed task joined releases it through the stop notice, with no report, as for any task', async () => {
    const { parent, child } = await childInTurn()
    const r = await sendWork(w.mgr, parent, child, 'and the docs')
    const id = r?.ok && r.state === 'mailed' ? r.messageId : ''
    await deliverDue(child)
    expect(read.taskRow(id, child)?.deliveredAt).not.toBeNull()
    handleOf(child).event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'boom', retryable: false } })
    await w.until(() => read.taskRow(id, child)?.releasedAt != null)
    expect(read.taskRow(id, child)).toMatchObject({ releasedWhy: 'error', settled: null })
    const notices = read.between('centralu', addr(parent), 'notice')
    expect(notices.filter((n) => n.facts.unanswered?.some((u) => u.id === id))).toHaveLength(1)
    expect(read.reportsOn(id)).toEqual([])
  })
})

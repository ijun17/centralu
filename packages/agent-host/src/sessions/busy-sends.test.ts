/**
 * A send to a session that cannot take it now is mail (docs/plans/mailbox.md §10.6.2, #1948 step 2), over the real manager: no note / queue / fork
 * choice comes back, the call answers `mailed` at once, the task waits for the turn's end and starts a turn of its own reported to its sender
 * (as before step 2: the reviewer's S2, S3, S3b, S4), and a stop releases it through the stop notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostMail } from '../mail/host-mail.js'
import { crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'
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
  it("agent_session send to a child in a turn answers mailed at once, with no choice; the task waits for the turn's end and starts a turn of its own", async () => {
    const { parent, child } = await childInTurn()
    const turns = turnsOf(w.store, child)
    const r = await w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'use Chromium' })
    expect(r).toMatchObject({ ok: true, state: 'mailed', sessionId: child, messageId: expect.any(String) })
    const task = read.tasks(addr(parent), child).find((t) => t.body === 'use Chromium')!
    expect(task).toMatchObject({ id: r.ok && r.state === 'mailed' ? r.messageId : '', origin: 'agent_session' })
    // Not into the running turn
    await deliverDue(child)
    expect(handleOf(child).sent.join(' ')).not.toContain(task.id)
    expect(read.taskRow(task.id, child)).toMatchObject({ deliveredAt: null })
    handleOf(child).answer('Started.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    await wakeDue(child)
    expect(handleOf(child).sent.at(-1)).toContain(task.id)
    expect(handleOf(child).sent.at(-1)).toContain('use Chromium')
    expect(turnsOf(w.store, child)).toHaveLength(turns.length + 1)
    expect(read.taskRow(task.id, child)).toMatchObject({ deliveredAt: expect.any(Number), turnSeq: turnsOf(w.store, child).at(-1)!.turnSeq })
  })

  /*
   * The deep review's cases (S2, S3, S3b, S4, S4b), each sender's report as before step 2: one report per send, on the turn that did that work. With
   * tasks joining the running turn, a sender was told of a turn that never saw its task, or nobody was told
   */
  describe('each sender is told of its own work, once', () => {
    /** The session's turn ends with `text`, and the mail due for it then goes as a wake */
    const turnEnds = async (id: string, text: string) => {
      handleOf(id).answer(text)
      await w.until(() => w.mgr.sessionInfo(id)?.state !== 'working')
      await wakeDue(id)
    }
    const reported = (taskId: string) => read.reportsOn(taskId).length

    it('S2: a follow-up sent while the turn it gave runs is not reported on that turn; it runs as the next, which is reported on it', async () => {
      const { parent, child } = await childInTurn()
      const [first] = read.tasks(addr(parent), child)
      const r = await w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'and the docs' })
      const follow = r.ok && r.state === 'mailed' ? r.messageId : ''
      await deliverDue(child)
      await turnEnds(child, 'Code done.')
      await w.until(() => reported(first!.id) > 0)
      expect(reported(follow)).toBe(0)
      expect(handleOf(child).sent.at(-1)).toContain(follow)
      await turnEnds(child, 'Docs done.')
      await w.until(() => reported(follow) > 0)
      expect([reported(first!.id), reported(follow)]).toEqual([1, 1])
    })

    it("S3: the Assistant's send into a child's turn leaves the child's parent its report, and gets its own on the turn after", async () => {
      const { parent, child } = await childInTurn()
      const [first] = read.tasks(addr(parent), child)
      const orc = await w.mgr.assistant()
      const sent = await w.mgr.runCentraluTool(orc.id, 'send_to_session', { sessionId: child, text: 'check the build' })
      expect(sent.text).toContain('went to it as mail')
      const [asked] = read.tasks(addr(orc.id), child)
      await deliverDue(child)
      await turnEnds(child, 'Code done.')
      await w.until(() => reported(first!.id) > 0)
      expect(reported(asked!.id)).toBe(0)
      // The parent's report mark went with the turn it was for: nothing keeps the parent waiting on the Assistant's work
      expect(w.store.children.listReportMarks().filter((r) => r.sessionId === child && r.callerSessionId === parent)).toEqual([])
      await turnEnds(child, 'Build green.')
      await w.until(() => reported(asked!.id) > 0)
      expect([reported(first!.id), reported(asked!.id)]).toEqual([1, 1])
    })

    it('S3b: two senders into one turn at different times are each told, on a turn of its own', async () => {
      const { parent, child } = await childInTurn()
      const [first] = read.tasks(addr(parent), child)
      const orc = await w.mgr.assistant()
      await w.mgr.runCentraluTool(orc.id, 'send_to_session', { sessionId: child, text: 'check the build' })
      await deliverDue(child)
      const r = await w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'and the docs' })
      const follow = r.ok && r.state === 'mailed' ? r.messageId : ''
      await deliverDue(child)
      const [asked] = read.tasks(addr(orc.id), child)
      await turnEnds(child, 'Code done.')
      await turnEnds(child, 'Next done.')
      await turnEnds(child, 'Last done.')
      await w.until(() => reported(asked!.id) > 0 && reported(follow) > 0)
      expect([reported(first!.id), reported(asked!.id), reported(follow)]).toEqual([1, 1, 1])
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

    it("S4: two ask_project into the person's turn are each a turn of their own after it, each reported to its asker", async () => {
      const { b, c, there } = await twoAskers()
      expect(await w.mgr.askProject(b, { project: w.target.id, session: there, task: 'what does parse() return?' })).toMatchObject({ state: 'mailed' })
      expect(await w.mgr.askProject(c, { project: w.target.id, session: there, task: 'which branch is it on?' })).toMatchObject({ state: 'mailed' })
      const [fromB] = read.tasks(addr(b), there)
      const [fromC] = read.tasks(addr(c), there)
      await deliverDue(there)
      await turnEnds(there, 'Done for the person.')
      expect([reported(fromB!.id), reported(fromC!.id)]).toEqual([0, 0])
      await turnEnds(there, 'It returns a tree.')
      await turnEnds(there, 'main.')
      await w.until(() => reported(fromB!.id) > 0 && reported(fromC!.id) > 0)
      expect([reported(fromB!.id), reported(fromC!.id)]).toEqual([1, 1])
    })

    it("S4b: an ask_project that comes while the first asker's turn runs waits for it, and each asker is told once", async () => {
      const { b, c, there } = await twoAskers()
      await w.mgr.askProject(b, { project: w.target.id, session: there, task: 'what does parse() return?' })
      const [fromB] = read.tasks(addr(b), there)
      await turnEnds(there, 'Done for the person.')
      expect(handleOf(there).sent.at(-1)).toContain(fromB!.id)
      await w.mgr.askProject(c, { project: w.target.id, session: there, task: 'which branch is it on?' })
      const [fromC] = read.tasks(addr(c), there)
      await deliverDue(there)
      expect(handleOf(there).sent.join(' ')).not.toContain(fromC!.id)
      await turnEnds(there, 'It returns a tree.')
      await turnEnds(there, 'main.')
      await w.until(() => reported(fromB!.id) > 0 && reported(fromC!.id) > 0)
      expect([reported(fromB!.id), reported(fromC!.id)]).toEqual([1, 1])
    })
  })

  it("option B: a delegated task given as mail shows as its sender's message in the receiver's conversation, the agent reads the mail frame once, and other mail keeps the line", async () => {
    const { parent, child } = await childInTurn()
    const r = await w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'use Chromium' })
    const id = r.ok && r.state === 'mailed' ? r.messageId : ''
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
    expect(JSON.stringify(task)).not.toContain('✉')
    // Other mail: the line, and no message of the sender's
    handleOf(child).answer('Done.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    m.service.send(addr(parent), { to: [addr(child)], text: 'which branch?', needsReply: true })
    since = w.store.messages.nextSeq(child) - 1
    await wakeDue(child)
    const other = shown(since)
    expect(other.filter((row) => row.role === 'user')).toEqual([])
    expect(JSON.stringify(other)).toContain('✉ 1 message')
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

  it("the Assistant's send_to_session to a session the person is working in answers sent as mail, with no choice", async () => {
    const orc = await w.mgr.assistant()
    const there = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    await w.mgr.inputs.send(there, 'the person works here')
    await w.until(() => w.mgr.sessionInfo(there)?.state === 'working')
    const r = await w.mgr.runCentraluTool(orc.id, 'send_to_session', { sessionId: there, text: 'check the build' })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('is busy, so this went to it as mail')
    expect(read.tasks(addr(orc.id), there)).toEqual([expect.objectContaining({ body: 'check the build', origin: 'send_to_session' })])
  })

  it('agent_session stop withdraws a mailed task that was not delivered yet', async () => {
    const { parent, child } = await childInTurn()
    w.mgr.sessionInfo(child)!.pendingApproval = { requestId: 'r1', detail: { kind: 'other', title: 'x' } } as never
    const r = await w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'later' })
    expect(r).toMatchObject({ state: 'mailed' })
    const task = read.tasks(addr(parent), child).find((t) => t.body === 'later')!
    w.mgr.sessionInfo(child)!.pendingApproval = null
    // Its own delegation runs too: the stop withdraws what it sent and was not given yet, and stops the turn
    const stopped = await w.mgr.agentSession(parent, { sessionId: child, action: 'stop' })
    expect(stopped).toMatchObject({ ok: true, state: 'stopped' })
    expect(read.taskRow(task.id, child)).toMatchObject({ settled: 'withdrawn', deliveredAt: null })
  })

  it('a session that stops in the turn of the mailed task releases it through the stop notice, and the report on it says so, as for any task', async () => {
    const { parent, child } = await childInTurn()
    const r = await w.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'and the docs' })
    const id = r.ok && r.state === 'mailed' ? r.messageId : ''
    handleOf(child).answer('Started.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    await wakeDue(child)
    expect(read.taskRow(id, child)?.deliveredAt).not.toBeNull()
    handleOf(child).event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'boom', retryable: false } })
    await w.until(() => read.taskRow(id, child)?.releasedAt != null)
    expect(read.taskRow(id, child)).toMatchObject({ releasedWhy: 'error' })
    // Its own turn: the report on it says how that turn ended, as for any task
    await w.until(() => read.reportsOn(id).length > 0)
    expect(read.reportsOn(id).map((r) => r.facts.outcome)).toEqual(['failed'])
  })
})

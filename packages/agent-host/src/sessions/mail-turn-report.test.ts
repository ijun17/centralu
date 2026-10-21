/**
 * A turn the mailbox starts is the work of the thread it carries (docs/plans/mailbox.md §6, slice 3), over the real manager: its end is reported
 * to the thread's owner like the end of any turn of work, so the thread leaves `running` and a parent above it is not held for good.
 * Found live (MR2 on #1473): the owner sent new work into a thread in `review` by mail, the helper did it, and nobody heard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSON } from '../mail/address.js'
import { answerRecorder, closingRecorder, delegationRecorder, finishRecorder, reportRecorder, turnRecorder } from '../mail/delegation.js'
import { MailDelivery } from '../mail/delivery.js'
import { MailService } from '../mail/service.js'
import { MailTurns } from '../mail/turns.js'
import type { ThreadRow } from '../dev-services/store/mail.js'
import { crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'

let w: CrossWorld
let mail: MailService
let delivery: MailDelivery
let clock = { t: 1_800_000_000_000 }

beforeEach(async () => {
  w = await crossWorld()
  clock = { t: Date.now() }
  mail = new MailService(w.store.mail, { hostId: () => 'hub-aaaaaaaa', now: () => clock.t })
  const turns = new MailTurns(w.store.mail, { now: () => clock.t })
  delivery = new MailDelivery(mail, w.store.mail, w.mgr.mailSessions(), { now: () => clock.t, schedule: () => () => {}, turns })
  w.mgr.useMail({
    sessionGone: (id) => void mail.sessionGone(id),
    sessionChanged: (id) => delivery.poke(id),
    sessionEvent: (e, ended) => turns.observe(e, ended),
    delegated: delegationRecorder(mail, (id) => w.mgr.sessionInfo(id), turns),
    answered: answerRecorder(mail, w.store.mail),
    report: reportRecorder(mail, w.store.mail),
    waitingOn: (ownerId, childId) => mail.waitingOn(mail.sessionAddress(ownerId), mail.sessionAddress(childId)),
    finishedWith: finishRecorder(mail),
    turnStarted: turnRecorder(mail, w.store.mail, turns),
  })
  mail.useClosing(
    closingRecorder(turns, {
      inTurn: (id) => w.mgr.sessionInfo(id)?.state === 'working',
      paused: (id, ownerId) => w.mgr.pausedFor(id, ownerId),
      workClosed: (c) => void w.mgr.workClosed(c),
    }),
  )
  delivery.start()
})
afterEach(async () => {
  delivery.stop()
  vi.restoreAllMocks()
  await w.dispose()
})

const handleOf = (id: string): CrossHandle => w.adapters.get('claude')!.handles.get(id)!
const addr = (id: string) => mail.sessionAddress(id)
const threadBetween = (owner: string, assignee: string): ThreadRow => w.store.mail.latestBetween(addr(owner), addr(assignee))!
const outcomes = (t: ThreadRow) => w.store.mail.messagesAfter(t.id, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu').map((m) => m.facts.outcome)
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}
/** Moves the clock past the debounce and looks at the mailbox, as its timer would */
const due = async (sessionId: string) => {
  clock.t += 40_000
  await delivery.process(addr(sessionId))
  await settle()
}
const turnEnds = async (id: string, text: string) => {
  handleOf(id).answer(text)
  await w.until(() => w.mgr.sessionInfo(id)?.state !== 'working')
  await new Promise((r) => setTimeout(r, 10))
}
async function startAgent(parent: string, task: string) {
  const started = await w.mgr.startAgent(parent, { task, wait: false })
  return started.ok ? started.sessionId : ''
}
async function reported(owner: string, helper: string, text: string) {
  await turnEnds(helper, text)
  await w.until(() => outcomes(threadBetween(owner, helper)).length >= 1)
}

describe('new work sent by mail into a thread in review', () => {
  it('mail into a thread that is running again is that thread’s work too, and its end is reported', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const thread = threadBetween(owner, helper)
    mail.update(thread.id, addr(owner), { state: 'running' })
    handleOf(helper).acceptsAtOnce = true
    mail.post(thread.id, addr(owner), { kind: 'note', body: 'and the docs' })
    await due(helper)
    await turnEnds(helper, 'docs written')
    await w.until(() => outcomes(thread).length === 2)
    expect(w.store.mail.thread(thread.id)?.state).toBe('review')
  })

  it('a member’s note into a reported thread starts no work of the thread: no report is owed for the turn it starts', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const thread = threadBetween(owner, helper)
    const bystander = await startAgent(owner, 'something else')
    mail.addMember(thread.id, addr(owner), addr(bystander))
    handleOf(helper).acceptsAtOnce = true
    mail.post(thread.id, addr(bystander), { kind: 'note', body: 'just an aside' })
    await due(helper)
    expect(handleOf(helper).sent).toHaveLength(2)
    expect(w.mgr.reportOwed(helper)).toBeNull()
    expect(w.store.mail.thread(thread.id)?.state).toBe('review')
  })

  it('the end of the turn it starts is reported to the owner: the thread leaves running, once', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const thread = threadBetween(owner, helper)
    expect(thread.state).toBe('review')

    handleOf(helper).acceptsAtOnce = true
    mail.post(thread.id, addr(owner), { kind: 'note', body: 'Now write TWO files' })
    expect(w.store.mail.thread(thread.id)?.state).toBe('review')
    await due(helper)
    expect(handleOf(helper).sent).toHaveLength(2)
    expect(w.store.mail.thread(thread.id)?.state).toBe('running')

    await turnEnds(helper, 'two files written')
    await w.until(() => outcomes(thread).length === 2)
    expect(outcomes(thread)).toEqual(['finished', 'finished'])
    expect(w.store.mail.thread(thread.id)?.state).toBe('review')
    // Once: a turn the helper runs afterwards on its own is not the work's
    await turnEnds(helper, 'tidied up')
    expect(outcomes(thread)).toHaveLength(2)
  })

  it('a parent held by a child that was sent more goes on when that child’s turn is reported: it is told at the real end', async () => {
    w.mgr.setUiPreferences({ agentDepth: 3 })
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const a = await w.callerSession()
    const b = await startAgent(a, 'build X')
    const c = await startAgent(b, 'do Y')
    // C answered Y (review); B's own turn is still going
    await reported(b, c, 'Y done')
    const y = threadBetween(b, c)
    expect(y.state).toBe('review')
    const x = threadBetween(a, b)

    // B sends C more by mail and ends its turn: X is held by Y, which is about to run
    handleOf(c).acceptsAtOnce = true
    mail.post(y.id, addr(b), { kind: 'note', body: 'also do Z' })
    await turnEnds(b, 'asked C for more')
    await w.until(() => outcomes(x).includes('paused'))
    expect(outcomes(x)).toEqual(['paused'])
    expect(w.store.mail.thread(x.id)?.state).toBe('running')

    // C does it: its turn is reported to B, which wakes B's turn for the work, and B's end is reported to A
    await due(c)
    await turnEnds(c, 'Z done')
    await w.until(() => outcomes(y).length === 2)
    expect(w.store.mail.thread(y.id)?.state).toBe('review')
    expect(w.mgr.reportOwed(c)).toBeNull()
    expect(w.store.mail.thread(x.id)?.state).toBe('running')
    await due(b)
    handleOf(b).acceptsAtOnce = true
    await w.until(() => (handleOf(b).sent.length ?? 0) >= 2)
    await turnEnds(b, 'X done')
    await w.until(() => outcomes(x).includes('finished'))
    expect(w.store.mail.thread(x.id)?.state).toBe('review')
  })

  it('mail that is not taken leaves no report owed', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const thread = threadBetween(owner, helper)
    handleOf(helper).sendTracked = (): Promise<void> => Promise.reject(new Error('the tool failed'))
    mail.post(thread.id, addr(owner), { kind: 'note', body: 'Now write TWO files' })
    await due(helper)
    expect(w.mgr.reportOwed(helper)).toBeNull()
    expect(w.store.mail.thread(thread.id)?.state).toBe('review')
  })
})

describe('a thread closed while its work is going (3.10, MB)', () => {
  const closeAs = (who: string, id: string, outcome: 'dropped' | 'finished' = 'dropped') => mail.update(id, who, { state: 'done', outcome })
  async function working() {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    expect(w.mgr.sessionInfo(helper)?.state).toBe('working')
    return { owner, helper, thread: threadBetween(owner, helper) }
  }
  const settleAfter = () => new Promise((r) => setTimeout(r, 30))

  it('the person dropping it mid-turn stops the helper’s turn, tells it once without a wake, and tells the owner once that it was stopped', async () => {
    const { owner, helper, thread } = await working()
    closeAs(PERSON, thread.id)
    await w.until(() => handleOf(helper).quiet.length === 1)
    expect(handleOf(helper).interrupted).toBe(1)
    expect(handleOf(helper).quiet[0]).toContain(`The person dropped thread ${thread.id}; its work was stopped. Do not continue it.`)
    expect(handleOf(helper).quiet[0]).toContain('[Centralu]')
    // The thread has it as an event
    expect(w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'event').at(-1)?.facts).toMatchObject({ change: 'helper_told', stopped: true })
    // The owner's report is the one notice that the person closed it, saying the turn was stopped
    const reports = w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ facts: { outcome: 'dropped', closedBy: 'person', stopped: true } })
    // The stopped turn ends, and nothing is reported a second time: no mark, no relayed message
    expect(w.mgr.reportOwed(helper)).toBeNull()
    await turnEnds(helper, 'stopped')
    await settleAfter()
    expect(w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu')).toHaveLength(1)
    expect((handleOf(owner).sent).filter((t) => t.includes(`sourceSessionId: ${helper}`))).toEqual([])
  })

  it('the owner closing it by mail stops the turn and tells the helper, naming the owner; the owner is not told of its own close', async () => {
    const { owner, helper, thread } = await working()
    closeAs(addr(owner), thread.id, 'finished')
    await w.until(() => handleOf(helper).quiet.length === 1)
    expect(handleOf(helper).interrupted).toBe(1)
    expect(handleOf(helper).quiet[0]).toContain(`The owner (${owner}) marked done thread ${thread.id}; its work was stopped.`)
    expect(w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu')).toEqual([])
  })

  it('a helper in a turn that is not the thread’s is not interrupted: it gets only the note', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const thread = threadBetween(owner, helper)
    // The owner asked for more (the thread runs again), and then the person typed into the helper: that turn is theirs
    mail.update(thread.id, addr(owner), { state: 'running' })
    await w.mgr.send(helper, 'wait, one question for you')
    expect(w.mgr.sessionInfo(helper)?.state).toBe('working')
    closeAs(PERSON, thread.id)
    await w.until(() => handleOf(helper).quiet.length === 1)
    expect(handleOf(helper).interrupted).toBe(0)
    expect(handleOf(helper).quiet[0]).toContain(`The person dropped thread ${thread.id}. Do not continue it.`)
    expect(handleOf(helper).quiet[0]).not.toContain('was stopped')
    expect(w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'event').at(-1)?.facts).toMatchObject({ change: 'helper_told', stopped: false })
    const closed = w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'report' && m.facts.closedBy === 'person')
    expect(closed[0]!.facts.stopped).toBeUndefined()
  })

  it('stops the background work the stopped turn started, and leaves a dev server the person started and work of another turn running (#1474)', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    Object.assign(w.adapters.get('claude')!.capabilities, { backgroundTasks: true })
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    const thread = threadBetween(owner, helper)
    const h = handleOf(helper)
    // Started before this turn's calls: the person's dev server, and an earlier turn's watcher
    h.event({ type: 'tool_call', sessionId: helper, callId: 'c-this', summary: { tool: 'Bash', title: 'pnpm test --watch', paths: [] } })
    h.event({
      type: 'background_tasks',
      sessionId: helper,
      live: [
        { id: 't-this', kind: 'shell', description: 'pnpm test --watch', status: 'running', stoppable: true, parentCallId: 'c-this' },
        { id: 't-server', kind: 'shell', description: 'pnpm dev', status: 'running', stoppable: true },
        { id: 't-old', kind: 'shell', description: 'tail -f log', status: 'running', stoppable: true, parentCallId: 'c-before' },
      ],
    })
    // The earlier call is in the conversation too, from before the turn began
    w.store.messages.appendMessages([{ sessionId: helper, seq: w.store.messages.nextSeq(helper), role: 'system', kind: 'tool_call', payload: { callId: 'c-before', summary: { tool: 'Bash', title: 'tail -f log', paths: [] } }, ts: Date.now() - 600_000 }])
    closeAs(PERSON, thread.id)
    await w.until(() => h.quiet.length === 1)
    expect(h.interrupted).toBe(1)
    expect(h.stoppedTasks).toEqual(['t-this'])
  })

  it('a tool that has no quiet input (Codex) is not sent the note, which would start a turn nobody reports: its turn is stopped and the thread has the event', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const started = await w.mgr.startAgent(owner, { task: 'write the files', wait: false, tool: 'codex' })
    const helper = started.ok ? started.sessionId : ''
    expect(w.mgr.sessionInfo(helper)).toMatchObject({ tool: 'codex', state: 'working' })
    const thread = threadBetween(owner, helper)
    const codex = w.adapters.get('codex')!.handles.get(helper)!
    closeAs(PERSON, thread.id)
    await w.until(() => codex.interrupted === 1)
    await settleAfter()
    expect(codex.sent).toHaveLength(1)
    expect(codex.quiet).toEqual([])
    expect(w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'event').at(-1)?.facts).toMatchObject({ change: 'helper_told', stopped: true })
  })

  it('a helper paused over its own background work for the owner is stopped too: the work is what is going', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    Object.assign(w.adapters.get('claude')!.capabilities, { backgroundTasks: true })
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'start the server')
    handleOf(helper).event({ type: 'background_tasks', sessionId: helper, live: [{ id: 't1', kind: 'shell', description: 'pnpm dev', status: 'running', stoppable: true }] })
    await turnEnds(helper, 'server started')
    const thread = threadBetween(owner, helper)
    await w.until(() => outcomes(thread).includes('paused'))
    expect(w.mgr.sessionInfo(helper)?.state).not.toBe('working')
    expect(w.mgr.pausedFor(helper, owner)).toBe(true)
    expect(mail.turnRunning(w.store.mail.thread(thread.id)!)).toBe(true)
    closeAs(PERSON, thread.id)
    await w.until(() => handleOf(helper).quiet.length === 1)
    expect(w.mgr.reportOwed(helper)).toBeNull()
    expect(w.store.mail.messagesAfter(thread.id, 0).filter((m) => m.kind === 'report' && m.facts.closedBy === 'person')[0]!.facts.stopped).toBe(true)
  })

  it('a thread whose work was reported and is marked done tells the helper nothing', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const thread = threadBetween(owner, helper)
    closeAs(PERSON, thread.id, 'finished')
    await settleAfter()
    expect(handleOf(helper).quiet).toEqual([])
    expect(handleOf(helper).interrupted).toBe(0)
  })
})

/**
 * A turn the mailbox starts is the work of the task it carries (docs/plans/mailbox.md §8.2, §9.2), over the real manager: its end is reported to
 * the task's sender like the end of any turn of work, so the task is settled and a parent above it is not held for good. Mail that is no task
 * starts no work. Found live (MR2 on #1473): the owner sent new work by mail after the first was reported, the helper did it, and nobody heard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailRow } from '../dev-services/store/mailbox.js'
import type { HostMail } from '../mail/host-mail.js'
import { PERSON } from '../mail/address.js'
import { MailPerson } from '../mail/person.js'
import { inTurn } from '../idle.js'
import { ChildReports } from './child-reports.js'
import { crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'
import { addressOf as addr, mailReader, wireHostMail } from './host-mail.test-helpers.js'

let w: CrossWorld
let m: HostMail
let read: ReturnType<typeof mailReader>
let clock = { t: 1_800_000_000_000 }

beforeEach(async () => {
  w = await crossWorld()
  clock = { t: Date.now() }
  m = wireHostMail(w.mgr, w.store, { now: () => clock.t })
  read = mailReader(w.store)
  m.delivery.start()
})
afterEach(async () => {
  m.delivery.stop()
  vi.restoreAllMocks()
  await w.dispose()
})

const handleOf = (id: string): CrossHandle => w.adapters.get('claude')!.handles.get(id)!
/** The first task `owner` gave `child` */
const taskOf = (owner: string, child: string): MailRow => read.tasks(addr(owner), child)[0]!
const outcomes = (taskId: string) => read.reportsOn(taskId).map((r) => r.facts.outcome)
/** The session a report of `id`'s work is owed to, if any (the host's report mark) */
const owedTo = (id: string) => (w.mgr as unknown as { children: { awaitingReport: ReadonlyMap<string, string> } }).children.awaitingReport.get(id) ?? null
/** New work sent by mail: a task from `owner` to `helper` the mailbox delivers (§9.7 stores an owner's answer to a clarification so) */
const mailTask = (owner: string, helper: string, text: string): MailRow => m.service.task(addr(owner), addr(helper), { text, origin: 'mail', delivered: false })
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await new Promise<void>((r) => setImmediate(r))
}
/** Moves the clock past the debounce and looks at the mailbox, as its timer would */
const due = async (sessionId: string) => {
  clock.t += 40_000
  await m.delivery.process(addr(sessionId))
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
  await w.until(() => outcomes(taskOf(owner, helper).id).length >= 1)
}

describe('new work sent by mail after the first was reported', () => {
  it('the turn it starts is that task’s, and its end is reported to the owner, once', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const first = taskOf(owner, helper)
    expect(read.taskRow(first.id, helper)).toMatchObject({ settled: 'reported' })

    handleOf(helper).acceptsAtOnce = true
    const more = mailTask(owner, helper, 'Now write TWO files')
    await due(helper)
    expect(handleOf(helper).sent).toHaveLength(2)
    expect(m.turns.current(helper)).toMatchObject({ by: 'mail', messageId: more.id })
    expect(owedTo(helper)).toBe(owner)

    await turnEnds(helper, 'two files written')
    await w.until(() => outcomes(more.id).length === 1)
    expect(outcomes(more.id)).toEqual(['finished'])
    expect(read.reportsOn(more.id)[0]).toMatchObject({ replyTo: more.id, facts: expect.objectContaining({ answer: 'two files written' }) })
    expect(read.taskRow(more.id, helper)).toMatchObject({ settled: 'reported' })
    // Once: a turn the helper runs afterwards on its own is not the work's
    await turnEnds(helper, 'tidied up')
    expect(outcomes(more.id)).toHaveLength(1)
    expect(outcomes(first.id)).toEqual(['finished'])
  })

  it('a plain message to a helper whose work was reported starts no work: no report is owed for the turn it starts', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    const bystander = await startAgent(owner, 'something else')
    handleOf(helper).acceptsAtOnce = true
    m.service.send(addr(bystander), { to: [addr(helper)], text: 'just an aside' })
    await due(helper)
    expect(handleOf(helper).sent).toHaveLength(2)
    expect(owedTo(helper)).toBeNull()
    expect(m.turns.current(helper)).toMatchObject({ by: 'mail', messageId: null })
    expect(outcomes(taskOf(owner, helper).id)).toEqual(['finished'])
  })

  it('a parent whose child sent more by mail is told waiting while that task is owed, and finished at the real end', async () => {
    w.mgr.prefs.setUiPreferences({ agentDepth: 3 })
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const a = await w.callerSession()
    const b = await startAgent(a, 'build X')
    const c = await startAgent(b, 'do Y')
    // C answered Y; B's own turn is still going
    await reported(b, c, 'Y done')
    const x = taskOf(a, b)
    expect(read.taskRow(taskOf(b, c).id, c)).toMatchObject({ settled: 'reported' })

    // B sends C more by mail in its turn for X, and ends its turn: X waits on Z, which is about to run
    handleOf(c).acceptsAtOnce = true
    const z = mailTask(b, c, 'also do Z')
    expect(z.causeId).toBe(x.id)
    await turnEnds(b, 'asked C for more')
    await w.until(() => outcomes(x.id).length >= 1)
    expect(outcomes(x.id)).toEqual(['waiting'])
    expect(read.taskRow(x.id, b)).toMatchObject({ settled: null })

    // C does it: its turn is reported to B, which wakes B's turn for the work, and B's end is reported to A
    await due(c)
    await turnEnds(c, 'Z done')
    await w.until(() => outcomes(z.id).length === 1)
    expect(read.taskRow(z.id, c)).toMatchObject({ settled: 'reported' })
    expect(owedTo(c)).toBeNull()
    expect(read.taskRow(x.id, b)).toMatchObject({ settled: null })
    handleOf(b).acceptsAtOnce = true
    await due(b)
    await w.until(() => (handleOf(b).sent.length ?? 0) >= 2)
    await turnEnds(b, 'X done')
    await w.until(() => outcomes(x.id).includes('finished'))
    expect(read.taskRow(x.id, b)).toMatchObject({ settled: 'reported' })
  })

  it('mail that is not taken leaves no report owed', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const owner = await w.callerSession()
    const helper = await startAgent(owner, 'write the files')
    await reported(owner, helper, 'one file written')
    handleOf(helper).sendTracked = (): Promise<void> => Promise.reject(new Error('the tool failed'))
    const more = mailTask(owner, helper, 'Now write TWO files')
    await due(helper)
    expect(owedTo(helper)).toBeNull()
    expect(outcomes(more.id)).toEqual([])
    expect(read.taskRow(more.id, helper)).toMatchObject({ settled: null })
  })

  /** A helper paused over its own background work for A; B gave it work earlier, which was reported */
  async function pausedForA() {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    Object.assign(w.adapters.get('claude')!.capabilities, { backgroundTasks: true })
    const a = await w.callerSession()
    const b = await w.callerSession()
    const helper = await startAgent(a, 'start the server')
    handleOf(helper).event({ type: 'background_tasks', sessionId: helper, live: [{ id: 't1', kind: 'shell', description: 'pnpm dev', status: 'running', stoppable: true }] })
    await turnEnds(helper, 'server started')
    const forA = taskOf(a, helper)
    await w.until(() => outcomes(forA.id).includes('paused'))
    expect(w.mgr.mail.pausedFor(helper, a)).toBe(true)
    const earlier = m.service.task(addr(b), addr(helper), { text: 'write the docs', origin: 'send_to_session', delivered: true })
    m.service.report(earlier.id, { outcome: 'finished', body: '[Centralu] The session ended its turn.' })
    return { a, b, helper, forA }
  }

  it('a helper that already owes owner A a report is sent work by owner B: B’s turn is reported to B, and A’s paused report is left as it was (#1474)', async () => {
    const { a, b, helper, forA } = await pausedForA()
    // B sends the helper more by mail: the helper takes the turn while its task for A still runs
    handleOf(helper).acceptsAtOnce = true
    const forB = mailTask(b, helper, 'and the changelog')
    await due(helper)
    expect(handleOf(helper).sent).toHaveLength(2)
    expect(m.turns.current(helper)).toMatchObject({ messageId: forB.id })
    await turnEnds(helper, 'docs written')
    await w.until(() => outcomes(forB.id).length === 1)

    // B hears of its own turn; A is not told this turn ended, and still waits for its task
    expect(outcomes(forB.id)).toEqual(['finished'])
    expect(read.taskRow(forB.id, helper)).toMatchObject({ settled: 'reported' })
    expect(outcomes(forA.id)).toEqual(['paused'])
    expect(read.taskRow(forA.id, helper)).toMatchObject({ settled: null })
    expect(w.mgr.mail.pausedFor(helper, a)).toBe(true)
    expect(owedTo(helper)).toBe(a)
  })

  it('A’s paused work ending during B’s turn is settled when that turn ends: nothing else would start its timer (#1474)', async () => {
    const { b, helper } = await pausedForA()
    handleOf(helper).acceptsAtOnce = true
    const forB = mailTask(b, helper, 'and the changelog')
    await due(helper)
    expect(w.mgr.sessionInfo(helper)?.state).toBe('working')
    // The server ends in the middle of B's turn
    handleOf(helper).event({ type: 'background_tasks', sessionId: helper, live: [] })
    const settled = vi.spyOn(ChildReports.prototype, 'settlePausedReport')
    await turnEnds(helper, 'docs written')
    await w.until(() => outcomes(forB.id).length === 1)
    expect(settled).toHaveBeenCalledWith(helper)
  })

  it('B withdrawing its task while that turn runs: the turn’s end is not A’s to hear of, nor B’s (#1474)', async () => {
    const { a, b, helper, forA } = await pausedForA()
    handleOf(helper).acceptsAtOnce = true
    const forB = mailTask(b, helper, 'and the changelog')
    await due(helper)
    expect(w.mgr.sessionInfo(helper)?.state).toBe('working')
    expect(m.service.done(addr(b), forB.id)).toMatchObject({ how: 'withdrawn' })
    await turnEnds(helper, 'stopped')
    await new Promise((r) => setTimeout(r, 30))
    expect(outcomes(forA.id)).toEqual(['paused'])
    expect(w.mgr.mail.pausedFor(helper, a)).toBe(true)
    expect(outcomes(forB.id)).toEqual([])
    expect(read.taskRow(forB.id, helper)).toMatchObject({ settled: 'withdrawn' })
    expect(handleOf(b).sent.filter((t) => t.includes(`sourceSessionId: ${helper}`))).toEqual([])
  })
})

describe('the person closing a chain whose work is going, over the real manager (3.10 as on main; owner decisions on #1914)', () => {
  /** The person's window wired as main.ts wires it */
  const personOf = () =>
    new MailPerson(m.service, w.store.mailbox, m.delivery, {
      session: (id) => {
        const s = w.mgr.sessionInfo(id)
        return s ? { name: s.name, state: s.state } : undefined
      },
      legacyChain: () => [],
      projectLabel: (id) => id,
      untrusted: () => false,
      turnOn: (id) => {
        const s = w.mgr.sessionInfo(id)
        const turn = s && inTurn(s.state) ? m.turns.current(id) : undefined
        return turn && { work: turn.messageId ?? turn.starter }
      },
      tellsNow: (id) => w.mgr.mail.tellsMailNow(id),
      tell: (id, text) => w.mgr.mail.tellMailNow(id, text),
    })
  /** A session at work on the person's task, which the mailbox delivered and started its turn with */
  async function working() {
    const helper = await w.callerSession()
    handleOf(helper).acceptsAtOnce = true
    const task = m.service.task(PERSON, addr(helper), { text: 'write the files', origin: 'person', delivered: false })
    await due(helper)
    expect(w.mgr.sessionInfo(helper)?.state).toBe('working')
    expect(m.turns.current(helper)?.messageId).toBe(task.id)
    return { helper, task }
  }

  it('Drop tells the session once without a wake, in Centralu’s words, and stops nothing: its turn goes on, and what it writes after reaches the person in the same chain', async () => {
    const { helper, task } = await working()
    const person = personOf()
    expect(person.list().threads[0]).toMatchObject({ id: task.id, state: 'running', working: true })
    expect(person.close(task.id, 'dropped')).toMatchObject({ state: 'done', outcome: 'dropped' })
    await w.until(() => handleOf(helper).quiet.length === 1)
    expect(handleOf(helper).quiet[0]).toContain(`[Centralu] The person dropped the mail that began with ${task.id} and withdrew what they asked of you in it (${task.id}). Do not continue that work. Centralu did not stop your turn`)
    person.close(task.id, 'dropped')
    await new Promise((r) => setTimeout(r, 30))
    // Once: the second close adds nothing, and nothing was interrupted
    expect(handleOf(helper).quiet).toHaveLength(1)
    expect(handleOf(helper).interrupted).toBe(0)
    expect(w.mgr.sessionInfo(helper)?.state).toBe('working')
    // The turn ends with its answer: the task is withdrawn, so no report of it opens the chain again
    await turnEnds(helper, 'completed')
    await new Promise((r) => setTimeout(r, 30))
    expect(outcomes(task.id)).toEqual([])
    expect(person.list().threads[0]).toMatchObject({ id: task.id, state: 'done', outcome: 'dropped', unread: 0 })
  })

  it('a tool that takes no quiet input (Codex) is not given the notice mid-turn: it waits as mail for its next mail, and nothing is stopped', async () => {
    const { helper, task } = await working()
    // Codex starts a turn for any input
    Object.defineProperty(w.adapters.get('claude')!, 'quietInput', { value: false })
    expect(w.mgr.mail.tellsMailNow(helper)).toBe(false)
    personOf().close(task.id, 'dropped')
    await new Promise((r) => setTimeout(r, 30))
    expect(handleOf(helper).quiet).toEqual([])
    expect(handleOf(helper).interrupted).toBe(0)
    // Written as mail for it, not delivered into the turn it is in
    const [notice] = read.to(addr(helper)).filter((x) => x.message.kind === 'notice')
    expect(notice?.message.facts.chainClosed).toMatchObject({ root: task.id, outcome: 'dropped' })
    expect(notice?.row.deliveredAt).toBeNull()
  })

  it('does not stop the background work the turn started either (#1474): the session decides', async () => {
    Object.assign(w.adapters.get('claude')!.capabilities, { backgroundTasks: true })
    const { helper, task } = await working()
    const h = handleOf(helper)
    h.event({ type: 'tool_call', sessionId: helper, callId: 'c-this', summary: { tool: 'Bash', title: 'pnpm test --watch', paths: [] } })
    h.event({
      type: 'background_tasks',
      sessionId: helper,
      live: [{ id: 't-this', kind: 'shell', description: 'pnpm test --watch', status: 'running', stoppable: true, parentCallId: 'c-this' }],
    })
    personOf().close(task.id, 'finished')
    await w.until(() => h.quiet.length === 1)
    expect(h.interrupted).toBe(0)
    expect(h.stoppedTasks).toEqual([])
    expect(h.quiet[0]).toContain(`The person marked done the mail that began with ${task.id}`)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { ChildOwnership, PAUSED_REPORT_SETTLE_MS } from './child-ownership.js'
import { LinkedReports, type LinkedEvent, type LinkedReportsHost, type ReportWork } from './linked-reports.js'
import { HUB_SENDER } from './hub-sender.js'

/*
 * The orchestrator's reports from a linked machine's sessions on their own (#82 phase 4, #723): which wait a machine's
 * event ends, whom the report goes to, and what a link that drops, a machine that is removed or a host that closes
 * does to a report still owed. The reports' wording, and the same paths through the real manager and the seat's
 * `send_to_session`, are in links/linked-sessions.test.ts. Linked reports live in the hub's memory only, so there is
 * no store side to check here.
 */

type Delivered = { orchestratorId: string; sessionId: string; name: string; project: string; preview: string; ending: string; error?: string; work?: ReportWork }

let store: Store
let children: ChildOwnership
let delivered: Delivered[]
let orchestrators: Set<string>
let linked: Set<string>
let mirror: Map<string, { name: string; project: string }>
let listing: (machineId: string) => Promise<{ sessionId: string; tasks: BackgroundTask[] }[] | null>
let closing: boolean
/** What the host's report gate answers, for every session (`LinkedReportsHost.reportGate`) */
let gateAnswer: 'deliver' | 'withhold' | 'defer'
let reports: LinkedReports

beforeEach(() => {
  store = new Store()
  children = new ChildOwnership(store)
  delivered = []
  orchestrators = new Set(['o1', 'o2'])
  linked = new Set(['m1', 'm10', 'm2'])
  mirror = new Map([
    ['m1.w1', { name: 'Worker', project: 'Site' }],
    ['m1.w2', { name: 'Builder', project: 'Site' }],
    ['m10.w1', { name: 'Other worker', project: 'Docs' }],
  ])
  listing = async () => []
  closing = false
  gateAnswer = 'deliver'
  /** The hub's reader over its links, as far as the reports read it: the mirror, the last words, and the machine's list */
  const reader = {
    describe: (id: string) => mirror.get(id) ?? null,
    lastWords: async (id: string) => ({ ok: true as const, text: `last words of ${id}`, length: 0, seq: null }),
    machineLinked: (id: string) => linked.has(id),
    machineWaitsForPerson: () => false,
    backgroundTasks: (id: string) => listing(id),
  } as unknown as LinkedSessions
  const host: LinkedReportsHost = {
    children,
    linkedReader: reader,
    hasSession: (id) => orchestrators.has(id),
    get closing() {
      return closing
    },
    reportGate: () => gateAnswer,
    deliverReport: async (orchestratorId, sessionId, name, project, preview, ending, work) => {
      delivered.push({ orchestratorId, sessionId, name, project, preview, ending: ending.type, ...(ending.error?.message ? { error: ending.error.message } : {}), ...(work ? { work } : {}) })
    },
  }
  reports = new LinkedReports(host)
})
afterEach(() => {
  reports.dispose()
  store.close()
  vi.useRealTimers()
})

/** Every report a step started has been handed over: they chain only on resolved promises, never on a timer */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const verify: BackgroundTask = { id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }
const build: BackgroundTask = { id: 'bg-build', kind: 'shell', description: 'pnpm build', status: 'running' }
const tasks = (sessionId: string, live: BackgroundTask[], ended?: BackgroundTask[]): LinkedEvent => ({ type: 'background_tasks', sessionId, live, ...(ended ? { ended } : {}) })
/** The orchestrator asks to hear about the session's turn (`send_to_session` with `reportBack`) */
const ask = (sessionId: string, orchestratorId = 'o1') => children.setLinkedReport(sessionId, { orchestratorId, busy: false })
/** A turn of the session there: it works, and ends */
const turn = (sessionId: string) => {
  reports.observe({ type: 'message_delta', sessionId })
  reports.observe({ type: 'turn_complete', sessionId })
}
const status = (id: string, s: string, name = 'Box') => reports.observe({ type: 'machine_status', machine: { id, name, status: s } })

describe('whom a turn end is reported to', () => {
  it('each waited session reports to the orchestrator that asked, once, with its name and last words', async () => {
    ask('m1.w1', 'o1')
    ask('m1.w2', 'o2')
    turn('m1.w2')
    turn('m1.w1')
    // A second end of the same turn, and a session nobody asked about, report nothing
    reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
    turn('m2.x')
    await flush()
    expect(delivered).toEqual([
      { orchestratorId: 'o2', sessionId: 'm1.w2', name: 'Builder', project: 'Site', preview: 'last words of m1.w2', ending: 'turn_complete' },
      { orchestratorId: 'o1', sessionId: 'm1.w1', name: 'Worker', project: 'Site', preview: 'last words of m1.w1', ending: 'turn_complete' },
    ])
    expect(children.linkedReports.size).toBe(0)
  })

  it('a turn end the machine reports before the turn was seen running is not that turn\'s end', async () => {
    ask('m1.w1')
    reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'waiting_input' })
    await flush()
    expect(delivered).toEqual([])
    reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'working' })
    reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'idle' })
    await flush()
    expect(delivered).toMatchObject([{ sessionId: 'm1.w1', ending: 'state_change' }])
  })

  it('an orchestrator deleted meanwhile is owed nothing, and the wait does not linger', async () => {
    ask('m1.w1', 'o1')
    orchestrators.delete('o1')
    turn('m1.w1')
    await flush()
    expect(delivered).toEqual([])
    expect(children.linkedReports.has('m1.w1')).toBe(false)
  })

  it('a session the hub never had a name for is reported under its id', async () => {
    ask('m2.x')
    turn('m2.x')
    await flush()
    expect(delivered).toMatchObject([{ sessionId: 'm2.x', name: 'm2.x', project: '(unknown)' }])
  })
})

describe('a pause over the session\'s own background work there (#723)', () => {
  it('grows with work a later turn leaves running, tells it once, and settles with how each task ended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    await flush()
    expect(delivered).toMatchObject([{ work: { paused: [verify], stoppable: false } }])
    // The next turn starts more work and ends: the pause holds both, and nothing more is said
    reports.observe(tasks('m1.w1', [verify, build]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(1)
    expect(children.linkedReports.get('m1.w1')?.paused?.map((t) => t.id)).toEqual(['bg-verify', 'bg-build'])
    // verify fails; build leaves the list without saying how, which reads as completed
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'failed' }]))
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS - 1)
    expect(delivered).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({
      orchestratorId: 'o1',
      ending: 'turn_complete',
      work: { settled: [{ id: 'bg-verify', status: 'failed' }, { id: 'bg-build', status: 'completed' }] },
    })
    expect(children.linkedReports.has('m1.w1')).toBe(false)
  })

  it('a state the machine reports after the paused turn, before any new turn, does not end the report', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'waiting_input' })
    await flush()
    // Only the pause: the work's end is told by the settle wait, not by a state no turn came before
    expect(delivered).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS)
    await flush()
    expect(delivered[1]).toMatchObject({ work: { settled: [{ id: 'bg-verify', status: 'completed' }] } })
  })

  it('a turn that fails while the work is paused is reported as it ended, and owes nothing more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
    reports.observe({ type: 'error', sessionId: 'm1.w1', error: { message: 'the CLI crashed' } })
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS * 2)
    await flush()
    expect(delivered.map((d) => d.ending)).toEqual(['turn_complete', 'error'])
    expect(delivered[1]).toMatchObject({ error: 'the CLI crashed' })
    expect(delivered[1]?.work).toBeUndefined()
  })

  it('a host that is closing settles nothing: the report is the next host\'s, or nobody\'s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask('m1.w1')
    ask('m1.w2', 'o2')
    reports.observe(tasks('m1.w1', [verify]))
    reports.observe(tasks('m1.w2', [build]))
    turn('m1.w1')
    turn('m1.w2')
    await flush()
    expect(delivered).toHaveLength(2)
    // One settle wait started before the host began closing, one would start after
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    closing = true
    reports.observe(tasks('m1.w2', [], [{ ...build, status: 'completed' }]))
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS * 2)
    await flush()
    expect(delivered).toHaveLength(2)
  })

  it('dispose ends every settle wait with the host', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    reports.dispose()
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS * 2)
    await flush()
    expect(delivered).toHaveLength(1)
  })
})

/*
 * #1342, the twin of #1344: the person's message goes straight to the machine, so the hub's `send` never runs there; what
 * the hub sees is the machine's relayed `user_message`. A paused report was owed until the work's end, which a watcher or
 * a dev server never reaches, and the person's own failed turn was reported as "The assigned work failed".
 */
describe('the person writes to a session whose report is paused there (#1342)', () => {
  /** The session ends a turn with its verify running: the orchestrator is told it paused */
  async function paused() {
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(1)
  }
  const person = (sessionId = 'm1.w1', text = '/compact'): LinkedEvent => ({ type: 'user_message', sessionId, seq: 7, text })

  it('ends the wait and tells the orchestrator once; a turn of the person that fails is not reported', async () => {
    await paused()
    reports.observe(person())
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ orchestratorId: 'o1', sessionId: 'm1.w1', work: { tookOver: true, paused: [{ id: 'bg-verify' }] } })
    // Not the machine's last words: what is there now is not the assigned work's
    expect(delivered[1]?.preview).toContain("the person's now")
    expect(children.linkedReports.has('m1.w1')).toBe(false)

    reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'working' })
    reports.observe({ type: 'error', sessionId: 'm1.w1', error: { message: 'compact crashed' } })
    // The task ends and a turn follows: still the session's own
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(2)
  })

  it('does not run the settle wait of a report it ended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await paused()
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    reports.observe(person())
    await flush()
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS * 2)
    await flush()
    expect(delivered.map((d) => d.work && Object.keys(d.work)[0])).toEqual(['paused', 'tookOver'])
  })

  it("a message with a source is not the person's: the hub's instruction, another session, an app", async () => {
    await paused()
    reports.observe({ ...person(), from: { sessionId: `m1.${HUB_SENDER}`, name: 'Orchestrator' } })
    reports.observe({ ...person(), from: { sessionId: 'm1.other', name: 'Other' } })
    reports.observe({ ...person(), fromApp: { appId: 'project-board', projectId: null, name: 'Project board' } })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(children.linkedReports.get('m1.w1')?.paused?.map((t) => t.id)).toEqual(['bg-verify'])
  })

  it("a note into the turn the work's ending started is not a takeover: that turn's end is the final report", async () => {
    await paused()
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
    reports.observe(person('m1.w1', 'how is it going?'))
    reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]?.work).toBeUndefined()
    expect(delivered[1]).toMatchObject({ ending: 'turn_complete' })
  })

  it("a report that is not paused is a turn of the orchestrator's still running, which the message joins: it stays owed", async () => {
    ask('m1.w1')
    reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
    reports.observe(person('m1.w1', 'also check the lint'))
    reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.work).toBeUndefined()
  })

  it('leaves a session whose report the gate does not let through to the gate (a child start_agent started)', async () => {
    await paused()
    gateAnswer = 'withhold'
    reports.observe(person())
    await flush()
    expect(delivered).toHaveLength(1)
  })

  it("a host swap owes nothing of it: the next host holds no wait, and the person's failed turn there reports nothing", async () => {
    await paused()
    reports.observe(person())
    await flush()
    // A linked wait lives in the hub's memory only (nothing of it is stored); the next host starts empty over the same store
    const next = new ChildOwnership(store)
    expect([...next.linkedReports]).toEqual([])
    const nextDelivered: string[] = []
    const nextReports = new LinkedReports({
      children: next,
      linkedReader: null,
      hasSession: () => true,
      closing: false,
      deliverReport: async (_o, sessionId) => void nextDelivered.push(sessionId),
    })
    nextReports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'working' })
    nextReports.observe({ type: 'error', sessionId: 'm1.w1', error: { message: 'compact crashed' } })
    await flush()
    expect(nextDelivered).toEqual([])
    nextReports.dispose()
  })
})

describe('a machine whose link drops or comes back', () => {
  it('a link that drops reports only its own machine\'s paused work, even when another machine\'s id starts with its', async () => {
    ask('m1.w1', 'o1')
    ask('m10.w1', 'o2')
    reports.observe(tasks('m1.w1', [verify]))
    reports.observe(tasks('m10.w1', [build]))
    turn('m1.w1')
    turn('m10.w1')
    await flush()
    expect(delivered).toHaveLength(2)
    status('m1', 'unreachable')
    await flush()
    expect(delivered).toHaveLength(3)
    // A machine that cannot be reached cannot be read: the preview points at the pause, which carried its last words
    expect(delivered[2]).toEqual({
      orchestratorId: 'o1', sessionId: 'm1.w1', name: 'Worker', project: 'Site',
      preview: '(in the paused report before this one)', ending: 'turn_complete', work: { linkLost: 'Box', paused: [verify] },
    })
    // m10 kept its wait and what the hub knew of its work: its next turn end, with that work still running, is no report
    expect(children.linkedReports.get('m10.w1')?.paused).toEqual([build])
    turn('m10.w1')
    await flush()
    expect(delivered).toHaveLength(3)
  })

  it('a turn in progress keeps its wait across a drop, and reports when it ends after the link is back', async () => {
    ask('m1.w1')
    reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
    status('m1', 'unreachable')
    status('m1', 'connected')
    await flush()
    expect(delivered).toEqual([])
    reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
    await flush()
    expect(delivered).toMatchObject([{ orchestratorId: 'o1', sessionId: 'm1.w1', ending: 'turn_complete' }])
    expect(delivered[0]?.work).toBeUndefined()
  })

  it('a resync that finds the paused work ended settles the report after the quiet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    await flush()
    listing = async () => [{ sessionId: 'm1.w1', tasks: [{ ...verify, status: 'stopped' }] }]
    reports.observe({ type: 'machine_resync', machineId: 'm1' })
    await flush()
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS)
    await flush()
    expect(delivered[1]).toMatchObject({ work: { settled: [{ id: 'bg-verify', status: 'stopped' }] } })
  })

  it('a resync forgets a session the machine no longer lists, and a read that fails forgets nothing', async () => {
    reports.observe(tasks('m1.w1', [verify]))
    reports.observe(tasks('m1.w2', [build]))
    // The machine cannot be asked: what the hub knew stands
    listing = async () => null
    reports.observe({ type: 'machine_resync', machineId: 'm1' })
    listing = () => Promise.reject(new Error('ssh closed'))
    reports.observe({ type: 'machine_resync', machineId: 'm1' })
    await flush()
    ask('m1.w2', 'o2')
    turn('m1.w2')
    await flush()
    // Read whole: w1 is not listed any more, so its old work holds nothing
    listing = async () => [{ sessionId: 'm1.w2', tasks: [build] }]
    reports.observe({ type: 'machine_resync', machineId: 'm1' })
    await flush()
    ask('m1.w1', 'o1')
    turn('m1.w1')
    await flush()
    expect(delivered.map((d) => [d.sessionId, d.work ? Object.keys(d.work)[0] : 'finished'])).toEqual([
      ['m1.w2', 'paused'],
      ['m1.w1', 'finished'],
    ])
  })
})

describe('a machine removed from Centralu', () => {
  it('reports every wait on it, paused or mid-turn, to its own orchestrator, under the name it last had', async () => {
    status('m1', 'connected', 'Box')
    ask('m1.w1', 'o1')
    ask('m1.w2', 'o2')
    ask('m10.w1', 'o1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    reports.observe({ type: 'message_delta', sessionId: 'm1.w2' })
    reports.observe({ type: 'message_delta', sessionId: 'm10.w1' })
    await flush()
    expect(delivered).toHaveLength(1)
    // Removed: its link and its mirror are gone
    linked.delete('m1')
    mirror.delete('m1.w1')
    mirror.delete('m1.w2')
    reports.observe({ type: 'machine_resync', machineId: 'm1' })
    await flush()
    expect(delivered.slice(1)).toEqual([
      { orchestratorId: 'o1', sessionId: 'm1.w1', name: 'Worker', project: 'Site', preview: '(in the paused report before this one)', ending: 'turn_complete', work: { machineRemoved: 'Box', paused: [verify] } },
      // Not an empty last response (#1186): nothing could be read, and it says why
      { orchestratorId: 'o2', sessionId: 'm1.w2', name: 'Builder', project: 'Site', preview: '(not read: its machine could not be reached)', ending: 'turn_complete', work: { machineRemoved: 'Box' } },
    ])
    expect([...children.linkedReports.keys()]).toEqual(['m10.w1'])
  })

  it('a session deleted on its machine drops its report and its work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    reports.observe({ type: 'session_deleted', sessionId: 'm1.w1' })
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS * 2)
    status('m1', 'unreachable')
    await flush()
    expect(delivered).toHaveLength(1)
    expect(children.linkedReports.size).toBe(0)
  })
})

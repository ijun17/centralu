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

type Delivered = { orchestratorId: string; sessionId: string; name: string; project: string; preview: string; ending: string; error?: string; work?: ReportWork; part?: { wrote?: true; added?: true } }

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
/** What the machine says the last turn said, and what the hub asked for of it (#1604) */
let said: (id: string) => string
let wordsAsked: unknown[]

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
  said = (id) => `last words of ${id}`
  wordsAsked = []
  /** The hub's reader over its links, as far as the reports read it: the mirror, the last words, and the machine's list */
  const reader = {
    describe: (id: string) => mirror.get(id) ?? null,
    lastWords: async (id: string, _max: number, opts?: unknown) => {
      wordsAsked.push(opts)
      return { ok: true as const, text: said(id), length: 0, seq: null }
    },
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
    deliverReport: async (orchestratorId, sessionId, name, project, preview, ending, work, _seq, part) => {
      delivered.push({ orchestratorId, sessionId, name, project, preview, ending: ending.type, ...(ending.error?.message ? { error: ending.error.message } : {}), ...(work ? { work } : {}), ...(part ? { part } : {}) })
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

  // #1604: the words of the turn that ended, not the child's last response; a turn with nothing to say says so
  it("asks for the turn's own words, and says so when the turn ended with none", async () => {
    ask('m1.w1')
    turn('m1.w1')
    await flush()
    expect(wordsAsked).toEqual([{ turn: true }])
    said = () => ''
    ask('m1.w1')
    turn('m1.w1')
    await flush()
    expect(delivered.map((d) => d.preview)).toEqual(['last words of m1.w1', expect.stringContaining('ended without saying anything')])
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
 * #1377: a turn belongs to whoever started it, on a linked machine too. The person's message goes straight to the machine;
 * the hub sees the machine's relayed `user_message` and the turn's events. It never closes a paused report (#1342 had
 * closed it at the first message): the person's own turn is reported to nobody, and "Take it over" is their choice.
 */
describe('a turn belongs to whoever started it, on a linked machine (#1377)', () => {
  /** The session ends a turn with its verify running: the orchestrator is told it paused */
  async function paused() {
    ask('m1.w1')
    reports.observe(tasks('m1.w1', [verify]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(1)
  }
  const person = (extra: Partial<LinkedEvent> = {}, text = '/compact'): LinkedEvent => ({ type: 'user_message', sessionId: 'm1.w1', seq: 7, text, ...extra })
  const failedTurn = () => {
    reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'working' })
    reports.observe({ type: 'error', sessionId: 'm1.w1', error: { message: 'compact crashed' } })
  }

  it("row 1: the person writes while it is at rest: their turn is theirs, not reported, and the report stays open until the work ends", async () => {
    await paused()
    reports.observe(person())
    failedTurn()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(children.linkedReports.get('m1.w1')?.paused?.map((t) => t.id)).toEqual(['bg-verify'])
    // Their next turn ends well: still nothing
    reports.observe(person({ seq: 8 }, 'how is it going?'))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(1)
    // The work ends and the turn that starts is the work's (row 3): reported
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ ending: 'turn_complete' })
    expect(delivered[1]?.work).toBeUndefined()
    expect(delivered[1]?.part).toBeUndefined()
    expect(children.linkedReports.has('m1.w1')).toBe(false)
  })

  it("row 1, after their turn: paused work that ended during it still settles the report", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await paused()
    reports.observe(person())
    reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 1_000)
    expect(delivered).toHaveLength(1)
    reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 1_000)
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ work: { settled: [{ id: 'bg-verify', status: 'completed' }] } })
    // The last response there is the person's: not read, so not the work's to report
    expect(delivered[1]?.preview).toContain("the last turn there was the person's")
    expect(delivered[1]?.preview).not.toContain('last words of')
  })

  it("row 2: the hub's instruction starts the turn: the work's, reported", async () => {
    ask('m1.w1')
    reports.observe({ ...person({ from: { sessionId: `m1.${HUB_SENDER}`, name: 'Orchestrator' } }, 'go'), seq: 1 })
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ ending: 'turn_complete' })
  })

  it("row 3: the CLI starts a turn when the work's background tasks end: the work's (no message before it)", async () => {
    await paused()
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ ending: 'turn_complete' })
  })

  it("row 5: the person writes into a turn the work started: the work's, reported, with the person's part", async () => {
    ask('m1.w1')
    reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
    reports.observe(person({}, 'also check the lint'))
    reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ ending: 'turn_complete', part: { wrote: true } })
  })

  it('"Add to the task": the message at rest makes the turn the work\'s, noted as their addition', async () => {
    await paused()
    reports.observe(person({ intent: 'task' }, 'Also add a changelog line.'))
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ ending: 'turn_complete', part: { added: true } })
  })

  // The hub routes the call, so it knows the choice before the machine does: an older machine strips what it does not know
  describe('the choice the hub sees go out with a message to the machine (#1377)', () => {
    it('"Take it over" closes the wait once the machine took the message, whether or not the machine echoes the choice', async () => {
      await paused()
      const done = reports.choosing('m1.w1', 'takeover')!
      expect(delivered).toHaveLength(1)
      done(true)
      await flush()
      expect(delivered).toHaveLength(2)
      expect(delivered[1]).toMatchObject({ work: { tookOver: true } })
      expect(children.linkedReports.has('m1.w1')).toBe(false)
      // The echo of a machine that does say it finds no wait: told once
      reports.observe(person({ intent: 'takeover' }))
      await flush()
      expect(delivered).toHaveLength(2)
    })

    it('"Take it over" does nothing when the machine did not take the message', async () => {
      await paused()
      reports.choosing('m1.w1', 'takeover')!(false)
      await flush()
      expect(delivered).toHaveLength(1)
      expect(children.linkedReports.get('m1.w1')?.paused?.map((t) => t.id)).toEqual(['bg-verify'])
    })

    it("\"Add to the task\" makes the next message the work's, noted as their addition, from a machine that does not echo it", async () => {
      await paused()
      const done = reports.choosing('m1.w1', 'task')!
      reports.observe(person({}, 'Also add a changelog line.'))
      done(true)
      reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
      turn('m1.w1')
      await flush()
      expect(delivered).toHaveLength(2)
      expect(delivered[1]).toMatchObject({ ending: 'turn_complete', part: { added: true } })
    })

    it('"Add to the task" for a message the machine did not take, or never relayed, is not kept for the next one', async () => {
      await paused()
      reports.choosing('m1.w1', 'task')!(false)
      reports.observe(person({}, 'a different message'))
      reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
      reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
      await flush()
      // Theirs, not the work's: nothing is reported
      expect(delivered).toHaveLength(1)
    })

    it('"Just asking", an unknown choice and a session that owes nothing ask nothing of the hub', async () => {
      await paused()
      expect(reports.choosing('m1.w1', 'ask')).toBeUndefined()
      expect(reports.choosing('m1.w1', undefined)).toBeUndefined()
      expect(reports.choosing('m1.w1', 'make-it-so')).toBeUndefined()
      expect(reports.choosing('m1.other', 'takeover')).toBeUndefined()
    })
  })

  // The machine's host says whose each turn was, from the inputs the tool took in: a message sent while the final answer
  // was written runs as a turn of its own, and the order of the messages the hub sees cannot tell
  describe('the machine says whose the turn was', () => {
    const said = (turn: { by: 'person' | 'work'; wrote?: true; added?: true }, type = 'turn_complete'): LinkedEvent => ({ type, sessionId: 'm1.w1', turn })

    it("a person's message the work's turn did not take in is their own turn after it: the work's report does not note it, and their turn is not reported", async () => {
      ask('m1.w1')
      reports.observe(tasks('m1.w1', [verify]))
      reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
      // They write while the answer is being written: the hub sees the message in a running turn
      reports.observe(person({ seq: 9 }, 'and tell me a joke'))
      reports.observe(said({ by: 'work' }))
      await flush()
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({ work: { paused: [{ id: 'bg-verify' }] } })
      expect(delivered[0]?.part).toBeUndefined()
      // The tool runs the held message as a turn of its own: the machine says it is theirs
      reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'working' })
      reports.observe(said({ by: 'person' }))
      await flush()
      expect(delivered).toHaveLength(1)
      expect(children.linkedReports.get('m1.w1')?.paused?.map((t) => t.id)).toEqual(['bg-verify'])
      // The work's end still reports
      reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
      reports.observe({ type: 'state_change', sessionId: 'm1.w1', state: 'working' })
      reports.observe(said({ by: 'work' }))
      await flush()
      expect(delivered).toHaveLength(2)
      expect(delivered[1]?.part).toBeUndefined()
    })

    it("a message the turn took in is noted as the machine says, with no message seen by the hub", async () => {
      ask('m1.w1')
      reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
      reports.observe(said({ by: 'work', wrote: true }))
      await flush()
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({ ending: 'turn_complete', part: { wrote: true } })
    })

    it('their addition to the task is noted as such, and a failed turn of theirs is reported to nobody', async () => {
      ask('m1.w1')
      reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
      reports.observe(said({ by: 'work', added: true }))
      await flush()
      expect(delivered[0]).toMatchObject({ part: { added: true } })
      ask('m1.w1')
      reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
      reports.observe({ ...said({ by: 'person' }, 'error'), error: { message: 'compact crashed' } })
      await flush()
      expect(delivered).toHaveLength(1)
      expect(children.linkedReports.has('m1.w1')).toBe(true)
    })

    it("a host that does not say is read from the messages the hub saw, as before", async () => {
      ask('m1.w1')
      reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
      reports.observe(person({}, 'also lint'))
      reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
      await flush()
      expect(delivered[0]).toMatchObject({ part: { wrote: true } })
    })
  })

  it('"Take it over": closes the report and tells the orchestrator once; none of their later turns is reported', async () => {
    await paused()
    reports.observe(person({ intent: 'takeover' }))
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ orchestratorId: 'o1', sessionId: 'm1.w1', work: { tookOver: true, paused: [{ id: 'bg-verify' }] } })
    // Not the machine's last words: what is there now is not the assigned work's
    expect(delivered[1]?.preview).toContain("the person's now")
    expect(children.linkedReports.has('m1.w1')).toBe(false)
    failedTurn()
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(2)
  })

  it('"Take it over" does not run the settle wait of a report it closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await paused()
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    reports.observe(person({ intent: 'takeover' }))
    await flush()
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS * 2)
    await flush()
    expect(delivered.map((d) => d.work && Object.keys(d.work)[0])).toEqual(['paused', 'tookOver'])
  })

  it('a message with a source is not the person\'s: another session\'s and an app\'s make the turn the work\'s', async () => {
    await paused()
    reports.observe(person({ from: { sessionId: 'm1.other', name: 'Other' } }))
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    turn('m1.w1')
    await flush()
    expect(delivered).toHaveLength(2)
    expect(delivered[1]?.part).toBeUndefined()
  })

  it('"Take it over" is left to the gate when the gate does not let the report through (a child start_agent started)', async () => {
    await paused()
    gateAnswer = 'withhold'
    reports.observe(person({ intent: 'takeover' }))
    await flush()
    expect(delivered).toHaveLength(1)
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

describe('an ask_project turn that ended on the session\'s own background work (#1457)', () => {
  it('owes the asker the work\'s last turn end, and the turn end that told the call says nothing besides', async () => {
    reports.observe(tasks('m1.w1', [verify]))
    expect(reports.oweAsker('m1.w1', 'o1', { type: 'turn_complete' })).toEqual([verify])
    expect(children.linkedReports.get('m1.w1')).toMatchObject({ orchestratorId: 'o1', busy: false, paused: [verify] })
    // The same event, read by the reports after the ask: paused already, so no notice
    reports.observe({ type: 'message_delta', sessionId: 'm1.w1' })
    reports.observe({ type: 'turn_complete', sessionId: 'm1.w1' })
    await flush()
    expect(delivered).toEqual([])
    reports.observe(tasks('m1.w1', [], [{ ...verify, status: 'completed' }]))
    turn('m1.w1')
    await flush()
    expect(delivered).toMatchObject([{ orchestratorId: 'o1', sessionId: 'm1.w1', preview: 'last words of m1.w1' }])
    expect(delivered[0]!.work).toBeUndefined()
  })

  it('owes nothing for a turn that did not complete, the person\'s, one with no such work, or a timer', () => {
    reports.observe(tasks('m1.w1', [verify]))
    expect(reports.oweAsker('m1.w1', 'o1', { type: 'error' })).toEqual([])
    expect(reports.oweAsker('m1.w1', 'o1', { type: 'turn_complete', turn: { by: 'person' } })).toEqual([])
    expect(reports.oweAsker('m1.w2', 'o1', { type: 'turn_complete' })).toEqual([])
    reports.observe(tasks('m1.w2', [{ id: 'cron', kind: 'other', description: 'every 5 minutes', status: 'running', timer: true }]))
    expect(reports.oweAsker('m1.w2', 'o1', { type: 'turn_complete' })).toEqual([])
    expect(children.linkedReports.size).toBe(0)
  })

  it('does not take over a report another session is owed, nor one the gate does not let through', () => {
    reports.observe(tasks('m1.w1', [verify]))
    ask('m1.w1', 'o2')
    expect(reports.oweAsker('m1.w1', 'o1', { type: 'turn_complete' })).toEqual([])
    expect(children.linkedReports.get('m1.w1')?.orchestratorId).toBe('o2')
    children.dropLinkedReport('m1.w1')
    gateAnswer = 'withhold'
    expect(reports.oweAsker('m1.w1', 'o1', { type: 'turn_complete' })).toEqual([])
    expect(children.linkedReports.size).toBe(0)
  })

  it('releases only the paused report the asker is owed, and the undo puts it back unless something else is owed by then', () => {
    reports.observe(tasks('m1.w1', [verify]))
    expect(reports.releaseAsker('m1.w1', 'o1')).toBeUndefined()
    // A report awaiting a turn, not paused over work, is not the pause's to release
    ask('m1.w1', 'o1')
    expect(reports.releaseAsker('m1.w1', 'o1')).toBeUndefined()
    children.dropLinkedReport('m1.w1')
    reports.oweAsker('m1.w1', 'o1', { type: 'turn_complete' })
    expect(reports.releaseAsker('m1.w1', 'o2')).toBeUndefined()
    const undo = reports.releaseAsker('m1.w1', 'o1')!
    expect(children.linkedReports.size).toBe(0)
    undo()
    expect(children.linkedReports.get('m1.w1')).toMatchObject({ orchestratorId: 'o1', paused: [verify] })
    // Something else owed meanwhile stays
    reports.releaseAsker('m1.w1', 'o1')!()
    expect(children.linkedReports.get('m1.w1')?.paused).toEqual([verify])
    const again = reports.releaseAsker('m1.w1', 'o1')!
    ask('m1.w1', 'o2')
    again()
    expect(children.linkedReports.get('m1.w1')?.orchestratorId).toBe('o2')
  })
})

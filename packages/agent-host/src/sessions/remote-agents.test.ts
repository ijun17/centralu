import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import type { LinkedSessions, OrchestratedSession } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { eventually } from '../../../../tooling/test-timing.js'
import { ChildOwnership, PAUSED_REPORT_SETTLE_MS } from './child-ownership.js'
import { LinkedReports, type LinkedReportsHost } from './linked-reports.js'
import { RemoteAgents, REMOTE_AGENTS_KEY, type RemoteAgentsHost } from './remote-agents.js'

/**
 * A child on a linked machine as the hub follows it (#1038), over a stand-in for the link that answers what the test
 * says: what the hub knows after a restart, and a link that drops before the hub saw the child's turn start. The real
 * link is in links.test.ts.
 */
let store: Store
let children: ChildOwnership
let state: string
let settled: string[]
let told: string[]
/** The last message the child took there, as the machine lists it */
let lastUser: { text: string; from: unknown } | null
/** This hub's sender as the machine records it, qualified with the machine's id */
const HUB = { sessionId: 'm1._hub-orchestrator' }
const PERSON = { sessionId: 'm1.person' }

const caller = { id: 'h1', name: 'Parent', projectId: 'p1', kind: 'worker', permissionPreset: 'normal', ...sessionLiveDefaults() } as unknown as SessionInfo
const child = { sessionId: 'm1.c1', callerId: 'h1', machineId: 'm1', machine: 'Box', name: 'Child', tool: 'claude', project: 'app', startedAt: 1, sent: 'TASK' }
/** A task of the child's own background work there, which a held report waits on (#723) */
const task = { id: 't1', description: 'build', status: 'running' } as never

function agents(extra: Record<string, unknown> = {}): RemoteAgents {
  const reader = {
    read: async () => ({ ok: true, state, lines: [] }),
    list: async (): Promise<OrchestratedSession[]> => [{ sessionId: child.sessionId, name: 'Child', project: 'app', state, tool: 'claude', preview: '', machine: 'Box' }],
    machineLinked: () => true,
    lastWords: async () => 'done there',
    lastUserMessage: async () => ({ ok: true, message: lastUser }),
  } as unknown as LinkedSessions
  const host = {
    children,
    store,
    linkedReader: reader,
    meta: new Map([[caller.id, caller]]),
    settleLinkedTurn: (id: string) => settled.push(id),
    linkedTasksRunning: () => [],
    tellSession: async (_to: string, text: string) => void told.push(text),
    ...extra,
  } as unknown as RemoteAgentsHost
  return new RemoteAgents(host, { agentCeilingError: () => null, reservePlace: () => ({ release: () => {} }) })
}

beforeEach(() => {
  store = new Store()
  children = new ChildOwnership(store)
  store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([child]))
  state = 'working'
  settled = []
  told = []
  // The child last took the instruction this hub sent it: its turn is the caller's
  lastUser = { text: 'TASK', from: HUB }
})
afterEach(() => store.close())

describe('what is owed of a child on a linked machine, across a hub restart (#1038)', () => {
  const stored = () => JSON.parse(store.settings.appSetting(REMOTE_AGENTS_KEY) ?? '[]') as { sessionId: string; owed?: { paused?: unknown[] } }[]

  it('keeps in the record whether its report is owed and what it is paused over, as the report changes', () => {
    // As the host starts: restored, which also hooks the record to its report
    agents().restore()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    expect(stored()[0]!.owed).toEqual({})
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false, paused: [task] })
    expect(stored()[0]!.owed).toEqual({ paused: [task] })
    children.dropLinkedReport(child.sessionId)
    expect(stored()[0]!.owed).toBeUndefined()
  })

  it('owes it again after a restart: read once the link is up, a paused one waiting on its work, nothing for a caller gone', async () => {
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([
      { ...child, owed: {} },
      { ...child, sessionId: 'm1.c2', owed: { paused: [task] } },
      { ...child, sessionId: 'm1.c3', callerId: 'gone', owed: {} },
    ]))
    const ra = agents()
    ra.restore()
    expect([...children.linkedReports.keys()]).toEqual(['m1.c1', 'm1.c2'])
    expect(stored().find((r) => r.sessionId === 'm1.c3')!.owed).toBeUndefined()
    // The link comes up and the child is at rest: its turn ended unseen, so its report goes now
    state = 'idle'
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await eventually(() => settled.includes('m1.c1'))
    expect(settled).not.toContain('m1.c2')
  })
})

// #1038 review: restored before the link was up, a held report settled its work as ended once the settle wait passed
it("leaves a restored held report to the link's resync, so a link slow to come up does not settle its work as ended", async () => {
  vi.useFakeTimers()
  try {
    const delivered: string[] = []
    const reports = new LinkedReports({
      children,
      linkedReader: { describe: () => ({ name: 'Child', project: 'app' }), lastWords: async () => '' } as unknown as LinkedSessions,
      hasSession: () => true,
      closing: false,
      deliverReport: async (_to: string, sessionId: string) => void delivered.push(sessionId),
    } as unknown as LinkedReportsHost)
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ ...child, owed: { paused: [task] } }]))
    // Wired as the host wires a restored report's settle wait
    agents({ linkedReportRestored: (id: string) => reports.restored(id) }).restore()
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 5_000)
    expect(delivered).toEqual([])
    expect(children.linkedReports.get(child.sessionId)?.paused).toEqual([task])
  } finally {
    vi.useRealTimers()
  }
})

// #1038 review (RV12): on the link's return, a turn the person ran there meanwhile was reported as the caller's answer
/**
 * Whose turn runs on the child's machine (#1038 review, RV12): only one that took the instruction this hub sent, and
 * never one the person started there, is read, answered, added to or reported as the caller's.
 */
describe("the turn on the child's machine, read as the caller's only on evidence", () => {
  let answered: string[]
  let sentTexts: string[]
  let holdSend: Promise<void> | null
  const q = { requestId: 'r1', questions: [{ question: 'Delete prod?', header: 'Delete', multiSelect: false, options: [{ label: 'yes', description: '' }, { label: 'no', description: '' }] }] }

  function following(): RemoteAgents {
    answered = []
    sentTexts = []
    holdSend = null
    store.projects.addProject({ id: 'p1', path: '/p', name: 'p' })
    store.projects.setProjectTrusted('p1', true)
    const reader = {
      read: async () => ({ ok: true, state, lines: [] }),
      list: async (): Promise<OrchestratedSession[]> => [{ sessionId: child.sessionId, name: 'Child', project: 'app', state, tool: 'claude', preview: '', machine: 'Box' }],
      machineLinked: () => true,
      lastWords: async () => "the person's private answer",
      lastUserMessage: async () => ({ ok: true, message: lastUser }),
      cards: async () => ({ ok: true, approval: null, questions: [q] }),
      answerQuestion: async (_s: string, id: string) => {
        answered.push(id)
        return { ok: true }
      },
      send: async (_s: string, text: string) => {
        sentTexts.push(text)
        if (holdSend) await holdSend
        return { ok: true }
      },
    } as unknown as LinkedSessions
    const host = {
      children,
      store,
      linkedReader: reader,
      meta: new Map([[caller.id, caller]]),
      settleLinkedTurn: (id: string) => settled.push(id),
      linkedTasksRunning: () => [],
      tellSession: async (_to: string, text: string) => void told.push(text),
      autoBoundaryOpen: () => false,
      emit: () => {},
      uiPreferences: () => ({}),
    } as unknown as RemoteAgentsHost
    const ra = new RemoteAgents(host, { agentCeilingError: () => null, reservePlace: () => ({ release: () => {} }) })
    ra.restore()
    return ra
  }
  const act = (ra: RemoteAgents, action: string, more: Record<string, unknown> = {}) =>
    ra.agentSession('h1', ra.of(child.sessionId)!, { sessionId: child.sessionId, action, ...more } as never)
  const reportOwed = () => children.linkedReports.has(child.sessionId)

  it("leaves a turn the person starts there while the caller's report waits on its background work to the person", async () => {
    const ra = following()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'TASK', from: HUB })
    // The caller's turn completed with its own background work running there: its report is held over that work
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false, paused: [task] })
    // The person types there; their turn runs and asks a question
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 2, text: 'my own thing', from: PERSON })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    ra.observe({ type: 'question_request', sessionId: child.sessionId, requestId: 'r1' })
    expect(await act(ra, 'status')).toMatchObject({ ok: true, state: 'working' })
    expect(await act(ra, 'answer', { card: 'r1.any', text: 'yes' })).toMatchObject({ ok: false, error: expect.stringContaining('not running a turn you gave it') })
    expect(await act(ra, 'send', { text: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('a turn you did not give it') })
    expect(answered).toEqual([])
    expect(sentTexts).toEqual([])
    // Nothing of the person's turn is owed to the caller, who is told its work is no longer followed
    expect(reportOwed()).toBe(false)
    expect(told.some((t) => t.includes('took a message there that you did not send'))).toBe(true)
  })

  it("takes neither a paused report's caller nor anyone else for the turn's owner before a message settles it", async () => {
    const ra = following()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'TASK', from: HUB })
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false, paused: [task] })
    // Held over its work, the turn is over: no card of what runs there is the caller's
    ra.observe({ type: 'question_request', sessionId: child.sessionId, requestId: 'r1' })
    expect(await act(ra, 'status')).toMatchObject({ ok: true, state: 'working' })
  })

  it('does not follow a turn the person began after a send read the child at rest, which took the send as a message', async () => {
    const ra = following()
    state = 'idle'
    let release!: () => void
    holdSend = new Promise<void>((resolve) => (release = resolve))
    const sending = act(ra, 'send', { text: 'do X' })
    await eventually(() => sentTexts.length === 1)
    // There: the person's message began a turn first; the hub's text went into it as a message
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'my own thing', from: PERSON })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 2, text: sentTexts[0], from: HUB })
    release()
    expect(await sending).toMatchObject({ ok: true, state: 'working', reported: false, notice: expect.stringContaining('a turn you did not give it') })
    expect(reportOwed()).toBe(false)
    state = 'working'
    ra.observe({ type: 'question_request', sessionId: child.sessionId, requestId: 'r1' })
    expect(await act(ra, 'status')).toMatchObject({ ok: true, state: 'working' })
    expect(told.some((t) => t.includes('asking a question'))).toBe(false)
  })

  it("does not take the person's turn for the caller's when a note arrives after the caller's turn ended", async () => {
    const ra = following()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'TASK', from: HUB })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    let release!: () => void
    holdSend = new Promise<void>((resolve) => (release = resolve))
    const note = act(ra, 'send', { text: 'use the staging data' })
    await eventually(() => sentTexts.length === 1)
    // The caller's turn ends (its report goes, as the linked reports send it), and the person types at once
    ra.observe({ type: 'turn_complete', sessionId: child.sessionId })
    children.dropLinkedReport(child.sessionId)
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 2, text: 'my own thing', from: PERSON })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 3, text: sentTexts[0], from: HUB })
    release()
    expect(await note).toMatchObject({ ok: true, reported: false, notice: expect.stringContaining('a turn you did not give it') })
    expect(reportOwed()).toBe(false)
  })

  it("takes a link's replay of an instruction seen before, and another link's sender, as no new instruction", async () => {
    const ra = following()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 7, text: 'TASK', from: HUB })
    ra.observe({ type: 'turn_complete', sessionId: child.sessionId })
    children.dropLinkedReport(child.sessionId)
    // The link comes back and replays what it relayed before
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 7, text: 'TASK', from: HUB })
    expect(reportOwed()).toBe(false)
    // The same text from a hub whose sender this machine's link does not qualify
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 8, text: 'TASK', from: { sessionId: 'hub.x._hub-orchestrator' } })
    expect(reportOwed()).toBe(false)
  })
})

describe('a child read at rest when the link is back after a missed end', () => {
  const returned = async (last: { text: string; from: unknown } | null, sent = 'TASK') => {
    store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ ...child, sent }]))
    lastUser = last
    const ra = agents()
    ra.restore()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: true })
    ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
    state = 'idle'
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await eventually(() => settled.length > 0 || !children.linkedReports.has(child.sessionId))
  }

  it('reports the turn that ended unseen when the last message it took is the instruction this hub sent', async () => {
    await returned({ text: 'TASK', from: HUB })
    expect(settled).toEqual([child.sessionId])
  })

  it("says only that it ended unseen, with none of its words, when the person's message came after", async () => {
    await returned({ text: 'my own thing', from: PERSON })
    expect(settled).toEqual([])
    const notice = told.find((t) => t.includes('came to rest there while the hub could not see it'))
    expect(notice).toBeDefined()
    expect(notice).not.toContain('done there')
  })

  it('takes neither an instruction that never went in (kept, then the hub restarted) nor another link\'s for its own', async () => {
    await returned({ text: 'an earlier instruction', from: HUB }, 'TASK')
    expect(settled).toEqual([])
    told = []
    await returned({ text: 'TASK', from: { sessionId: 'hub.x._hub-orchestrator' } })
    expect(settled).toEqual([])
  })
})

describe('a child on a linked machine, as the hub follows it (#1038 review)', () => {
  // After a hub restart nothing is armed or waited on: the state is the machine's, not "finished"
  it("lists the child's state as its machine reports it, not as what the hub happens to hold", async () => {
    const ra = agents()
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ sessionId: child.sessionId, state: 'working', machine: 'Box' })])
    state = 'waiting_approval'
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'waiting' })])
    state = 'idle'
    expect(await ra.rows('h1')).toEqual([expect.objectContaining({ state: 'finished' })])
  })

  // A drop before the first event of the turn left it unseen as busy, and its end while the link was down never reported
  it('reports a turn that ended while the link was down, when a call was waiting on it and had not seen it start', async () => {
    const ra = agents()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    const waiting = ra.agentSession('h1', ra.of(child.sessionId)!, { sessionId: child.sessionId, action: 'wait' })
    await eventually(() => !children.linkedReports.has(child.sessionId))
    ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
    expect(await waiting).toMatchObject({ ok: true, state: 'working', notice: expect.stringContaining('The link to Box dropped') })
    // The turn ended there meanwhile; the link comes back
    state = 'idle'
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await eventually(() => settled.length === 1)
    expect(settled).toEqual([child.sessionId])
  })
})

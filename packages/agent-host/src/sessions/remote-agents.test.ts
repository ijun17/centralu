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
let lastUser: { text: string; from: unknown; seq?: number } | null
/** Whether the machine lists the child in no turn when its last message is read; absent: it did not say */
let lastAtRest: boolean | undefined
/** How many times the hub has read the machine's last message (`verify`) */
let lastUserReads = 0
/** When the last update of the child's machine cut its turn, as the link says (#1618); null when none did */
let cutAt: number | null
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
    machineWaitsForPerson: () => false,
    lastWords: async () => ({ ok: true as const, text: 'done there', length: 0, seq: null }),
    lastUserMessage: async () => ({ ok: true, message: lastUser }),
    cutByUpdate: (id: string) => (id === child.sessionId ? cutAt : null),
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
  lastUserReads = 0
  lastAtRest = undefined
  cutAt = null
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
      linkedReader: { describe: () => ({ name: 'Child', project: 'app' }), lastWords: async () => ({ ok: true as const, text: '', length: 0, seq: null }) } as unknown as LinkedSessions,
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

// #1342: the stored side of the person's message ending a paused report, across a hub swap
it("a hub swap keeps a paused report ended by the person's message ended: one notice, the stored record cleared, no later report", async () => {
  const delivered: string[] = []
  const reports = new LinkedReports({
    children,
    linkedReader: { describe: () => ({ name: 'Child', project: 'app' }), lastWords: async () => ({ ok: true as const, text: '', length: 0, seq: null }) } as unknown as LinkedSessions,
    hasSession: () => true,
    closing: false,
    deliverReport: async (_to: string, sessionId: string) => void delivered.push(sessionId),
  })
  store.settings.setAppSetting(REMOTE_AGENTS_KEY, JSON.stringify([{ ...child, owed: { paused: [task] } }]))
  // The next host: the paused report is owed again from the store
  const ra = agents()
  ra.restore()
  expect(children.linkedReports.get(child.sessionId)?.paused).toEqual([task])
  // The person writes there: the host reads the event with the child's rule first, then the linked reports (`observeLinked`)
  const person = { type: 'user_message', sessionId: child.sessionId, seq: 3, text: '/compact' }
  ra.observe(person)
  reports.observe(person)
  await new Promise((r) => setTimeout(r, 20))
  expect(told.length + delivered.length).toBe(1)
  expect(children.linkedReports.has(child.sessionId)).toBe(false)
  expect(JSON.parse(store.settings.appSetting(REMOTE_AGENTS_KEY) ?? '[]')[0].owed).toBeUndefined()
  // Their turn fails: nothing more is reported
  for (const e of [{ type: 'state_change', sessionId: child.sessionId, state: 'working' }, { type: 'error', sessionId: child.sessionId, error: { message: 'compact crashed' } }]) {
    ra.observe(e)
    reports.observe(e)
  }
  await new Promise((r) => setTimeout(r, 20))
  expect(told.length + delivered.length).toBe(1)
  reports.dispose()
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

  function following(words: LinkedSessions['lastWords'] = async () => ({ ok: true as const, text: "the person's private answer", length: 0, seq: null })): RemoteAgents {
    answered = []
    sentTexts = []
    holdSend = null
    store.projects.addProject({ id: 'p1', path: '/p', name: 'p' })
    store.projects.setProjectTrusted('p1', true)
    const reader = {
      read: async () => ({ ok: true, state, lines: [] }),
      list: async (): Promise<OrchestratedSession[]> => [{ sessionId: child.sessionId, name: 'Child', project: 'app', state, tool: 'claude', preview: '', machine: 'Box' }],
      machineLinked: () => true,
      machineWaitsForPerson: () => false,
      lastWords: words,
      lastUserMessage: async () => {
        lastUserReads++
        return { ok: true, message: lastUser, ...(lastAtRest !== undefined ? { atRest: lastAtRest } : {}) }
      },
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

  // RV13-A: a wait opened on the person's turn with no evidence, and returned the person's card, leaving a report armed
  it("opens no wait on a turn the person runs there, and returns none of its cards", async () => {
    const ra = following()
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'my own thing', from: PERSON })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    const waiting = act(ra, 'wait')
    await Promise.resolve()
    ra.observe({ type: 'question_request', sessionId: child.sessionId, requestId: 'r1' })
    const r = await waiting
    expect(r).toMatchObject({ ok: true, state: 'working', reported: false })
    expect(JSON.stringify(r)).not.toContain('Delete prod?')
    expect(reportOwed()).toBe(false)
  })

  // RV13-B: a wait on the person's turn returned the person's answer as its result
  it("returns nothing of a turn the person runs there at that turn's end", async () => {
    const ra = following()
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'my own thing', from: PERSON })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    const waiting = act(ra, 'wait')
    await Promise.resolve()
    ra.observe({ type: 'turn_complete', sessionId: child.sessionId })
    expect(JSON.stringify(await waiting)).not.toContain('private answer')
  })

  // #1186: a read of its answer that failed came back as an empty answer, which read as "it said nothing"
  it('says its answer could not be read there, and how to read it, rather than answering empty', async () => {
    const ra = following(async () => ({ ok: false as const, error: 'the link closed' }))
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'TASK', from: HUB })
    state = 'idle'
    const r = await act(ra, 'status')
    expect(r).toMatchObject({ ok: true, state: 'at_rest', answer: '' })
    expect((r as { notice?: string }).notice).toBe(`Its answer could not be read there (the link closed): read_session(sessionId="${child.sessionId}") reads it once the machine answers.`)
  })

  it("cuts a long answer with the read there that shows the rest, at the answer's own seq", async () => {
    const long = `${'a'.repeat(7000)}`
    const ra = following(async () => ({ ok: true as const, text: long, length: long.length, seq: 17 }))
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'TASK', from: HUB })
    state = 'idle'
    const r = await act(ra, 'status')
    expect((r as { answer: string }).answer).toContain(`read_session(sessionId="${child.sessionId}", around=17, offset=4500)`)
  })

  // RV13-C: after the notice that it ended unwatched, status at rest read the person's words
  it('reads none of the words of a turn that ended unwatched after the person spoke there', async () => {
    const ra = following()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: true })
    ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
    state = 'idle'
    lastUser = { text: 'my own thing', from: PERSON }
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await eventually(() => !reportOwed())
    const r = await act(ra, 'status')
    expect(r).toMatchObject({ ok: true, state: 'at_rest' })
    expect(JSON.stringify(r)).not.toContain('private answer')
  })

  // RV13-D: a wait cut short owed the person's turn to the caller again, and took a place under the ceiling
  it("owes nothing of a turn the person runs there when a wait on it is cut short", async () => {
    const ra = following()
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'my own thing', from: PERSON })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    const ctl = new AbortController()
    const waiting = ra.agentSession('h1', ra.of(child.sessionId)!, { sessionId: child.sessionId, action: 'wait' } as never, ctl.signal)
    await Promise.resolve()
    ctl.abort()
    await waiting
    expect(reportOwed()).toBe(false)
    expect(ra.workingIn('p1')).toBe(0)
  })

  // RV13 LOW: a turn the person began, which the machine said after the state the send read, still keeps the send out
  it('takes a turn its events said began for running, though the state read before them said at rest', async () => {
    const ra = following()
    state = 'idle'
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'my own thing', from: PERSON })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    expect(await act(ra, 'send', { text: 'do X' })).toMatchObject({ ok: false, error: expect.stringContaining('a turn you did not give it') })
    expect(sentTexts).toEqual([])
  })

  // RV13 LOW, the rule chosen: once the person speaks into the caller's running turn, nothing more of it is the caller's
  it("ends what is owed of the caller's turn once the person speaks into it, and tells the caller", async () => {
    const ra = following()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'TASK', from: HUB })
    ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working' })
    ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 2, text: 'my own thing', from: PERSON })
    expect(reportOwed()).toBe(false)
    expect(told.some((t) => t.includes('took a message there that you did not send'))).toBe(true)
    expect(await act(ra, 'status')).toMatchObject({ ok: true, state: 'working', reported: false })
  })

  // RV13 LOW: an instruction with no record of it as a turn of its own was still followed (a start's own race is in the table)
  it("follows no send whose instruction did not come back as a turn of its own", async () => {
    const ra = following()
    state = 'idle'
    // The send goes, but no record of it comes back as this hub's instruction
    const r = await ra.agentSession('h1', ra.of(child.sessionId)!, { sessionId: child.sessionId, action: 'send', text: 'do X' } as never)
    expect(r).toMatchObject({ ok: true, state: 'working', reported: false, notice: expect.stringContaining('did not go in as a turn of its own') })
    expect(reportOwed()).toBe(false)
  })

  describe("a turn the machine says it ran for a note of the caller's (#1604)", () => {
    const NOTE_ROW = 2
    const named = { ...HUB, name: 'h1' }
    const opens = (ra: RemoteAgents, origin?: unknown) => ra.observe({ type: 'state_change', sessionId: child.sessionId, state: 'working', ...(origin ? { origin } : {}) })
    const ends = (ra: RemoteAgents) => {
      ra.observe({ type: 'turn_complete', sessionId: child.sessionId })
      children.dropLinkedReport(child.sessionId)
    }
    /** The caller's turn took its task and a note (row 2) as the tool read them; the turn ends and its report goes as the linked reports send it */
    async function afterNote(): Promise<RemoteAgents> {
      const ra = following()
      children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: false })
      ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 1, text: 'TASK', from: HUB })
      opens(ra)
      expect(await act(ra, 'send', { text: 'use the staging data' })).toMatchObject({ ok: true, state: 'working' })
      ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: NOTE_ROW, text: sentTexts[0], from: HUB })
      ends(ra)
      return ra
    }
    /**
     * The turn that ran for the note began and was taken for the caller's (a control: the cases below only mean something if
     * this holds), took another note of the caller's (row 4), and ended: what begins next is judged again
     */
    async function afterFollowUp(): Promise<RemoteAgents> {
      const ra = await afterNote()
      opens(ra, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(true)
      expect(await act(ra, 'send', { text: 'and the keys' })).toMatchObject({ ok: true, state: 'working' })
      ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 4, text: sentTexts[1], from: HUB })
      ends(ra)
      return ra
    }

    it("is the note's, so the caller's: its end is owed and a note goes into it", async () => {
      const ra = await afterNote()
      expect(reportOwed()).toBe(false)
      opens(ra, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(true)
      expect(await act(ra, 'send', { text: 'and the keys' })).toMatchObject({ ok: true, state: 'working' })
      expect(sentTexts).toHaveLength(2)
    })

    it("is the caller's when the machine names the message on a second event of the turn, after the one that opened it (Codex)", async () => {
      const ra = await afterNote()
      opens(ra)
      expect(reportOwed()).toBe(false)
      opens(ra, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(true)
      expect(await act(ra, 'send', { text: 'and the keys' })).toMatchObject({ ok: true, state: 'working' })
    })

    it("is taken for the caller's by what the machine says, not by how long after the last turn it began", async () => {
      const ra = await afterNote()
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000)
      opens(ra, { seq: NOTE_ROW, from: named })
      clock.mockRestore()
      expect(reportOwed()).toBe(true)
    })

    it("is not the caller's when it names a row the hub holds no note of", async () => {
      const ra = await afterFollowUp()
      // The note of row 4 went into the turn that ended; row 9 is not one of the hub's
      opens(ra, { seq: 9, from: named })
      expect(reportOwed()).toBe(false)
    })

    it("is not the caller's when the row is named for another sender", async () => {
      const ra = await afterFollowUp()
      opens(ra, { seq: 4, from: { sessionId: 'm1.another-session', name: 'Other' } })
      expect(reportOwed()).toBe(false)
    })

    it("is not the caller's when the machine says nothing of what it ran for (a machine from before this, a tool that does not say)", async () => {
      const ra = await afterFollowUp()
      opens(ra)
      expect(reportOwed()).toBe(false)
      expect(await act(ra, 'send', { text: 'and this' })).toMatchObject({ ok: false, error: expect.stringContaining('a turn it started by itself') })
      expect(sentTexts).toHaveLength(2)
    })

    it("is not the caller's when the person's message came first", async () => {
      const ra = await afterFollowUp()
      ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: 5, text: 'my own thing', from: PERSON })
      opens(ra, { seq: 5, from: { ...PERSON, name: 'person' } })
      expect(reportOwed()).toBe(false)
      expect(await act(ra, 'send', { text: 'and this' })).toMatchObject({ ok: false, error: expect.stringContaining('a turn you did not give it') })
      expect(sentTexts).toHaveLength(2)
    })

    /** The link is back (or the hub started again) and the machine's last message is read: what `verify` settles */
    async function readAgain(ra: RemoteAgents): Promise<void> {
      const before = lastUserReads
      ra.observe({ type: 'machine_resync', machineId: 'm1' })
      await eventually(() => lastUserReads > before)
      // The read's answer is taken in the next turn of the loop
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    it("is not the caller's when it opens while the link is down: whose it is cannot be told", async () => {
      const ra = await afterFollowUp()
      ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
      opens(ra, { seq: 4, from: named })
      expect(reportOwed()).toBe(false)
    })

    it("is the caller's when the link dropped between the note and its turn, and the machine's last message read when it is back is that note", async () => {
      const ra = await afterNote()
      ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
      lastUser = { text: sentTexts[0]!, from: HUB }
      await readAgain(ra)
      opens(ra, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(true)
      expect(await act(ra, 'send', { text: 'and the keys' })).toMatchObject({ ok: true, state: 'working' })
    })

    it("is not the caller's when the link dropped between the note and its turn, and the person wrote there meanwhile", async () => {
      // A control: the turn run for the first note is the caller's, and the second note (row 4) is held for the one after it
      const ra = await afterFollowUp()
      ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
      lastUser = { text: 'my own thing', from: PERSON }
      await readAgain(ra)
      opens(ra, { seq: 4, from: named })
      expect(reportOwed()).toBe(false)
    })

    it("is the caller's after the hub restarted, once the machine's last message is read to be that note: the rows it held are in its record", async () => {
      await afterNote()
      const note = sentTexts[0]!
      // A hub that starts again: nothing is in memory, and whose the turn is cannot be told until the machine is read
      const restarted = following()
      lastUser = { text: note, from: HUB }
      opens(restarted, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(false)
      await readAgain(restarted)
      opens(restarted, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(true)
    })

    it('stops holding the rows of turns that opened while the hub could not see them, once the machine is read with the child in no turn', async () => {
      const ra = await afterNote()
      expect(ra.of(child.sessionId)?.given).toEqual([1, NOTE_ROW])
      ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
      // The turns for both messages opened and ended while the link was down: their events were not seen
      opens(ra, { seq: NOTE_ROW, from: named })
      lastUser = { text: sentTexts[0]!, from: HUB, seq: NOTE_ROW }
      // A control: read while the child is in a turn, the rows stay
      lastAtRest = false
      await readAgain(ra)
      expect(ra.of(child.sessionId)?.given).toEqual([1, NOTE_ROW])
      ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
      lastAtRest = true
      await readAgain(ra)
      expect(ra.of(child.sessionId)?.given).toEqual([NOTE_ROW])
    })

    it('keeps the row of the last message the machine took in when it reads the child at rest: the turn run for it may not have opened', async () => {
      const ra = await afterNote()
      ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
      // The note was queued in the turn that ended; the tool opens its turn a moment later, the child at rest in between
      lastUser = { text: sentTexts[0]!, from: HUB, seq: NOTE_ROW }
      lastAtRest = true
      await readAgain(ra)
      opens(ra, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(true)
    })

    it('keeps the rows after the last message the machine took in when it reads the child at rest', async () => {
      const ra = await afterNote()
      ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'unreachable' } })
      lastUser = { text: sentTexts[0]!, from: HUB, seq: 1 }
      lastAtRest = true
      await readAgain(ra)
      expect(ra.of(child.sessionId)?.given).toEqual([1, NOTE_ROW])
    })

    it("is not the caller's after the hub restarted when the machine's last message is not that note", async () => {
      // A control: the turn run for the first note is the caller's, and the second note (row 4) is held for the one after it
      await afterFollowUp()
      const restarted = following()
      lastUser = { text: 'my own thing', from: PERSON }
      await readAgain(restarted)
      opens(restarted, { seq: 4, from: named })
      expect(reportOwed()).toBe(false)
    })

    it('is one turn: the note is done with once a turn has begun', async () => {
      const ra = await afterNote()
      opens(ra, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(true)
      ends(ra)
      opens(ra, { seq: NOTE_ROW, from: named })
      expect(reportOwed()).toBe(false)
    })

    it("is not the caller's when it names nothing, whatever notes are still held for turns to come", async () => {
      const ra = await afterFollowUp()
      // The tool's own next turn names no row of the caller's
      opens(ra)
      expect(reportOwed()).toBe(false)
    })

    /**
     * The gap (#1604): the caller's note went into turn 1, which did not read it; turn 1 ends, and before the turn the tool
     * runs for the note begins, the caller sends an instruction with no ifBusy: the machine is at rest as far as anyone can
     * see. The tool runs the note's turn first (nothing opens it that the hub can tell from the instruction's), then the
     * instruction's, which names its row
     */
    describe('an instruction sent at rest between a turn and the turn run for a note before it', () => {
      /** Sent at rest: the machine's record of it comes back as the answer to the send does */
      async function sentInTheGap(ra: RemoteAgents, row: number): Promise<void> {
        state = 'idle'
        let release!: () => void
        holdSend = new Promise<void>((resolve) => (release = resolve))
        const sending = act(ra, 'send', { text: 'and now this' })
        await eventually(() => sentTexts.length === 2)
        ra.observe({ type: 'user_message', sessionId: child.sessionId, seq: row, text: sentTexts[1], from: HUB })
        release()
        expect(await sending).toMatchObject({ ok: true, state: 'working', reported: true })
        state = 'working'
      }

      it("takes the instruction's own turn for the caller's after the note's turn ended as its report", async () => {
        const ra = await afterNote()
        await sentInTheGap(ra, 3)
        // The turn run for the note (row 2) ends, and it is reported as the send's turn is
        ends(ra)
        expect(reportOwed()).toBe(false)
        // Then the turn run for the instruction (row 3) opens
        opens(ra, { seq: 3, from: named })
        expect(reportOwed()).toBe(true)
        expect(await act(ra, 'send', { text: 'a note into it' })).toMatchObject({ ok: true, state: 'working' })
        expect(sentTexts).toHaveLength(3)
      })

      it("still takes the note's turn for the caller's when that is the one that opens first", async () => {
        const ra = await afterNote()
        await sentInTheGap(ra, 3)
        ends(ra)
        opens(ra, { seq: NOTE_ROW, from: named })
        expect(reportOwed()).toBe(true)
        ends(ra)
        // And the instruction's after it
        opens(ra, { seq: 3, from: named })
        expect(reportOwed()).toBe(true)
      })

      it("does not take a turn run for another's message for the caller's", async () => {
        const ra = await afterNote()
        await sentInTheGap(ra, 3)
        ends(ra)
        // A control: the instruction's own turn is taken
        opens(ra, { seq: 3, from: named })
        expect(reportOwed()).toBe(true)
        ends(ra)
        opens(ra, { seq: 7, from: named })
        expect(reportOwed()).toBe(false)
      })
    })

    it('says a turn ended without saying anything, rather than answering with nothing', async () => {
      const ra = following(async () => ({ ok: true as const, text: '', length: 0, seq: null }))
      state = 'idle'
      lastUser = { text: 'TASK', from: HUB }
      expect(await act(ra, 'status')).toMatchObject({ ok: true, state: 'at_rest', answer: expect.stringContaining('ended without saying anything') })
    })

    it("reads an adopted turn's answer as that turn's, from the machine's turn, not the last response of its record", async () => {
      const asked: unknown[] = []
      const ra = following(async (_s, _max, opts) => {
        asked.push(opts)
        return { ok: true as const, text: 'the second turn', length: 0, seq: null }
      })
      state = 'idle'
      lastUser = { text: 'TASK', from: HUB }
      expect(await act(ra, 'status')).toMatchObject({ ok: true, state: 'at_rest', answer: 'the second turn' })
      expect(asked).toEqual([{ turn: true }])
    })
  })

  it('does not say the person may be using a turn it saw no message begin', async () => {
    const ra = following()
    state = 'idle'
    // The send goes, but no record of it comes back as this hub's instruction: the hub did not see the turn begin
    await act(ra, 'send', { text: 'do X' })
    state = 'working'
    const r = await act(ra, 'send', { text: 'and this' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('this hub did not see begin') })
    expect((r as { error: string }).error).not.toContain('person may be using')
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
    const notice = told.find((t) => t.includes('that you did not give it while the hub could not see it'))
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

/*
 * #1618: the hub's update of a machine goes at once, and the host it starts there continues the turns the stop cut. The caller
 * of a child whose turn that was hears it once the link is back: the turn was cut and goes on, its report still to come. It
 * used to hear that the link dropped, then the child's stop read as the work's end ("finished")
 */
describe('a child whose turn an update of its machine cut (#1618)', () => {
  const update = (ra: RemoteAgents) => {
    ra.restore()
    children.setLinkedReport(child.sessionId, { orchestratorId: 'h1', busy: true })
    ra.observe({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'updating' } })
  }
  const continued = () => told.filter((t) => t.includes('cut the turn') && t.includes('Centralu continued it there on the new version'))

  it('is not told the link dropped; once the link is back and the turn runs there again, it hears once that it was continued', async () => {
    const ra = agents()
    // An update that cut no turn of the child: the drop is told, as before
    update(ra)
    await eventually(() => told.some((t) => t.includes('The link to Box dropped')))
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(continued()).toEqual([])
    told = []
    // The next update cut its turn
    cutAt = 1_000
    update(ra)
    await new Promise((r) => setTimeout(r, 20))
    expect(told.filter((t) => t.includes('dropped'))).toEqual([])
    // The new host continued it: working again there
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await eventually(() => continued().length === 1)
    expect(continued()[0]).toContain('Its report comes when that turn ends')
    expect(settled).toEqual([])
    expect(children.linkedReports.get(child.sessionId)?.busy).toBe(true)
    // Another catch-up of the same update tells nothing more
    ra.observe({ type: 'machine_resync', machineId: 'm1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(continued()).toHaveLength(1)
  })

})

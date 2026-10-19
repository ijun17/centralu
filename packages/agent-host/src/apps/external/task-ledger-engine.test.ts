import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { BATCH_MS, Ledger, MAX_ATTEMPTS, MIN_GAP_MS } from '../../../../../.centralu/apps/task-ledger/engine.mjs'

/**
 * The task ledger's engine (docs/plans/task-ledger.md §4, §5): the file, what it has heard of the sessions, the sweep and
 * the one message to the responsible session, driven with a clock and a recording notifier. What it says to Centralu
 * through the real runtime is task-ledger-app.test.ts.
 */

const T0 = 1_700_000_000_000
const MIN = 60_000

type Facts = { ok: boolean; facts?: any; open?: any[]; error?: string }
const noFacts = (): Facts => ({ ok: true, facts: { issues: new Map(), prs: new Map(), decisions: new Map() }, open: [] })

function world(file: { data: any } = { data: null }) {
  const w = {
    now: T0,
    file,
    told: [] as { address: string; text: string }[],
    takes: true as boolean,
    facts: noFacts(),
    factsAsked: [] as any[],
    timers: [] as { fn: () => void; ms: number }[],
    busy: [] as (string | false)[],
    saves: 0,
  }
  const make = () =>
    new Ledger({
      load: async () => structuredClone(w.file.data),
      save: async (d: any) => {
        w.saves += 1
        w.file.data = structuredClone(d)
      },
      notify: async (address: string, text: string) => {
        w.told.push({ address, text })
        return w.takes
      },
      readFacts: async (args: any) => {
        w.factsAsked.push(args)
        return w.facts
      },
      busy: (r: string | false) => w.busy.push(r),
      now: () => w.now,
      schedule: (fn: () => void, ms: number) => {
        w.timers.push({ fn, ms })
        return () => {}
      },
      project: 'proj',
    })
  return { w, make }
}

const row = (id: string, over: Record<string, unknown> = {}): any => ({
  id,
  name: `session ${id}`,
  kind: 'worker',
  tool: 'claude',
  state: 'idle',
  live: true,
  waitingSince: null,
  lastSeq: 10,
  activeAt: T0,
  parentId: null,
  askedBy: null,
  pending: { approvals: 0, questions: 0 },
  createdAt: 1,
  machine: null,
  appId: null,
  ...over,
})
const full = (...rows: any[]) => ({ full: true, sessions: rows, gone: [] })
const change = (rows: any[], gone: string[] = []) => ({ full: false, sessions: rows, gone })

async function started(file?: { data: any }) {
  const { w, make } = world(file)
  const l = make()
  await l.start()
  return { w, l, make }
}

describe('telling the responsible session', () => {
  it('sends nothing while nobody is responsible, then tells what is due once somebody takes charge', async () => {
    const { w, l } = await started()
    await l.add({ title: 'Fix login' })
    expect(await l.flush()).toEqual({ sent: 0, why: 'nobody is responsible' })
    await l.takeCharge('orch.mac', 'orchestrator')
    expect(await l.flush()).toEqual({ sent: 1 })
    expect(w.told).toHaveLength(1)
    expect(w.told[0]).toMatchObject({ address: 'orch.mac' })
    expect(w.told[0]!.text).toContain('T1 "Fix login": ready, nobody is assigned.')
    expect(w.told[0]!.text).toContain('(proj)')
  })

  it('tells each change once: not at the next flush, not at the sweep, not after the app starts again', async () => {
    const file = { data: null as any }
    const { w, l, make } = await started(file)
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Fix login' })
    await l.flush()
    w.now += 11 * MIN
    await l.sweep()
    await l.flush()
    expect(w.told).toHaveLength(1)
    // The app stops and starts (a swap, a crash): the key is in the file
    const again = make()
    await again.start()
    w.now += 11 * MIN
    await again.sweep()
    await again.flush()
    expect(w.told).toHaveLength(1)
    // A new change is a new message: the task goes back to ready after review
    await again.add({ title: 'Second' })
    w.now += 2 * MIN
    await again.flush()
    expect(w.told).toHaveLength(2)
    expect(w.told[1]!.text).toContain('T2')
    expect(w.told[1]!.text).not.toContain('T1')
  })

  it('puts everything due into one message, eight lines at most', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    for (let i = 0; i < 11; i++) await l.add({ title: `Task ${i + 1}` })
    await l.flush()
    expect(w.told).toHaveLength(1)
    const lines = w.told[0]!.text.split('\n')
    expect(lines[0]).toBe('Task ledger: 11 things need you. (proj)')
    expect(lines.filter((x: string) => x.startsWith('- T'))).toHaveLength(8)
    expect(lines).toContain('- and 3 more: call ledger_list to see them.')
  })

  it('tells at most once a minute, and schedules the rest instead of dropping it', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'One' })
    await l.flush()
    // The batch timer the change set has gone off by now (nothing was due any more)
    for (const t of w.timers.splice(0)) t.fn()
    await l.chain
    w.now += 5_000
    await l.add({ title: 'Two' })
    expect(await l.flush()).toEqual({ sent: 0, why: 'told a moment ago' })
    expect(w.told).toHaveLength(1)
    // The batch timer was set for when the minute is up
    expect(w.timers.at(-1)!.ms).toBeGreaterThanOrEqual(MIN_GAP_MS - 5_000)
    w.now += MIN_GAP_MS
    await l.flush()
    expect(w.told).toHaveLength(2)
    expect(w.told[1]!.text).toContain('T2')
  })

  it('waits the batch time before telling of a change, so a burst is one message', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    w.timers.length = 0
    await l.add({ title: 'One' })
    await l.add({ title: 'Two' })
    expect(w.timers).toHaveLength(1)
    expect(w.timers[0]!.ms).toBe(BATCH_MS)
    expect(w.told).toHaveLength(0)
    w.timers[0]!.fn()
    await l.chain
    await until(() => w.told.length === 1)
    expect(w.told[0]!.text).toContain('2 things need you')
  })

  it('tries again at the next sweep when Centralu refuses, three times in all, then shows it as not delivered', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Fix login' })
    w.takes = false
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(await l.flush({ force: true })).toMatchObject({ sent: 0 })
      // Not again before the sweep time
      expect(await l.flush({ force: true })).toEqual({ sent: 0, why: 'nothing is due' })
      w.now += 11 * MIN
    }
    expect(w.told).toHaveLength(MAX_ATTEMPTS)
    expect(await l.flush({ force: true })).toEqual({ sent: 0, why: 'nothing is due' })
    expect(l.view().failedTold).toBe(1)
    expect(l.view().attention[0]).toMatchObject({ taskId: 'T1', told: 'failed' })
    // Still on the panel's list, which does not depend on being told
    expect(l.view().tasks[0].attention).toHaveLength(1)
  })

  it('does not tell a second time of a message the app was sending when it stopped (it may have gone)', async () => {
    const file = { data: null as any }
    const { w, l, make } = await started(file)
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Fix login' })
    // The file as it stood after the key was written and before the answer: status "sending"
    const key = Object.keys(l.ledger.notified)[0] ?? `unassigned:T1:${l.ledger.tasks[0].stateSince}`
    file.data.notified[key] = { at: w.now, status: 'sending', attempts: 0, kind: 'unassigned', taskId: 'T1' }
    const again = make()
    await again.start()
    expect(await again.flush({ force: true })).toEqual({ sent: 0, why: 'nothing is due' })
    expect(w.told).toHaveLength(0)
  })

  it('keeps the same message from going twice when two flushes run at once', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Fix login' })
    await Promise.all([l.flush({ force: true }), l.flush({ force: true }), l.flush({ force: true })])
    expect(w.told).toHaveLength(1)
  })
})

describe('the sessions the tasks are given to', () => {
  const give = (l: any) => l.update('T1', { assignee: { sessionId: 's1', name: 'worker' } })

  it('does not call earlier messages a new answer: the first it hears of an assignee is the starting point', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Mac checks' })
    await give(l)
    await l.applyObservation(full(row('s1', { lastSeq: 40 })))
    expect(l.get('T1').seenSeq).toBe(40)
    expect(await l.flush({ force: true })).toEqual({ sent: 0, why: 'nothing is due' })
    expect(w.told).toHaveLength(0)
  })

  it('tells when the assignee finishes with a new answer, once, and again for the next answer', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Mac checks' })
    await give(l)
    await l.applyObservation(full(row('s1', { lastSeq: 40, state: 'working' })))
    await l.applyObservation(change([row('s1', { lastSeq: 47, state: 'waiting_input' })]))
    await l.flush({ force: true })
    expect(w.told).toHaveLength(1)
    expect(w.told[0]!.text).toContain('T1 "Mac checks": its session finished, with a new answer.')
    await l.applyObservation(change([row('s1', { lastSeq: 47, state: 'waiting_input', name: 'renamed' })]))
    await l.flush({ force: true })
    expect(w.told).toHaveLength(1)
    // It is asked again and answers again
    w.now += 5 * MIN
    await l.applyObservation(change([row('s1', { lastSeq: 52, state: 'waiting_input' })]))
    await l.flush({ force: true })
    expect(w.told).toHaveLength(2)
  })

  it('stays on the list until somebody looks, and looking (any change to the task) takes it off', async () => {
    const { l } = await started()
    await l.add({ title: 'Mac checks' })
    await give(l)
    await l.applyObservation(full(row('s1', { lastSeq: 40 })))
    await l.applyObservation(change([row('s1', { lastSeq: 47, state: 'waiting_input' })]))
    expect(l.view().attention.map((a: any) => a.kind)).toEqual(['answer'])
    await l.update('T1', { seen: true })
    expect(l.get('T1').seenSeq).toBe(47)
    expect(l.view().attention).toEqual([])
  })

  it('tells when the assignee stops to ask, and when it has been quiet for the quiet time', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Mac checks' })
    await give(l)
    await l.applyObservation(full(row('s1', { lastSeq: 40, state: 'working', activeAt: w.now })))
    w.now += 29 * MIN
    expect(l.items()).toEqual([])
    w.now += 2 * MIN
    expect(l.items().map((i: any) => i.kind)).toEqual(['quiet'])
    await l.flush({ force: true })
    expect(w.told[0]!.text).toContain('its session has been quiet for 31 minutes')
    await l.applyObservation(change([row('s1', { lastSeq: 41, state: 'waiting_approval', waitingSince: w.now, pending: { approvals: 0, questions: 1 }, activeAt: w.now })]))
    await l.flush({ force: true })
    expect(w.told[1]!.text).toContain('its session stopped to ask a question')
  })

  it('tells when the assignee is gone, only once the whole project has been heard', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Mac checks' })
    await give(l)
    // Never heard in full: a missing session says nothing
    expect(l.items()).toEqual([])
    await l.applyObservation(full(row('s1', { lastSeq: 40 }), row('s2')))
    await l.applyObservation(change([], ['s1']))
    expect(l.items().map((i: any) => i.key)).toEqual(['quiet:T1:s1:gone'])
    await l.flush({ force: true })
    expect(w.told[0]!.text).toContain('its session no longer exists')
    // A cut snapshot cannot say a session is gone
    await l.applyObservation({ full: true, sessions: [row('s2')], gone: [], truncated: true })
    expect(l.complete).toBe(false)
    expect(l.items()).toEqual([])
  })

  it('keeps the name a session had, and shows its state on the task', async () => {
    const { l } = await started()
    await l.add({ title: 'Mac checks' })
    await give(l)
    await l.applyObservation(full(row('s1', { name: 'mac-worker', state: 'working' })))
    const t = l.view().tasks[0]
    expect(t.assignee.name).toBe('mac-worker')
    expect(t.assigneeState).toMatchObject({ state: 'working', live: true })
    await l.applyObservation(change([], ['s1']))
    expect(l.view().tasks[0].assignee.name).toBe('mac-worker')
    expect(l.view().tasks[0].assigneeState).toBeNull()
  })

  it('replaces what it knew with the whole project, so a session that went while it was away is not remembered', async () => {
    const { l } = await started()
    await l.applyObservation(full(row('a'), row('b')))
    await l.applyObservation(full(row('b')))
    expect([...l.sessions.keys()]).toEqual(['b'])
    expect(l.observing.ok).toBe(true)
    l.observationFailed('Tool watch_sessions not found')
    expect(l.view().observing).toMatchObject({ ok: false, reason: 'Tool watch_sessions not found' })
    expect([...l.sessions.keys()]).toEqual(['b'])
  })
})

describe('what GitHub settles at the sweep', () => {
  const facts = (over: Record<string, any>): Facts => ({ ok: true, open: [], facts: { issues: new Map(), prs: new Map(), decisions: new Map(), ...over } })

  it('moves a blocked task to ready when its last blocker resolves, and tells once, in one line with "nobody is assigned"', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Land the stack', blockedBy: [{ kind: 'pr', ref: 7 }, { kind: 'issue', ref: 3 }] })
    expect(l.get('T1').state).toBe('blocked')
    w.facts = facts({ prs: new Map([[7, { state: 'merged' }]]), issues: new Map([[3, { title: 'x', state: 'open' }]]) })
    await l.sweep()
    expect(l.get('T1').state).toBe('blocked')
    w.facts = facts({ prs: new Map([[7, { state: 'merged' }]]), issues: new Map([[3, { title: 'x', state: 'closed' }]]) })
    await l.sweep()
    expect(l.get('T1')).toMatchObject({ state: 'ready', unblocked: { since: w.now } })
    await l.flush({ force: true })
    expect(w.told).toHaveLength(1)
    expect(w.told[0]!.text).toContain('T1 "Land the stack": what blocked it is resolved; nobody is assigned.')
    // "Nobody is assigned" is not told again for the same task
    w.now += 11 * MIN
    await l.sweep()
    await l.flush({ force: true })
    expect(w.told).toHaveLength(1)
  })

  it('asks GitHub only for the blockers of blocked tasks and the issues tasks are linked to', async () => {
    const { w, l } = await started()
    await l.settings({ github: { on: true } })
    await l.add({ title: 'a', blockedBy: [{ kind: 'pr', ref: 7 }, { kind: 'decision', ref: 9 }] })
    await l.add({ title: 'b', state: 'review', blockedBy: [{ kind: 'issue', ref: 4 }] })
    await l.add({ title: 'c', issue: 12 })
    await l.add({ title: 'd', issue: 13, state: 'done' })
    await l.sweep()
    const asked = w.factsAsked.at(-1)
    expect([...asked.prs]).toEqual([7])
    expect([...asked.decisions]).toEqual([9])
    expect([...asked.issues]).toEqual([12])
    expect(asked.wantOpen).toBe(true)
  })

  it('takes a linked task\'s title from its issue, closes it when the issue closes, and reopens what the issue closed', async () => {
    const { w, l } = await started()
    await l.add({ title: 'old title', issue: 12 })
    w.facts = facts({ issues: new Map([[12, { title: 'Renamed in GitHub', state: 'open' }]]) })
    await l.sweep()
    expect(l.get('T1').title).toBe('Renamed in GitHub')
    w.facts = facts({ issues: new Map([[12, { title: 'Renamed in GitHub', state: 'closed' }]]) })
    await l.sweep()
    expect(l.get('T1')).toMatchObject({ state: 'done', issueClosed: true })
    w.facts = facts({ issues: new Map([[12, { title: 'Renamed in GitHub', state: 'open' }]]) })
    await l.sweep()
    expect(l.get('T1')).toMatchObject({ state: 'ready', issueClosed: false })
    // A task a person finished is not reopened by an open issue
    await l.update('T1', { state: 'done' })
    await l.sweep()
    expect(l.get('T1').state).toBe('done')
  })

  it('offers the open issues that are not tasks, and adds the ones the person picks', async () => {
    const { w, l } = await started()
    await l.settings({ github: { on: true } })
    await l.add({ title: 'linked', issue: 1 })
    w.facts = { ok: true, facts: { issues: new Map([[1, { title: 'linked', state: 'open' }]]), prs: new Map(), decisions: new Map() }, open: [{ number: 1, title: 'linked' }, { number: 2, title: 'Second\nissue' }, { number: 3, title: 'Third' }] }
    await l.sweep()
    expect(l.view().github.offers).toEqual([{ number: 2, title: 'Second\nissue' }, { number: 3, title: 'Third' }])
    expect(w.factsAsked.at(-1).wantOpen).toBe(true)
    const r = await l.adopt([2, 99])
    expect(r.added).toEqual(['T2'])
    expect(l.get('T2')).toMatchObject({ title: 'Second issue', issue: 2, state: 'ready' })
    expect(l.view().github.offers).toEqual([{ number: 3, title: 'Third' }])
  })

  it('does not hold up a change while gh is slow: a task is added while the sweep waits for GitHub', async () => {
    const file = { data: null as any }
    const { w, make } = world(file)
    let release: (f: Facts) => void = () => {}
    const slow = make()
    ;(slow as any).deps.readFacts = () => new Promise<Facts>((r) => (release = r))
    await slow.start()
    await slow.add({ title: 'linked', issue: 12 })
    const sweeping = slow.sweep()
    // The sweep is waiting for GitHub; an agent adds a task meanwhile and gets its answer
    const added = await slow.add({ title: 'meanwhile' })
    expect(added.task.id).toBe('T2')
    release({ ok: true, open: [], facts: { issues: new Map([[12, { title: 'From GitHub', state: 'open' }]]), prs: new Map(), decisions: new Map() } })
    await sweeping
    expect(slow.get('T1').title).toBe('From GitHub')
    expect(slow.get('T2').title).toBe('meanwhile')
    expect(w.file.data.tasks.map((t: any) => t.id)).toEqual(['T1', 'T2'])
  })

  it('says when GitHub cannot be read and goes on without it', async () => {
    const { w, l } = await started()
    await l.settings({ github: { on: true } })
    w.facts = { ok: false, error: 'The GitHub CLI (gh) is not installed on this machine.' }
    expect(await l.sweep()).toEqual({ ok: false, error: 'The GitHub CLI (gh) is not installed on this machine.' })
    expect(l.view().github).toMatchObject({ on: true, ok: false, error: 'The GitHub CLI (gh) is not installed on this machine.' })
    await l.add({ title: 'still works' })
    expect(l.view().tasks).toHaveLength(1)
  })

  it('forgets a done task after 14 days, and what it told of a task that stopped needing it after a day', async () => {
    const { w, l } = await started()
    await l.applyObservation(full(row('s1')))
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'a' })
    await l.flush({ force: true })
    expect(Object.keys(l.ledger.notified)).toHaveLength(1)
    await l.update('T1', { state: 'done' })
    await l.sweep()
    // Not at once: a flicker is not told twice
    expect(Object.keys(l.ledger.notified)).toHaveLength(1)
    w.now += 25 * 60 * MIN
    await l.sweep()
    expect(Object.keys(l.ledger.notified)).toHaveLength(0)
    w.now += 14 * 24 * 60 * MIN
    await l.sweep()
    expect(l.view().tasks).toEqual([])
  })
})

describe('what must not be told twice or to itself', () => {
  it('does not watch the task of the session that is itself responsible: its answer to a message is not a reason to send another', async () => {
    const { w, l } = await started()
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Mine', assignee: { sessionId: 'orch', name: 'orch' } })
    await l.applyObservation(full(row('orch', { lastSeq: 10 })))
    for (const seq of [14, 19, 23]) {
      await l.applyObservation(change([row('orch', { lastSeq: seq, state: 'waiting_input' })]))
      w.now += 2 * MIN
      await l.flush({ force: true })
    }
    expect(w.told).toEqual([])
    expect(l.view().attention).toEqual([])
    // It is watched again once the task is somebody else's
    await l.update('T1', { assignee: { sessionId: 's1', name: 'w' } })
    await l.applyObservation(full(row('orch'), row('s1', { lastSeq: 5 })))
    await l.applyObservation(change([row('s1', { lastSeq: 9, state: 'waiting_input' })]))
    await l.flush({ force: true })
    expect(w.told).toHaveLength(1)
  })

  it('does not tell a day-old answer again when the app starts and sweeps before it has heard of the sessions', async () => {
    const file = { data: null as any }
    const { w, l, make } = await started(file)
    await l.takeCharge('orch.mac', 'orchestrator')
    await l.add({ title: 'Mac checks' })
    await l.update('T1', { assignee: { sessionId: 's1', name: 'w' } })
    await l.applyObservation(full(row('s1', { lastSeq: 10, state: 'working' })))
    await l.applyObservation(change([row('s1', { lastSeq: 15, state: 'waiting_input' })]))
    await l.flush({ force: true })
    expect(w.told).toHaveLength(1)
    // The app starts again more than a day later: the first sweep comes before the first answer of the poll
    w.now += 30 * 60 * MIN
    const again = make()
    await again.start()
    await again.sweep()
    await again.applyObservation(full(row('s1', { lastSeq: 15, state: 'waiting_input' })))
    again.ledger.tasks[0].seenSeq = 10
    await again.flush({ force: true })
    expect(w.told).toHaveLength(1)
  })

  it('does not close a task again that a person reopened while its issue is still closed', async () => {
    const { w, l } = await started()
    await l.settings({ github: { on: true } })
    await l.add({ title: 'linked', issue: 12 })
    const closed = { ok: true, open: [], facts: { issues: new Map([[12, { title: 'x', state: 'closed' }]]), prs: new Map(), decisions: new Map() } }
    w.facts = closed
    await l.sweep()
    expect(l.get('T1').state).toBe('done')
    await l.update('T1', { state: 'ready' })
    await l.sweep()
    await l.sweep()
    expect(l.get('T1').state).toBe('ready')
    // Linked to another issue that is closed: that is news, and closes it
    await l.update('T1', { issue: 13 })
    w.facts = { ...closed, facts: { ...closed.facts, issues: new Map([[13, { title: 'y', state: 'closed' }]]) } }
    await l.sweep()
    expect(l.get('T1').state).toBe('done')
  })

  it('asks GitHub nothing while it is off, and reads at most ten decisions in a sweep when it is on', async () => {
    const { w, l } = await started()
    await l.add({ title: 'a', blockedBy: [{ kind: 'pr', ref: 7 }], issue: 3 })
    await l.sweep()
    expect(w.factsAsked.at(-1)).toMatchObject({ wantOpen: false })
    expect([...w.factsAsked.at(-1).issues, ...w.factsAsked.at(-1).prs]).toEqual([])
  })

  it('reads a file a newer version wrote, and does not write it back, so a rollback cannot damage it', async () => {
    const file = { data: { version: 9, nextId: 2, tasks: [{ id: 'T1', title: 'later', state: 'someday', stateSince: 1 }], settings: {}, notified: {}, addresses: {} } as any }
    const { w, l } = await started(file)
    expect(l.view()).toMatchObject({ readOnly: true })
    expect((await l.add({ title: 'new' })).error).toMatch(/written by a newer version/)
    await l.sweep()
    expect(w.saves).toBe(0)
    expect(w.file.data.tasks[0].state).toBe('someday')
  })
})

describe('the file and the changes made to it', () => {
  it('gives two tasks added at the same moment two ids', async () => {
    const { l } = await started()
    const ids = await Promise.all([l.add({ title: 'a' }), l.add({ title: 'b' }), l.add({ title: 'c' })])
    expect(ids.map((r: any) => r.task.id)).toEqual(['T1', 'T2', 'T3'])
  })

  it('saves what a change did, and a change refused saves nothing', async () => {
    const { w, l } = await started()
    await l.add({ title: 'a' })
    const saves = w.saves
    expect((await l.update('T1', { state: 'nope' })).error).toMatch(/A state is one of/)
    expect(await l.update('T9', {})).toMatchObject({ error: expect.stringMatching(/no task T9/) })
    expect(w.saves).toBe(saves)
    await l.update('T1', { next: 'start' })
    expect(w.file.data.tasks[0].next).toBe('start')
  })

  it('makes a session that called the ledger a choice for the responsible one, and refuses one that never did', async () => {
    const { l } = await started()
    await l.hearAddress('s7.mac7', '')
    await l.hearAddress('s7.mac7', '')
    expect(l.view().choices).toEqual([{ sessionId: 's7', label: 's7' }])
    expect((await l.chooseResponsible('nobody')).error).toMatch(/has not used the ledger/)
    await l.chooseResponsible('s7')
    expect(l.view().responsible).toMatchObject({ sessionId: 's7' })
    expect(l.ledger.settings.responsible.address).toBe('s7.mac7')
    // The address Centralu gives it later replaces the old one
    await l.hearAddress('s7.newmac', '')
    expect(l.ledger.settings.responsible.address).toBe('s7.newmac')
    await l.settings({ responsible: null })
    expect(l.view().responsible).toBeNull()
  })

  it('refuses to take charge from the panel, where there is no session', async () => {
    const { l } = await started()
    expect((await l.takeCharge(null, '')).error).toMatch(/Only a session can take charge/)
  })

  it('keeps the app running while any task is open, and lets it go when none is', async () => {
    const { w, l } = await started()
    expect(w.busy.at(-1)).toBe(false)
    await l.add({ title: 'a' })
    await l.add({ title: 'b' })
    expect(w.busy.at(-1)).toBe('watching 2 tasks')
    await l.update('T1', { state: 'done' })
    expect(w.busy.at(-1)).toBe('watching 1 task')
    await l.update('T2', { state: 'done' })
    expect(w.busy.at(-1)).toBe(false)
  })
})

async function until(ok: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

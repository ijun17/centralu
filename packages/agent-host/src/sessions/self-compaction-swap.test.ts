import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { tempRoot } from '../temp-dir.test-helpers.js'
import { FakeAdapter, FakeHandle, projectDirs } from './manager.test-helpers.js'
import { FakeProcess } from './kept-host.test-helpers.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { THEN_SETTLE_MS } from './self-compaction.js'

/**
 * A `compact_self` with a `then` across a host swap and a restart (#2024). Two session managers over one store, as the swap tests do
 * (background-tasks-swap.test.ts): the leaving host lets go of its processes (`detachAll`), the next one adopts the kept process or comes up
 * with none. The step goes exactly once, and when the new host cannot tell whether the compaction happened the session is told.
 */

const processes: AgentProcessHost = { spawn: () => new FakeProcess() }
const STEP = 'Continue with step 3 of the plan in docs/x.md'

let store: Store
let events: NormalizedEvent[]
const hosts: SessionManager[] = []
const dir = projectDirs()

beforeEach(() => {
  store = new Store()
  events = []
  // The moment a step waits after the compact turn ended is moved by hand
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
const settle = () => vi.advanceTimersByTimeAsync(THEN_SETTLE_MS + 1)
afterEach(async () => {
  vi.useRealTimers()
  for (const m of hosts.splice(0)) await m.tenure.disposeAll()
  store.close()
})

function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new FakeAdapter()
  claude.compactCommand = (focus) => (focus ? `/compact ${focus}` : '/compact')
  ;(claude.capabilities as { backgroundTasks: boolean }).backgroundTasks = true
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, tempRoot('compact-then-home-'), { processes, keptSessions: kept })
  hosts.push(mgr)
  return { mgr, claude, rpc: createRpcHandler(mgr, adapters) }
}

/** A session on the first host that asked to be compacted with a step, up to the point `until` names */
async function asking(a: ReturnType<typeof host>, until: 'asked' | 'sent' | 'compacted') {
  const p = (await a.rpc('projects.add', { path: dir('compact-then-') })) as { id: string }
  const s = (await a.rpc('agents.createSession', { projectId: p.id, cwd: dir('compact-then-cwd-'), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
  const tools = a.claude.lastOrchestratorTools!
  const h = a.claude.last!
  await a.mgr.inputs.send(s.id, 'hello')
  h.emitContext(150_000, 200_000)
  h.emitEvent({ type: 'state_change', sessionId: s.id, state: 'working' })
  expect(tools.compactSelf!(undefined, STEP).text).toMatch(/with your `then`/)
  if (until !== 'asked') {
    h.finishTurn()
    expect(h.sent).toEqual(['hello', '/compact'])
  }
  if (until === 'compacted') {
    // The compact turn: the tool starts it and reports the compaction; it is still running when the host swaps
    h.emitEvent({ type: 'state_change', sessionId: s.id, state: 'working' })
    h.emitEvent({ type: 'compaction', sessionId: s.id, failed: false })
  }
  return { id: s.id, h }
}

const lastHandle = (h: ReturnType<typeof host>): FakeHandle => {
  const last = h.claude.last
  if (!last) throw new Error('the host started no session process')
  return last
}
const stepsSentTo = (h: FakeHandle) => h.sent.filter((t) => t.includes(STEP))

describe('compact_self then across a host swap (#2024)', () => {
  it('sends the step once from the new host when the compaction was reported before the swap, and the leaving host sends nothing', async () => {
    const a = host()
    const { id, h } = await asking(a, 'compacted')
    await a.mgr.tenure.detachAll()
    // The kept compact turn ends after the old host let go: it must not act on it
    h.finishTurn()
    await settle()
    expect(stepsSentTo(h)).toEqual([])

    const b = host(new Set([id]))
    await b.mgr.tenure.adoptKept([{ sessionId: id, tool: 'claude', process: new FakeProcess() }])
    const next = lastHandle(b)
    // The adopted process is still in the compact turn: the step is not put into it, and follows its end
    await settle()
    expect(stepsSentTo(next)).toEqual([])
    next.finishTurn()
    await settle()
    await expect.poll(() => stepsSentTo(next)).toHaveLength(1)
    expect(next.origins[next.sent.findIndex((t) => t.includes(STEP))]).toEqual({ kind: 'channel', server: 'centralu' })
    expect(next.sent.find((t) => t.includes(STEP))).toMatch(/The compaction you asked for with compact_self is done/)
    expect(events.filter((e) => e.type === 'notice' && e.sessionId === id && e.text === 'Centralu sent the agent its next step after the compaction')).toHaveLength(1)
    // Nothing is left to send twice: a host that starts again finds no step
    expect(store.settings.appSetting(`compact_then:${id}`)).toBeNull()
    const c = host(new Set([id]))
    await c.mgr.tenure.adoptKept([{ sessionId: id, tool: 'claude', process: new FakeProcess() }])
    expect(stepsSentTo(lastHandle(c))).toEqual([])
    expect(stepsSentTo(next)).toHaveLength(1)
  })

  it('tells a kept process that is in a turn, quietly and with the text of its step, when the swap came before the compaction was known done', async () => {
    for (const until of ['asked', 'sent'] as const) {
      const a = host()
      const { id } = await asking(a, until)
      await a.mgr.tenure.detachAll()
      const b = host(new Set([id]))
      await b.mgr.tenure.adoptKept([{ sessionId: id, tool: 'claude', process: new FakeProcess() }])
      const next = lastHandle(b)
      expect(stepsSentTo(next), until).toEqual([])
      expect(next.nudges, until).toEqual([expect.stringContaining(STEP)])
      expect(next.nudges[0], until).toMatch(/changed hosts/)
      expect(events.some((e) => e.type === 'notice' && e.sessionId === id && /changed hosts/.test(e.text)), until).toBe(true)
      expect(store.settings.appSetting(`compact_then:${id}`), until).toBeNull()
    }
  })

  it('wakes a session with no process for the step after a restart that has no keeper, when the compaction was reported', async () => {
    const a = host()
    const { id } = await asking(a, 'compacted')
    await a.mgr.tenure.detachAll()
    // No kept process: the host after it starts the session's tool anew
    const b = host()
    b.mgr.startSelfCompaction()
    await expect.poll(() => (b.claude.last ? stepsSentTo(b.claude.last).length : 0)).toBe(1)
    expect(store.settings.appSetting(`compact_then:${id}`)).toBeNull()
  })

  it('warns the person through the mailbox hook when a session passes 6 cycles in an hour, on the sixth step that goes before it', async () => {
    const warned: [string, number][] = []
    const a = host()
    a.mgr.mail.useMail({ sessionGone: () => undefined, sessionChanged: () => undefined, compactCycles: (id, count) => void warned.push([id, count]) })
    const { id, h } = await asking(a, 'compacted')
    // Six cycles went in the hour before this one
    const now = Date.now()
    store.settings.setAppSetting(`compact_cycles:${id}`, JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => now - n * 60_000)))
    h.finishTurn()
    await settle()
    await expect.poll(() => warned).toEqual([[id, 7]])
    expect(stepsSentTo(h)).toHaveLength(1)
  })

  it('wakes a session with no process with a turn that carries its step, when the restart came before the compaction was known done', async () => {
    for (const until of ['asked', 'sent'] as const) {
      const a = host()
      const { id } = await asking(a, until)
      await a.mgr.tenure.detachAll()
      // The restarted host has no process for it: the note is a turn that wakes it, not a note that waits in the store for someone to type
      const b = host()
      b.mgr.startSelfCompaction()
      await expect.poll(() => (b.claude.last ? b.claude.last.sent.length : 0)).toBe(1)
      const woken = lastHandle(b)
      expect(woken.sent[0], until).toContain(STEP)
      expect(woken.sent[0], until).toMatch(/changed hosts/)
      expect(woken.origins[0], until).toEqual({ kind: 'channel', server: 'centralu' })
      expect(store.settings.appSetting(`compact_notes:${id}`), until).toBeNull()
      expect(store.settings.appSetting(`compact_then:${id}`), until).toBeNull()
      expect(events.some((e) => e.type === 'notice' && e.sessionId === id && /changed hosts.*the agent was woken with its next step/.test(e.text)), until).toBe(true)
    }
  })
})

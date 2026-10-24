import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { DEFAULT_AUTO_COMPACT, nudgeShares } from '@cc/protocol'
import { managerWorld, projectDirs } from './manager.test-helpers.js'
import { ContextNudges, type ContextNudgesHost } from './context-nudges.js'

/**
 * Telling a growing session to call compact_self (#1492). The first part reads the rule on a fake host; the second runs it
 * through a real session manager and a fake tool.
 */

const WINDOW = 1_000_000

function world(over: { window?: number | null; setting?: Partial<typeof DEFAULT_AUTO_COMPACT> } = {}) {
  const session = { id: 's1', tool: 'claude', state: 'working', live: true, context: { used: 0, window: WINDOW, exactness: 'exact' } } as SessionInfo
  const told: string[] = []
  const notices: string[] = []
  const state = {
    setting: { ...DEFAULT_AUTO_COMPACT, ...over.setting },
    modelWindow: over.window === undefined ? WINDOW : over.window,
    tool: true,
    takes: true,
    throws: false,
    /** When set, the tool answers later (Codex's steer): the test settles each note */
    answers: null as null | ((ok: boolean) => void)[],
  }
  const host: ContextNudgesHost = {
    session: () => session,
    window: () => state.modelWindow,
    setting: () => state.setting,
    hasCompactTool: () => state.tool,
    nudge: (_id, text) => {
      if (state.throws) throw new Error('closed')
      if (!state.takes) return false
      if (state.answers) {
        return new Promise<boolean>((resolve) =>
          state.answers?.push((ok) => {
            if (ok) told.push(text)
            resolve(ok)
          }),
        )
      }
      told.push(text)
      return true
    },
    notice: (_id, text) => void notices.push(text),
  }
  const n = new ContextNudges(host)
  const emit = (e: NormalizedEvent) => n.observe(e)
  /** One model request of the session's own conversation, as the stream reports it: `size` tokens of input in all */
  const request = (size: number, agent?: string) =>
    emit({
      type: 'usage_update',
      sessionId: 's1',
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      request: { inputTokens: 2_000, cacheReadTokens: size - 12_000, cacheCreationTokens: 10_000, ...(agent ? { agent } : {}) },
    })
  return { n, state, told, notices, emit, request, session }
}

describe('telling a growing session to call compact_self (#1492)', () => {
  it('tells it once past 30% in the middle of a turn, with its size, and again at 10 points below the share the tool compacts at', () => {
    const w = world()
    w.request(250_000)
    expect(w.told).toEqual([])
    w.request(310_000)
    expect(w.told).toHaveLength(1)
    expect(w.told[0]).toMatch(/about 31% full \(310k of 1000k tokens\)/)
    expect(w.told[0]).toMatch(/call compact_self/)
    // Once: more requests under the second share say nothing
    w.request(330_000)
    w.request(480_000)
    expect(w.told).toHaveLength(1)
    // 50% = 60% − 10 points
    w.request(505_000)
    expect(w.told).toHaveLength(2)
    expect(w.told[1]).toMatch(/about 51% full/)
    expect(w.told[1]).toMatch(/compacts it by itself in the middle of work at 60%/)
    w.request(590_000)
    expect(w.told).toHaveLength(2)
    expect(w.notices).toHaveLength(2)
  })

  it('starts again after a compaction, whoever made it: nothing until 30% is crossed again, then once more', () => {
    const w = world()
    w.request(320_000)
    w.request(520_000)
    expect(w.told).toHaveLength(2)
    w.emit({ type: 'compaction', sessionId: 's1', failed: false, before: 520_000, after: 20_000 })
    w.request(120_000)
    w.request(290_000)
    expect(w.told).toHaveLength(2)
    w.request(315_000)
    expect(w.told).toHaveLength(3)
    w.request(330_000)
    expect(w.told).toHaveLength(3)
    // A fresh conversation (/clear) is a new cycle too
    w.emit({ type: 'conversation_reset', sessionId: 's1' })
    w.request(310_000)
    expect(w.told).toHaveLength(4)
  })

  it('does not start again after a compaction that failed', () => {
    const w = world()
    w.request(320_000)
    w.emit({ type: 'compaction', sessionId: 's1', failed: true, reason: 'Not enough messages to compact.' })
    w.request(330_000)
    expect(w.told).toHaveLength(1)
  })

  it('says it once when one request is over both shares', () => {
    const w = world()
    w.request(560_000)
    expect(w.told).toHaveLength(1)
    expect(w.told[0]).toMatch(/compacts it by itself/)
    w.request(570_000)
    expect(w.told).toHaveLength(1)
  })

  it('never tells a share at or above the share the tool compacts at, and keeps the second below it', () => {
    // The tool compacts at 25%: the first share (30%) is never told, the tool compacts first; the second follows it, 10 points below
    const w = world({ window: 500_000, setting: { share: 0.25 } })
    expect(nudgeShares({ share: 0.25, nudgeFirst: 0.3, nudgeSecond: null })).toEqual({ first: 0.3, second: 0.15 })
    w.request(90_000)
    expect(w.told).toEqual([])
    w.request(105_000)
    expect(w.told).toHaveLength(1)
    // Past the first share too: still the one note, which was the second share's
    w.request(160_000)
    expect(w.told).toHaveLength(1)

    // A second share chosen above the tool's own is held below it
    expect(nudgeShares({ share: 0.5, nudgeFirst: 0.3, nudgeSecond: 0.8 }).second).toBe(0.45)
    expect(nudgeShares({ share: 0.6, nudgeFirst: 0.3, nudgeSecond: null }).second).toBe(0.5)
    expect(nudgeShares({ share: 0.95, nudgeFirst: 0.3, nudgeSecond: null }).second).toBe(0.85)
  })

  it('follows a chosen first share and second share', () => {
    const w = world({ setting: { nudgeFirst: 0.4, nudgeSecond: 0.55 } })
    w.request(350_000)
    expect(w.told).toEqual([])
    w.request(410_000)
    expect(w.told).toHaveLength(1)
    w.request(530_000)
    expect(w.told).toHaveLength(1)
    w.request(560_000)
    expect(w.told).toHaveLength(2)
  })

  it('says nothing under the compaction floor, with the notices off, with Centralu’s control off, or to a session without the tool', () => {
    // 30% of a 200k window is 60k: compact_self would refuse that; the first notice waits for the floor, where it is over both shares
    const small = world({ window: 200_000 })
    small.request(70_000)
    expect(small.told).toEqual([])
    small.request(105_000)
    expect(small.told).toHaveLength(1)

    for (const setting of [{ nudge: false }, { controlled: false }]) {
      const w = world({ setting })
      w.request(400_000)
      expect(w.told).toEqual([])
    }
    const noTool = world()
    noTool.state.tool = false
    noTool.request(400_000)
    expect(noTool.told).toEqual([])

    // The window not known yet (no reading, no model window): the share cannot be told
    const unknown = world({ window: null })
    unknown.session.context = null
    unknown.request(400_000)
    expect(unknown.told).toEqual([])
  })

  it('does not count a subagent’s request: it has a prompt of its own', () => {
    const w = world()
    w.request(400_000, 'toolu_1')
    expect(w.told).toEqual([])
  })

  it('keeps a note the tool does not take now, and tells it with a later request, once', () => {
    const w = world()
    w.state.takes = false
    w.request(320_000)
    expect(w.told).toEqual([])
    expect(w.notices).toEqual([])
    w.state.takes = true
    w.request(325_000)
    expect(w.told).toHaveLength(1)
    expect(w.told[0]).toMatch(/about 33% full/)
    w.request(330_000)
    expect(w.told).toHaveLength(1)
  })

  it('holds a note the tool refuses when it answers later (a steer into a turn that has ended), and tells it with a later request, once (#1504 review)', async () => {
    const w = world()
    w.state.answers = []
    w.request(320_000)
    expect(w.state.answers).toHaveLength(1)
    // More requests while the answer is awaited send nothing more
    w.request(325_000)
    expect(w.state.answers).toHaveLength(1)
    w.state.answers[0]?.(false)
    await Promise.resolve()
    await Promise.resolve()
    // Refused: not told, no notice, the share is still owed
    expect(w.told).toEqual([])
    expect(w.notices).toEqual([])
    // The next turn's first request carries it
    w.request(330_000)
    expect(w.state.answers).toHaveLength(2)
    w.state.answers[1]?.(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(w.told).toHaveLength(1)
    expect(w.told[0]).toMatch(/about 33% full/)
    expect(w.notices).toHaveLength(1)
    w.request(340_000)
    expect(w.state.answers).toHaveLength(2)
  })

  it('does not repeat a note whose send failed with every request', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = world()
    w.state.throws = true
    w.request(320_000)
    w.request(325_000)
    w.state.throws = false
    w.request(330_000)
    expect(w.told).toEqual([])
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })

  it('forgets a deleted session, and ignores events after stop()', () => {
    const w = world()
    w.request(320_000)
    w.emit({ type: 'session_deleted', sessionId: 's1' })
    w.request(330_000)
    expect(w.told).toHaveLength(2)
    w.n.stop()
    w.emit({ type: 'compaction', sessionId: 's1', failed: false })
    w.request(530_000)
    expect(w.told).toHaveLength(2)
  })
})

describe('on the session manager (#1492)', () => {
  const dir = projectDirs()
  let world: ReturnType<typeof managerWorld>

  beforeEach(() => {
    world = managerWorld()
  })
  afterEach(async () => {
    await world.mgr.disposeAll()
    world.store.close()
  })

  async function session(window = 1_000_000) {
    const { rpc, mgr, adapter } = world
    const p = (await rpc('projects.add', { path: dir('nudge-') })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: dir('nudge-cwd-'), tool: 'claude', permissionPreset: 'normal' })) as { id: string }
    const h = adapter.last!
    await mgr.send(s.id, 'hello')
    // The reading of the turn before gives the window; the turn then grows past the share on its own
    h.emitContext(20_000, window)
    h.finishTurn()
    return { id: s.id, h }
  }
  const request = (h: { emitEvent(e: NormalizedEvent): void }, id: string, size: number) =>
    h.emitEvent({
      type: 'usage_update',
      sessionId: id,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      request: { inputTokens: 1_000, cacheReadTokens: size - 1_000, cacheCreationTokens: 0 },
    })

  it('hands a session past 30% in one turn one quiet note, and a second at 50%, with no turn and no message of its own', async () => {
    const { id, h } = await session()
    h.emitEvent({ type: 'state_change', sessionId: id, state: 'working' })
    request(h, id, 200_000)
    expect(h.nudges).toEqual([])
    world.events.length = 0
    request(h, id, 330_000)
    expect(h.nudges).toHaveLength(1)
    expect(h.nudges[0]).toMatch(/about 33% full/)
    // Quiet: nothing was sent as a message, so no turn starts and none is interrupted; the conversation says what was told
    expect(h.sent).toEqual(['hello'])
    expect(world.events).toContainEqual(expect.objectContaining({ type: 'notice', sessionId: id, from: 'Centralu', text: expect.stringContaining('33% full') }))
    request(h, id, 400_000)
    request(h, id, 520_000)
    expect(h.nudges).toHaveLength(2)
    expect(h.nudges[1]).toMatch(/at 60%/)
    // The agent compacts (any way): the next cycle tells the first share again
    h.emitEvent({ type: 'compaction', sessionId: id, failed: false })
    request(h, id, 330_000)
    expect(h.nudges).toHaveLength(3)
  })

  it('says nothing with the notices off, and takes the shares from the preferences', async () => {
    const { id, h } = await session()
    world.mgr.setUiPreferences({ autoCompact: { nudge: false } })
    request(h, id, 400_000)
    expect(h.nudges).toEqual([])
    world.mgr.setUiPreferences({ autoCompact: { nudge: true, nudgeFirst: 0.5 } })
    request(h, id, 400_000)
    expect(h.nudges).toEqual([])
    request(h, id, 510_000)
    expect(h.nudges).toHaveLength(1)
  })
})

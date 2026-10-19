import { describe, expect, it } from 'vitest'
import { createMockPlatform } from './index.js'

/*
 * The mock keeps the context reading the way the host does (`nextContext`), so the list a reconnect reads back shows
 * the gauge the window showed live: a turn-end reading stays (#48), a fresh conversation empties it (#304), and a
 * compaction that reports its size moves it there (#1282).
 */
describe('the mock context gauge', () => {
  it('follows a turn-end reading, a compaction with a size, and a fresh conversation', async () => {
    const mock = createMockPlatform()
    try {
      const p = await mock.projects.add('/tmp/context-gauge')
      const s = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: p.defaultTool, permissionPreset: 'normal' })
      const context = async () => (await mock.agents.listSessions()).find((x) => x.id === s.id)!.context

      mock.emit({ type: 'compaction', sessionId: s.id, failed: false, before: 964_000, after: 8_800 })
      expect(await context()).toBeNull()

      mock.emit({ type: 'context_update', sessionId: s.id, used: 964_000, window: 1_000_000, exactness: 'exact' })
      mock.emit({ type: 'compaction', sessionId: s.id, failed: true, reason: 'Not enough messages to compact.' })
      expect(await context()).toEqual({ used: 964_000, window: 1_000_000, exactness: 'exact' })

      mock.emit({ type: 'compaction', sessionId: s.id, failed: false, before: 964_000, after: 8_800 })
      expect(await context()).toEqual({ used: 8_800, window: 1_000_000, exactness: 'estimate' })

      mock.emit({ type: 'conversation_reset', sessionId: s.id, trigger: 'clear' })
      expect(await context()).toBeNull()
    } finally {
      await mock.dispose()
    }
  })
})

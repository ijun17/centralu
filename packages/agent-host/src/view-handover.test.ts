import { describe, expect, it } from 'vitest'
import { recordViewHandover, restoreViewHandover, VIEW_HANDOVER_KEY, VIEW_HANDOVER_MAX_AGE_MS, type HandoverSettings } from './view-handover.js'
import { OriginPorts } from './views/origin-ports.js'
import { ViewHost, type AppRef, type ViewSource } from './views/view-host.js'
import { VIEW_MIME_TYPE } from './views/view-document.js'

/**
 * The record a planned hand-over leaves for the next host (#280 step 4). The seam with a real
 * runtime, a conversation's views and the RPC door is covered by inline-views.test.ts ("a planned
 * hand-over to the next host"); the address surviving behind a front door by view-host.test.ts.
 */

const NOTES: AppRef = { projectId: 'p1', appId: 'notes' }

function settings(): HandoverSettings & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    appSetting: (k) => values.get(k) ?? null,
    setAppSetting: (k, v) => void values.set(k, v),
    deleteAppSetting: (k) => void values.delete(k),
  }
}

function host(): ViewHost {
  const source: ViewSource = {
    readResource: async (_a, uri) => ({ contents: [{ uri, mimeType: VIEW_MIME_TYPE, text: 'x' }] }),
    retain: () => () => {},
  }
  return new ViewHost({
    secret: 'view-handover-test-secret-0123456789abcdef',
    allowedOrigins: ['http://127.0.0.1:5174'],
    source,
    ports: new OriginPorts({ load: () => null, save: () => {} }, { log: () => {} }),
    hostPort: () => 1,
    log: () => {},
  })
}

describe('the view hand-over record', () => {
  it('the next host opens the recorded views under the same ids, and deletes the record once read', () => {
    const s = settings()
    const first = host()
    const id = first.open(NOTES, 'ui://notes/board').instanceId
    expect(recordViewHandover(s, first, null, 1_000)).toBe(1)

    const next = host()
    expect(restoreViewHandover(s, next, null, 1_000 + 5_000)).toEqual({ restored: 1, skipped: 0 })
    expect(next.describe(id)).toEqual({ app: NOTES, uri: 'ui://notes/board' })
    expect(s.values.has(VIEW_HANDOVER_KEY)).toBe(false)
    // A second start finds nothing to reopen
    expect(restoreViewHandover(s, host(), null, 1_000 + 6_000)).toEqual({ restored: 0, skipped: 0 })
  })

  it('a record older than ten minutes, or from the future, reopens nothing and is deleted all the same', () => {
    for (const age of [VIEW_HANDOVER_MAX_AGE_MS + 1, -60_000]) {
      const s = settings()
      const first = host()
      const id = first.open(NOTES, 'ui://notes/board').instanceId
      recordViewHandover(s, first, null, 1_000_000)
      const next = host()
      expect(restoreViewHandover(s, next, null, 1_000_000 + age)).toEqual({ restored: 0, skipped: 1 })
      expect(next.describe(id)).toBeNull()
      expect(s.values.has(VIEW_HANDOVER_KEY)).toBe(false)
    }
  })

  it('a host with no open view leaves no record, and clears one an earlier host left', () => {
    const s = settings()
    s.values.set(VIEW_HANDOVER_KEY, JSON.stringify({ at: 1, views: [{ id: 'a'.repeat(22), app: NOTES, uri: 'ui://notes/board' }] }))
    expect(recordViewHandover(s, host(), null, 2)).toBe(0)
    expect(s.values.has(VIEW_HANDOVER_KEY)).toBe(false)
  })

  it('an unreadable record reopens nothing and is deleted', () => {
    const s = settings()
    s.values.set(VIEW_HANDOVER_KEY, '{not json')
    expect(restoreViewHandover(s, host(), null, 1)).toEqual({ restored: 0, skipped: 0 })
    expect(s.values.has(VIEW_HANDOVER_KEY)).toBe(false)
  })
})

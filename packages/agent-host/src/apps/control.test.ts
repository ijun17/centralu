import { describe, expect, it } from 'vitest'
import type { ControlDoc, NormalizedEvent } from '@cc/protocol'
import type { HostAppContext } from './contract.js'
import { controlHostApp } from './control.js'

/**
 * Declarative watches (#80's checkpoint v1) — observation is the physical mechanism, the rule is this
 * app's opinion.
 * The contract: a hit produces a high-priority notification, no watches means zero cost, and a
 * session filter applies to only that session.
 */

function fakeCtx(doc: ControlDoc | null) {
  const kv = new Map<string, unknown>()
  if (doc) kv.set('doc', doc)
  let changed = 0
  const ctx: HostAppContext = {
    kv: {
      get: <T,>(k: string) => (kv.get(k) as T) ?? null,
      set: (k, v) => void kv.set(k, v),
    },
    sessionSummary: (id) => (id === 's1' ? { name: '작업 세션', state: 'working', projectId: 'p1' } : null),
    emitChanged: () => changed++,
    sessions: {
      createCoordinator: async () => {
        throw new Error('감시 테스트에서 조율자를 만들 일은 없다')
      },
    },
  }
  return { ctx, kv, changedCount: () => changed }
}

const toolCall = (sessionId: string, title: string, paths: string[] = []): NormalizedEvent =>
  ({ type: 'tool_call', sessionId, callId: 'c1', summary: { tool: 'Bash', title, readOnly: false, paths } }) as NormalizedEvent

describe('control app watches (#80)', () => {
  it('a pattern hit produces a high-priority notification carrying a session link', () => {
    const { ctx, kv, changedCount } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'git commit' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit -m "x"'))

    const notifies = (kv.get('doc') as ControlDoc).notifies ?? []
    expect(notifies).toHaveLength(1)
    expect(notifies[0]).toMatchObject({ sessionId: 's1', priority: 'high' })
    expect(notifies[0]!.text).toContain('git commit')
    expect(notifies[0]!.text).toContain('작업 세션')
    expect(changedCount()).toBe(1)
  })

  it('paths are matched too — a file watch ("call me if store.ts is touched") works as intended', () => {
    const { ctx, kv } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'store.ts' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'Edit', ['packages/ui/src/store/store.ts']))

    expect((kv.get('doc') as ControlDoc).notifies).toHaveLength(1)
  })

  it('a session filter restricts it to only that session', () => {
    const { ctx, kv } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'commit', sessionId: 's2' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit'))

    expect((kv.get('doc') as ControlDoc).notifies).toHaveLength(0)
  })

  it('writes nothing when there are no watches — since this hook runs on every tool call, it must cost nothing', () => {
    const { ctx, kv, changedCount } = fakeCtx({ notifies: [] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit'))

    expect(kv.get('doc')).toEqual({ notifies: [] })
    expect(changedCount()).toBe(0)
  })

  it('ignores an event that is not a tool call', () => {
    const { ctx, changedCount } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'commit' }] })

    controlHostApp.observe!(ctx, { type: 'turn_complete', sessionId: 's1' } as NormalizedEvent)

    expect(changedCount()).toBe(0)
  })
})

/**
 * A document with no notifies field (surfaced by M4 P-5).
 *
 * This document's shape had one separate definition each in the host and the UI, and they disagreed:
 * the host wrote `notifies` as required, the UI as optional. What actually ends up stored is the
 * UI's shape — when there is no document yet (a fresh install, before a notification has ever fired),
 * the UI writes something like `{ ...(doc ?? {}), metrics }`, **with no notifies field at all.** That
 * happens after a single one-line reply from the rail (the inline-reply counter), or after setting a
 * foreman tool or a watch in settings. The host received that document and crashed on
 * `doc.notifies.push`.
 */
describe('a document with no notifies field — a document the UI wrote first', () => {
  it('control_notify still adds a notification even to a document that has only the inline-reply counter', async () => {
    const { ctx, kv } = fakeCtx({ metrics: { inlineReplies: 1 } })

    const r = await controlHostApp.tools!.run(ctx, 'control_notify', { text: '사람이 봐야 합니다' }, {
      sessionId: 'orc',
      profile: 'orchestrator',
    })

    expect(r.isError).toBeFalsy()
    const doc = kv.get('doc') as ControlDoc
    expect(doc.notifies).toHaveLength(1)
    expect(doc.metrics).toEqual({ inlineReplies: 1 }) // someone else's field is left untouched
  })

  it('a notification still fires on a watch hit even in a document that has only watches', () => {
    const { ctx, kv, changedCount } = fakeCtx({ watches: [{ id: 'w1', pattern: 'git commit' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit -m "x"'))

    expect((kv.get('doc') as ControlDoc).notifies).toHaveLength(1)
    expect(changedCount()).toBe(1)
  })
})

/**
 * Whatever arrives while waiting on the foreman is preserved (#178). Stored as JSON, like the
 * manager's kv, and re-parsed on every read — a kv that returns the same object would make an old
 * copy indistinguishable from the current document.
 */
describe('the race between creating a task and writing the document (#178)', () => {
  it('a notification, a dismissal, and another task that all arrive while waiting on the foreman are not overwritten', async () => {
    const kv = new Map<string, string>()
    kv.set('doc', JSON.stringify({ notifies: [{ id: 'old', text: 'old notice', ts: 1 }] } satisfies ControlDoc))
    const gates: (() => void)[] = []
    let made = 0
    const ctx: HostAppContext = {
      kv: {
        get: <T,>(k: string) => (kv.has(k) ? (JSON.parse(kv.get(k)!) as T) : null),
        set: (k, v) => void kv.set(k, JSON.stringify(v)),
      },
      sessionSummary: (id) => (id === 's1' ? { name: '작업 세션', state: 'working', projectId: 'p1' } : null),
      emitChanged: () => {},
      sessions: {
        // A Codex foreman waits until its app-server is ready — the test controls that window
        createCoordinator: () => new Promise((done) => gates.push(() => done({ id: `coord-${++made}`, name: '반장' }))),
      },
    }
    const orch = { sessionId: 'orch', profile: 'orchestrator' as const }
    const run = controlHostApp.tools!.run
    const task = (title: string) => run(ctx, 'control_create_task', { title, goal: '', memberSessionIds: ['s1'] }, orch)

    const a = task('A')
    const b = task('B')
    await run(ctx, 'control_notify', { text: 'blocked on CI', sessionId: 's1' }, { sessionId: 's1', profile: 'manager' })
    // A person dismissed the old notification from the rail (apps.setState replaces the whole document)
    const now = ctx.kv.get<ControlDoc>('doc')!
    ctx.kv.set('doc', { ...now, notifies: (now.notifies ?? []).filter((n) => n.id !== 'old') })
    for (const open of gates.splice(0)) open()
    await Promise.all([a, b])

    const doc = ctx.kv.get<ControlDoc>('doc')!
    expect((doc.tasks ?? []).map((t) => t.title).sort()).toEqual(['A', 'B'])
    expect((doc.notifies ?? []).map((n) => n.text)).toEqual(['blocked on CI'])
  })
})

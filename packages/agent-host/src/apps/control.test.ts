import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { HostAppContext } from './contract.js'
import { controlHostApp, type ControlDoc } from './control.js'

/**
 * 선언형 감시 (#80 체크포인트 v1) — 관찰은 물리, 규칙은 이 앱의 의견.
 * 계약: 걸리면 high 알림, 감시가 없으면 공짜, 세션 필터는 그 세션만.
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
  }
  return { ctx, kv, changedCount: () => changed }
}

const toolCall = (sessionId: string, title: string, paths: string[] = []): NormalizedEvent =>
  ({ type: 'tool_call', sessionId, callId: 'c1', summary: { tool: 'Bash', title, readOnly: false, paths } }) as NormalizedEvent

describe('관제 앱 감시 (#80)', () => {
  it('패턴이 걸리면 high 알림이 서고 세션 링크가 실린다', () => {
    const { ctx, kv, changedCount } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'git commit' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit -m "x"'))

    const doc = kv.get('doc') as ControlDoc
    expect(doc.notifies).toHaveLength(1)
    expect(doc.notifies[0]).toMatchObject({ sessionId: 's1', priority: 'high' })
    expect(doc.notifies[0]!.text).toContain('git commit')
    expect(doc.notifies[0]!.text).toContain('작업 세션')
    expect(changedCount()).toBe(1)
  })

  it('경로도 대조 대상이다 — 파일 감시("store.ts 건드리면 불러")가 성립한다', () => {
    const { ctx, kv } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'store.ts' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'Edit', ['packages/ui/src/store/store.ts']))

    expect((kv.get('doc') as ControlDoc).notifies).toHaveLength(1)
  })

  it('세션 필터가 있으면 그 세션만 본다', () => {
    const { ctx, kv } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'commit', sessionId: 's2' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit'))

    expect((kv.get('doc') as ControlDoc).notifies).toHaveLength(0)
  })

  it('감시가 없으면 아무것도 쓰지 않는다 — 이 훅은 모든 툴 호출에 도니 공짜여야 한다', () => {
    const { ctx, kv, changedCount } = fakeCtx({ notifies: [] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit'))

    expect(kv.get('doc')).toEqual({ notifies: [] })
    expect(changedCount()).toBe(0)
  })

  it('툴 호출이 아닌 이벤트는 무시한다', () => {
    const { ctx, changedCount } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'commit' }] })

    controlHostApp.observe!(ctx, { type: 'turn_complete', sessionId: 's1' } as NormalizedEvent)

    expect(changedCount()).toBe(0)
  })
})

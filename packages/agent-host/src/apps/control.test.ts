import { describe, expect, it } from 'vitest'
import type { ControlDoc, NormalizedEvent } from '@cc/protocol'
import type { HostAppContext } from './contract.js'
import { controlHostApp } from './control.js'

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

describe('관제 앱 감시 (#80)', () => {
  it('패턴이 걸리면 high 알림이 서고 세션 링크가 실린다', () => {
    const { ctx, kv, changedCount } = fakeCtx({ notifies: [], watches: [{ id: 'w1', pattern: 'git commit' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit -m "x"'))

    const notifies = (kv.get('doc') as ControlDoc).notifies ?? []
    expect(notifies).toHaveLength(1)
    expect(notifies[0]).toMatchObject({ sessionId: 's1', priority: 'high' })
    expect(notifies[0]!.text).toContain('git commit')
    expect(notifies[0]!.text).toContain('작업 세션')
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

/**
 * 알림 칸이 없는 문서 (M4 P-5에서 드러남).
 *
 * 이 문서의 모양은 호스트와 UI에 한 벌씩 있었고, 둘이 달랐다: 호스트는 `notifies`를 필수로,
 * UI는 선택으로 적었다. 실제로 저장되는 것은 UI 쪽 모양이다 — 문서가 아직 없을 때(새로 설치한
 * 뒤 알림이 한 번도 안 선 상태) UI는 `{ ...(doc ?? {}), metrics }`처럼 **알림 칸 없이** 쓴다.
 * 레일에서 한 줄 답을 한 번 하거나(판정 카운터), 설정에서 반장 도구나 감시를 정하면 그렇게 된다.
 * 호스트는 그 문서를 받아 `doc.notifies.push`에서 넘어졌다.
 */
describe('알림 칸이 없는 문서 — UI가 먼저 쓴 문서', () => {
  it('판정 카운터만 적힌 문서에도 control_notify가 알림을 올린다', async () => {
    const { ctx, kv } = fakeCtx({ metrics: { inlineReplies: 1 } })

    const r = await controlHostApp.tools!.run(ctx, 'control_notify', { text: '사람이 봐야 합니다' }, {
      sessionId: 'orc',
      profile: 'orchestrator',
    })

    expect(r.isError).toBeFalsy()
    const doc = kv.get('doc') as ControlDoc
    expect(doc.notifies).toHaveLength(1)
    expect(doc.metrics).toEqual({ inlineReplies: 1 }) // 남의 칸은 그대로다
  })

  it('감시만 적힌 문서에서도 감시가 걸리면 알림이 선다', () => {
    const { ctx, kv, changedCount } = fakeCtx({ watches: [{ id: 'w1', pattern: 'git commit' }] })

    controlHostApp.observe!(ctx, toolCall('s1', 'git commit -m "x"'))

    expect((kv.get('doc') as ControlDoc).notifies).toHaveLength(1)
    expect(changedCount()).toBe(1)
  })
})

/**
 * 반장을 기다리는 동안 들어온 것이 남는다 (#178). 매니저의 kv처럼 JSON으로 저장하고 읽을 때마다
 * 새로 푼다 — 같은 객체를 돌려주는 kv로는 옛 사본과 지금의 문서가 구별되지 않는다.
 */
describe('업무 만들기와 문서 쓰기의 경합 (#178)', () => {
  it('반장을 기다리는 동안 들어온 알림·지우기·다른 업무가 덮이지 않는다', async () => {
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
        // Codex 반장은 app-server가 준비될 때까지 기다린다 — 그 창을 시험이 쥔다
        createCoordinator: () => new Promise((done) => gates.push(() => done({ id: `coord-${++made}`, name: '반장' }))),
      },
    }
    const orch = { sessionId: 'orch', profile: 'orchestrator' as const }
    const run = controlHostApp.tools!.run
    const task = (title: string) => run(ctx, 'control_create_task', { title, goal: '', memberSessionIds: ['s1'] }, orch)

    const a = task('A')
    const b = task('B')
    await run(ctx, 'control_notify', { text: 'blocked on CI', sessionId: 's1' }, { sessionId: 's1', profile: 'manager' })
    // 사람이 레일에서 옛 알림을 지웠다 (apps.setState는 문서를 통째로 바꾼다)
    const now = ctx.kv.get<ControlDoc>('doc')!
    ctx.kv.set('doc', { ...now, notifies: (now.notifies ?? []).filter((n) => n.id !== 'old') })
    for (const open of gates.splice(0)) open()
    await Promise.all([a, b])

    const doc = ctx.kv.get<ControlDoc>('doc')!
    expect((doc.tasks ?? []).map((t) => t.title).sort()).toEqual(['A', 'B'])
    expect((doc.notifies ?? []).map((n) => n.text)).toEqual(['blocked on CI'])
  })
})

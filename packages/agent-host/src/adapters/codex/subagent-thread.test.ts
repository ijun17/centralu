import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * 코덱스의 서브에이전트는 **다른 스레드**다 (#98의 codex 쪽).
 *
 * multi_agent 기능은 codex에서 기본으로 켜져 있고(features/src/lib.rs: key "multi_agent",
 * Stage::Stable, default_enabled: true), 모델이 spawn_agent로 자식 스레드를 띄운다.
 * app-server는 스레드가 새로 생길 때마다 **초기화된 모든 연결**에 그 스레드의 리스너를
 * 붙인다 (app-server/src/lib.rs: thread_created_rx → try_attach_thread_listener(thread_id,
 * initialized_connection_ids)). 그 "새로 생긴 스레드"를 알리는 곳은 에이전트 스폰뿐이다
 * (core/src/agent/control/spawn.rs의 notify_thread_created). 그래서 우리 연결로 자식
 * 스레드의 알림이 threadId만 다르게 달고 온다 — 소스로 확인한 경로이고 실행으로는 아직
 * 재지 않았다.
 *
 * 우리 어댑터는 threadId를 보지 않았다. 자식의 도구 호출과 글은 부모의 대화로,
 * 자식의 turn/started는 스톱이 겨눌 턴으로, 자식의 turn/completed는 부모의 "끝났다"로
 * 들어간다.
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'parent-thread' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.requests.length = 0
})

async function session() {
  const events: NormalizedEvent[] = []
  const adapter = new CodexAdapter()
  const handle = await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
  return { handle, events, notify: (method: string, params: unknown) => state.handlers!.onNotification({ method, params }) }
}

const command = (threadId: string, id: string, cmd: string) => ({
  threadId,
  turnId: 'x',
  item: { type: 'commandExecution', id, command: cmd, status: 'inProgress' },
})

describe('codex 자식 스레드의 알림은 부모 세션의 대화가 아니다 (#98)', () => {
  it('자식의 도구 호출·글은 부모의 대화에 줄을 만들지 않는다', async () => {
    const { events, notify } = await session()
    notify('item/started', command('parent-thread', 'call_parent', 'git status'))
    notify('item/started', command('child-thread', 'call_child', 'rg boundaries'))
    notify('item/agentMessage/delta', { threadId: 'child-thread', turnId: 'x', itemId: 'm1', delta: 'child report' })
    notify('item/agentMessage/delta', { threadId: 'parent-thread', turnId: 'x', itemId: 'm2', delta: 'parent answer' })

    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { callId: string }).callId)).toEqual(['call_parent'])
    expect(events.filter((e) => e.type === 'message_delta').map((e) => (e as { text: string }).text)).toEqual(['parent answer'])
  })

  it('자식의 턴이 끝나도 부모는 끝나지 않는다 — 스톱은 부모의 턴을 겨눈다', async () => {
    const { handle, events, notify } = await session()
    handle.send('오래 걸리는 일')
    await tick()
    notify('turn/started', { threadId: 'parent-thread', turn: { id: 'turn-parent' } })
    notify('turn/started', { threadId: 'child-thread', turn: { id: 'turn-child' } })
    notify('turn/completed', { threadId: 'child-thread', turn: { id: 'turn-child', status: 'completed' } })

    expect(events.some((e) => e.type === 'turn_complete')).toBe(false)
    handle.interrupt()
    expect(state.requests.filter((r) => r.method === 'turn/interrupt').map((r) => r.params)).toEqual([
      { threadId: 'parent-thread', turnId: 'turn-parent' },
    ])
  })
})

import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * compact은 메시지가 아니라 함수다 (도그푸딩 지적).
 *
 * app-server 경로에는 CLI의 슬래시 처리기가 없어서, "/compact"를 turn/start로 보내면
 * 모델이 그 **글자를 읽는다** — 압축은 일어나지 않고, 화면은 보낸 것처럼 보인다.
 * 전용 RPC(thread/compact/start)로 가로채는지, 그리고 그 판정이 지나치게 넓지 않은지
 * (진짜 메시지를 삼키면 그게 새 버그다)를 요청 기록으로 본다.
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  /** 세션이 등록한 알림 콜백 — 테스트가 turn/completed를 흉내 낼 때 쓴다 */
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
  /** 여기 든 메서드는 실패한다 — compact 시작 실패 경로용 */
  failMethods: new Set<string>(),
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (state.failMethods.has(method)) return Promise.reject(new Error(`${method} failed (test)`))
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'skills/list') {
        return Promise.resolve({
          data: [{ skills: [{ name: 'deploy', description: '배포' }, { name: 'compact', description: '중복' }] }],
        })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const methods = () => state.requests.map((r) => r.method)
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.requests.length = 0
  state.failMethods.clear()
})

async function session(emit: (e: unknown) => void = () => {}) {
  const adapter = new CodexAdapter()
  const handle = await adapter.createSession(
    { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' },
    emit as Parameters<typeof adapter.createSession>[1],
  )
  return handle
}

describe('codex /compact — 함수로 실행된다', () => {
  it('/compact은 turn/start가 아니라 thread/compact/start로 간다', async () => {
    const h = await session()
    h.send('/compact')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('thread/compact/start')
    expect(methods()).not.toContain('turn/start')
    expect(state.requests.find((r) => r.method === 'thread/compact/start')?.params).toEqual({ threadId: 't1' })
  })

  it('둘레 공백은 관대하게 — " /compact "도 함수다', async () => {
    const h = await session()
    h.send('  /compact  ')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('thread/compact/start')
  })

  it('"/compact 어쩌고"는 메시지다 — 판정이 넓으면 진짜 말을 삼킨다', async () => {
    const h = await session()
    h.send('/compact 다음에 해줘')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('turn/start')
    expect(methods()).not.toContain('thread/compact/start')
  })

  it('자동완성 목록에 compact이 있다 — 쓸 수 있는데 안 보이는 명령은 목록의 거짓말이다', async () => {
    const h = await session()
    const cmds = await h.listCommands!()
    // skills/list가 같은 이름을 실어 와도 하나만 남는다
    expect(cmds.filter((c) => c.name === 'compact')).toHaveLength(1)
    expect(cmds.some((c) => c.name === 'deploy')).toBe(true)
    expect(cmds.some((c) => c.name === 'review')).toBe(true)
  })
})

/**
 * /review도 함수다 (review/start RPC — 실측: 결과는 agentMessage로 스트리밍).
 * compact과 다른 점 하나: **인자가 의미를 갖는다** — 있으면 그 지시대로(custom),
 * 없으면 codex CLI의 기본과 같은 "지금 바뀐 것들"(uncommittedChanges)이다.
 */
describe('codex /review — 함수로 실행된다', () => {
  it('인자 없으면 uncommittedChanges 리뷰다', async () => {
    const h = await session()
    h.send('/review')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('review/start')
    expect(methods()).not.toContain('turn/start')
    expect(state.requests.find((r) => r.method === 'review/start')?.params).toEqual({
      threadId: 't1',
      target: { type: 'uncommittedChanges' },
    })
  })

  it('인자가 있으면 그 지시대로 리뷰한다 (custom)', async () => {
    const h = await session()
    h.send('/review 보안 위주로 봐줘')
    await new Promise((r) => setTimeout(r, 0))
    expect(state.requests.find((r) => r.method === 'review/start')?.params).toEqual({
      threadId: 't1',
      target: { type: 'custom', instructions: '보안 위주로 봐줘' },
    })
  })

  it('"/reviewer 채용"은 메시지다 — 접두사가 닮았다고 삼키면 안 된다', async () => {
    const h = await session()
    h.send('/reviewer 채용 공고 써줘')
    await new Promise((r) => setTimeout(r, 0))
    expect(methods()).toContain('turn/start')
    expect(methods()).not.toContain('review/start')
  })
})

/**
 * compact이 도는 동안 turn/start로 들어간 입력을 codex(0.147.0)는 **성공을 답하며
 * 버린다** — 도그푸딩 실측(2026-09-02, MGH 세션): rollout에 설정 적용만 남고
 * user 메시지가 한 줄도 없었고, 에러도 오지 않아 화면에는 보낸 것처럼 남았다.
 * 상류도 compact/review 턴을 조종 불가로 분류한다 ("cannot steer a compact turn").
 * 그래서 어댑터가 그 동안의 메시지를 쌓았다가 턴이 끝나면 내보내는지를 본다.
 */
describe('codex compact/review 중 메시지 — 버리는 자리에 보내지 않는다', () => {
  it('compact 중에는 쌓고, 끝나면 한 턴으로 순서대로 나간다', async () => {
    const h = await session()
    h.send('/compact')
    await tick()
    h.send('첫 메시지')
    h.send('둘째 메시지')
    await tick()
    // 여기서 turn/start가 나갔다면 codex가 버렸을 것이다
    expect(methods()).not.toContain('turn/start')

    state.handlers!.onNotification({ method: 'turn/completed', params: {} })
    await tick()
    const turn = state.requests.find((r) => r.method === 'turn/start')
    expect(turn?.params?.input).toEqual([
      { type: 'text', text: '첫 메시지' },
      { type: 'text', text: '둘째 메시지' },
    ])
  })

  it('compact이 끝난 뒤의 메시지는 즉시 나간다 — 큐가 필요보다 오래 살면 안 된다', async () => {
    const h = await session()
    h.send('/compact')
    await tick()
    state.handlers!.onNotification({ method: 'turn/completed', params: {} })
    await tick()
    h.send('끝난 뒤 메시지')
    await tick()
    expect(state.requests.find((r) => r.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: '끝난 뒤 메시지' },
    ])
  })

  it('review 중에도 같다 — 상류가 조종 불가로 분류하는 건 둘 다다', async () => {
    const h = await session()
    h.send('/review')
    await tick()
    h.send('리뷰 중 메시지')
    await tick()
    expect(methods()).not.toContain('turn/start')
    state.handlers!.onNotification({ method: 'turn/completed', params: {} })
    await tick()
    expect(state.requests.find((r) => r.method === 'turn/start')?.params?.input).toEqual([
      { type: 'text', text: '리뷰 중 메시지' },
    ])
  })

  it('compact 시작이 실패하면 큐가 풀린다 — 잠긴 큐는 영원한 유실이다', async () => {
    state.failMethods.add('thread/compact/start')
    const events: { type: string }[] = []
    const h = await session((e) => events.push(e as { type: string }))
    h.send('/compact')
    h.send('같이 보낸 메시지')
    await tick()
    await tick()
    // 실패는 알려지고, 쌓였던 메시지는 그래도 나간다
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(
      state.requests.some(
        (r) => r.method === 'turn/start' && JSON.stringify(r.params?.input).includes('같이 보낸 메시지'),
      ),
    ).toBe(true)
  })

  it('배달 못 한 채 dispose되면 말한다 — 화면에는 이미 보낸 것으로 남아 있다', async () => {
    const events: { type: string; error?: { message: string } }[] = []
    const h = await session((e) => events.push(e as { type: string; error?: { message: string } }))
    h.send('/compact')
    await tick()
    h.send('유실 후보')
    await tick()
    await h.dispose()
    expect(events.some((e) => e.type === 'error' && /not delivered/.test(e.error?.message ?? ''))).toBe(true)
  })
})

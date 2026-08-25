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
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
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

beforeEach(() => {
  state.requests.length = 0
})

async function session() {
  const adapter = new CodexAdapter()
  const handle = await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
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

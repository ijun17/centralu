import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 앱이 스키마를 주고 부탁한 에이전트 (M4 D-1) — Codex는 스키마를 **턴마다** 받는다(`turn/start`의 `outputSchema`, 설치된
 * 0.153.4의 생성 타입 TurnStartParams). 한 턴이라도 빠지면 그 턴의 마지막 메시지는 스키마 밖의 글이 된다. 로그아웃
 * 상태라 실행으로는 재지 못했다 — 무엇을 보내는지만 본다(interrupt.test.ts와 같은 흉내 클라이언트).
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 0))
const turns = () => state.requests.filter((r) => r.method === 'turn/start').map((r) => r.params)

beforeEach(() => {
  state.requests.length = 0
})

describe('Codex — 스키마는 턴마다', () => {
  it('스키마를 받은 세션은 보내는 턴마다 outputSchema를 싣는다', async () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }
    const h = await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', outputSchema: schema }, () => {})
    h.send('first')
    await tick()
    h.send('second')
    await tick()
    expect(turns().map((p) => p?.outputSchema)).toEqual([schema, schema])
  })

  it('스키마가 없으면 싣지 않는다', async () => {
    const h = await new CodexAdapter().createSession({ sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    h.send('plain')
    await tick()
    expect(turns().map((p) => (p ? 'outputSchema' in p : null))).toEqual([false])
  })
})

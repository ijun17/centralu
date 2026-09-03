import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * 재개는 클로드처럼 — 사람 앞에서 기다리지 않는다 (도그푸딩: 같은 122MB 스레드가
 * CLI에선 3초, 우리 경로에선 13초+. thread/resume이 파일을 되읽는 비용은 codex의
 * 것이지만, 그 비용을 "Waking…" 앞에서 치르는 것은 우리의 선택이었다).
 *
 * 지키는 계약 셋:
 *  1. 큰 스레드는 3초 뒤 핸들이 먼저 나온다 — 메시지는 ready 큐에서 기다렸다 배달된다
 *  2. 잠금 오류는 3초 창 안에서 그대로 던진다 — "갈라서 이어가기" 갈림길 UI가 산다
 *  3. 배경 재개가 실패하면 조용히 잠들지 않는다 — adapter_crashed로 매니저가 걷는다
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  hang: new Set<string>(),
  fail: new Map<string, string>(),
  resolvers: new Map<string, (v: unknown) => void>(),
  rejecters: new Map<string, (e: Error) => void>(),
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      const failMsg = state.fail.get(method)
      if (failMsg) return Promise.reject(new Error(failMsg))
      if (state.hang.has(method)) {
        return new Promise((res, rej) => {
          state.resolvers.set(method, res)
          state.rejecters.set(method, rej)
        })
      }
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params?.threadId } })
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
  state.hang.clear()
  state.fail.clear()
  state.resolvers.clear()
  state.rejecters.clear()
})

describe('codex 지연 재개 — 클로드처럼', () => {
  it('큰 스레드는 3초 뒤 핸들이 먼저 나오고, 메시지는 큐에서 기다렸다 배달된다', { timeout: 10_000 }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const adapter = new CodexAdapter()

    const t0 = Date.now()
    const h = await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'big-thread' },
      (e) => events.push(e),
    )
    const waited = Date.now() - t0
    expect(waited).toBeGreaterThanOrEqual(2900) // 잠금 오류를 잡을 창
    expect(waited).toBeLessThan(6000) // 그 뒤로는 기다리지 않는다 — 이게 이 기능의 전부다
    expect(h.externalId).toBe('big-thread') // 재개는 id를 이미 안다 — 즉시 저장 가능해야 한다

    // 재개가 끝나기 전의 메시지는 큐에서 기다린다
    h.send('깨기 전에 보낸 말')
    await tick()
    expect(methods()).not.toContain('turn/start')

    // 재개가 끝나면 큐가 흐른다
    state.resolvers.get('thread/resume')!({ thread: { id: 'big-thread' } })
    await tick()
    await tick()
    const turn = state.requests.find((r) => r.method === 'turn/start')
    expect(turn?.params?.input).toEqual([{ type: 'text', text: '깨기 전에 보낸 말' }])
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('잠금 오류는 3초 창 안에서 그대로 던진다 — 갈림길 UI가 산다', async () => {
    state.fail.set('thread/resume', 'thread abc already has an active writer')
    const adapter = new CodexAdapter()
    await expect(
      adapter.createSession(
        { sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'locked' },
        () => {},
      ),
    ).rejects.toThrow(/already open elsewhere/)
  })

  it('배경 재개가 실패하면 adapter_crashed가 오른다 — 조용한 좀비를 만들지 않는다', { timeout: 10_000 }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const adapter = new CodexAdapter()
    await adapter.createSession(
      { sessionId: 's3', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'doomed' },
      (e) => events.push(e),
    )

    state.rejecters.get('thread/resume')!(new Error('rollout corrupted'))
    await tick()
    await tick()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        sessionId: 's3',
        error: expect.objectContaining({ code: 'adapter_crashed', message: expect.stringContaining('rollout corrupted') }),
      }),
    )
  })
})

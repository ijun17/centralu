import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 응답 길이(verbosity, #54)는 **thread config로만** 넘어간다.
 *
 * effort와 겉보기에 같은 설정인데 길이 다르다 — turn/start에는 verbosity 자리가 없다
 * (generated/v2/TurnStartParams.ts에 없음, 실측). 그래서 스레드를 띄우는 두 자리
 * (thread/start·thread/resume)에 실리는지를 본다. 여기 빠지면 화면에는 골라져 있는데
 * codex는 기본값으로 도는, 눈으로 못 잡는 종류의 유실이 된다.
 *
 * 클라이언트를 가짜로 갈아 끼우고 **요청 파라미터를 그대로 본다** — 이 계약의 전부가
 * "무엇을 보냈는가"라서, 보낸 것을 기록하는 것보다 나은 검사가 없다.
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') {
        return Promise.resolve({ thread: { id: 't1' } })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const paramsOf = (method: string) => state.requests.find((r) => r.method === method)?.params

beforeEach(() => {
  state.requests.length = 0
})

describe('codex 응답 길이(verbosity) 전달', () => {
  it('thread/start의 config.model_verbosity로 실린다', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', verbosity: 'low' },
      () => {},
    )
    expect(paramsOf('thread/start')?.config).toMatchObject({ model_verbosity: 'low' })
  })

  it('재개(thread/resume)에도 따라온다 — 잠들었다 깨면 풀리는 설정이면 안 된다', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', verbosity: 'high', resumeExternalId: 'ext-1' },
      () => {},
    )
    expect(paramsOf('thread/resume')?.config).toMatchObject({ model_verbosity: 'high' })
  })

  /** 응답 속도(service_tier)도 같은 배관이다 — 시작·재개 둘 다 */
  it('속도 티어가 thread/start와 thread/resume의 config.service_tier로 실린다', async () => {
    const a1 = new CodexAdapter()
    await a1.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', serviceTier: 'priority' }, () => {})
    expect(paramsOf('thread/start')?.config).toMatchObject({ service_tier: 'priority' })

    state.requests.length = 0
    const a2 = new CodexAdapter()
    await a2.createSession(
      { sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal', serviceTier: 'priority', resumeExternalId: 'ext-1' },
      () => {},
    )
    expect(paramsOf('thread/resume')?.config).toMatchObject({ service_tier: 'priority' })
  })

  it('안 고르면 service_tier 키 자체가 없다 — 속도의 기본값도 codex의 것이다', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const config = paramsOf('thread/start')?.config as Record<string, unknown>
    expect(config.service_tier).toBeUndefined()
  })

  /*
   * 예전 계약은 "안 고르면 config 자체를 안 보낸다"였다. #58이 한 자리를 바꿨다:
   * model_reasoning_summary는 우리가 켠다 — 이 스위치 없이는 추론 스트림이 한 건도
   * 안 와서, 배선한 기능이 존재하지 않는 것과 같아지기 때문이다 (실측). 그 외의
   * 기본값은 여전히 codex의 것이다: verbosity를 안 골랐으면 그 키는 없어야 한다.
   */
  it('안 고르면 verbosity 키를 보내지 않는다 — 추론 요약 스위치만 우리가 켠다', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const config = paramsOf('thread/start')?.config as Record<string, unknown>
    expect(config.model_reasoning_summary).toBe('auto')
    expect(config.model_verbosity).toBeUndefined()
  })

  /*
   * config는 오케스트레이터 블록도 쓴다. 스프레드 둘이 같은 키를 만들면 **뒤가 앞을
   * 통째로 덮는다** — 합쳐지는 게 아니다. 이 테스트가 없으면 verbosity를 더한 사람도,
   * 나중에 config에 세 번째 것을 더할 사람도 그 사실을 코드에서 읽을 수 없다.
   */
  it('오케스트레이터의 config와 한 덩어리로 합쳐진다 — 서로를 덮지 않는다', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession(
      {
        sessionId: 's1',
        cwd: '/tmp',
        permissionPreset: 'normal',
        verbosity: 'medium',
        orchestratorTools: {} as never,
        orchestratorBridge: { url: 'http://127.0.0.1:1', token: 't' },
      },
      () => {},
    )
    const config = paramsOf('thread/start')?.config as Record<string, unknown>
    expect(config.model_verbosity).toBe('medium')
    expect(config.mcp_servers).toBeDefined()
    expect(config.project_doc_max_bytes).toBe(0)
  })
})

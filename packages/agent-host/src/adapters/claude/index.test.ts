import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * CLI 프로세스가 조용히 사라지면 SDK 스트림은 예외 없이 **그냥 끝나기도** 한다.
 * 그때 어댑터가 아무 말도 안 올리면 화면은 영원히 '작업 중'이고 다음 말은 허공으로 간다.
 * 여기서는 SDK를 조종 가능한 가짜로 갈아 끼워 그 경계만 본다 —
 * 진짜 CLI를 띄우면 죽는 시점을 테스트가 정할 수 없다.
 */
const control = vi.hoisted(() => ({
  endStream: () => {},
  failStream: (_err: Error) => {},
  /** 만든 질의들, 만든 차례로 — close가 불렸는지와 사용량 창구가 어느 것인지를 본다 */
  queries: [] as { closed: boolean }[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const q = {
      closed: false,
      // eslint-disable-next-line require-yield -- 아무것도 내놓지 않고 끝나는 스트림이 바로 시험 대상이다
      async *[Symbol.asyncIterator]() {
        // 테스트가 시키면 예외 없이 끝나거나(프로세스가 사라진 모양) 던진다(SDK가 오류 result를 예외로 바꾼 모양)
        await new Promise<void>((resolve, reject) => {
          control.endStream = resolve
          control.failStream = reject
        })
      },
      interrupt: async () => {},
      close: () => {
        q.closed = true
      },
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
    control.queries.push(q)
    return q
  },
}))

const { ClaudeAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('claude 스트림이 예고 없이 끝날 때', () => {
  it('adapter_crashed를 올린다 — 세션이 working에 갇히지 않게 (codex의 onExit과 같은 신호)', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    control.endStream()
    await tick()

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        sessionId: 's1',
        error: expect.objectContaining({ code: 'adapter_crashed', retryable: true }),
      }),
    )
  })

  it('우리가 닫아서 끝난 것은 죽었다고 말하지 않는다 (codex에서 하루를 잃은 그 교훈)', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    await handle.dispose()
    control.endStream()
    await tick()

    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  /*
   * 갈아 끼운 세션의 옛 프로세스 (#157). 멈춘 턴 뒤에 설정을 바꾸면 옛 CLI는 오류 result를 안은 채 끝나고,
   * SDK는 그것을 예외로 바꿔 던진다. 그 예외가 adapter_crashed로 올라가면 매니저가 새 프로세스를 닫는다.
   * 그리고 입력만 끝내면 CLI는 돌던 턴을 마저 돈다 — dispose는 프로세스를 끝내야 한다.
   */
  it('닫은 뒤 스트림이 예외로 끝나도 크래시를 올리지 않고, 닫을 때 프로세스를 끝낸다 (#157)', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's4', cwd: '/tmp', permissionPreset: 'auto' },
      (e) => events.push(e),
    )
    const q = control.queries.at(-1)!

    await handle.dispose()
    expect(q.closed).toBe(true)
    control.failStream(new Error('Claude Code returned an error result: [ede_diagnostic] result_type=user'))
    await tick()

    expect(events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('사용량 창구는 살아 있는 질의만 빌린다 — 닫힌 세션의 질의를 붙들지 않는다 (#157)', async () => {
    const adapter = new ClaudeAdapter()
    const older = await adapter.createSession({ sessionId: 's5', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const qOlder = control.queries.at(-1)!
    const newer = await adapter.createSession({ sessionId: 's6', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const qNewer = control.queries.at(-1)!
    expect(ClaudeAdapter.lastQuery).toBe(qNewer)

    // 가장 최근 세션이 닫혀도 더 오래된 세션이 살아 있으면 그 질의에 묻는다
    await newer.dispose()
    expect(ClaudeAdapter.lastQuery).toBe(qOlder)
    await older.dispose()
    expect([...ClaudeAdapter.liveQueries]).not.toContain(qOlder)
  })

  /*
   * SDK가 입력을 안 당겨 가는 동안(턴이 도는 중이 이 모양이다) 큐에 남은 메시지는
   * dispose와 함께 아무도 안 읽게 된다. 화면에는 이미 보낸 것으로 남아 있으므로
   * (매니저가 먼저 기록한다) 말없이 버리면 "보냈는데 에이전트가 못 읽은" 상태가
   * 조용히 생긴다 — codex compact 큐 유실 사고(2026-09-02)와 같은 종류다.
   */
  it('큐에 메시지를 남긴 채 닫히면 유실을 말한다 — 침묵은 원래 버그의 재연이다', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's3', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    handle.send('배달 안 된 메시지')
    await handle.dispose()

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        sessionId: 's3',
        error: expect.objectContaining({ message: expect.stringContaining('not delivered') }),
      }),
    )
  })
})

/**
 * /goal은 헤드리스 SDK에 없다 (실측 2026-09-07, smoke-goal.mts — 원류에 active_goal
 * 0건). 보내면 모델이 골 역할극을 한다 — 가로채서 정직한 한 줄을 답하는지 본다.
 */
describe('claude /goal — SDK에 없는 기능의 정직한 거절', () => {
  it('/goal은 모델에게 가지 않고 안내 한 줄 + 턴 종료로 답한다', async () => {
    const events: NormalizedEvent[] = []
    const adapter = new ClaudeAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's3', cwd: '/tmp', permissionPreset: 'normal' },
      (e) => events.push(e),
    )

    handle.send('/goal 테스트 전부 초록')
    await tick()
    expect(events.some((e) => e.type === 'message_delta' && /interactive Claude CLI/.test(e.text ?? ''))).toBe(true)
    expect(events.some((e) => e.type === 'turn_complete')).toBe(true)
    // 모델로 가는 working 전이가 없어야 한다 — 보낸 척이 최악이다
    expect(events.some((e) => e.type === 'state_change' && e.state === 'working')).toBe(false)

    // 판정은 좁다 — /goal을 언급하는 진짜 메시지는 그대로 나간다
    handle.send('/goal이 뭐하는 명령이야?')
    await tick()
    expect(events.some((e) => e.type === 'state_change' && e.state === 'working')).toBe(true)
    await handle.dispose()
    control.endStream()
  })
})

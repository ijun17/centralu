import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * CLI 프로세스가 조용히 사라지면 SDK 스트림은 예외 없이 **그냥 끝나기도** 한다.
 * 그때 어댑터가 아무 말도 안 올리면 화면은 영원히 '작업 중'이고 다음 말은 허공으로 간다.
 * 여기서는 SDK를 조종 가능한 가짜로 갈아 끼워 그 경계만 본다 —
 * 진짜 CLI를 띄우면 죽는 시점을 테스트가 정할 수 없다.
 */
const control = vi.hoisted(() => ({ endStream: () => {} }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    // eslint-disable-next-line require-yield -- 아무것도 내놓지 않고 끝나는 스트림이 바로 시험 대상이다
    async *[Symbol.asyncIterator]() {
      // 테스트가 시키면 예외 없이 끝난다 (프로세스가 사라진 모양)
      await new Promise<void>((r) => (control.endStream = r))
    },
    interrupt: async () => {},
    supportedCommands: async () => [],
    getContextUsage: async () => undefined,
  }),
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

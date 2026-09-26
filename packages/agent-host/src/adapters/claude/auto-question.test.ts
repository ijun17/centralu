import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * auto 세션의 선택지 (#171). auto는 canUseTool을 넘기지 않아서, 모델이 AskUserQuestion으로 물어도 선택지 카드가
 * 뜨지 않았다. 콜백을 넘기되 선택지만 받고, 나머지(설정 파일의 ask 규칙에 걸린 요청)는 예전의 auto처럼 거절하는지
 * 본다 — 실측은 scripts/probe-auto-callback.mts. SDK를 가짜로 바꿔 끼우고 어댑터가 넘긴 옵션을 직접 본다.
 */
type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>
const sdk = vi.hoisted(() => ({ options: null as null | { canUseTool?: CanUseTool; permissionMode?: string } }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { canUseTool?: CanUseTool; permissionMode?: string } }) => {
    sdk.options = options
    return {
      // eslint-disable-next-line require-yield -- CLI가 아무 말도 하지 않는 스트림 — 이 시험은 콜백만 부른다
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

describe('auto 세션의 AskUserQuestion (#171)', () => {
  it('선택지는 카드로 올라오고, 권한 모드는 그대로 bypassPermissions다', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/x', permissionPreset: 'auto' }, (e) => events.push(e))
    expect(sdk.options?.permissionMode).toBe('bypassPermissions')
    expect(sdk.options?.canUseTool).toBeTypeOf('function')

    void sdk.options!.canUseTool!('AskUserQuestion', {
      questions: [{ question: 'Pick one', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
    })
    expect(events.some((e) => e.type === 'question_request')).toBe(true)
    await handle.dispose()
  })

  it('콜백에 온 나머지 요청은 예전의 auto처럼 거절한다 — 카드도 허용도 없다', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 's2', cwd: '/x', permissionPreset: 'auto' }, (e) => events.push(e))
    const r = await Promise.race([
      sdk.options!.canUseTool!('Bash', { command: 'touch cc-auto-probe.txt' }),
      new Promise<{ behavior: string }>((res) => setTimeout(() => res({ behavior: 'still asking' }), 20)),
    ])
    expect(r.behavior).toBe('deny')
    expect(events.some((e) => e.type === 'approval_request')).toBe(false)
    await handle.dispose()
  })
})

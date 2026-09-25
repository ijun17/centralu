import { describe, expect, it, vi } from 'vitest'

/**
 * 앱이 스키마를 주고 부탁한 에이전트 (M4 D-1) — Claude는 구조화 출력을 **질의를 시작할 때** 받는다(`outputFormat`, 질의
 * 단위 옵션). 그래서 세션을 만들 때 받은 스키마가 질의의 옵션에 실려야 한다. 진짜 CLI는 모델을 부르므로 SDK를 흉내로
 * 갈아 끼우고 넘긴 옵션만 본다(흉내가 따르는 실측은 normalize.test.ts의 결말 픽스처).
 */
const state = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    state.options.push(options)
    return {
      // eslint-disable-next-line require-yield -- 옵션만 본다. 스트림은 열린 채로 둔다
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: async () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

describe('Claude — 스키마는 질의의 outputFormat으로', () => {
  it('스키마를 받은 세션은 json_schema 형식으로 질의를 연다', async () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
    await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', outputSchema: schema }, () => {})
    expect(state.options.at(-1)!.outputFormat).toEqual({ type: 'json_schema', schema })
  })

  it('스키마가 없으면 형식을 싣지 않는다 — 보통 세션의 답은 글이다', async () => {
    await new ClaudeAdapter().createSession({ sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    expect('outputFormat' in state.options.at(-1)!).toBe(false)
  })
})

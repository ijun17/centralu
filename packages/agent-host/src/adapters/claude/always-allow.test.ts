import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * "항상 허용"한 파일 편집 (#170). 화면은 파일 편집의 매처로 그 경로를 보내고 매니저는 그것을 저장했다가 재시작 때 다시
 * 넣는다 — 그런데 Claude 어댑터는 편집을 `Edit:file_edit`라는 열쇠로 찾아서, 같은 파일을 다시 고칠 때마다 물었다.
 * 여기서는 SDK를 가짜로 바꿔 끼우고 어댑터가 넘긴 canUseTool을 직접 부른다.
 */
type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>
const sdk = vi.hoisted(() => ({ canUseTool: null as CanUseTool | null }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { canUseTool?: CanUseTool } }) => {
    sdk.canUseTool = options.canUseTool ?? null
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

const EDIT = { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' }
/** 콜백의 답 — 사람에게 묻고 있으면 답이 오지 않는다 */
const answer = (p: Promise<{ behavior: string }>) =>
  Promise.race([p.then((r) => r.behavior), new Promise<string>((r) => setTimeout(() => r('still asking'), 20))])

async function session() {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/x', permissionPreset: 'safe' }, (e) => events.push(e))
  const asks = () => events.filter((e) => e.type === 'approval_request')
  return { handle, canUseTool: sdk.canUseTool!, asks }
}

describe('Claude 파일 편집의 "항상 허용" (#170)', () => {
  it('항상 허용한 경로의 다음 편집은 묻지 않는다 — 다른 파일은 여전히 묻는다', async () => {
    const { handle, canUseTool, asks } = await session()
    const first = canUseTool('Edit', EDIT)
    const ask = asks()[0] as Extract<NormalizedEvent, { type: 'approval_request' }>
    expect(ask.detail).toMatchObject({ kind: 'file_edit', path: '/x/a.ts' })

    // 화면이 보내는 매처 그대로 (store.respondApproval: 편집은 detail.path)
    handle.respondApproval(ask.requestId, 'always', 'session', '/x/a.ts')
    expect((await first).behavior).toBe('allow')

    expect(await answer(canUseTool('Edit', { ...EDIT, new_string: 'c' }))).toBe('allow')
    expect(asks()).toHaveLength(1)

    void canUseTool('Edit', { ...EDIT, file_path: '/x/b.ts' })
    expect(asks()).toHaveLength(2)
    await handle.dispose()
  })

  it('재시작 뒤 저장된 경로 규칙(applyRules)도 맞는다', async () => {
    const { handle, canUseTool, asks } = await session()
    handle.applyRules!(['/x/a.ts'])
    expect(await answer(canUseTool('Write', { file_path: '/x/a.ts', content: 'new' }))).toBe('allow')
    expect(asks()).toHaveLength(0)
    await handle.dispose()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * "Always allow" for file edits (#170). The UI sends the path as the matcher for a file edit, and
 * the manager saves it and reapplies it after a restart — but the Claude adapter was looking up
 * edits by the key `Edit:file_edit`, so it asked again every time the same file was edited again.
 * Here the SDK is swapped for a fake and the `canUseTool` the adapter passed is called directly.
 */
type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>
const sdk = vi.hoisted(() => ({ canUseTool: null as CanUseTool | null }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { canUseTool?: CanUseTool } }) => {
    sdk.canUseTool = options.canUseTool ?? null
    return {
      // eslint-disable-next-line require-yield -- a stream where the CLI says nothing; this test only calls the callback
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
/** The callback's answer — while still asking the person, no answer arrives. */
const answer = (p: Promise<{ behavior: string }>) =>
  Promise.race([p.then((r) => r.behavior), new Promise<string>((r) => setTimeout(() => r('still asking'), 20))])

async function session() {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/x', permissionPreset: 'safe' }, (e) => events.push(e))
  const asks = () => events.filter((e) => e.type === 'approval_request')
  return { handle, canUseTool: sdk.canUseTool!, asks }
}

describe('"Always allow" for Claude file edits (#170)', () => {
  it('does not ask again for the next edit to an always-allowed path — other files still get asked', async () => {
    const { handle, canUseTool, asks } = await session()
    const first = canUseTool('Edit', EDIT)
    const ask = asks()[0] as Extract<NormalizedEvent, { type: 'approval_request' }>
    expect(ask.detail).toMatchObject({ kind: 'file_edit', path: '/x/a.ts' })

    // Exactly the matcher the UI sends (store.respondApproval: for edits it is detail.path).
    handle.respondApproval(ask.requestId, 'always', 'session', '/x/a.ts')
    expect((await first).behavior).toBe('allow')

    expect(await answer(canUseTool('Edit', { ...EDIT, new_string: 'c' }))).toBe('allow')
    expect(asks()).toHaveLength(1)

    void canUseTool('Edit', { ...EDIT, file_path: '/x/b.ts' })
    expect(asks()).toHaveLength(2)
    await handle.dispose()
  })

  it('also honors the path rules (applyRules) saved and restored after a restart', async () => {
    const { handle, canUseTool, asks } = await session()
    handle.applyRules!(['/x/a.ts'])
    expect(await answer(canUseTool('Write', { file_path: '/x/a.ts', content: 'new' }))).toBe('allow')
    expect(asks()).toHaveLength(0)
    await handle.dispose()
  })
})

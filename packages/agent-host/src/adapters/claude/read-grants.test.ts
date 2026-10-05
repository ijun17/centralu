import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * A read of a file another project handed back (#371 part B). ask_project grants the caller the paths the answer
 * named, after the process started, so `additionalDirectories` cannot carry them: the read lands in `canUseTool`
 * (measured, see `CreateSessionOpts.readableDirs`), and the adapter asks the host's `mayRead`. Here the SDK is a
 * fake and the callback is called directly, as in always-allow.test.ts.
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

const answer = (p: Promise<{ behavior: string }>) =>
  Promise.race([p.then((r) => r.behavior), new Promise<string>((r) => setTimeout(() => r('still asking'), 20))])

describe('reads another project handed back (#371)', () => {
  it('lets a granted read through without a card, and still asks for anything else, writes included', async () => {
    const events: NormalizedEvent[] = []
    const granted = '/w/toolkit/out/a.png'
    const handle = await new ClaudeAdapter().createSession(
      { sessionId: 's1', cwd: '/w/consumer', permissionPreset: 'normal', mayRead: (p) => p === granted || p === '/w/toolkit/out' },
      (e) => events.push(e),
    )
    const canUseTool = sdk.canUseTool!
    const asks = () => events.filter((e) => e.type === 'approval_request').length

    expect(await answer(canUseTool('Read', { file_path: granted }))).toBe('allow')
    expect(await answer(canUseTool('Glob', { pattern: '*.png', path: '/w/toolkit/out' }))).toBe('allow')
    expect(asks()).toBe(0)

    expect(await answer(canUseTool('Read', { file_path: '/w/toolkit/secret.env' }))).toBe('still asking')
    expect(await answer(canUseTool('Write', { file_path: granted, content: 'x' }))).toBe('still asking')
    expect(asks()).toBe(2)
    await handle.dispose()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * Choice cards for auto sessions (#171). Auto did not pass a `canUseTool` callback, so when the
 * model asked via AskUserQuestion no choice card appeared. This checks that the callback is now
 * passed, that it only accepts question choices, and that everything else (a request caught by
 * an `ask` rule in the settings file) is still denied the way old-style auto denied it — measured
 * in scripts/probe-auto-callback.mts. The SDK is swapped for a fake and the options the adapter
 * passed are inspected directly.
 */
type CanUseTool = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>
const sdk = vi.hoisted(() => ({ options: null as null | { canUseTool?: CanUseTool; permissionMode?: string } }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { canUseTool?: CanUseTool; permissionMode?: string } }) => {
    sdk.options = options
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

describe('AskUserQuestion in auto sessions (#171)', () => {
  it('question choices come up as a card, and the permission mode stays bypassPermissions', async () => {
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

  it('denies every other request that reaches the callback, as old-style auto did — no card, no approval', async () => {
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

/*
 * #382: Centralu's own tools are never asked about, under any preset (#93, and Codex's `default_tools_approval_mode:
 * 'approve'` since #363). Under auto a request reaches the callback only when an `ask` rule matched (the person's
 * own, or a trusted project's settings file), and the auto branch used to deny it before the exemption was reached:
 * a rule naming `mcp__centralu` refused the orchestrator's tools in auto while normal and safe let them through.
 */
describe("Centralu's own tools in auto sessions (#382)", () => {
  it('are allowed when an ask rule sends them to the callback, as under the other presets; anything else is still denied', async () => {
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 's3', cwd: '/x', permissionPreset: 'auto' }, (e) => events.push(e))
    expect((await sdk.options!.canUseTool!('mcp__centralu__read_session', {})).behavior).toBe('allow')
    // The exemption is the full server name, not a prefix (#93)
    expect((await sdk.options!.canUseTool!('mcp__centralu__pw__navigate', {})).behavior).toBe('deny')
    expect((await sdk.options!.canUseTool!('mcp__app-notes__write', {})).behavior).toBe('deny')
    expect(events.some((e) => e.type === 'approval_request')).toBe(false)
    await handle.dispose()
  })
})

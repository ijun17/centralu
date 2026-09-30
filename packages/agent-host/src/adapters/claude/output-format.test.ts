import { describe, expect, it, vi } from 'vitest'

/**
 * The agent the app hands a schema to and asks for structured output (M4 D-1) — Claude accepts
 * structured output only **when a query starts** (`outputFormat`, a per-query option). So the
 * schema received when the session was created has to be carried into the query's options.
 * Since the real CLI calls the model, we swap in a stub for the SDK and only check the options
 * passed through (the measured behavior the stub follows lives in the closing fixture of
 * normalize.test.ts).
 */
const state = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    state.options.push(options)
    return {
      // eslint-disable-next-line require-yield -- only the options matter here; leave the stream open
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

describe('Claude — schema goes through the query outputFormat', () => {
  it('a session given a schema opens its query with the json_schema format', async () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
    await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', outputSchema: schema }, () => {})
    expect(state.options.at(-1)!.outputFormat).toEqual({ type: 'json_schema', schema })
  })

  it('omits the format when there is no schema — an ordinary session answers in prose', async () => {
    await new ClaudeAdapter().createSession({ sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    expect('outputFormat' in state.options.at(-1)!).toBe(false)
  })
})

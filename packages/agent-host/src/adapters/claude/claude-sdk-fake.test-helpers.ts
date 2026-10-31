/**
 * The SDK swapped for a fake, for a test that calls the `canUseTool` the adapter passed (or reads what it wrote to the CLI)
 * and nothing else. Used as the factory of `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` in the test file: a helper
 * cannot call `vi.mock` for its importer. A test that needs more of the SDK spreads `importOriginal()` first, or adds its own
 * exports after this one.
 */
export type CanUseTool = (
  name: string,
  input: Record<string, unknown>,
  opts?: { toolUseID?: string; signal?: AbortSignal } & Record<string, unknown>,
) => Promise<{ behavior: string; message?: string; updatedInput?: Record<string, unknown> }>
export type QueryOptions = { canUseTool?: CanUseTool; permissionMode?: string }

const idleQuery = (stream: object, commands: unknown[]) => ({
  ...stream,
  interrupt: async () => {},
  close: () => {},
  supportedCommands: async () => commands,
  getContextUsage: async () => undefined,
})

/** A stream where the CLI says nothing; `onQuery` is handed the options of each `query` call */
export const fakeClaudeSdk = (onQuery: (options: QueryOptions) => void) => ({
  query: ({ options }: { options: QueryOptions }) => {
    onQuery(options)
    return idleQuery(
      {
        // eslint-disable-next-line require-yield -- a stream where the CLI says nothing; this test only calls the callback
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {})
        },
      },
      [],
    )
  },
})

/** A stream that never yields: `messages` collects what the adapter writes to the CLI's stdin */
export const fakeClaudeSdkWire = (messages: Record<string, unknown>[]) => ({
  query: ({ prompt }: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    void (async () => {
      for await (const u of prompt) messages.push(u)
    })()
    return idleQuery({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) }, [{ name: 'goal' }])
  },
})

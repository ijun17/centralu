import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { settledNow } from '../approval-outcome.test-helpers.js'

/**
 * Request ids are unique across processes (#683 review). The counter restarts in each process, so a window that
 * missed the events around a process swap could hold the old process's `req-1` while the new process raised its own
 * `req-1`: an Allow from a row drawn from the first landed on the second, a command nobody had read. Each handle now
 * tags its ids, so the old id is refused as gone. The SDK is a fake; `canUseTool` is called directly.
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

/** One process of the session: its handle, its `canUseTool`, and the approval cards it raised */
async function processOf(sessionId: string) {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession({ sessionId, cwd: '/x', permissionPreset: 'safe' }, (e) => events.push(e))
  const ids = () => events.flatMap((e) => (e.type === 'approval_request' || e.type === 'question_request' ? [e.requestId] : []))
  return { handle, canUseTool: sdk.canUseTool!, ids }
}


describe('Claude request ids across a process swap (#683 review)', () => {
  it("the old process's first request id does not answer the new process's first request", async () => {
    const old = await processOf('s1')
    void old.canUseTool('Bash', { command: 'ls' })
    const [oldId] = old.ids()
    await old.handle.dispose()

    // The session's process is replaced; the new one raises its first request
    const next = await processOf('s1')
    const asked = next.canUseTool('Bash', { command: 'rm -rf build' })
    const [newId] = next.ids()

    expect(newId).not.toBe(oldId)
    // An Allow from a row still drawn from the old request is refused as gone, and the new command stays unanswered
    expect(next.handle.respondApproval(oldId!, 'allow')).toBe(false)
    expect(await settledNow(asked)).toBe('still asking')
    await next.handle.dispose()
  })

  it('question ids are tagged the same way', async () => {
    const a = await processOf('s1')
    void a.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] })
    const b = await processOf('s1')
    void b.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] })
    expect(a.ids()[0]).toMatch(/^q-\w+-1$/)
    expect(b.ids()[0]).not.toBe(a.ids()[0])
    await a.handle.dispose()
    await b.handle.dispose()
  })
})

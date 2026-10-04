import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'

/**
 * Claude under the keeper (#280 step 2): the CLI's process comes from the keeper through
 * `spawnClaudeCodeProcess`, a new host adopts one that is already running, and a leaving host lets
 * go of it without a word to the CLI. The SDK is swapped for a fake that records what it was given.
 */
const sdk = vi.hoisted(() => {
  const state = {
    options: null as null | Record<string, unknown>,
    interrupts: 0,
    closes: 0,
    inbox: [] as unknown[],
    wake: null as null | (() => void),
    ended: false,
  }
  return {
    state,
    push(m: unknown) {
      state.inbox.push(m)
      state.wake?.()
    },
    end() {
      state.ended = true
      state.wake?.()
    },
    async *stream() {
      for (;;) {
        while (state.inbox.length > 0) yield state.inbox.shift()
        if (state.ended) return
        await new Promise<void>((r) => (state.wake = r))
      }
    },
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    sdk.state.options = args.options
    sdk.state.inbox.length = 0
    sdk.state.ended = false
    return {
      [Symbol.asyncIterator]: () => sdk.stream(),
      interrupt: async () => {
        sdk.state.interrupts++
      },
      close: () => {
        sdk.state.closes++
      },
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')

function fakeProcess() {
  return { detach: vi.fn(async () => {}), kill: vi.fn(() => true) } as unknown as AgentProcess & { detach: ReturnType<typeof vi.fn> }
}

async function adoptedSession(openCalls: { callId: string; tool: string }[]) {
  const events: NormalizedEvent[] = []
  const adopted = fakeProcess()
  const spawned: AgentSpawnSpec[] = []
  const handle = await new ClaudeAdapter().createSession(
    {
      sessionId: 's1',
      cwd: '/tmp',
      permissionPreset: 'normal',
      resumeExternalId: 'conv-1',
      processSource: {
        spawn: (spec) => (spawned.push(spec), fakeProcess()),
        adopt: { process: adopted, openCalls },
      },
    },
    (e) => events.push(e),
  )
  const spawn = sdk.state.options!.spawnClaudeCodeProcess as (o: AgentSpawnSpec) => AgentProcess
  return { handle, events, adopted, spawned, spawn }
}

describe('claude under the keeper', () => {
  it('the first spawn adopts the running CLI; a later one spawns through the keeper', async () => {
    const { handle, adopted, spawned, spawn } = await adoptedSession([])
    expect(spawn({ command: 'claude', args: ['--resume=conv-1'], env: {} })).toBe(adopted)
    expect(spawned).toHaveLength(0)
    spawn({ command: 'claude', args: [], env: {} })
    expect(spawned).toHaveLength(1)
    // The adopted CLI says its id only with its next turn; the conversation is the one resumed
    expect(handle.externalId).toBe('conv-1')
  })

  /**
   * The CLI asked the old host's in-process server and nobody will answer: measured, it waits in
   * silence until interrupted. The new owner releases the turn and says why.
   */
  it('a call to an in-process tool lost with the old host is failed out loud and the turn released', async () => {
    sdk.state.interrupts = 0
    const { events } = await adoptedSession([{ callId: 'c1', tool: 'mcp__centralu__send_to_session' }])
    expect(sdk.state.interrupts).toBe(1)
    const err = events.find((e) => e.type === 'error')
    expect(err && err.type === 'error' && err.error.message).toMatch(/mcp__centralu__send_to_session/)
  })

  it('a running Bash call is not lost — it runs inside the CLI, which the keeper kept', async () => {
    sdk.state.interrupts = 0
    const { events } = await adoptedSession([{ callId: 'c1', tool: 'Bash' }])
    expect(sdk.state.interrupts).toBe(0)
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
  })

  it('detaching tells the CLI nothing: no close, no deny for a waiting approval, and the stream ending is no crash', async () => {
    sdk.state.closes = 0
    const { handle, events, adopted } = await adoptedSession([])
    const canUseTool = sdk.state.options!.canUseTool as (n: string, i: Record<string, unknown>) => Promise<unknown>
    void canUseTool('Bash', { command: 'rm -rf build' })
    await new Promise((r) => setTimeout(r, 5))
    expect(events.some((e) => e.type === 'approval_request')).toBe(true)
    await handle.detach!()
    sdk.end()
    await new Promise((r) => setTimeout(r, 10))
    expect(adopted.detach).toHaveBeenCalled()
    expect(sdk.state.closes).toBe(0)
    expect(events.some((e) => e.type === 'approval_resolved')).toBe(false)
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })
})

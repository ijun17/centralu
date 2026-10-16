import { describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, NormalizedEvent } from '@cc/protocol'
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
    /** What the stream throws once its inbox is empty: the SDK's error for a CLI that died */
    failure: null as null | Error,
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
    fail(e: Error) {
      state.failure = e
      state.wake?.()
    },
    async *stream() {
      for (;;) {
        while (state.inbox.length > 0) yield state.inbox.shift()
        if (state.failure) throw state.failure
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
    sdk.state.failure = null
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

async function adoptedSession(openCalls: { callId: string; tool: string }[], backgroundTasks?: BackgroundTask[]) {
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
        adopt: { process: adopted, openCalls, ...(backgroundTasks ? { backgroundTasks } : {}) },
      },
    },
    (e) => events.push(e),
  )
  const spawn = sdk.state.options!.spawnClaudeCodeProcess as (o: AgentSpawnSpec) => AgentProcess
  return { handle, events, adopted, spawned, spawn }
}

describe('claude under the keeper', () => {
  it('a fresh keeper process receives the peer controls in its query and spawn environment', async () => {
    const spawned: AgentSpawnSpec[] = []
    const handle = await new ClaudeAdapter({ executable: () => null, startGapMs: 0 }).createSession(
      { sessionId: 'fresh', cwd: '/tmp', permissionPreset: 'safe', processSource: { spawn: (spec) => (spawned.push(spec), fakeProcess()) } },
      () => {},
    )
    const options = sdk.state.options!
    expect(options.settings).toMatchObject({ crossSessionInbound: 'refuse' })
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['ListAgents', 'ListPeers']))
    expect(options.disallowedTools).not.toContain('SendMessage')
    expect((options.env as AgentSpawnSpec['env']).CLAUDE_CODE_HARBOR_KITE).toBe('0')
    const spawn = options.spawnClaudeCodeProcess as (o: AgentSpawnSpec) => AgentProcess
    spawn({ command: 'claude', args: [], env: options.env as AgentSpawnSpec['env'] })
    expect(spawned[0]!.env.CLAUDE_CODE_HARBOR_KITE).toBe('0')
    await handle.dispose()
    sdk.end()
  })

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

  /**
   * A shell started with `run_in_background` keeps running in the kept CLI, which lists its tasks only when they
   * change (#648): the previous host's record seeds the tracker, so the shell's ending is reported, and until then
   * the session reads as holding background work. Without the record, the CLI's notification about an unknown task
   * is a foreground task's ending to the tracker, which says nothing.
   */
  it('the background shells the previous host recorded are known: their endings are reported', async () => {
    const shell: BackgroundTask = { id: 'b1', kind: 'shell', description: 'npm run dev', stopsWithTurn: false, stoppable: true, status: 'running' }
    const { events, handle } = await adoptedSession([], [shell])
    sdk.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'exited 0' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'background_tasks')).toBe(true))
    const level = events.find((e) => e.type === 'background_tasks')
    expect(level && level.type === 'background_tasks' && level.ended?.map((t) => [t.id, t.status])).toEqual([['b1', 'completed']])
    expect(level && level.type === 'background_tasks' && level.live).toEqual([])
    await handle.detach!()
    sdk.end()
  })

  it('without a record from the previous host, the tracker starts empty, as before', async () => {
    const { events, handle } = await adoptedSession([])
    sdk.push({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary: 'exited 0' })
    await new Promise((r) => setTimeout(r, 10))
    expect(events.some((e) => e.type === 'background_tasks')).toBe(false)
    await handle.detach!()
    sdk.end()
  })

  /** The SDK adds a CLI's stderr to its error only for a process it spawned itself; the keeper's was left without (#428) */
  it('a crash of the keeper\'s CLI carries the end of its stderr', async () => {
    const { events, adopted, spawn } = await adoptedSession([])
    Object.assign(adopted, { stderrTail: () => 'Error: Invalid API key · Please run /login\n' })
    spawn({ command: 'claude', args: ['--resume=conv-1'], env: {} })
    sdk.fail(new Error('Claude Code process exited with code 1'))
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true))
    const err = events.find((e) => e.type === 'error')
    expect(err && err.type === 'error' && err.error).toMatchObject({
      code: 'adapter_crashed',
      message: 'Claude Code process exited with code 1. stderr: Error: Invalid API key · Please run /login',
    })
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

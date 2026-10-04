import { describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, NormalizedEvent } from '@cc/protocol'
import { ClaudeStreamNormalizer } from './normalize.js'

/**
 * A Claude session's background work (#290), from the messages the CLI sends.
 *
 * Every fixture is a message as measured (scripts/probe-background-tasks.mts, CLI 2.1.282, SDK 0.3.263, haiku,
 * 2026-10-04), trimmed of uuid/session_id/output_file. The order is the measured one: the level
 * (`background_tasks_changed`) before `task_started` for the same task, and on interrupt the level, `task_updated`
 * killed and `task_notification` stopped in the same millisecond, then the turn's `error_during_execution`.
 */
const script = vi.hoisted(() => ({
  messages: [] as unknown[],
  release: () => {},
  stopped: [] as string[],
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of script.messages) yield m
      await new Promise<void>((r) => (script.release = r))
    },
    interrupt: async () => {},
    stopTask: async (id: string) => {
      script.stopped.push(id)
    },
    close: () => {},
    supportedCommands: async () => [],
    getContextUsage: async () => undefined,
  }),
}))

const { ClaudeAdapter } = await import('./index.js')

const SHELL_CALL = 'toolu_01ABN1MzYLko7rtxh7BUPWd8'
const AGENT_CALL = 'toolu_01Bpjnx856Pw4P6hQsepUJkY'

const shellLevel = {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [{ task_id: 'bzztskv5d', task_type: 'local_bash', description: 'Background sleep 191 seconds' }],
}
const shellStarted = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'bzztskv5d',
  tool_use_id: SHELL_CALL,
  description: 'Background sleep 191 seconds',
  is_backgrounded: true,
  task_type: 'local_bash',
}
const bothLevel = {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [
    { task_id: 'bzztskv5d', task_type: 'local_bash', description: 'Background sleep 191 seconds' },
    { task_id: 'a202e1fd007fa1e73', task_type: 'local_agent', description: 'probe sleeper' },
  ],
}
const agentStarted = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'a202e1fd007fa1e73',
  tool_use_id: AGENT_CALL,
  description: 'probe sleeper',
  subagent_type: 'general-purpose',
  is_backgrounded: true,
  spawn_depth: 1,
  task_type: 'local_agent',
  prompt: 'Run the Bash command `sleep 192; echo bg-sub-done` in the foreground and then reply done.',
}
const launched = [shellLevel, shellStarted, bothLevel, agentStarted]
/** What interrupting the turn sent, as measured */
const interrupted = [
  shellLevel,
  { type: 'system', subtype: 'task_updated', task_id: 'a202e1fd007fa1e73', patch: { status: 'killed', end_time: 1791112717086 } },
  { type: 'system', subtype: 'task_notification', task_id: 'a202e1fd007fa1e73', tool_use_id: AGENT_CALL, status: 'stopped', summary: 'probe sleeper' },
  { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '' }] } },
  { type: 'result', subtype: 'error_during_execution', modelUsage: {} },
]
/** What stopTask(<the shell>) sent, as measured */
const shellStopped = [
  { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
  { type: 'system', subtype: 'task_updated', task_id: 'bzztskv5d', patch: { status: 'killed', end_time: 1791112781220 } },
  { type: 'system', subtype: 'task_notification', task_id: 'bzztskv5d', tool_use_id: SHELL_CALL, status: 'stopped', summary: 'sleep 191; echo bg-shell-done' },
]

const feed = (messages: unknown[], n = new ClaudeStreamNormalizer('s1')) => ({ n, events: messages.flatMap((m) => n.push(m)) })
const lastTasks = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'background_tasks').at(-1) as
  | Extract<NormalizedEvent, { type: 'background_tasks' }>
  | undefined
const byId = (tasks: BackgroundTask[] | undefined) => Object.fromEntries((tasks ?? []).map((t) => [t.id, t]))

describe('a Claude session reports its background work (#290)', () => {
  it('the live set names each task, its kind, the call that launched it, and what an interrupt does to it', () => {
    const { events } = feed(launched)
    const live = byId(lastTasks(events)?.live)
    expect(live['bzztskv5d']).toEqual({
      id: 'bzztskv5d',
      kind: 'shell',
      description: 'Background sleep 191 seconds',
      parentCallId: SHELL_CALL,
      stopsWithTurn: false,
      stoppable: true,
      status: 'running',
    })
    expect(live['a202e1fd007fa1e73']).toMatchObject({ kind: 'agent', description: 'probe sleeper', parentCallId: AGENT_CALL, stopsWithTurn: true })
  })

  it('an interrupt ends the subagent as stopped and leaves the shell running', () => {
    const { events } = feed([...launched, ...interrupted])
    const last = lastTasks(events)
    expect(last?.live.map((t) => t.id)).toEqual(['bzztskv5d'])
    expect(last?.ended).toEqual([
      expect.objectContaining({ id: 'a202e1fd007fa1e73', kind: 'agent', status: 'stopped', parentCallId: AGENT_CALL, summary: 'probe sleeper' }),
    ])
  })

  it('a task that ended reports it once — a repeated notification adds nothing', () => {
    const { n } = feed([...launched, ...interrupted])
    expect(n.push(interrupted[2]).filter((e) => e.type === 'background_tasks')).toEqual([])
  })

  it('a failed task keeps the reason the CLI gave', () => {
    const { events } = feed([
      ...launched,
      shellLevel,
      { type: 'system', subtype: 'task_notification', task_id: 'a202e1fd007fa1e73', tool_use_id: AGENT_CALL, status: 'failed', summary: 'API Error: 529 overloaded' },
    ])
    expect(lastTasks(events)?.ended?.[0]).toMatchObject({ status: 'failed', summary: 'API Error: 529 overloaded' })
  })

  it('a foreground task that never entered the live set is not background work', () => {
    const { events } = feed([
      { type: 'system', subtype: 'task_started', task_id: 'fg1', tool_use_id: 'toolu_fg', description: 'probe fg', is_backgrounded: false, task_type: 'local_agent' },
      { type: 'system', subtype: 'task_notification', task_id: 'fg1', tool_use_id: 'toolu_fg', status: 'completed', summary: 'done' },
    ])
    expect(events.filter((e) => e.type === 'background_tasks')).toEqual([])
  })

  it('a shell a subagent started says nothing about the interrupt — that was not measured — and ambient work is marked', () => {
    const { events } = feed([
      ...launched,
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          ...bothLevel.tasks,
          { task_id: 'bstu422cq', task_type: 'local_bash', description: 'Sleep for 192 seconds then echo completion message' },
          { task_id: 'w1', task_type: 'monitor_mcp', description: 'watch', ambient: true },
        ],
      },
      { type: 'system', subtype: 'task_started', task_id: 'bstu422cq', owned_by_subagent: true, tool_use_id: 'toolu_01L2KLGZhrtdc7E1fDADd29n', description: 'Sleep for 192 seconds then echo completion message', is_backgrounded: true, task_type: 'local_bash' },
    ])
    const live = byId(lastTasks(events)?.live)
    expect(live['bstu422cq']).not.toHaveProperty('stopsWithTurn')
    expect(live['w1']).toMatchObject({ kind: 'mcp', ambient: true })
  })
})

describe('through the adapter (#290)', () => {
  async function session(messages: unknown[]) {
    script.messages = messages
    script.stopped = []
    const events: NormalizedEvent[] = []
    const handle = await new ClaudeAdapter().createSession({ sessionId: 's1', cwd: '/repo', permissionPreset: 'auto' }, (e) => events.push(e))
    await new Promise((r) => setTimeout(r, 20))
    return { handle, events }
  }

  it('declares that it reports background work', () => {
    expect(new ClaudeAdapter().capabilities.backgroundTasks).toBe(true)
  })

  it('stopping one task asks the CLI to stop that task, and its ending arrives as the stream says', async () => {
    const { handle, events } = await session([...launched, ...interrupted, ...shellStopped])
    await handle.stopBackgroundTask?.('bzztskv5d')
    expect(script.stopped).toEqual(['bzztskv5d'])
    expect(lastTasks(events)).toMatchObject({ live: [], ended: [{ id: 'bzztskv5d', kind: 'shell', status: 'stopped' }] })
    await handle.dispose()
    script.release()
  })

  it('closing the session ends what was still running as stopped — the process takes it along, silently', async () => {
    const { handle, events } = await session(launched)
    await handle.dispose()
    script.release()
    const last = lastTasks(events)
    expect(last?.live).toEqual([])
    expect(last?.ended?.map((t) => [t.id, t.status])).toEqual([
      ['bzztskv5d', 'stopped'],
      ['a202e1fd007fa1e73', 'stopped'],
    ])
  })
})

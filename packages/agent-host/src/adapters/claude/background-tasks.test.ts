import { describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, NormalizedEvent } from '@cc/protocol'
import { ClaudeStreamNormalizer } from './normalize.js'
import { recordedWhere } from './recorded.test-helpers.js'
import { sdk } from './sdk-message.test-helpers.js'

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

const feed = (messages: unknown[], n = new ClaudeStreamNormalizer('s1')) => ({ n, events: messages.flatMap((m) => n.push(sdk(m))) })
const lastTasks = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'background_tasks').at(-1)
const byId = (tasks: BackgroundTask[] | undefined) => Object.fromEntries((tasks ?? []).map((t) => [t.id, t]))

describe('a shell that ends on its own (recorded: background)', () => {
  const messages = recordedWhere('background', (m) => m.type === 'system' && /^(background_tasks_changed|task_started|task_updated|task_notification)$/.test(String(m.subtype)))

  it('is live with its kind and the call that launched it, then ends once as completed and leaves the live set', () => {
    const { events } = feed(messages)
    const levels = events.filter((e) => e.type === 'background_tasks')
    const live = levels.find((l) => l.live.some((t) => t.parentCallId))?.live[0]
    expect(live).toMatchObject({ kind: 'shell', parentCallId: 'toolu_000001', stopsWithTurn: false, stoppable: true, status: 'running' })
    const ended = levels.flatMap((l) => l.ended ?? [])
    expect(ended).toEqual([expect.objectContaining({ id: live!.id, kind: 'shell', status: 'completed', parentCallId: 'toolu_000001' })])
    expect(levels.at(-1)?.live).toEqual([])
  })
})

describe('a background subagent that ends on its own (recorded: background-agent)', () => {
  const messages = recordedWhere('background-agent', (m) => m.type === 'system' && /^(background_tasks_changed|task_started|task_updated|task_notification)$/.test(String(m.subtype)))

  it('is live as an agent with the call that launched it, its own foreground command is no background work, and it ends once as completed', () => {
    const { events } = feed(messages)
    const levels = events.filter((e) => e.type === 'background_tasks')
    const agent = levels.flatMap((l) => l.live).find((t) => t.kind === 'agent' && t.parentCallId)
    expect(agent).toMatchObject({ kind: 'agent', parentCallId: 'toolu_000001', status: 'running' })
    // The command the subagent ran in the foreground: the CLI says it started and ended, and it never entered the live set
    const foreground = (messages as unknown as Record<string, unknown>[]).find((m) => m.subtype === 'task_started' && m.is_backgrounded === false) as { task_id: string } | undefined
    expect(foreground).toBeDefined()
    const named = levels.flatMap((l) => [...l.live, ...(l.ended ?? [])]).map((t) => t.id)
    expect(named).not.toContain(foreground!.task_id)
    expect(levels.flatMap((l) => l.ended ?? [])).toEqual([expect.objectContaining({ id: agent!.id, kind: 'agent', status: 'completed' })])
    expect(levels.at(-1)?.live).toEqual([])
  })
})

/*
 * Hand-written, as measured (scripts/probe-background-tasks.mts): a subagent beside a shell, and an interrupt that ends one and
 * leaves the other, have no recording (a Stop while both run is a race a scenario cannot hold to), nor has a task that failed (the
 * failure is the provider's, 529 overloaded, which no run can ask for)
 */
describe('a Claude session reports its background work (#290)', () => {
  // Hand-written: the shell and the subagent live at once, before the interrupt below (no recording holds both)
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

  // Hand-written: a Stop while a subagent and a shell both run is a race no scenario holds to
  it('an interrupt ends the subagent as stopped and leaves the shell running', () => {
    const { events } = feed([...launched, ...interrupted])
    const last = lastTasks(events)
    expect(last?.live.map((t) => t.id)).toEqual(['bzztskv5d'])
    expect(last?.ended).toEqual([
      expect.objectContaining({ id: 'a202e1fd007fa1e73', kind: 'agent', status: 'stopped', parentCallId: AGENT_CALL, summary: 'probe sleeper' }),
    ])
  })

  // Hand-written: a notification repeated for one task is not something a run can be asked to send
  it('a task that ended reports it once — a repeated notification adds nothing', () => {
    const { n } = feed([...launched, ...interrupted])
    expect(n.push(sdk(interrupted[2])).filter((e) => e.type === 'background_tasks')).toEqual([])
  })

  // Hand-written: the failure is the provider's (529 overloaded), which no run can ask for
  it('a failed task keeps the reason the CLI gave', () => {
    const { events } = feed([
      ...launched,
      shellLevel,
      { type: 'system', subtype: 'task_notification', task_id: 'a202e1fd007fa1e73', tool_use_id: AGENT_CALL, status: 'failed', summary: 'API Error: 529 overloaded' },
    ])
    expect(lastTasks(events)?.ended?.[0]).toMatchObject({ status: 'failed', summary: 'API Error: 529 overloaded' })
  })

  // Hand-written: a monitor (ambient) task needs an MCP server that watches, which no scenario sets up
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

  // Hand-written: the SDK is mocked to see the adapter's stopTask call; the frames are the measured ones above
  it('stopping one task asks the CLI to stop that task, and its ending arrives as the stream says', async () => {
    const { handle, events } = await session([...launched, ...interrupted, ...shellStopped])
    await handle.stopBackgroundTask?.('bzztskv5d')
    expect(script.stopped).toEqual(['bzztskv5d'])
    expect(lastTasks(events)).toMatchObject({ live: [], ended: [{ id: 'bzztskv5d', kind: 'shell', status: 'stopped' }] })
    await handle.dispose()
    script.release()
  })

  // Hand-written: what the adapter itself ends on dispose; the CLI sends nothing for it
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

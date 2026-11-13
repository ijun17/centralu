import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { RequestTurn, RequestTurnAnswer } from '../contract.js'
import { requestTurnHooks } from './request-hook.js'

/**
 * The Assistant's turn that a session's request is (docs/plans/mailbox.md §9.7, #1447): every tool call of the CLI's own that is not a read is
 * put to the person, naming who asked, whatever the session's preset. The adapter does it with a `PreToolUse` hook, which the CLI runs before every tool
 * call in every permission mode (measured with the real CLI: scripts/probe-pretooluse-hook.mts; a narrower permission mode alone left out the tools that
 * need no permission, such as Agent, CronCreate and ScheduleWakeup). The SDK is swapped for a fake that keeps the options the adapter passed.
 */
type HookInputLike = { hook_event_name: string; tool_name: string; tool_input: unknown }
type HookOutput = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
type HookCallback = (input: HookInputLike, id: string | undefined, o: { signal: AbortSignal }) => Promise<HookOutput>
type Options = {
  canUseTool: (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>
  hooks?: { PreToolUse: { hooks: HookCallback[]; timeout?: number }[]; PostToolUse: { hooks: HookCallback[] }[] }
}
const cli = vi.hoisted(() => ({ options: null as null | Options }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    cli.options = options
    return {
      // eslint-disable-next-line require-yield -- a stream where the CLI says nothing; this test only calls the hook
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
  createSdkMcpServer: (cfg: { name: string }) => ({ type: 'sdk' as const, name: cfg.name }),
  tool: (name: string) => ({ name }),
}))

const { ClaudeAdapter } = await import('./index.js')

afterEach(() => {
  cli.options = null
})

const ALLOWED: RequestTurnAnswer = { allowed: true, asked: true }

function world(preset: 'auto' | 'normal' = 'auto') {
  const turn = { active: false, asked: [] as { tool: string; input: Record<string, unknown>; signal?: AbortSignal }[], answer: ALLOWED, fails: false, done: [] as string[] }
  const requestTurn: RequestTurn = {
    active: () => turn.active,
    ask: async (tool, input, signal) => {
      turn.asked.push({ tool, input, ...(signal ? { signal } : {}) })
      if (turn.fails) throw new Error('the card could not be raised')
      return turn.answer
    },
    done: (tool) => void turn.done.push(tool),
  }
  const events: NormalizedEvent[] = []
  const start = (sessionId: string) =>
    new ClaudeAdapter().createSession({ sessionId, cwd: '/tmp', permissionPreset: preset, requestTurn, centraluTools: {} as never, toolProfile: 'assistant' }, (e) => events.push(e))
  /** What the CLI’s hook says to a tool call */
  const hook = (tool: string, input: unknown = {}, id = 'toolu_1') => cli.options!.hooks!.PreToolUse[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, id, { signal: new AbortController().signal })
  /** The CLI saying a call ran (`PostToolUse`) or failed (`PostToolUseFailure`) */
  const after = (event: 'PostToolUse' | 'PostToolUseFailure', tool: string, id: string) =>
    cli.options!.hooks!.PostToolUse[0]!.hooks[0]!({ hook_event_name: event, tool_name: tool, tool_input: {} }, id, { signal: new AbortController().signal })
  return { turn, events, start, hook, after }
}

describe('a hook in front of every tool call of a session’s request', () => {
  it('is given to a session that has a request turn, with a wait long enough for a person; a session without one has none', async () => {
    const w = world()
    const handle = await w.start('h1')
    // A card waits for a person: the CLI’s own limit for a hook would end the wait early
    expect(cli.options?.hooks?.PreToolUse[0]?.timeout).toBeGreaterThanOrEqual(3600)
    await handle.dispose()

    const plain = await new ClaudeAdapter().createSession({ sessionId: 'h2', cwd: '/tmp', permissionPreset: 'auto' }, () => {})
    expect(cli.options?.hooks).toBeUndefined()
    await plain.dispose()
  })

  it('outside a request’s turn it says nothing: the CLI’s own flow decides, and nobody is asked', async () => {
    const w = world('auto')
    const handle = await w.start('h3')
    expect(await w.hook('Bash', { command: 'ls' })).toEqual({})
    expect(w.turn.asked).toEqual([])
    await handle.dispose()
  })

  it('in a request’s turn a command is put to the person under auto, and Allow lets it run without a second question', async () => {
    const w = world('auto')
    const handle = await w.start('h4')
    w.turn.active = true
    expect(await w.hook('Bash', { command: 'echo pwned > file' })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
    expect(w.turn.asked.map((a) => [a.tool, a.input])).toEqual([['Bash', { command: 'echo pwned > file' }]])
    await handle.dispose()
  })

  it('Deny is the model’s answer: the step does not run, and it reads the person’s words', async () => {
    const w = world('auto')
    const handle = await w.start('h5')
    w.turn.active = true
    w.turn.answer = { allowed: false, message: 'Nothing was done: the person did not allow it.' }
    expect(await w.hook('Write', { file_path: 'a.txt', content: 'x' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Nothing was done: the person did not allow it.' },
    })
    await handle.dispose()
  })

  it('every tool the CLI calls is put to the host, also the ones that need no permission: a subagent, a scheduled prompt, a wake-up', async () => {
    const w = world('auto')
    const handle = await w.start('h6')
    w.turn.active = true
    w.turn.answer = { allowed: false, message: 'no' }
    for (const tool of ['Agent', 'CronCreate', 'ScheduleWakeup', 'TaskStop', 'SendMessage', 'EnterPlanMode', 'WebFetch', 'mcp__elsewhere__tool']) {
      expect(await w.hook(tool), tool).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    }
    expect(w.turn.asked.map((a) => a.tool)).toEqual(['Agent', 'CronCreate', 'ScheduleWakeup', 'TaskStop', 'SendMessage', 'EnterPlanMode', 'WebFetch', 'mcp__elsewhere__tool'])
    await handle.dispose()
  })

  it('a read goes on to the CLI’s own flow: the hook decides nothing', async () => {
    const w = world('auto')
    const handle = await w.start('h7')
    w.turn.active = true
    w.turn.answer = { allowed: true, asked: false }
    expect(await w.hook('Read', { file_path: 'a.txt' })).toEqual({})
    await handle.dispose()
  })

  it('Centralu’s own tools, the app tool among them, ask in the call itself, so the hook leaves them; an app- server is not Centralu’s and is asked about', async () => {
    const w = world('auto')
    const handle = await w.start('h8')
    w.turn.active = true
    w.turn.answer = { allowed: false, message: 'no' }
    expect(await w.hook('mcp__centralu__read_session')).toEqual({})
    // An app is reached through Centralu’s `app` tool, whose call the host asks about knowing the app’s tool (#2231)
    expect(await w.hook('mcp__centralu__app', { action: 'call', app: 'board', tool: 'queue_merge', args: {} })).toEqual({})
    expect(await w.hook('AskUserQuestion', { questions: [] })).toEqual({})
    expect(w.turn.asked).toEqual([])
    // A server named app-x is never Centralu’s since #2231: it asks like any other (#93)
    expect(await w.hook('mcp__app-board__queue_merge')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    // Nor is Centralu’s own name on a server that is not Centralu’s (it has three parts, and the server is the one the session was given)
    expect(await w.hook('mcp__centralu__pw__navigate')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(w.turn.asked.map((a) => a.tool)).toEqual(['mcp__app-board__queue_merge', 'mcp__centralu__pw__navigate'])
    await handle.dispose()
  })

  it('a question that cannot be asked refuses the step: it never runs unasked', async () => {
    const w = world('auto')
    const handle = await w.start('h9')
    w.turn.active = true
    w.turn.fails = true
    expect(await w.hook('Bash', { command: 'ls' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('could not ask the person') } })
    await handle.dispose()
  })

  it('a step the person allowed is recorded once the CLI says it ran; one that failed, or one the hook did not let through as asked, is not (#1739)', async () => {
    const w = world('auto')
    const handle = await w.start('h9c')
    w.turn.active = true
    await w.hook('Bash', { command: 'ls' }, 'toolu_ran')
    await w.hook('Bash', { command: 'false' }, 'toolu_failed')
    // Allowed and not yet run: no record
    expect(w.turn.done).toEqual([])
    await w.after('PostToolUseFailure', 'Bash', 'toolu_failed')
    await w.after('PostToolUse', 'Bash', 'toolu_ran')
    // A call the hook left to the CLI's own flow (a read) is not the request's step to record; nor is one heard of twice
    w.turn.answer = { allowed: true, asked: false }
    await w.hook('Read', { file_path: 'a' }, 'toolu_read')
    await w.after('PostToolUse', 'Read', 'toolu_read')
    await w.after('PostToolUse', 'Bash', 'toolu_ran')
    expect(w.turn.done).toEqual(['Bash'])
    await handle.dispose()
  })

  it('a turn that cannot be told is refused, not let through: a hook that throws would let the tool run', async () => {
    const w = world('auto')
    const handle = await w.start('h9b')
    const broken = requestTurnHooks({ requestTurn: { active: () => { throw new Error('the store is gone') }, ask: async () => ALLOWED, done: () => {} } }, () => true)!.PreToolUse[0]!.hooks[0]!
    const out = (await broken({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } as never, 'toolu_4', { signal: new AbortController().signal })) as HookOutput
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    await handle.dispose()
  })

  it('a rule the person saved with “always” is for their own turns: a request’s turn still asks', async () => {
    const w = world('normal')
    const handle = await w.start('h10')
    // The person’s turn: the CLI’s card, answered “always” with the command as its matcher
    const first = cli.options!.canUseTool('Bash', { command: 'npm test' })
    for (let i = 0; i < 20 && !w.events.some((e) => e.type === 'approval_request'); i++) await new Promise((r) => setTimeout(r, 5))
    const card = w.events.find((e) => e.type === 'approval_request')
    expect(card).toBeTruthy()
    handle.respondApproval((card as { requestId: string }).requestId, 'always', 'session', 'npm test')
    expect(await first).toMatchObject({ behavior: 'allow' })
    expect(await cli.options!.canUseTool('Bash', { command: 'npm test' })).toMatchObject({ behavior: 'allow' })
    // In a request’s turn the hook asks regardless of the rule
    w.turn.active = true
    await w.hook('Bash', { command: 'npm test' })
    expect(w.turn.asked.map((a) => a.tool)).toEqual(['Bash'])
    await handle.dispose()
  })

  it('the wait is cut short with the CLI’s own signal, so a stopped turn leaves no card behind', async () => {
    const w = world('auto')
    const handle = await w.start('h11')
    w.turn.active = true
    const abort = new AbortController()
    await cli.options!.hooks!.PreToolUse[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, 'toolu_2', { signal: abort.signal })
    expect(w.turn.asked[0]?.signal).toBe(abort.signal)
    await handle.dispose()
  })
})

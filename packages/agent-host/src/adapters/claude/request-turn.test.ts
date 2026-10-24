import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import type { RequestTurn } from '../contract.js'

/**
 * The orchestrator's turn that a session's request is (docs/plans/mailbox.md §9.7, #1447): the CLI runs it under `default` whatever the session's
 * preset, so every step of its own that is not a read reaches the person's card, naming who asked; and the session goes back to its own mode when
 * the turn ends. Measured on a live query, bypass to default and back (scripts/probe-request-turn-mode.mts). The SDK is swapped for a fake that
 * writes down, in order, the modes it was asked for and the inputs it was given.
 */
const cli = vi.hoisted(() => {
  const inbox: unknown[] = []
  let wake: (() => void) | null = null
  return {
    log: [] as string[],
    canUseTool: null as null | ((name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>),
    failMode: false,
    push(m: unknown) {
      inbox.push(m)
      wake?.()
      wake = null
    },
    async *stream() {
      for (;;) {
        while (inbox.length > 0) yield inbox.shift()
        await new Promise<void>((r) => (wake = r))
      }
    },
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: { text: string }[] } }>; options: { canUseTool: typeof cli.canUseTool } }) => {
    cli.canUseTool = options.canUseTool
    void (async () => {
      try {
        for await (const u of prompt) cli.log.push(`input:${u.message.content[0]?.text}`)
      } catch {
        cli.log.push('input stream ended in an error')
      }
    })()
    return {
      [Symbol.asyncIterator]: () => cli.stream(),
      interrupt: async () => {},
      close: () => {},
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
      setPermissionMode: async (mode: string) => {
        if (cli.failMode) throw new Error('the CLI would not change mode')
        cli.log.push(`mode:${mode}`)
      },
    }
  },
  createSdkMcpServer: (cfg: { name: string }) => ({ type: 'sdk' as const, name: cfg.name }),
  tool: (name: string) => ({ name }),
}))

const { ClaudeAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 15))
const result = { type: 'result', subtype: 'success', is_error: false, modelUsage: {} }

afterEach(() => {
  cli.log.length = 0
  cli.failMode = false
})

function world(preset: 'auto' | 'normal' = 'auto') {
  const turn = { active: false, asked: [] as { tool: string; input: Record<string, unknown> }[], answer: { allowed: true } as { allowed: true } | { allowed: false; message: string } }
  const requestTurn: RequestTurn = {
    active: () => turn.active,
    ask: async (tool, input) => {
      turn.asked.push({ tool, input })
      return turn.answer
    },
  }
  const events: NormalizedEvent[] = []
  const start = (sessionId: string) =>
    new ClaudeAdapter().createSession({ sessionId, cwd: '/tmp', permissionPreset: preset, requestTurn, orchestratorTools: {} as never, toolProfile: 'orchestrator' }, (e) => events.push(e))
  return { turn, events, start }
}

describe('the turn of a session’s request runs under a narrower mode, and the session goes back after it', () => {
  it('under auto: default is set before the CLI reads the wake, bypass again when the turn ends, and a turn that is not a request changes nothing', async () => {
    const w = world('auto')
    const handle = await w.start('r1')
    // The person’s turn: the session’s own mode, no change asked for
    handle.send('the person typed')
    await tick()
    expect(cli.log).toEqual(['input:the person typed'])
    cli.push(result)
    await tick()

    // A session’s request: the mode is set to default first, then the wake goes in
    cli.log.length = 0
    w.turn.active = true
    handle.send('<centralu-mail/>', { origin: { kind: 'channel', server: 'centralu' } })
    await tick()
    expect(cli.log).toEqual(['mode:default', 'input:<centralu-mail/>'])

    // The turn ends: the host has heard it (no request is the turn now), and the session is in its own mode again
    w.turn.active = false
    cli.push(result)
    await tick()
    expect(cli.log).toEqual(['mode:default', 'input:<centralu-mail/>', 'mode:bypassPermissions'])
    await handle.dispose()
  })

  it('if the mode cannot be set, the wake is not sent: the request’s steps never run unasked', async () => {
    const w = world('auto')
    const handle = await w.start('r2')
    cli.failMode = true
    w.turn.active = true
    handle.send('<centralu-mail/>', { origin: { kind: 'channel', server: 'centralu' } })
    await tick()
    expect(cli.log).toEqual(['input stream ended in an error'])
    await handle.dispose()
  })

  it('a session that is not given a request turn is never switched', async () => {
    cli.log.length = 0
    const handle = await new ClaudeAdapter().createSession({ sessionId: 'r3', cwd: '/tmp', permissionPreset: 'auto' }, () => {})
    handle.send('hello')
    await tick()
    cli.push(result)
    await tick()
    expect(cli.log).toEqual(['input:hello'])
    await handle.dispose()
  })
})

describe('in a request’s turn every step of the CLI’s own asks the person, whatever the preset', () => {
  it('under auto, which denies what reaches it: a command is asked about, and the answer is the person’s', async () => {
    const w = world('auto')
    const handle = await w.start('c1')
    w.turn.active = true
    expect(await cli.canUseTool!('Bash', { command: 'echo pwned > file' })).toMatchObject({ behavior: 'allow' })
    expect(w.turn.asked).toEqual([{ tool: 'Bash', input: { command: 'echo pwned > file' } }])
    w.turn.answer = { allowed: false, message: 'Nothing was done: the person did not allow it.' }
    expect(await cli.canUseTool!('Write', { file_path: 'a.txt', content: 'x' })).toEqual({ behavior: 'deny', message: 'Nothing was done: the person did not allow it.' })
    expect(w.turn.asked.map((a) => a.tool)).toEqual(['Bash', 'Write'])
    await handle.dispose()
  })

  it('outside a request the same call is as it was: auto denies it, and nothing is asked', async () => {
    const w = world('auto')
    const handle = await w.start('c2')
    expect(await cli.canUseTool!('Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny' })
    expect(w.turn.asked).toEqual([])
    await handle.dispose()
  })

  it('Centralu’s own tools and an attached app’s are let through here: they ask in the host’s gate, so the person is asked once', async () => {
    const w = world('auto')
    const handle = await w.start('c3')
    w.turn.active = true
    expect(await cli.canUseTool!('mcp__centralu__read_session', {})).toMatchObject({ behavior: 'allow' })
    expect(await cli.canUseTool!('mcp__app-board__merge_when_green', {})).toMatchObject({ behavior: 'allow' })
    // Another MCP server is not Centralu’s and not an attached app: it asks like a command
    await cli.canUseTool!('mcp__elsewhere__tool', {})
    expect(w.turn.asked.map((a) => a.tool)).toEqual(['mcp__elsewhere__tool'])
    await handle.dispose()
  })

  it('a rule the person saved with “always” is for their own turns: a request’s turn still asks', async () => {
    const w = world('normal')
    const handle = await w.start('c4')
    // The person’s turn: the card, answered “always”
    const first = cli.canUseTool!('Bash', { command: 'npm test' })
    await tick()
    const card = w.events.find((e) => e.type === 'approval_request')
    expect(card).toBeTruthy()
    handle.respondApproval((card as { requestId: string }).requestId, 'always', 'session', 'npm test')
    expect(await first).toMatchObject({ behavior: 'allow' })
    // Again in the person’s turn: the rule answers
    expect(await cli.canUseTool!('Bash', { command: 'npm test' })).toMatchObject({ behavior: 'allow' })
    expect(w.turn.asked).toEqual([])
    // In a request’s turn the rule is not asked
    w.turn.active = true
    await cli.canUseTool!('Bash', { command: 'npm test' })
    expect(w.turn.asked.map((a) => a.tool)).toEqual(['Bash'])
    await handle.dispose()
  })
})

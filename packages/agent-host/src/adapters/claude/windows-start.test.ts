import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * How the Claude adapter starts its processes on Windows (#353), with the platform passed in and the
 * SDK swapped for a fake that records each `query()` and lets the test play the CLI.
 */
type Started = {
  at: number
  options: Record<string, unknown>
  /** The messages the adapter feeds the CLI */
  input: AsyncIterator<{ message: { content: { text: string }[] } }>
  push(m: unknown): void
  end(): void
  closed: boolean
  /** What close() does to the stream: by default nothing, as a process mid-turn */
  onClose: () => void
}

const sdk = vi.hoisted(() => ({ started: [] as Started[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<never>; options: Record<string, unknown> }) => {
    const inbox: unknown[] = []
    let wake: (() => void) | null = null
    let done = false
    const s: Started = {
      at: Date.now(),
      options,
      input: prompt[Symbol.asyncIterator](),
      push(m) {
        inbox.push(m)
        wake?.()
        wake = null
      },
      end() {
        done = true
        wake?.()
        wake = null
      },
      closed: false,
      onClose: () => {},
    }
    sdk.started.push(s)
    async function* stream() {
      for (;;) {
        while (inbox.length > 0) yield inbox.shift()
        if (done) return
        await new Promise<void>((r) => (wake = r))
      }
    }
    return {
      [Symbol.asyncIterator]: () => stream(),
      interrupt: async () => {},
      close: () => {
        s.closed = true
        s.onClose()
      },
      supportedCommands: async () => [],
      getContextUsage: async () => undefined,
    }
  },
}))

const { ClaudeAdapter } = await import('./index.js')
type Options = NonNullable<ConstructorParameters<typeof ClaudeAdapter>[0]>

const PROGRAM = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 7)])
let dir: string
let exe: string

beforeEach(() => {
  sdk.started.length = 0
  dir = mkdtempSync(join(tmpdir(), 'cc-353-'))
  const pkg = join(dir, 'npm', 'node_modules', '@anthropic-ai', 'claude-code')
  mkdirSync(join(pkg, 'bin'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.289' }))
  writeFileSync(join(pkg, 'install.cjs'), '')
  exe = join(pkg, 'bin', 'claude.exe')
  writeFileSync(exe, PROGRAM)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const adapter = (o: Options = {}) =>
  new ClaudeAdapter({ platform: 'win32', dataRoot: () => join(dir, 'data'), executable: () => exe, startGapMs: 0, ...o })

async function session(a: InstanceType<typeof ClaudeAdapter>, id = 's1') {
  const events: NormalizedEvent[] = []
  const handle = await a.createSession({ sessionId: id, cwd: dir, permissionPreset: 'auto' }, (e) => events.push(e))
  return { handle, events, cli: sdk.started.at(-1)! }
}

const text = (m: IteratorResult<{ message: { content: { text: string }[] } }>) => m.value?.message.content[0]?.text
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('where a Windows Claude session starts from (#353)', () => {
  it("starts the hard link in the data folder, not npm's claude.exe", async () => {
    const { handle, cli } = await session(adapter())
    const path = cli.options.pathToClaudeCodeExecutable as string
    expect(path).toBe(join(dir, 'data', 'tools', 'claude', `2.1.289-${PROGRAM.length}`, 'claude.exe'))
    expect(statSync(path).ino).toBe(statSync(exe).ino)
    await handle.dispose()
  })

  it("npm's placeholder fails the start with the fix, before any process is started", async () => {
    writeFileSync(exe, '@echo off\r\necho Error: claude native binary not installed.\r\n')
    await expect(session(adapter())).rejects.toThrow(/placeholder.*install\.cjs/s)
    expect(sdk.started).toHaveLength(0)
  })

  it('detect names the placeholder and the fix instead of "not found"', async () => {
    writeFileSync(exe, '@echo off\r\necho Error: claude native binary not installed.\r\n')
    const r = await adapter().detect()
    expect(r).toMatchObject({ tool: 'claude', installed: false, loggedIn: false })
    expect(r.detail).toContain('placeholder')
    expect(r.detail).toContain('install.cjs')
  })

  it('off Windows the path found on PATH is started as it is', async () => {
    const { handle, cli } = await session(adapter({ platform: 'darwin' }))
    expect(cli.options.pathToClaudeCodeExecutable).toBe(exe)
    await handle.dispose()
  })
})

describe('spacing Claude starts on Windows (#353)', () => {
  it('sessions started together reach the CLI a gap apart, in the order they were asked', async () => {
    const a = adapter({ startGapMs: 60 })
    const t0 = Date.now()
    const all = await Promise.all([session(a, 'a'), session(a, 'b'), session(a, 'c')])
    const at = sdk.started.map((s) => s.at - t0)
    /*
     * Each start is held to its own slot, a gap after the one before. Measured from t0, not from the start before it:
     * the CLI is reached after work the gate does not time (the first session also makes the program's link), so on
     * Windows 11 the first start once landed 13 ms late and the next one only 47 ms after it, still in its slot (#14).
     * 5 ms of slack for Windows timers, which can fire a little before Date.now() says they are due.
     */
    expect(at[0]).toBeLessThan(40)
    expect(at[1]).toBeGreaterThanOrEqual(60 - 5)
    expect(at[2]).toBeGreaterThanOrEqual(120 - 5)
    await Promise.all(all.map((s) => s.handle.dispose()))
  })

  it('by default only Windows waits', async () => {
    const a = new ClaudeAdapter({ platform: 'darwin', executable: () => exe })
    const t0 = Date.now()
    const all = await Promise.all([session(a, 'a'), session(a, 'b')])
    expect(sdk.started.at(-1)!.at - t0).toBeLessThan(40)
    await Promise.all(all.map((s) => s.handle.dispose()))
  })
})

const RACE =
  'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again'
// What the CLI (2.1.289) writes when the refresh race is lost: an API error message of its own, then an error result
const raceTurn = (cli: Started) => {
  cli.push({ type: 'assistant', parent_tool_use_id: null, error: 'server_error', message: { id: 'm1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: RACE }] } })
  cli.push({ type: 'result', subtype: 'success', is_error: true, result: RACE, modelUsage: {} })
}

describe('a turn that lost the sign-in refresh race (#353)', () => {
  it('goes again once after the delay, says so in the conversation, and does not fail the turn', async () => {
    const { handle, events, cli } = await session(adapter({ retryDelay: () => 30 }))
    handle.send('fix the build')
    expect(text(await cli.input.next())).toBe('fix the build')
    raceTurn(cli)
    await tick()

    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(events.find((e) => e.type === 'notice')).toMatchObject({ level: 'warning', from: 'Claude Code', label: 'sign-in', text: RACE })
    expect(events.find((e) => e.type === 'turn_complete')).toBeUndefined()

    // The same message reaches the CLI again
    expect(text(await cli.input.next())).toBe('fix the build')
    cli.push({ type: 'result', subtype: 'success', is_error: false, result: 'done', modelUsage: {} })
    await tick()
    expect(events.at(-1)).toMatchObject({ type: 'turn_complete' })
    await handle.dispose()
  })

  it('a second loss in a row is reported as the failure it is', async () => {
    const { handle, events, cli } = await session(adapter({ retryDelay: () => 10 }))
    handle.send('fix the build')
    await cli.input.next()
    raceTurn(cli)
    await cli.input.next()
    raceTurn(cli)
    await tick()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ error: { message: RACE } })
    await handle.dispose()
  })

  it('another failure is not retried', async () => {
    const { handle, events, cli } = await session(adapter({ retryDelay: () => 10 }))
    handle.send('fix the build')
    await cli.input.next()
    cli.push({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500', modelUsage: {} })
    await tick()
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(events.find((e) => e.type === 'notice')).toBeUndefined()
    await handle.dispose()
  })

  it('Stop during the delay calls the resend off', async () => {
    const { handle, events, cli } = await session(adapter({ retryDelay: () => 30 }))
    handle.send('fix the build')
    await cli.input.next()
    raceTurn(cli)
    await tick()
    handle.interrupt()
    let resent = false
    void cli.input.next().then(() => (resent = true))
    await new Promise((r) => setTimeout(r, 60))
    expect(resent).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'waiting_input', reason: 'interrupted' })
    await handle.dispose()
  })

  it('closing the session during the delay says the message was not delivered', async () => {
    const { handle, events, cli } = await session(adapter({ retryDelay: () => 1000 }))
    handle.send('fix the build')
    await cli.input.next()
    raceTurn(cli)
    await tick()
    await handle.dispose()
    expect(events.filter((e) => e.type === 'error').map((e) => (e as { error: { message: string } }).error.message)).toEqual([
      '1 message(s) were still queued when the session closed and were not delivered — please resend',
    ])
  })
})

describe('the host on its way out, on Windows (#353)', () => {
  it('waits for the closed Claude processes to leave by themselves', async () => {
    const a = adapter()
    const { handle, cli } = await session(a)
    // An idle CLI leaves a moment after its stdin closes
    cli.onClose = () => setTimeout(() => cli.end(), 40)
    await handle.dispose()
    let gone = false
    void (handle as unknown as { ended: Promise<void> }).ended.then(() => (gone = true))
    await a.settle()
    expect(gone).toBe(true)
  })

  it('never longer than its cap', async () => {
    const a = adapter({ exitGraceMs: 30 })
    const { handle } = await session(a)
    await handle.dispose() // the stream never ends: a process mid-turn
    const t0 = Date.now()
    await a.settle()
    expect(Date.now() - t0).toBeLessThan(200)
  })

  it('off Windows nothing waits', async () => {
    const a = adapter({ platform: 'darwin', exitGraceMs: 5000 })
    const { handle } = await session(a)
    await handle.dispose()
    const t0 = Date.now()
    await a.settle()
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('the link a session ran from is released when its process ends', async () => {
    const a = adapter()
    const { handle, cli } = await session(a)
    const path = cli.options.pathToClaudeCodeExecutable as string
    // A newer Claude Code is installed while the session runs
    rmSync(exe)
    writeFileSync(exe, Buffer.concat([PROGRAM, Buffer.from('new')]))
    writeFileSync(join(dir, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.290' }))
    const next = await session(a, 's2')
    expect(next.cli.options.pathToClaudeCodeExecutable).not.toBe(path)
    expect(statSync(path).isFile()).toBe(true) // still in use

    cli.onClose = () => cli.end()
    await handle.dispose()
    await tick()
    expect(() => statSync(path)).toThrow()
    await next.handle.dispose()
  })
})

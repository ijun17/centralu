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
  input: AsyncIterator<{ uuid: string; message: { content: { text: string }[] } }>
  push(m: unknown): void
  end(): void
  closed: boolean
  interrupts: unknown[]
  cancelled: string[]
  noteCancellations: string[]
  /** What close() does to the stream: by default nothing, as a process mid-turn */
  onClose: () => void
}

const sdk = vi.hoisted(() => ({ started: [] as Started[], version: '2.1.289', canCancel: true, capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<never>; options: Record<string, unknown> }) => {
    const inbox: unknown[] = [{ type: 'system', subtype: 'init', claude_code_version: sdk.version, capabilities: sdk.capabilities }]
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
      interrupts: [],
      cancelled: [],
      noteCancellations: [],
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
      interrupt: async (options?: unknown) => { s.interrupts.push(options); return { cancelled: s.cancelled, still_queued: [] } },
      cancelAsyncMessage: sdk.canCancel ? async (uuid: string) => { s.noteCancellations.push(uuid); return true } : undefined,
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
  sdk.version = '2.1.289'
  sdk.canCancel = true
  sdk.capabilities = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1']
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
  it('a queued parent note is completed by its own result UUID, rather than the preceding result', async () => {
    const { handle, cli } = await session(adapter())
    handle.send('original task')
    const original = (await cli.input.next()).value!
    let done = false
    const note = handle.sendTracked!('parent note').then(() => { done = true })
    const input = (await cli.input.next()).value!
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: original.uuid, user_message_uuids: [original.uuid] })
    await tick()
    expect(done).toBe(false)
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: original.uuid, user_message_uuids: [original.uuid, input.uuid] })
    await note
    expect(done).toBe(true)
    cli.end()
    await handle.dispose()
  })

  it('notifies the host after the note result is recorded, before the next SDK frame', async () => {
    const { handle, cli, events } = await session(adapter())
    const observed: string[] = []
    const note = handle.sendTracked!('note', {
      complete: () => { expect(events.at(-1)?.type).toBe('turn_complete'); observed.push('complete') },
      fail: () => {},
    })
    const id = (await cli.input.next()).value!.uuid
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: id, user_message_uuids: [id] })
    cli.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'next turn' } } })
    await note
    expect(observed).toEqual(['complete'])
    cli.end()
    await handle.dispose()
  })

  it('a capped result completes only the UUIDs it reports; an omitted note still requires its own receipt', async () => {
    const { handle, cli } = await session(adapter())
    const notes: Promise<void>[] = []
    const ids: string[] = []
    for (let n = 0; n < 65; n++) {
      notes.push(handle.sendTracked!(`note ${n}`))
      ids.push((await cli.input.next()).value!.uuid)
    }
    let firstDone = false
    void notes[0]!.then(() => { firstDone = true })
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: ids.at(-1), user_message_uuids: ids.slice(-64) })
    await Promise.all(notes.slice(1))
    expect(firstDone).toBe(false)
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: ids[0], user_message_uuids: [ids[0]] })
    await Promise.all(notes)
    cli.end()
    await handle.dispose()
  })

  it('stop cancels SDK-queued notes as well as the running turn', async () => {
    const { handle, cli } = await session(adapter())
    const note = handle.sendTracked!('queued note')
    await cli.input.next()
    const rejected = expect(note).rejects.toThrow('stopped')
    handle.interrupt()
    await rejected
    expect(cli.interrupts).toEqual([{ cancelQueued: true }])
    cli.end()
    await handle.dispose()
  })

  it('the next note turn becomes working and an intentional stop does not turn its result into a failure', async () => {
    const { handle, cli, events } = await session(adapter())
    handle.send('original')
    const original = (await cli.input.next()).value!.uuid
    const note = handle.sendTracked!('next turn')
    const id = (await cli.input.next()).value!.uuid
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: original, user_message_uuids: [original] })
    await tick()
    cli.push({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: id, event: { type: 'message_start', message: { id: 'note-reply' } } })
    await tick()
    expect(events.at(-1)).toMatchObject({ type: 'state_change', state: 'working' })
    const rejected = expect(note).rejects.toThrow('stopped')
    handle.interrupt()
    cli.push({ type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuid: id, user_message_uuids: [id] })
    await rejected
    await tick()
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    cli.end()
    await handle.dispose()
  })

  it('a parent note does not replace a pending approval with a working state', async () => {
    const events: NormalizedEvent[] = []
    const a = adapter()
    const handle = await a.createSession({ sessionId: 's1', cwd: dir, permissionPreset: 'normal' }, (e) => events.push(e))
    const cli = sdk.started.at(-1)!
    handle.send('original')
    await cli.input.next()
    const canUse = cli.options.canUseTool as (tool: string, input: unknown, context: unknown) => Promise<unknown>
    const approval = canUse('Bash', { command: 'write result.txt' }, { toolUseID: 'call-1', signal: new AbortController().signal })
    await tick()
    const card = events.find((e) => e.type === 'approval_request')!
    expect(card.type).toBe('approval_request')
    const before = events.length
    const note = handle.sendTracked!('keep the approval open')
    expect(events.slice(before).filter((e) => e.type === 'state_change')).toEqual([])
    handle.respondApproval((card as Extract<NormalizedEvent, { type: 'approval_request' }>).requestId, 'deny')
    await approval
    cli.end()
    await handle.dispose()
    await expect(note).rejects.toThrow('closed')
  })

  it('an ID-less background task result between turns neither cancels nor completes a parent note', async () => {
    const { handle, cli, events } = await session(adapter())
    handle.send('start a background shell')
    const original = (await cli.input.next()).value!.uuid
    let done = false
    const note = handle.sendTracked!('parent note').then(() => { done = true })
    const id = (await cli.input.next()).value!.uuid
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: original, user_message_uuids: [original] })
    cli.push({ type: 'system', subtype: 'task_notification', task_id: 'shell-1', status: 'completed', summary: 'shell finished' })
    cli.push({ type: 'result', subtype: 'success' })
    await tick()
    expect(done).toBe(false)
    expect(cli.interrupts).toEqual([])
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: id, user_message_uuids: [id] })
    await note
    expect(done).toBe(true)
    cli.end()
    await handle.dispose()
  })

  it.each(['2.1.288', 'unknown'])('refuses tracked notes on a single-UUID CLI (%s) from startup, while ordinary sends still work', async (version) => {
    sdk.version = version
    const { handle, cli } = await session(adapter())
    expect(handle.sendTracked).toBeUndefined()
    handle.send('original')
    const original = (await cli.input.next()).value!.uuid
    cli.push({ type: 'stream_event', user_message_uuid: original, event: { type: 'message_start', message: { id: 'old-reply' } } })
    handle.send('person follow-up')
    await cli.input.next()
    // An old result only echoes the original input; it cannot confirm a folded parent note.
    cli.push({ type: 'result', subtype: 'success', user_message_uuid: original })
    cli.push({ type: 'system', subtype: 'init', claude_code_version: '2.1.289', canCancel: true, capabilities: sdk.capabilities })
    await tick()
    expect(handle.sendTracked).toBeUndefined()
    expect(cli.interrupts).toEqual([])
    cli.end()
    await handle.dispose()
  })

  it('does not offer tracked notes without the startup cancellation-receipt protocol', async () => {
    sdk.capabilities = []
    const { handle, cli } = await session(adapter())
    expect(handle.sendTracked).toBeUndefined()
    cli.end()
    await handle.dispose()
  })

  it.each(['local', 'SDK'] as const)('stop reports a person message cancelled alongside a parent note in the %s queue', async (queue) => {
    const { handle, cli, events } = await session(adapter())
    handle.send('original')
    await cli.input.next()
    handle.send('person message already shown in chat')
    let person: string | undefined
    if (queue === 'SDK') person = (await cli.input.next()).value!.uuid
    const note = handle.sendTracked!('parent note')
    if (queue === 'SDK') {
      const id = (await cli.input.next()).value!.uuid
      cli.cancelled = [person!, id]
    }
    const rejected = expect(note).rejects.toThrow('stopped')
    handle.interrupt()
    await rejected
    await tick()
    expect(cli.interrupts).toEqual([{ cancelQueued: true }])
    expect(events.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ message: '1 message(s) were still queued when the turn stopped and were not delivered — please resend' }) }),
    ])
    cli.end()
    await handle.dispose()
  })

  it.each([
    { queue: 'local', canCancel: true }, { queue: 'SDK', canCancel: true },
    { queue: 'local', canCancel: false }, { queue: 'SDK', canCancel: false },
  ])('a turn error cancels only parent notes and preserves the person message ($queue, per-UUID SDK: $canCancel)', async ({ queue, canCancel }) => {
    sdk.canCancel = canCancel
    const { handle, cli, events } = await session(adapter())
    handle.send('original task')
    const original = (await cli.input.next()).value!.uuid
    handle.send('person message')
    let person: string | undefined
    if (queue === 'SDK') person = (await cli.input.next()).value!.uuid
    const note = handle.sendTracked!('parent note')
    let id: string | undefined
    if (queue === 'SDK') {
      id = (await cli.input.next()).value!.uuid
      cli.cancelled = [person!, id!] // A broad cancel_queued interrupt would drop the person message too.
    }
    const rejected = expect(note).rejects.toThrow()
    cli.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['turn failed'], user_message_uuids: [original] })
    await rejected
    expect(cli.interrupts).toEqual([])
    // Even a per-UUID API can cancel a coalesced representative's whole batch. Keep mixed SDK queues intact.
    expect(cli.noteCancellations).toEqual([])
    if (queue === 'local') expect(text(await cli.input.next())).toBe('person message')
    expect(events.filter((e) => e.type === 'error').some((e) => e.error.message.includes('not delivered'))).toBe(false)
    cli.end()
    await handle.dispose()
  })

  it('a turn error cancels standalone SDK parent notes individually when no person input can join their batch', async () => {
    const { handle, cli } = await session(adapter())
    handle.send('original task')
    const original = (await cli.input.next()).value!.uuid
    const note = handle.sendTracked!('standalone parent note')
    const id = (await cli.input.next()).value!.uuid
    const rejected = expect(note).rejects.toThrow()
    cli.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['turn failed'], user_message_uuids: [original] })
    await rejected
    expect(cli.interrupts).toEqual([])
    expect(cli.noteCancellations).toEqual([id])
    cli.end()
    await handle.dispose()
  })

  it('accepts another user message through the prompt iterator during a turn, without ending or interrupting it', async () => {
    const a = adapter()
    expect(a.capabilities.midTurnInput).toBe(true)
    const { handle, cli, events } = await session(a)
    handle.send('long job')
    expect(text(await cli.input.next())).toBe('long job')
    cli.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Working.' } } })
    await tick()
    const next = cli.input.next()
    handle.send('Another session says: use Chromium.')
    expect(text(await next)).toBe('Another session says: use Chromium.')
    expect(cli.closed).toBe(false)
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false)
    cli.end()
    await handle.dispose()
  })

  it("starts the hard link in the data folder, not npm's claude.exe", async () => {
    const { handle, cli } = await session(adapter())
    const path = cli.options.pathToClaudeCodeExecutable as string
    expect(path).toBe(join(dir, 'data', 'tools', 'claude', `2.1.289-${PROGRAM.length}`, 'claude.exe'))
    // bigint ids: as Numbers, two NTFS file ids above 2^53 can come out equal (#368)
    expect(statSync(path, { bigint: true }).ino).toBe(statSync(exe, { bigint: true }).ino)
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
     *
     * Only lower bounds: how late a start may come is up to the machine. The test used to also require the first start
     * within 40 ms, and a loaded windows-2022 runner took 42 (#368, job 113423297517). That the first start does not
     * wait is the next test's, on a gap no machine could hide.
     */
    expect(at[1]).toBeGreaterThanOrEqual(60 - 5)
    expect(at[2]).toBeGreaterThanOrEqual(120 - 5)
    await Promise.all(all.map((s) => s.handle.dispose()))
  })

  it('the first start does not wait for a gap', async () => {
    // Held to a gap, this start would come an hour later and the test would time out
    const { handle, cli } = await session(adapter({ startGapMs: 3_600_000 }))
    expect(sdk.started).toEqual([cli])
    await handle.dispose()
  })

  it('by default only Windows waits', async () => {
    // Windows' default gap is 1.5 s. Held to it, the second start could not come before t0 + 1.5 s
    const a = new ClaudeAdapter({ platform: 'darwin', executable: () => exe })
    const t0 = Date.now()
    const all = await Promise.all([session(a, 'a'), session(a, 'b')])
    expect(sdk.started.at(-1)!.at - t0).toBeLessThan(1_500)
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

  it('a note sent during the sign-in retry delay completes only its own UUID, before the older note is retried', async () => {
    const { handle, cli } = await session(adapter({ retryDelay: () => 100 }))
    vi.useFakeTimers()
    let olderDone = false
    const older = handle.sendTracked!('N1').then(() => { olderDone = true })
    const n1 = (await cli.input.next()).value!.uuid
    raceTurn(cli)
    await vi.advanceTimersByTimeAsync(0)
    const newer = handle.sendTracked!('N2')
    const n2 = (await cli.input.next()).value!.uuid
    cli.push({ type: 'result', subtype: 'success', user_message_uuids: [n2] })
    await newer
    expect(olderDone).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect((await cli.input.next()).value!.uuid).toBe(n1)
    cli.push({ type: 'result', subtype: 'success', user_message_uuids: [n1] })
    await older
    expect(olderDone).toBe(true)
    cli.end()
    await handle.dispose()
  })

  it('a later turn error cancels retry-held parent notes while the person input in that retry is delivered', async () => {
    const { handle, cli } = await session(adapter({ retryDelay: () => 100 }))
    vi.useFakeTimers()
    handle.send('person input held for retry')
    await cli.input.next()
    const older = handle.sendTracked!('N1')
    await cli.input.next()
    raceTurn(cli)
    await vi.advanceTimersByTimeAsync(0)
    const newer = handle.sendTracked!('N2')
    const n2 = (await cli.input.next()).value!.uuid
    const rejected = [expect(older).rejects.toThrow(), expect(newer).rejects.toThrow()]
    cli.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['turn failed'], user_message_uuids: [n2] })
    await Promise.all(rejected)
    await vi.advanceTimersByTimeAsync(100)
    expect(text(await cli.input.next())).toBe('person input held for retry')
    handle.send('fresh input')
    expect(text(await cli.input.next())).toBe('fresh input')
    cli.end()
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

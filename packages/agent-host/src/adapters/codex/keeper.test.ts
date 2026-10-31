import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AgentProcess, AgentSpawnSpec } from '../contract.js'
import { CodexAdapter } from './index.js'
import { CodexSession } from './session.js'
import { eventually } from '../../../../../tooling/test-timing.js'

/**
 * Codex under the keeper (#280 step 2): a new host adopts an app-server another host was talking
 * to. Measured (codex-cli 0.160.0, 2026-10-04): the second `initialize` on that stdio is rejected
 * with "Already initialized", and `thread/resume` answers with the turn still running and re-sends a
 * pending approval under the same id. The app-server here is a fake that answers the same way.
 */
class FakeAppServer extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  killed = false
  received: { id?: string; method: string; params?: Record<string, unknown> }[] = []
  stdinEnded = false
  kills: string[] = []
  detached = false
  /** Methods this fake does not answer (a request left in flight, as when the process dies before answering) */
  hold = new Set<string>()
  /**
   * `paginated`: codex-cli 0.160.0 given `excludeTurns: true` (#342) — the resume answers with no turns and
   * `thread/turns/list` names the running one. `legacy`: a Codex that predates both, answering with the turns and not
   * knowing the method.
   */
  constructor(
    private readonly mode: 'paginated' | 'legacy' | 'idle' = 'legacy',
    /** A process this host spawned answers `initialize`; an adopted one already was initialized */
    private readonly fresh = false,
  ) {
    super()
    let buf = ''
    this.stdin.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id?: string; method: string; params?: Record<string, unknown> }
        buf = buf.slice(nl + 1)
        this.received.push(msg)
        // A real app-server answers on a later tick, never inside the write
        setImmediate(() => this.answer(msg))
      }
    })
    this.stdin.on('finish', () => (this.stdinEnded = true))
  }
  private reply(id: string | undefined, body: Record<string, unknown>) {
    if (id !== undefined) this.stdout.write(`${JSON.stringify({ id, ...body })}\n`)
  }
  private answer(m: { id?: string; method: string }) {
    if (this.hold.has(m.method)) return
    if (m.method === 'initialize') {
      return this.reply(m.id, this.fresh ? { result: {} } : { error: { code: -32600, message: 'Already initialized' } })
    }
    if (m.method === 'thread/resume') {
      const turns = this.mode === 'paginated' || this.mode === 'idle' ? [] : [{ id: 'turn-9', status: 'inProgress' }]
      if (this.mode === 'idle') return this.reply(m.id, { result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns } } })
      this.reply(m.id, { result: { thread: { id: 'thread-1', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns } } })
      // The approval the old host never answered, re-sent under its old id
      this.stdout.write(`${JSON.stringify({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-9', itemId: 'i1', command: 'touch x', cwd: '/tmp' } })}\n`)
      return
    }
    if (m.method === 'thread/goal/get') return this.reply(m.id, { result: { goal: null } })
    if (m.method === 'thread/turns/list') {
      if (this.mode === 'legacy') return this.reply(m.id, { error: { code: -32601, message: 'Method not found' } })
      if (this.mode === 'idle') return this.reply(m.id, { result: { data: [], nextCursor: null, backwardsCursor: null } })
      return this.reply(m.id, { result: { data: [{ id: 'turn-9', status: 'inProgress', items: [], itemsView: 'notLoaded' }], nextCursor: 'c1', backwardsCursor: null } })
    }
    this.reply(m.id, { result: {} })
  }
  /** Answers the requests held for `method`, and the later ones */
  release(method: string) {
    this.hold.delete(method)
    for (const m of this.received.filter((r) => r.method === method)) this.answer(m)
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(signal)
    return true
  }
  async detach() {
    this.detached = true
  }
}

async function adopt(mode: 'paginated' | 'legacy' | 'idle' = 'legacy') {
  const server = new FakeAppServer(mode)
  const events: { type: string; requestId?: string }[] = []
  const handle = await new CodexAdapter().createSession(
    {
      sessionId: 's1',
      cwd: '/tmp',
      permissionPreset: 'safe',
      resumeExternalId: 'thread-1',
      processSource: {
        spawn: () => {
          throw new Error('an adopted session must not spawn')
        },
        adopt: { process: server as unknown as AgentProcess, openCalls: [] },
      },
    },
    (e) => events.push(e as never),
  )
  return { server, handle, events }
}

describe('codex under the keeper', () => {
  it('adopts a running app-server: the second initialize is shrugged off and the pending approval comes back', async () => {
    const { handle, events, server } = await adopt()
    expect(handle.externalId).toBe("thread-1")
    await eventually(() => events.some((e) => e.type === 'approval_request'))
    // No new thread: the running one is resumed
    expect(server.received.map((m) => m.method)).toContain('thread/resume')
    expect(server.received.map((m) => m.method)).not.toContain('thread/start')
  })

  /** Stop needs the running turn's id, which an adopting host never saw start */
  it('can stop the turn that was already running when it adopted the app-server', async () => {
    const { handle, server } = await adopt()
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    handle.interrupt()
    await eventually(() => server.received.some((m) => m.method === 'turn/interrupt'))
    expect(server.received.find((m) => m.method === 'turn/interrupt')!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-9' })
  })

  /*
   * #342: the resume asks for metadata only. Measured (codex-cli 0.160.0, 2026-10-05) on one connection, as the keeper
   * hands it over: while a turn ran, `thread/resume {excludeTurns: true}` said `status: active` with `turns: []`, and
   * `thread/turns/list {limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'}` named the turn `inProgress`. With an
   * approval pending, the resume re-sent it under its old id (#0) and said `activeFlags: ['waitingOnApproval']`.
   */
  it('resumes without the history and still stops the running turn, which it asks for on its own (#342)', async () => {
    const { handle, events, server } = await adopt('paginated')
    await eventually(() => events.some((e) => e.type === 'approval_request'))
    expect(server.received.find((m) => m.method === 'thread/resume')!.params).toMatchObject({ excludeTurns: true })
    handle.interrupt()
    // Waits for the interrupt without failing here, so a missing turn id reads as what was sent, not as a timeout
    for (let i = 0; i < 200 && !server.received.some((m) => m.method === 'turn/interrupt'); i++) await new Promise((r) => setTimeout(r, 5))
    expect(server.received.find((m) => m.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-1', turnId: 'turn-9' })
    expect(server.received.find((m) => m.method === 'thread/turns/list')?.params).toEqual({
      threadId: 'thread-1',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    })
  })

  /*
   * #1733 review: the thread has its id while its running turn is still looked up. A Stop then is not one for a resume still
   * waking (#168): the message sent meanwhile is not taken back and nothing says "stopped", since the adopted turn runs on.
   * The message goes once the lookup answers, and the next Stop stops that turn.
   */
  it('a Stop while the running turn is looked up keeps the message sent meanwhile; the next Stop stops the adopted turn', async () => {
    const server = new FakeAppServer('paginated')
    server.hold.add('thread/turns/list')
    const events: { type: string }[] = []
    const session = new CodexSession(
      {
        sessionId: 's1',
        cwd: '/tmp',
        permissionPreset: 'safe',
        resumeExternalId: 'thread-1',
        processSource: {
          spawn: () => {
            throw new Error('an adopted session must not spawn')
          },
          adopt: { process: server as unknown as AgentProcess, openCalls: [] },
        },
      },
      (e) => events.push(e as never),
    )
    await eventually(() => server.received.some((m) => m.method === 'thread/turns/list'))
    session.send('merge this in')
    session.interrupt()
    expect(events.some((e) => e.type === 'state_change')).toBe(false)
    server.release('thread/turns/list')
    await session.ready
    await eventually(() => server.received.some((m) => m.method === 'turn/start'))
    expect(server.received.find((m) => m.method === 'turn/start')!.params).toMatchObject({ input: [{ type: 'text', text: 'merge this in' }] })
    session.interrupt()
    await eventually(() => server.received.some((m) => m.method === 'turn/interrupt'))
    expect(server.received.find((m) => m.method === 'turn/interrupt')!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-9' })
  })

  it('an older Codex answers the resume with its turns: the running one is read from there, nothing more is asked', async () => {
    const { handle, server } = await adopt('legacy')
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    expect(server.received.some((m) => m.method === 'thread/turns/list')).toBe(false)
    handle.interrupt()
    await eventually(() => server.received.some((m) => m.method === 'turn/interrupt'))
    expect(server.received.find((m) => m.method === 'turn/interrupt')!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-9' })
  })

  it("a session's app-server finds the host's address and its own credential, with the environment it inherits (#1405)", async () => {
    const server = new FakeAppServer('paginated', true)
    const specs: AgentSpawnSpec[] = []
    await new CodexAdapter().createSession(
      {
        sessionId: 's1',
        cwd: '/tmp',
        permissionPreset: 'safe',
        hostAccess: { url: 'ws://127.0.0.1:4100', credential: 'ccs1:s1:mac' },
        processSource: { spawn: (spec) => (specs.push(spec), server) },
      },
      () => {},
    )
    expect(specs).toHaveLength(1)
    expect(specs[0]!.env).toMatchObject({ CC_HOST_URL: 'ws://127.0.0.1:4100', CC_HOST_CREDENTIAL: 'ccs1:s1:mac' })
    expect(specs[0]!.env.PATH ?? specs[0]!.env.Path).toMatch(/./) // kept from the host's own (its value is the OS layer's, #1599)
  })

  it('a resume this host started itself sends excludeTurns and asks for no running turn', async () => {
    const server = new FakeAppServer('paginated', true)
    await new CodexAdapter().createSession(
      {
        sessionId: 's1',
        cwd: '/tmp',
        permissionPreset: 'safe',
        resumeExternalId: 'thread-1',
        processSource: { spawn: () => server as unknown as AgentProcess },
      },
      () => {},
    )
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    expect(server.received.find((m) => m.method === 'thread/resume')!.params).toMatchObject({ threadId: 'thread-1', excludeTurns: true })
    expect(server.received.some((m) => m.method === 'thread/turns/list')).toBe(false)
  })

  it('detaching sends no EOF and no signal, and denies nothing', async () => {
    const { handle, events, server } = await adopt()
    await eventually(() => events.some((e) => e.type === 'approval_request'))
    await handle.detach!()
    await new Promise((r) => setTimeout(r, 20))
    expect(server.detached).toBe(true)
    expect(server.stdinEnded).toBe(false)
    expect(server.kills).toEqual([])
    expect(events.some((e) => e.type === 'approval_resolved')).toBe(false)
    expect(server.received.some((m) => m.method.includes('requestApproval') || (m.id === undefined && m.method !== 'initialized'))).toBe(false)
  })

  /** "codex app-server exited (code 1)" said nothing a person could act on: its stderr was never kept (#428) */
  it('an app-server that dies says why, from the end of its stderr', async () => {
    const { events, server } = await adopt()
    await eventually(() => events.some((e) => e.type === 'approval_request'))
    Object.assign(server, { stderrTail: () => 'Error: thread already has an active writer\n' })
    server.exitCode = 1
    server.emit('exit', 1, null)
    await eventually(() => events.some((e) => e.type === 'error'))
    expect((events.find((e) => e.type === 'error') as unknown as { error: unknown }).error).toMatchObject({
      code: 'adapter_crashed',
      message: 'codex app-server exited (code 1). stderr: Error: thread already has an active writer',
    })
  })

  /**
   * #1397: a Codex session keeps its app-server while idle (#568), so a shutdown or a kill lands on sessions with no turn.
   * Whatever the exit code, that is only a process gone: asleep, no error. A turn in flight is still a crash.
   */
  it.each([0, 1])('an app-server that exits (code %i) while its session is idle only puts the session to sleep, with no error', async (code) => {
    const { events, server } = await adopt('idle')
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    await new Promise((r) => setTimeout(r, 20))
    expect(events.some((e) => e.type === 'approval_request')).toBe(false)
    server.exitCode = code
    server.emit('exit', code, null)
    await eventually(() => events.some((e) => e.type === 'session_live'))
    expect(events.find((e) => e.type === 'session_live')).toEqual({ type: 'session_live', sessionId: 's1', live: false, reason: 'asleep' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it.each([0, 1])('an app-server that exits (code %i) in the middle of a turn is still a crash', async (code) => {
    const { events, server } = await adopt()
    await eventually(() => events.some((e) => e.type === 'approval_request'))
    server.exitCode = code
    server.emit('exit', code, null)
    await eventually(() => events.some((e) => e.type === 'error'))
    expect((events.find((e) => e.type === 'error') as unknown as { error: unknown }).error).toMatchObject({ code: 'adapter_crashed' })
    expect(events.some((e) => e.type === 'session_live')).toBe(false)
  })

  /**
   * #1397 review: an ordinary send has no receipt, so between `turn/start` going out and its answer the session looked idle:
   * an exit then said "asleep", the manager dropped the handle and the #157 filter dropped the error, and the message was
   * lost with no answer, error or stderr. A message not yet answered is a turn in flight.
   */
  it.each([0, 101])('an app-server that exits (code %i) before its answer to a message just sent is a crash, not sleep', async (code) => {
    const { events, server, handle } = await adopt('idle')
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    server.hold.add('turn/start')
    handle.send('please do the thing')
    await eventually(() => server.received.some((m) => m.method === 'turn/start'))
    server.exitCode = code
    server.emit('exit', code, null)
    await eventually(() => events.some((e) => e.type === 'error'))
    expect(events.some((e) => e.type === 'session_live')).toBe(false)
    expect(events.filter((e) => e.type === 'error').map((e) => (e as unknown as { error: { code: string } }).error.code)).toContain('adapter_crashed')
  })

  it('a message sent in the same tick as the exit counts too: nothing between the send and its turn/start is idle', async () => {
    const { events, server, handle } = await adopt('idle')
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    server.hold.add('turn/start')
    handle.send('first')
    // Not yet on the wire: the thread is up, and turn/start goes out on a later tick
    server.exitCode = 101
    server.emit('exit', 101, null)
    await eventually(() => events.some((e) => e.type === 'error'))
    expect(events.some((e) => e.type === 'session_live')).toBe(false)
  })

  it('goes idle again once the turn/start is answered and no turn runs: an exit then is sleep', async () => {
    const { events, server, handle } = await adopt('idle')
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    handle.send('hello')
    await eventually(() => server.received.some((m) => m.method === 'turn/start'))
    // The answer names no turn: nothing runs, and nothing is left in flight
    await new Promise((r) => setTimeout(r, 30))
    server.exitCode = 0
    server.emit('exit', 0, null)
    await eventually(() => events.some((e) => e.type === 'session_live'))
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('a running compact is a turn in flight: an exit during it is a crash', async () => {
    const { events, server, handle } = await adopt('idle')
    await eventually(() => server.received.some((m) => m.method === 'thread/goal/get'))
    server.hold.add('thread/compact/start')
    handle.send('/compact')
    await eventually(() => server.received.some((m) => m.method === 'thread/compact/start'))
    server.exitCode = 0
    server.emit('exit', 0, null)
    await eventually(() => events.some((e) => e.type === 'error'))
    expect(events.some((e) => e.type === 'session_live')).toBe(false)
  })

  it('an app-server that exits before it has finished starting is a crash, not sleep', async () => {
    const server = new FakeAppServer('idle')
    server.hold.add('thread/resume')
    const events: { type: string }[] = []
    void new CodexAdapter()
      .createSession(
        {
          sessionId: 's1',
          cwd: '/tmp',
          permissionPreset: 'safe',
          resumeExternalId: 'thread-1',
          processSource: {
            spawn: () => {
              throw new Error('an adopted session must not spawn')
            },
            adopt: { process: server as unknown as AgentProcess, openCalls: [] },
          },
        },
        (e) => events.push(e as never),
      )
      .catch(() => {})
    await eventually(() => server.received.some((m) => m.method === 'thread/resume'))
    server.exitCode = 0
    server.emit('exit', 0, null)
    await eventually(() => events.some((e) => e.type === 'error'))
    expect(events.some((e) => e.type === 'session_live')).toBe(false)
  })

  it('request ids carry a per-client prefix, so an answer meant for the old host cannot resolve a new request', async () => {
    const { server } = await adopt()
    const ids = server.received.filter((m) => m.id !== undefined).map((m) => String(m.id))
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{6}-\d+$/)
  })
})

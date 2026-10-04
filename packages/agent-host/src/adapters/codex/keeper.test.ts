import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { AgentProcess } from '../contract.js'
import { CodexAdapter } from './index.js'

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
  /**
   * `paginated`: codex-cli 0.160.0 given `excludeTurns: true` (#342) — the resume answers with no turns and
   * `thread/turns/list` names the running one. `legacy`: a Codex that predates both, answering with the turns and not
   * knowing the method.
   */
  constructor(
    private readonly mode: 'paginated' | 'legacy' = 'legacy',
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
    if (m.method === 'initialize') {
      return this.reply(m.id, this.fresh ? { result: {} } : { error: { code: -32600, message: 'Already initialized' } })
    }
    if (m.method === 'thread/resume') {
      const turns = this.mode === 'paginated' ? [] : [{ id: 'turn-9', status: 'inProgress' }]
      this.reply(m.id, { result: { thread: { id: 'thread-1', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns } } })
      // The approval the old host never answered, re-sent under its old id
      this.stdout.write(`${JSON.stringify({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-9', itemId: 'i1', command: 'touch x', cwd: '/tmp' } })}\n`)
      return
    }
    if (m.method === 'thread/goal/get') return this.reply(m.id, { result: { goal: null } })
    if (m.method === 'thread/turns/list') {
      if (this.mode === 'legacy') return this.reply(m.id, { error: { code: -32601, message: 'Method not found' } })
      return this.reply(m.id, { result: { data: [{ id: 'turn-9', status: 'inProgress', items: [], itemsView: 'notLoaded' }], nextCursor: 'c1', backwardsCursor: null } })
    }
    this.reply(m.id, { result: {} })
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(signal)
    return true
  }
  async detach() {
    this.detached = true
  }
}

async function adopt(mode: 'paginated' | 'legacy' = 'legacy') {
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

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

describe('codex under the keeper', () => {
  it('adopts a running app-server: the second initialize is shrugged off and the pending approval comes back', async () => {
    const { handle, events, server } = await adopt()
    expect(handle.externalId).toBe("thread-1")
    await until(() => events.some((e) => e.type === 'approval_request'))
    // No new thread: the running one is resumed
    expect(server.received.map((m) => m.method)).toContain('thread/resume')
    expect(server.received.map((m) => m.method)).not.toContain('thread/start')
  })

  /** Stop needs the running turn's id, which an adopting host never saw start */
  it('can stop the turn that was already running when it adopted the app-server', async () => {
    const { handle, server } = await adopt()
    await until(() => server.received.some((m) => m.method === 'thread/goal/get'))
    handle.interrupt()
    await until(() => server.received.some((m) => m.method === 'turn/interrupt'))
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
    await until(() => events.some((e) => e.type === 'approval_request'))
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

  it('an older Codex answers the resume with its turns: the running one is read from there, nothing more is asked', async () => {
    const { handle, server } = await adopt('legacy')
    await until(() => server.received.some((m) => m.method === 'thread/goal/get'))
    expect(server.received.some((m) => m.method === 'thread/turns/list')).toBe(false)
    handle.interrupt()
    await until(() => server.received.some((m) => m.method === 'turn/interrupt'))
    expect(server.received.find((m) => m.method === 'turn/interrupt')!.params).toEqual({ threadId: 'thread-1', turnId: 'turn-9' })
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
    await until(() => server.received.some((m) => m.method === 'thread/goal/get'))
    expect(server.received.find((m) => m.method === 'thread/resume')!.params).toMatchObject({ threadId: 'thread-1', excludeTurns: true })
    expect(server.received.some((m) => m.method === 'thread/turns/list')).toBe(false)
  })

  it('detaching sends no EOF and no signal, and denies nothing', async () => {
    const { handle, events, server } = await adopt()
    await until(() => events.some((e) => e.type === 'approval_request'))
    await handle.detach!()
    await new Promise((r) => setTimeout(r, 20))
    expect(server.detached).toBe(true)
    expect(server.stdinEnded).toBe(false)
    expect(server.kills).toEqual([])
    expect(events.some((e) => e.type === 'approval_resolved')).toBe(false)
    expect(server.received.some((m) => m.method.includes('requestApproval') || (m.id === undefined && m.method !== 'initialized'))).toBe(false)
  })

  it('request ids carry a per-client prefix, so an answer meant for the old host cannot resolve a new request', async () => {
    const { server } = await adopt()
    const ids = server.received.filter((m) => m.id !== undefined).map((m) => String(m.id))
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{6}-\d+$/)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcClient, type RpcClientOptions } from './rpc-client.js'
import { SessionInfo, liveBackgroundTasks } from '@cc/protocol'
import { currentSession, missingDefaults, withoutDefaultedFields } from '../../../protocol/src/test-helpers.js'

/**
 * A fake WebSocket for reproducing connect, disconnect and responses by hand, with no real
 * socket. Used together with a fake timer, since reconnection (the backoff setTimeout) also
 * has to be verified.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
  }
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  /** As if the server accepted the connection */
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  /** Opens and completes the handshake — the host said hello_ok, so calls may now go out (#82) */
  ready(hello: Record<string, unknown> = {}): void {
    this.open()
    this.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0, streamEpoch: 'epoch-a', ...hello })
  }
  /** Receives a server frame */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }
  /** As if the connection dropped abruptly (the server went down, a network cut) */
  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

function makeClient(opts?: Partial<Omit<RpcClientOptions, 'url' | 'token' | 'WebSocketImpl'>>): RpcClient {
  return new RpcClient({
    url: 'ws://127.0.0.1:1/',
    token: 't',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    ...opts,
  })
}

/** The id of the last rpc frame sent */
function lastRpcId(ws: FakeWebSocket): string {
  const frames = ws.sent.map((s) => JSON.parse(s) as { kind: string; id?: string }).filter((f) => f.kind === 'rpc')
  return frames[frames.length - 1]!.id!
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * An unreadable response is also a response (dogfooding, 2026-09-10).
 *
 * When the host sent an error code not in the protocol, the frame failed validation and was
 * silently dropped, and the caller waited for an answer all the way to the 30-second timeout —
 * the screen stayed at 'loading' the whole time.
 */
describe('RpcClient unreadable response (dogfooding)', () => {
  it('even a failure response that fails validation ends the call — carrying its explanation as-is', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.ready()

    const call = rpc.call('fs.readFile', { projectId: 'p', path: 'item.yml' })
    ws.receive({
      kind: 'res',
      id: lastRpcId(ws),
      ok: false,
      // 'ENOENT' is not in ProtocolErrorCode — the whole frame fails validation
      error: { code: 'ENOENT', message: 'ENOENT: no such file or directory', retryable: false },
    })

    await expect(call).rejects.toThrow('ENOENT: no such file or directory')
    rpc.close()
  })

  it('still ignores a strange frame that is not a call being waited for', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.ready()

    const call = rpc.call('sessions.list', {})
    ws.receive({ kind: 'res', id: 'nobody-waits-for-this', ok: false, error: { code: 'ENOENT', message: 'x' } })
    ws.receive({ kind: 'wat', hello: 1 })
    // Our call is still alive and well — and ends only when the real answer arrives
    ws.receive({ kind: 'res', id: lastRpcId(ws), ok: true, result: { sessions: [] } })

    await expect(call).resolves.toMatchObject({ sessions: [] })
    rpc.close()
  })
})

/**
 * A window attached to an older host (#280). The beta.9 window read a beta.7 host's session list,
 * which had no `backgroundTasks` (#305), and crashed on `undefined.filter`: results reached the
 * screen as sent, so the field's `.default([])` never applied.
 */
describe('RpcClient — an older host\'s answers get the defaults the protocol added since (#280)', () => {
  it('a session list with every defaulted field left out arrives with all of them filled in', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.ready()

    const call = rpc.call('sessions.list', {})
    ws.receive({ kind: 'res', id: lastRpcId(ws), ok: true, result: [withoutDefaultedFields(SessionInfo, currentSession('s1'))] })

    const sessions = await call
    expect(missingDefaults(SessionInfo.array(), sessions)).toEqual([])
    // The line that took the screen down
    expect(liveBackgroundTasks(sessions[0]!.backgroundTasks)).toEqual([])
    rpc.close()
  })
})

describe('RpcClient rejects in-flight calls on disconnect (U1)', () => {
  /*
   * Its outcome is unknown (#82): the host may have run it. It is therefore not marked retryable —
   * a blind retry of a rename or a send could do it twice.
   */
  it('an RPC sent with no answer yet is rejected as unknown, not retryable, when the connection drops', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.ready()

    const call = rpc.call('sessions.list', {})
    ws.drop()

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: false })
    await expect(call).rejects.toThrow('Connection lost before an answer came — the host may or may not have done this')
    rpc.close()
  })

  it('an RPC that was only queued (never sent) while disconnected is not rejected, and is sent and resolved after reconnecting', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws1 = FakeWebSocket.last
    ws1.ready()
    ws1.drop()

    // Calling while disconnected — queuing is the existing contract
    const call = rpc.call('sessions.list', {})

    // The backoff timer produces a reconnect
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws1)
    ws2.ready()

    const id = lastRpcId(ws2)
    ws2.receive({ kind: 'res', id, ok: true, result: [] })
    await expect(call).resolves.toEqual([])
    rpc.close()
  })

  it('a queued call sent after reconnecting (now in-flight) is still rejected on the next disconnect', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.ready()
    FakeWebSocket.last.drop()

    const call = rpc.call('sessions.list', {})
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    ws2.ready() // The queue emptied and it was sent
    ws2.drop() // Dropped again before an answer arrived

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: false })
    rpc.close()
  })

  it('is rejected at the timeout if a response never arrives (even with a fine socket)', async () => {
    const rpc = makeClient({ callTimeoutMs: 5000 })
    rpc.connect()
    FakeWebSocket.last.ready()

    const call = rpc.call('sessions.list', {})
    const assertion = expect(call).rejects.toMatchObject({ code: 'timeout', retryable: true })
    await vi.advanceTimersByTimeAsync(5001)
    await assertion

    // A late-arriving response is quietly ignored (no double resolution)
    FakeWebSocket.last.receive({ kind: 'res', id: lastRpcId(FakeWebSocket.last), ok: true, result: [] })
    rpc.close()
  })

  it('the timeout also cleans up a call stuck in the queue — pending and queue do not grow without bound', async () => {
    const rpc = makeClient({ callTimeoutMs: 5000 })
    rpc.connect()
    FakeWebSocket.last.ready()
    FakeWebSocket.last.drop()

    const call = rpc.call('sessions.list', {})
    const assertion = expect(call).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(5001)
    await assertion

    // A rejected call's frame must not go out again on reconnect
    await vi.advanceTimersByTimeAsync(10_000)
    const ws = FakeWebSocket.last
    ws.ready()
    expect(ws.sent.filter((s) => (JSON.parse(s) as { kind: string }).kind === 'rpc')).toHaveLength(0)
    rpc.close()
  })

  it('updateEndpoint (a host restart) also rejects the in-flight call sent to the old host', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.ready()

    const call = rpc.call('sessions.list', {})
    rpc.updateEndpoint('ws://127.0.0.1:2/', 't2')

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: false })
    rpc.close()
  })
})

/*
 * An RPC that ends in a revival gets a long budget (#164). A revival alone can use up to 150
 * seconds just to start the process (the manager's stage limit), and these five were missing
 * from the list and cut off at 30 seconds — the host applied the settings and restarted, but
 * the screen showed a failure.
 */
describe('RpcClient — budget for a call ending in a revival (#164)', () => {
  const RESUMING = [
    'agents.updateSettings',
    'agents.forkConversation',
    'agents.resolveMcpProposal',
    'agents.resolveSkillProposal',
    'agents.deleteOrchestratorSkill',
  ] as const

  it.each(RESUMING)('%s is not cut off at 30 seconds, but is cut off at 180', async (method) => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.ready()
    let settled = false
    const call = (rpc.call as (m: string, p: unknown) => Promise<unknown>)(method, {})
    const assertion = expect(call.finally(() => (settled = true))).rejects.toMatchObject({ code: 'timeout' })

    await vi.advanceTimersByTimeAsync(30_001)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(150_000)
    await assertion
    rpc.close()
  })
})

/*
 * #173: the starting point for replay. A first-met host replays its whole buffer, and that is
 * all stuff that finished before the screen was attached (a "done" card stood for every
 * finished turn). Attaching to a host that came back up on the same address while still
 * holding the old number meant nothing was ever replayed.
 */
describe('RpcClient — the starting point for replay (#173)', () => {
  const ev = (seq: number) => ({
    kind: 'event',
    seq,
    event: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: `e${seq}` },
  })
  const hellos = (ws: FakeWebSocket) =>
    ws.sent.map((s) => JSON.parse(s) as { kind: string; afterSeq?: number }).filter((f) => f.kind === 'hello')

  function connected() {
    const rpc = makeClient()
    const got: string[] = []
    const conn: string[] = []
    rpc.onEvent((e) => got.push((e as { text: string }).text))
    rpc.onConnectionChange((s) => conn.push(s))
    rpc.connect()
    FakeWebSocket.last.open()
    return { rpc, got, conn }
  }

  it('does not pass through old events replayed by a first-met host, and passes through starting after them', () => {
    const { rpc, got, conn } = connected()
    const ws = FakeWebSocket.last
    expect(hellos(ws)[0]!.afterSeq).toBeUndefined()
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 3 })
    for (const n of [1, 2, 3, 4]) ws.receive(ev(n))
    expect(got).toEqual(['e4'])
    // This was a first meeting, so there is nothing to re-read — the screen just started from the list and the store
    expect(conn).not.toContain('resync_required')

    // The next reconnect states what was received up to, and passes through the replay after that, since it was missed
    ws.drop()
    vi.advanceTimersByTime(1000)
    const ws2 = FakeWebSocket.last
    ws2.open()
    expect(hellos(ws2)[0]!.afterSeq).toBe(4)
    ws2.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 5 })
    ws2.receive(ev(5))
    expect(got).toEqual(['e4', 'e5'])
    rpc.close()
  })

  it('if the host comes back up on the same address with a smaller number, announces a resync and settles on the new number', () => {
    const { rpc, got, conn } = connected()
    const ws = FakeWebSocket.last
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0 })
    for (let n = 1; n <= 50; n++) ws.receive(ev(n))

    ws.drop()
    vi.advanceTimersByTime(1000)
    const ws2 = FakeWebSocket.last
    ws2.open()
    expect(hellos(ws2)[0]!.afterSeq).toBe(50)
    // The new host has only numbered three events
    ws2.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 3 })
    expect(conn.filter((s) => s === 'resync_required')).toHaveLength(1)
    ws2.receive(ev(4))
    expect(got[got.length - 1]).toBe('e4')

    // The next disconnect asks for replay using the new host's number — not the old 50
    ws2.drop()
    vi.advanceTimersByTime(1000)
    const ws3 = FakeWebSocket.last
    ws3.open()
    expect(hellos(ws3)[0]!.afterSeq).toBe(4)
    rpc.close()
  })

  it('a first meeting after switching to a new host does not pass through replay, but does announce that the screen must re-read what it is holding', () => {
    const { rpc, got, conn } = connected()
    FakeWebSocket.last.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0 })
    rpc.updateEndpoint('ws://127.0.0.1:2/', 't2')
    const ws2 = FakeWebSocket.last
    ws2.open()
    ws2.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 2 })
    ws2.receive(ev(1))
    ws2.receive(ev(2))
    expect(got).toEqual([])
    expect(conn).toContain('resync_required')
    rpc.close()
  })
})

/*
 * #82: recovery hardening for the local app. Every test here was run against the code before it
 * and failed; the failures are quoted in the pull request.
 */
describe('RpcClient — authenticated readiness (#82)', () => {
  const rpcFrames = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s) as { kind: string; id?: string }).filter((f) => f.kind === 'rpc')

  it('sends no call and does not report connected until the host says hello_ok', async () => {
    const rpc = makeClient()
    const states: string[] = []
    rpc.onConnectionChange((s) => states.push(s))
    rpc.connect()
    const queued = rpc.call('sessions.list', {})
    const ws = FakeWebSocket.last
    ws.open()
    const whileConnecting = rpc.call('projects.list', {})
    expect(ws.sent.map((s) => (JSON.parse(s) as { kind: string }).kind)).toEqual(['hello'])
    expect(states).toEqual(['connecting'])
    expect(rpc.connectionState).toBe('connecting')

    ws.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0, streamEpoch: 'epoch-a' })
    expect(states).toEqual(['connecting', 'connected'])
    // In the order they were made
    expect(rpcFrames(ws).map((f) => f.id)).toEqual(['1', '2'])
    ws.receive({ kind: 'res', id: '1', ok: true, result: [] })
    ws.receive({ kind: 'res', id: '2', ok: true, result: [] })
    await expect(Promise.all([queued, whileConnecting])).resolves.toEqual([[], []])
    rpc.close()
  })

  it('a handshake the host refuses leaves queued calls unsent and alive, not reported as maybe-delivered', async () => {
    const rpc = makeClient()
    rpc.connect()
    let settled = false
    const call = rpc.call('sessions.rename', { sessionId: 's', name: 'n' }).finally(() => (settled = true))
    const ws = FakeWebSocket.last
    ws.open()
    // A wrong token: the host closes without hello_ok
    ws.drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(rpcFrames(ws)).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    ws2.ready()
    ws2.receive({ kind: 'res', id: lastRpcId(ws2), ok: true, result: { ok: true } })
    await expect(call).resolves.toEqual({ ok: true })
    rpc.close()
  })

  it('drops a socket whose hello_ok never comes, ignores what it sends meanwhile, and retries', async () => {
    const rpc = makeClient({ handshakeTimeoutMs: 100 })
    const events: unknown[] = []
    const states: string[] = []
    rpc.onEvent((e) => events.push(e))
    rpc.onConnectionChange((s) => states.push(s))
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open()
    ws.receive({ kind: 'event', seq: 1, event: { type: 'turn_complete', sessionId: 's' } })
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(ws.readyState).toBe(3)
    expect(states).toEqual(['connecting', 'disconnected'])
    await vi.advanceTimersByTimeAsync(200)
    expect(FakeWebSocket.last).not.toBe(ws)
    rpc.close()
  })
})

describe('RpcClient — host lifetime and duplicates (#82)', () => {
  const ev = (seq: number) => ({ kind: 'event', seq, event: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: `e${seq}` } })
  const hello = (ws: FakeWebSocket) => JSON.parse(ws.sent[0]!) as { afterSeq?: number; streamEpoch?: string }

  function client() {
    const rpc = makeClient()
    const got: string[] = []
    const conn: string[] = []
    rpc.onEvent((e) => got.push((e as { text: string }).text))
    rpc.onConnectionChange((s) => conn.push(s))
    rpc.connect()
    return { rpc, got, conn }
  }

  it('hands each seq on once, whatever repeats arrive', () => {
    const { rpc, got } = client()
    const ws = FakeWebSocket.last
    ws.ready()
    for (const n of [1, 2, 2, 1, 3, 3]) ws.receive(ev(n))
    expect(got).toEqual(['e1', 'e2', 'e3'])
    rpc.close()
  })

  it('reconnects with its cursor and the lifetime that issued it', async () => {
    const { rpc } = client()
    FakeWebSocket.last.ready({ streamEpoch: 'epoch-a' })
    FakeWebSocket.last.receive(ev(1))
    FakeWebSocket.last.receive(ev(2))
    FakeWebSocket.last.drop()
    await vi.advanceTimersByTimeAsync(1000)
    FakeWebSocket.last.open()
    expect(hello(FakeWebSocket.last)).toMatchObject({ afterSeq: 2, streamEpoch: 'epoch-a' })
    rpc.close()
  })

  /*
   * The case #173's `currentSeq < lastSeq` check cannot see: the new lifetime has already numbered
   * past the old cursor. Even a host that fails to say resyncRequired must not get its numbers
   * read as the old lifetime's.
   */
  it('a hello_ok from another lifetime is a resync, even when its numbers are ahead of the cursor', async () => {
    const { rpc, got, conn } = client()
    FakeWebSocket.last.ready({ streamEpoch: 'epoch-a' })
    for (const n of [1, 2, 3]) FakeWebSocket.last.receive(ev(n))
    FakeWebSocket.last.drop()
    await vi.advanceTimersByTimeAsync(1000)
    const ws = FakeWebSocket.last
    ws.open()
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 5, streamEpoch: 'epoch-b' })
    expect(conn.slice(-2)).toEqual(['connected', 'resync_required'])
    // The other lifetime's 4 and 5 are not "what was missed"
    ws.receive(ev(4))
    ws.receive(ev(5))
    ws.receive(ev(6))
    expect(got).toEqual(['e1', 'e2', 'e3', 'e6'])
    ws.drop()
    await vi.advanceTimersByTimeAsync(1000)
    FakeWebSocket.last.open()
    expect(hello(FakeWebSocket.last)).toMatchObject({ afterSeq: 6, streamEpoch: 'epoch-b' })
    rpc.close()
  })

  it('a resync the host asks for moves the cursor to its watermark, so the next reconnect does not ask again', async () => {
    const { rpc, got, conn } = client()
    FakeWebSocket.last.ready({ streamEpoch: 'epoch-a' })
    FakeWebSocket.last.receive(ev(1))
    FakeWebSocket.last.drop()
    await vi.advanceTimersByTimeAsync(1000)
    const ws = FakeWebSocket.last
    ws.open()
    // e.g. the replay would not fit the host's budget
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: true, currentSeq: 900, streamEpoch: 'epoch-a' })
    expect(conn).toContain('resync_required')
    ws.receive(ev(901))
    expect(got).toEqual(['e1', 'e901'])
    ws.drop()
    await vi.advanceTimersByTimeAsync(1000)
    FakeWebSocket.last.open()
    expect(hello(FakeWebSocket.last)).toMatchObject({ afterSeq: 901, streamEpoch: 'epoch-a' })
    rpc.close()
  })
})

/** What a call has come to so far: 'pending', its result, or its error */
function outcomeOf(p: Promise<unknown>): { value: unknown } {
  const o: { value: unknown } = { value: 'pending' }
  p.then(
    (v) => (o.value = v),
    (e) => (o.value = e),
  )
  return o
}

describe('RpcClient — bounded pending work (#82)', () => {
  it('refuses a call over the pending cap before it is queued, and never sends it later', async () => {
    const rpc = makeClient({ maxPendingCalls: 2 })
    rpc.connect()
    const a = rpc.call('sessions.list', {})
    const b = rpc.call('sessions.list', {})
    const third = outcomeOf(rpc.call('sessions.list', {}))
    await vi.advanceTimersByTimeAsync(0)
    expect(third.value).toMatchObject({ code: 'overloaded', retryable: true })
    const ws = FakeWebSocket.last
    ws.ready()
    const ids = ws.sent.map((s) => JSON.parse(s) as { kind: string; id?: string }).filter((f) => f.kind === 'rpc').map((f) => f.id)
    expect(ids).toEqual(['1', '2'])
    ws.receive({ kind: 'res', id: '1', ok: true, result: [] })
    ws.receive({ kind: 'res', id: '2', ok: true, result: [] })
    await Promise.all([a, b])
    // Room again once answered
    const c = rpc.call('sessions.list', {})
    ws.receive({ kind: 'res', id: lastRpcId(ws), ok: true, result: [] })
    await expect(c).resolves.toEqual([])
    rpc.close()
  })

  it('refuses unsent frames over the byte cap while the host is away', async () => {
    const rpc = makeClient({ maxQueuedBytes: 200 })
    rpc.connect()
    const small = rpc.call('sessions.list', {})
    const big = outcomeOf(rpc.call('sessions.rename', { sessionId: 's', name: 'x'.repeat(300) }))
    await vi.advanceTimersByTimeAsync(0)
    expect(big.value).toMatchObject({ code: 'overloaded', retryable: true })
    FakeWebSocket.last.ready()
    expect(FakeWebSocket.last.sent.filter((s) => s.includes('sessions.rename'))).toEqual([])
    FakeWebSocket.last.receive({ kind: 'res', id: '1', ok: true, result: [] })
    await expect(small).resolves.toEqual([])
    rpc.close()
  })
})

describe('RpcClient — unknown outcomes are never replayed (#82, #173)', () => {
  it('a call that went out and lost its answer is rejected and is not sent again after reconnecting', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.ready()
    const call = outcomeOf(rpc.call('sessions.rename', { sessionId: 's', name: 'new' }))
    FakeWebSocket.last.drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(call.value).toMatchObject({ code: 'connection_lost', retryable: false })
    const ws = FakeWebSocket.last
    ws.ready()
    expect(ws.sent.map((s) => (JSON.parse(s) as { kind: string }).kind)).toEqual(['hello'])
    rpc.close()
  })
})

describe('RpcClient — deterministic close (#82)', () => {
  it('close() leaves no timer behind, even with a reconnect pending', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.ready()
    FakeWebSocket.last.drop() // a reconnect is now scheduled
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    rpc.close()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a call after close() fails at once instead of waiting out its timeout', async () => {
    const rpc = makeClient()
    rpc.connect()
    rpc.close()
    await expect(rpc.call('sessions.list', {})).rejects.toMatchObject({ code: 'connection_closed' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

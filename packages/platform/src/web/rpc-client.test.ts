import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcClient } from './rpc-client.js'

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

function makeClient(opts?: { callTimeoutMs?: number }): RpcClient {
  return new RpcClient({
    url: 'ws://127.0.0.1:1/',
    token: 't',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    callTimeoutMs: opts?.callTimeoutMs,
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
    ws.open()

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
    ws.open()

    const call = rpc.call('sessions.list', {})
    ws.receive({ kind: 'res', id: 'nobody-waits-for-this', ok: false, error: { code: 'ENOENT', message: 'x' } })
    ws.receive({ kind: 'wat', hello: 1 })
    // Our call is still alive and well — and ends only when the real answer arrives
    ws.receive({ kind: 'res', id: lastRpcId(ws), ok: true, result: { sessions: [] } })

    await expect(call).resolves.toMatchObject({ sessions: [] })
    rpc.close()
  })
})

describe('RpcClient rejects in-flight calls on disconnect (U1)', () => {
  it('an RPC sent with no answer yet is rejected with a retryable error when the connection drops', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open()

    const call = rpc.call('sessions.list', {})
    ws.drop()

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: true })
    rpc.close()
  })

  it('an RPC that was only queued (never sent) while disconnected is not rejected, and is sent and resolved after reconnecting', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws1 = FakeWebSocket.last
    ws1.open()
    ws1.drop()

    // Calling while disconnected — queuing is the existing contract
    const call = rpc.call('sessions.list', {})

    // The backoff timer produces a reconnect
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws1)
    ws2.open()

    const id = lastRpcId(ws2)
    ws2.receive({ kind: 'res', id, ok: true, result: [] })
    await expect(call).resolves.toEqual([])
    rpc.close()
  })

  it('a queued call sent after reconnecting (now in-flight) is still rejected on the next disconnect', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.open()
    FakeWebSocket.last.drop()

    const call = rpc.call('sessions.list', {})
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    ws2.open() // The queue emptied and it was sent
    ws2.drop() // Dropped again before an answer arrived

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: true })
    rpc.close()
  })

  it('is rejected at the timeout if a response never arrives (even with a fine socket)', async () => {
    const rpc = makeClient({ callTimeoutMs: 5000 })
    rpc.connect()
    FakeWebSocket.last.open()

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
    FakeWebSocket.last.open()
    FakeWebSocket.last.drop()

    const call = rpc.call('sessions.list', {})
    const assertion = expect(call).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(5001)
    await assertion

    // A rejected call's frame must not go out again on reconnect
    await vi.advanceTimersByTimeAsync(10_000)
    const ws = FakeWebSocket.last
    ws.open()
    expect(ws.sent.filter((s) => (JSON.parse(s) as { kind: string }).kind === 'rpc')).toHaveLength(0)
    rpc.close()
  })

  it('updateEndpoint (a host restart) also rejects the in-flight call sent to the old host', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.open()

    const call = rpc.call('sessions.list', {})
    rpc.updateEndpoint('ws://127.0.0.1:2/', 't2')

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: true })
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
    FakeWebSocket.last.open()
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

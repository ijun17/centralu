import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { HostServer } from '../transport/server.js'
import { RemoteClient, type RemoteHello } from './remote-client.js'
import { eventually } from '../../../../tooling/test-timing.js'

/** The hub's connection to a linked machine's host (#82), against the real server */

const TOKEN = 'remote-token'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function host(port = 0, build = { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, version: '0.1.0-beta.11' }) {
  const server = new HostServer({ port, token: TOKEN, onRpc: async (method, params) => ({ method, params }), build })
  const p = await server.listen()
  cleanups.push(() => server.close())
  return { server, port: p }
}

function client(port: number, extra: Partial<ConstructorParameters<typeof RemoteClient>[0]> = {}) {
  const seen = { hellos: [] as RemoteHello[], events: [] as unknown[], terms: [] as unknown[], downs: [] as string[], refusals: [] as unknown[] }
  const c = new RemoteClient(
    { url: `ws://127.0.0.1:${port}`, token: TOKEN, maxBackoffMs: 100, ...extra },
    {
      hello: (h) => seen.hellos.push(h),
      event: (e) => seen.events.push(e),
      terminal: (f) => seen.terms.push(f),
      down: (r) => seen.downs.push(r),
      refused: (r) => seen.refusals.push(r),
    },
  )
  cleanups.push(() => c.close())
  return { c, seen }
}

const ev = (text: string) => ({ type: 'message_delta' as const, sessionId: 's1', role: 'assistant' as const, text })

describe('the link client (#82)', () => {
  it('a first contact takes the host’s number as its start and drops the replay, reporting the remote’s build', async () => {
    const { server, port } = await host()
    server.broadcast(ev('old'))
    const { c, seen } = client(port)
    c.connect()
    await eventually(() => c.connected)
    expect(seen.hellos).toEqual([{ resync: true, newLifetime: true, protocolVersion: PROTOCOL_VERSION, build: expect.objectContaining({ version: '0.1.0-beta.11' }) }])
    server.broadcast(ev('new'))
    await eventually(() => seen.events.length > 0)
    expect(seen.events).toEqual([ev('new')])
  })

  it('a dropped socket reconnects with its cursor and gets what it missed, once', async () => {
    const { server, port } = await host()
    const { c, seen } = client(port)
    c.connect()
    await eventually(() => c.connected)
    server.broadcast(ev('a'))
    await eventually(() => seen.events.length === 1)
    // Cut every socket the host holds; the host keeps running and keeps numbering
    for (const ws of (server as unknown as { clients: Set<{ terminate(): void }> }).clients) ws.terminate()
    await eventually(() => seen.downs.length === 1)
    server.broadcast(ev('b'))
    await eventually(() => seen.events.length === 2)
    expect(seen.events).toEqual([ev('a'), ev('b')])
    expect(seen.hellos.at(-1)).toMatchObject({ resync: false, newLifetime: false })
  })

  it('a host restarted at the same address is a new lifetime: the hub has to read its snapshot again', async () => {
    const first = await host()
    const { c, seen } = client(first.port)
    c.connect()
    await eventually(() => c.connected)
    first.server.broadcast(ev('a'))
    await eventually(() => seen.events.length === 1)
    await first.server.close()
    await eventually(() => seen.downs.length === 1)
    await host(first.port)
    await eventually(() => seen.hellos.length === 2)
    expect(seen.hellos[1]).toMatchObject({ resync: true, newLifetime: true })
  })

  it('a call fails at once while the link is down, instead of waiting for it', async () => {
    const { port } = await host()
    const { c } = client(port, { callTimeoutMs: 60_000 })
    /*
     * "At once" is asserted as "before any timer could run", not as a wall-clock bound: 100 ms on a
     * loaded machine fails for load, and a call that waited for a short timer would still pass it (#845).
     */
    const outcome = await Promise.race([
      c.call('sessions.list', {}).then(() => 'answered', (e: unknown) => e),
      new Promise((r) => setImmediate(() => r('still waiting'))),
    ])
    expect(outcome).toMatchObject({ retryable: true, message: expect.stringMatching(/not reachable/) })
  })

  it('forwards a call and its answer, and a remote failure keeps its code, retry flag and data', async () => {
    const server = new HostServer({
      port: 0,
      token: TOKEN,
      onRpc: async (method) => {
        if (method === 'fail') throw Object.assign(new Error('nope'), { code: 'session_not_found', data: { x: 1 } })
        return { ok: method }
      },
    })
    const port = await server.listen()
    cleanups.push(() => server.close())
    const { c } = client(port)
    c.connect()
    await eventually(() => c.connected)
    expect(await c.call('sessions.list', {})).toEqual({ ok: 'sessions.list' })
    await expect(c.call('fail', {})).rejects.toMatchObject({ code: 'session_not_found', message: 'nope', retryable: false, data: { x: 1 } })
  })

  it('reports a refused token and a refused protocol, and does not retry either', async () => {
    const { port } = await host()
    const wrong = client(port, { token: 'stale' })
    wrong.c.connect()
    await eventually(() => wrong.seen.refusals.length === 1)
    expect(wrong.seen.refusals[0]).toMatchObject({ code: 4001 })

    const other = client(port, { protocolVersion: PROTOCOL_VERSION + 1 })
    other.c.connect()
    await eventually(() => other.seen.refusals.length === 1)
    expect(other.seen.refusals[0]).toMatchObject({
      code: 4002,
      error: { code: 'version_mismatch', data: { protocolVersion: PROTOCOL_VERSION, version: '0.1.0-beta.11' } },
    })
    await new Promise((r) => setTimeout(r, 400))
    expect(wrong.seen.refusals).toHaveLength(1)
    expect(other.seen.refusals).toHaveLength(1)
    expect(wrong.c.connected || other.c.connected).toBe(false)
  })

  it('never answers a request from the remote: the reverse direction is off (plan §3.2)', async () => {
    // A "remote host" that, once greeted, tries to call the hub
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    const fromHub: unknown[] = []
    wss.on('connection', (ws) => {
      ws.on('message', (d) => {
        const f = JSON.parse(String(d)) as { kind: string }
        fromHub.push(f)
        if (f.kind === 'hello') {
          ws.send(JSON.stringify({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false, currentSeq: 0, streamEpoch: 'e' }))
          ws.send(JSON.stringify({ kind: 'rpc', id: 'r1', method: 'fs.readFile', params: { projectId: 'p', path: '.ssh/id_ed25519' } }))
          ws.send(JSON.stringify({ kind: 'hello', token: 'x', protocolVersion: PROTOCOL_VERSION }))
        }
      })
    })
    await new Promise((r) => wss.once('listening', r))
    const { port } = wss.address() as { port: number }
    const { c, seen } = client(port)
    c.connect()
    await eventually(() => c.connected)
    await new Promise((r) => setTimeout(r, 200))
    // Only the hub's own hello went out: nothing answered the request, nothing was dispatched
    expect(fromHub).toEqual([expect.objectContaining({ kind: 'hello' })])
    expect(seen.events).toEqual([])
  })

  it('terminal output arrives with its exit', async () => {
    const { server, port } = await host()
    const { c, seen } = client(port)
    c.connect()
    await eventually(() => c.connected)
    server.pushTerminal({ terminalId: 'term-1', data: 'hi' })
    server.pushTerminal({ terminalId: 'term-1', exitCode: 0 })
    await eventually(() => seen.terms.length === 2)
    expect(seen.terms).toEqual([{ terminalId: 'term-1', data: 'hi' }, { terminalId: 'term-1', exitCode: 0 }])
  })
})

/*
 * The hub's ssh forward listens on a loopback port that another account on the hub can take first (#838). The hello
 * carries the remote's token, so a host that can prove it holds the token is asked to before the hello goes out.
 */
describe('a host asked to prove it holds the token (#838)', () => {
  /** What holds the forward's port instead of the host: it records what it is sent and answers as told */
  async function squatter(answer: (frame: Record<string, unknown>) => unknown) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const got: string[] = []
    wss.on('connection', (ws) => {
      ws.on('message', (d) => {
        got.push(String(d))
        const reply = answer(JSON.parse(String(d)) as Record<string, unknown>)
        if (reply !== undefined) ws.send(JSON.stringify(reply))
      })
    })
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    return { port: (wss.address() as { port: number }).port, got }
  }

  it('the real host proves it, and the link comes up as before', async () => {
    const { port } = await host()
    const { c, seen } = client(port, { proveHost: true })
    c.connect()
    await eventually(() => c.connected)
    expect(seen.hellos).toHaveLength(1)
  })

  // A machine rolled back to a build from before #838 closes on `prove` (4001): a refusal, so the line is read again
  it('a host that refuses the prove is reported as a refusal, not retried', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    let opened = 0
    wss.on('connection', (ws) => {
      opened++
      ws.on('message', () => ws.close(4001, 'not a hello'))
    })
    const { c, seen } = client((wss.address() as { port: number }).port, { proveHost: true })
    c.connect()
    await eventually(() => seen.refusals.length === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(seen.refusals).toEqual([expect.objectContaining({ code: 4001 })])
    expect(opened).toBe(1)
    expect(seen.downs).toEqual([])
  })

  it('a program on the port that cannot prove it never receives the token', async () => {
    for (const answer of [
      () => undefined,
      (f: Record<string, unknown>) => ({ kind: 'proof', nonce: f.nonce, mac: 'x'.repeat(43) }),
      () => ({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false, currentSeq: 0 }),
    ]) {
      const s = await squatter(answer)
      const { c } = client(s.port, { proveHost: true, handshakeTimeoutMs: 300 })
      c.connect()
      await eventually(() => s.got.length > 0)
      await new Promise((r) => setTimeout(r, 400))
      expect(c.connected).toBe(false)
      expect(s.got.join('\n')).not.toContain(TOKEN)
      expect(JSON.parse(s.got[0]!)).toMatchObject({ kind: 'prove' })
      c.close()
    }
  })
})

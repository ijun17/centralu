import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { HostServer } from '../transport/server.js'
import { MAX_INCOMING_CALLS, RemoteClient, type RemoteHello } from './remote-client.js'
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

/** A socket class that counts the sockets a client opens: a retry is a new one, made the moment its delay runs out */
function counted() {
  const opened = { n: 0 }
  class Counted extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args)
      opened.n++
    }
  }
  // Its one constructor stands for ws's overloads, which TypeScript cannot match one by one
  return { opened, Counted: Counted as unknown as typeof WebSocket }
}

/**
 * Waits until a client has had its reconnect delay run out `n` times (#845), against a socket that closes at once:
 * what proves that a retry another client would have made in the meantime has been made, where a fixed sleep proved
 * nothing on a loaded machine. Every client here has the same delay (`maxBackoffMs`), and Node runs timers of one
 * delay in the order they were set, so a retry set before this one's is made first.
 */
async function retriesPassed(n: number) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
  wss.on('connection', (ws) => ws.close(1011))
  const { opened, Counted } = counted()
  const { c } = client((wss.address() as { port: number }).port, { WebSocketImpl: Counted })
  c.connect()
  await eventually(() => opened.n > n)
  c.close()
}

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
    const sockets = counted()
    const wrong = client(port, { token: 'stale', WebSocketImpl: sockets.Counted })
    wrong.c.connect()
    await eventually(() => wrong.seen.refusals.length === 1)
    expect(wrong.seen.refusals[0]).toMatchObject({ code: 4001 })

    const other = client(port, { protocolVersion: PROTOCOL_VERSION + 1, WebSocketImpl: sockets.Counted })
    other.c.connect()
    await eventually(() => other.seen.refusals.length === 1)
    expect(other.seen.refusals[0]).toMatchObject({
      code: 4002,
      error: { code: 'version_mismatch', data: { protocolVersion: PROTOCOL_VERSION, version: '0.1.0-beta.11' } },
    })
    await retriesPassed(2)
    // One socket each: neither refusal was tried again
    expect(sockets.opened.n).toBe(2)
    expect(wrong.seen.refusals).toHaveLength(1)
    expect(other.seen.refusals).toHaveLength(1)
    expect(wrong.c.connected || other.c.connected).toBe(false)
  })

  it('without a handler, never answers a request from the remote: the reverse direction is off (plan §3.2)', async () => {
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
          // Read only after the two before it: once it arrives, the client has had its chance to act on them
          ws.send(JSON.stringify({ kind: 'event', seq: 1, event: ev('after') }))
        }
        if (f.kind === 'rpc') ws.send(JSON.stringify({ kind: 'res', id: (f as { id?: string }).id, ok: true, result: null }))
      })
    })
    await new Promise((r) => wss.once('listening', r))
    const { port } = wss.address() as { port: number }
    const { c, seen } = client(port)
    c.connect()
    await eventually(() => c.connected)
    await eventually(() => seen.events.length > 0)
    // A call of the hub's own: what it sent before this reaches the remote before it does, on the same socket
    await c.call('sessions.list', {})
    // Only the hub's own hello and call went out: nothing answered the request, nothing was dispatched
    expect(fromHub).toEqual([expect.objectContaining({ kind: 'hello' }), expect.objectContaining({ kind: 'rpc', method: 'sessions.list' })])
    expect(seen.events).toEqual([ev('after')])
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
describe('calls from the remote host: the reverse direction (#550)', () => {
  /** A real host with the hub connected, and the client number the host knows the hub's socket by */
  async function linked(handler: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>) {
    let hubClient = 0
    const server = new HostServer({
      port: 0,
      token: TOKEN,
      onRpc: async (_m, _p, ctx) => {
        hubClient = ctx!.client
        return {}
      },
    })
    const port = await server.listen()
    cleanups.push(() => server.close())
    const c = new RemoteClient({ url: `ws://127.0.0.1:${port}`, token: TOKEN, maxBackoffMs: 100 }, { call: handler })
    cleanups.push(() => c.close())
    c.connect()
    await eventually(() => c.connected)
    await c.call('anything', {})
    return { server, c, client: hubClient }
  }

  it('answers through the handler the link gave, a result and a refusal with its code', async () => {
    const seen: unknown[] = []
    const { server, client } = await linked(async (method, params) => {
      seen.push({ method, params })
      if (method === 'hub.projects') return { projects: [{ id: 'p1', name: 'cc' }] }
      throw Object.assign(new Error('Unknown method: fs.readFile'), { code: 'not_supported' })
    })
    await expect(server.call(client, 'hub.projects', { a: 1 })).resolves.toEqual({ projects: [{ id: 'p1', name: 'cc' }] })
    await expect(server.call(client, 'fs.readFile', {})).rejects.toThrow('Unknown method: fs.readFile')
    expect(seen).toEqual([{ method: 'hub.projects', params: { a: 1 } }, { method: 'fs.readFile', params: {} }])
  })

  it('aborts the handler when the host withdraws the call, and when the link closes', async () => {
    const aborted: string[] = []
    const started: string[] = []
    const { server, c, client } = await linked(
      (method, _p, signal) =>
        new Promise((_resolve, reject) => {
          started.push(method)
          signal.addEventListener('abort', () => {
            aborted.push(method)
            reject(new Error('aborted'))
          })
        }),
    )
    const ctl = new AbortController()
    const first = server.call(client, 'one', {}, { signal: ctl.signal })
    const second = server.call(client, 'two', {})
    await eventually(() => started.length === 2)
    ctl.abort()
    await expect(first).rejects.toThrow('cancelled')
    await eventually(() => aborted.includes('one'))
    expect(aborted).toEqual(['one'])
    c.close()
    await eventually(() => aborted.includes('two'))
    await expect(second).rejects.toThrow()
  })

  it(`refuses a call past ${MAX_INCOMING_CALLS} running at once instead of queueing it`, async () => {
    const release: (() => void)[] = []
    const { server, client } = await linked(() => new Promise((resolve) => release.push(() => resolve('done'))))
    const running = Array.from({ length: MAX_INCOMING_CALLS }, (_, i) => server.call(client, `m${i}`, {}))
    await eventually(() => release.length === MAX_INCOMING_CALLS)
    await expect(server.call(client, 'one-too-many', {})).rejects.toThrow('Too many calls at once')
    for (const r of release) r()
    await expect(Promise.all(running)).resolves.toHaveLength(MAX_INCOMING_CALLS)
  })
})

describe('a host asked to prove it holds the token (#838)', () => {
  /** What holds the forward's port instead of the host: it records what it is sent and answers as told */
  async function squatter(answer: (frame: Record<string, unknown>) => unknown) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const got: string[] = []
    /** Per connection, in order: whether the hub has closed it */
    const conns: { closed: boolean }[] = []
    wss.on('connection', (ws) => {
      const conn = { closed: false }
      conns.push(conn)
      ws.on('close', () => (conn.closed = true))
      ws.on('message', (d) => {
        got.push(String(d))
        const reply = answer(JSON.parse(String(d)) as Record<string, unknown>)
        if (reply !== undefined) ws.send(JSON.stringify(reply))
      })
    })
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())))
    return { port: (wss.address() as { port: number }).port, got, conns }
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
    const sockets = counted()
    const { c, seen } = client((wss.address() as { port: number }).port, { proveHost: true, WebSocketImpl: sockets.Counted })
    c.connect()
    await eventually(() => seen.refusals.length === 1)
    await retriesPassed(2)
    expect(seen.refusals).toEqual([expect.objectContaining({ code: 4001 })])
    expect(sockets.opened.n).toBe(1)
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
      /*
       * The client gave up on the first socket (closed, and all it sent on it received) and came back with a new
       * prove: it is done with that answer, where a fixed sleep could end first on a loaded machine (#845)
       */
      await eventually(() => s.conns[0]?.closed && s.got.length >= 2)
      expect(c.connected).toBe(false)
      expect(s.got.join('\n')).not.toContain(TOKEN)
      for (const frame of s.got) expect(JSON.parse(frame)).toMatchObject({ kind: 'prove' })
      c.close()
    }
  })
})

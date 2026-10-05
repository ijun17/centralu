/** WS server round trip + reconnect restoration (T3-1 integration) */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request, type IncomingHttpHeaders } from 'node:http'
import { PROTOCOL_VERSION, parseServerFrame, type NormalizedEvent } from '@cc/protocol'
import { HostServer, parseAllowedOrigins, versionMismatchMessage, type HostServerOptions } from './server.js'
import { deriveHttpSecret, sameSecret, secretError, type HttpRoute } from './http.js'

const TOKEN = 'test-token'
let server: HostServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

async function start(onRpc = async () => ({ ok: true }), extra: Partial<HostServerOptions> = {}) {
  server = new HostServer({ port: 0, token: TOKEN, onRpc, ...extra })
  const port = await server.listen()
  return { server: server!, port }
}

function connect(port: number, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : undefined)
  const frames: Record<string, unknown>[] = []
  ws.on('message', (d) => frames.push(JSON.parse(String(d))))
  return {
    ws,
    frames,
    open: () => new Promise<void>((r) => ws.on('open', () => r())),
    closed: () => new Promise<number>((r) => ws.on('close', (code) => r(code))),
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    wait: async (pred: () => boolean, ms = 2000) => {
      const t0 = Date.now()
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error('timeout')
        await new Promise((r) => setTimeout(r, 10))
      }
    },
  }
}

const ev = (text: string): NormalizedEvent => ({ type: 'message_delta', sessionId: 's1', role: 'assistant', text })

describe('handshake', () => {
  it('allows the token handshake from a browser dev origin', async () => {
    // Given: the supported Vite browser origin connects to the host.
    const { port } = await start()
    const c = connect(port, 'http://127.0.0.1:5174')

    // When: it presents the shared launch token.
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)

    // Then: the observable handshake succeeds.
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION })
    c.ws.close()
  })

  it('allows the token handshake from a desktop dev origin', async () => {
    // Given: the Tauri desktop dev server origin connects to the host.
    const { port } = await start()
    const c = connect(port, 'http://127.0.0.1:5173')

    // When: it presents the shared launch token.
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)

    // Then: the observable handshake succeeds.
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION })
    c.ws.close()
  })

  it.each(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'])(
    'allows the token handshake from the Tauri origin %s',
    async (origin) => {
      // Given: a supported packaged WebView origin connects to the host.
      const { port } = await start()
      const c = connect(port, origin)

      // When: it presents the shared launch token.
      await c.open()
      c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
      await c.wait(() => c.frames.length > 0)

      // Then: the observable handshake succeeds.
      expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION })
      c.ws.close()
    },
  )

  it('a malicious origin is rejected at the upgrade, before it can ever send a valid token', async () => {
    // Given: a cross-site browser origin knows a valid token.
    const { port } = await start()
    const c = connect(port, 'http://evil.example')

    // When: it attempts the WebSocket upgrade.
    const observed = await new Promise<string>((resolve) => {
      c.ws.on('open', () => resolve('opened'))
      c.ws.on('error', (err) => resolve(err.message))
    })

    // Then: the socket never opens, so token auth is unreachable from that origin.
    expect(observed).toContain('Unexpected server response')
    expect(observed).not.toBe('opened')
    // If the rejection ever breaks, this socket stays open — closed here so afterEach never burns 10 seconds over it
    c.ws.close()
  })

  it('the literal null origin is not treated like a native no-origin connection', async () => {
    // Given: a sandboxed/browser request sends the literal Origin: null value.
    const { port } = await start()
    const c = connect(port, 'null')

    // When: it attempts the WebSocket upgrade.
    const observed = await new Promise<string>((resolve) => {
      c.ws.on('open', () => resolve('opened'))
      c.ws.on('error', (err) => resolve(err.message))
    })

    // Then: the host rejects it at the origin boundary.
    expect(observed).toContain('Unexpected server response')
    expect(observed).not.toBe('opened')
    c.ws.close()
  })

  it('a correct token gets hello_ok', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false })
    c.ws.close()
  })

  /** A window of another build can attach to this host through the keeper, and must be able to tell (#280) */
  it('hello_ok says which build the host is and where it came from', async () => {
    const build = { commit: 'abc1234', protocolVersion: PROTOCOL_VERSION, bundlePath: '/Applications/Centralu.app' }
    const { port } = await start(undefined, { build })
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', build })
    expect(parseServerFrame(c.frames[0]).success).toBe(true)
    c.ws.close()
  })



  it.each(['http://localhost:5173', 'http://localhost:5174'])('localhost dev origin %s is allowed with the token', async (origin) => {
    // Given: a browser uses localhost instead of 127.0.0.1 for the supported dev port.
    const { port } = await start()
    const c = connect(port, origin)

    // When: it presents the shared launch token.
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)

    // Then: origin allowlisting does not reject the legitimate localhost variant.
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION })
    c.ws.close()
  })

  it('empty server tokens are rejected before listen', async () => {
    // Given / When / Then: an empty token cannot accidentally become an accepted credential.
    expect(() => new HostServer({ port: 0, token: '', onRpc: async () => ({ ok: true }) })).toThrow(/token/i)
  })

  /**
   * A single `CC_HOST_TOKEN=" "` split the host's and the UI's judgment: the host accepted " " as
   * a normal token and got as far as listen (guessable in just a few tries), while the browser
   * trimmed it, found it empty, and threw MissingHostTokenError, never connecting at all. Checks
   * that both sides use the same rule.
   */
  it.each([' ', '\t', '\n', '   '])('a whitespace-only token (%j) is rejected by the same rule as the browser', (token) => {
    // Given / When / Then: whitespace is not a credential on either side of the socket.
    expect(() => new HostServer({ port: 0, token, onRpc: async () => ({ ok: true }) })).toThrow(/token/i)
  })

  it('the host logs the fact when rejecting a disallowed origin', async () => {
    // Given: the host is running and nothing has been logged yet.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '))
    })
    try {
      const { port } = await start()

      // When: a cross-site origin attempts the upgrade and is refused.
      const c = connect(port, 'http://evil.example')
      await new Promise<void>((resolve) => {
        c.ws.on('open', () => resolve())
        c.ws.on('error', () => resolve())
      })
      c.ws.close()

      // Then: the operator can tell this apart from "the host is down".
      expect(logged.join('\n')).toContain('http://evil.example')
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * A blocked UI does not give up — since its backoff caps out at 5 seconds (web/rpc-client.ts),
   * logging every attempt per origin would pile up more than 700 identical lines an hour in
   * host.log. Checks that only the first line remains.
   */
  it('logs the rejection only once even when the same origin keeps retrying', async () => {
    // Given: a host, and a blocked origin that behaves like the UI's retry loop.
    const logged: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '))
    })
    try {
      const { port } = await start()
      const attempt = async (origin: string) => {
        const c = connect(port, origin)
        await new Promise<void>((resolve) => {
          c.ws.on('open', () => resolve())
          c.ws.on('error', () => resolve())
        })
        c.ws.close()
      }

      // When: it retries three times, and a second blocked origin appears once.
      await attempt('http://evil.example')
      await attempt('http://evil.example')
      await attempt('http://evil.example')
      await attempt('http://other.example')

      // Then: one line per distinct origin, not one per attempt.
      expect(logged.filter((l) => l.includes('http://evil.example'))).toHaveLength(1)
      expect(logged.filter((l) => l.includes('http://other.example'))).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  /*
   * That memory has to have a cap. The key is the Origin header a request sends — a value chosen
   * from outside — so storing it without bound would let anyone able to reach loopback knock with a
   * different origin each time and grow the host's memory. No token is required. The same spot used
   * to hang shutdown too, with no authentication needed either.
   */
  it('the rejection-log memory does not grow without bound — origin is a value chosen from outside', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { port, server } = await start()
      for (let i = 0; i < 200; i++) {
        const c = connect(port, `http://evil-${i}.example`)
        await new Promise<void>((resolve) => {
          c.ws.on('open', () => resolve())
          c.ws.on('error', () => resolve())
        })
        c.ws.close()
      }

      const memo = (server as unknown as { loggedRejections: Set<string> }).loggedRejections
      expect(memo.size).toBeLessThanOrEqual(64)
    } finally {
      spy.mockRestore()
    }
  })

  it('CC_HOST_ALLOWED_ORIGINS replaces the default list and lets a connection through', async () => {
    // Given: a host started from the environment override rather than the built-in list.
    server = new HostServer({
      port: 0,
      token: TOKEN,
      allowedOrigins: parseAllowedOrigins(' http://192.168.1.9:4000 , '),
      onRpc: async () => ({ ok: true }),
    })
    const port = await server.listen()

    // When: the overridden origin attempts the upgrade.
    const c = connect(port, 'http://192.168.1.9:4000')
    // If rejected, open never comes — whichever of the two arrives first has to be caught so a
    // failure with "why it failed" written on it comes back instead of a 5-second timeout
    const upgrade = await new Promise<string>((resolve) => {
      c.ws.on('open', () => resolve('opened'))
      c.ws.on('error', (err) => resolve(err.message))
    })
    expect(upgrade).toBe('opened')
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)

    // Then: it is accepted, so there is an escape hatch from the built-in list.
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok' })
    c.ws.close()
  })

  /**
   * If an empty value became an empty allow list, that would make **a host nobody can connect to.**
   * An environment variable ending up empty by accident is common, so an empty value is read as
   * "not configured" rather than an override, and falls back to the default.
   */
  it.each([undefined, '', '   ', ',', ' , , '])(
    'CC_HOST_ALLOWED_ORIGINS of %j is not treated as an override',
    (raw) => {
      // Given / When / Then: a blank value falls back to the built-in list, not to nothing.
      expect(parseAllowedOrigins(raw)).toBeUndefined()
    },
  )
  it('a wrong token closes the connection', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: 'wrong', protocolVersion: PROTOCOL_VERSION })
    expect(await c.closed()).toBe(4001)
  })

  it('rejects a mismatched protocol version', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: 999 })
    expect(await c.closed()).toBe(4002)
  })

  it('tells a newer app that the host is the side to update', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION + 1 })
    expect(await c.closed()).toBe(4002)
    const refusal = c.frames.find((f) => f.kind === 'res') as { error: { code: string; message: string } } | undefined
    expect(refusal?.error.code).toBe('version_mismatch')
    expect(refusal?.error.message).toContain(`host speaks protocol ${PROTOCOL_VERSION}`)
    expect(refusal?.error.message).toContain('update Centralu where the host runs')
  })

  it('tells an older app that the app is the side to update, naming the host version', () => {
    const message = versionMismatchMessage(3, 2, '0.2.0')
    expect(message).toContain('Centralu 0.2.0 speaks protocol 3, the app speaks protocol 2')
    expect(message).toContain('update the Centralu app on this computer')
    expect(message).not.toContain('where the host runs')
  })

  it('closes the connection if RPC is sent without authenticating', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'rpc', id: '1', method: 'sessions.list', params: {} })
    expect(await c.closed()).toBe(4001)
  })
})

describe('RPC round trip', () => {
  it('returns the result', async () => {
    const { port } = await start(async () => ({ hello: 'world' }) as never)
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    c.send({ kind: 'rpc', id: 'r1', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res'))
    expect(c.frames.find((f) => f.kind === 'res')).toMatchObject({ id: 'r1', ok: true, result: { hello: 'world' } })
    c.ws.close()
  })

  it('converts a handler error into a ProtocolError', async () => {
    const { port } = await start(async () => {
      throw Object.assign(new Error('session not found'), { code: 'session_not_found' })
    })
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    c.send({ kind: 'rpc', id: 'r1', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res'))
    expect(c.frames.find((f) => f.kind === 'res')).toMatchObject({
      ok: false,
      error: { code: 'session_not_found', message: 'session not found' },
    })
    c.ws.close()
  })

  /**
   * Most of the failures that arrive here are Node's own failures — `fs.stat` comes with `ENOENT`.
   * Putting that string into the envelope as is gives it a value outside the protocol, and the
   * client drops the whole frame: the failure **never arrives** (dogfooding 2026-09-10 — a file
   * link showed as a blank screen).
   */
  it('an error code the protocol does not know goes out as internal, with the message carried through as is', async () => {
    const { port } = await start(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, stat '/p/item.yml'"), { code: 'ENOENT' })
    })
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    c.send({ kind: 'rpc', id: 'r1', method: 'fs.readFile', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res'))
    expect(c.frames.find((f) => f.kind === 'res')).toMatchObject({
      ok: false,
      error: { code: 'internal', message: "ENOENT: no such file or directory, stat '/p/item.yml'" },
    })
    c.ws.close()
  })
})

describe('reconnect restoration (docs/protocol.md §1)', () => {
  it('receives events that happened while disconnected, via afterSeq', async () => {
    const { server: srv, port } = await start()

    const c1 = connect(port)
    await c1.open()
    c1.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c1.wait(() => c1.frames.length > 0)
    srv.broadcast(ev('1'))
    srv.broadcast(ev('2'))
    await c1.wait(() => c1.frames.filter((f) => f.kind === 'event').length === 2)
    c1.ws.close()

    // The host keeps logging even while the UI is closed
    srv.broadcast(ev('3'))
    srv.broadcast(ev('4'))

    const c2 = connect(port)
    await c2.open()
    // The cursor travels with the lifetime that issued it (#82)
    const epoch = (c1.frames[0] as { streamEpoch: string }).streamEpoch
    expect(epoch).toBe(srv.streamEpoch)
    c2.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 2, streamEpoch: epoch })
    await c2.wait(() => c2.frames.filter((f) => f.kind === 'event').length === 2)

    const replayed = c2.frames.filter((f) => f.kind === 'event')
    expect(replayed.map((f) => f.seq)).toEqual([3, 4])
    expect(c2.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: false, currentSeq: 4, streamEpoch: epoch })
    c2.ws.close()
  })

  it('broadcasts to multiple clients', async () => {
    const { server: srv, port } = await start()
    const a = connect(port)
    const b = connect(port)
    await Promise.all([a.open(), b.open()])
    for (const c of [a, b]) c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await Promise.all([a.wait(() => a.frames.length > 0), b.wait(() => b.frames.length > 0)])
    srv.broadcast(ev('x'))
    await Promise.all([
      a.wait(() => a.frames.some((f) => f.kind === 'event')),
      b.wait(() => b.frames.some((f) => f.kind === 'event')),
    ])
    a.ws.close()
    b.ws.close()
  })
})

/**
 * The HTTP door on the same port (M4 P-2). App views' sandbox proxy is served on this port. Since
 * this door is one anyone able to reach loopback can knock on (another program on the same
 * machine, any web page opened in a browser), **every route sits behind a secret path segment.**
 * If the secret is missing or wrong, the same 404 goes out as when the route does not exist.
 */
describe('HTTP door (M4 P-2)', () => {
  const SECRET = 'S'.repeat(20) + 'ecret-for-the-http-gate-01'

  type Seen = { method: string; path: string; query: Record<string, string>; probe?: string; params: readonly string[] }

  async function startHttp(routes: HttpRoute[]) {
    server = new HostServer({ port: 0, token: TOKEN, onRpc: async () => ({ ok: true }), http: { secret: SECRET, routes } })
    return server.listen()
  }

  /** Sends the path **exactly as written** — fetch would already collapse `..` and `//`, which would prevent building the attack shape */
  function raw(port: number, method: string, path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  function echoRoutes(seen: Seen[]): HttpRoute[] {
    return [
      {
        method: 'GET',
        path: '/echo',
        handle: (r) => {
          seen.push({ method: r.method, path: r.path, query: Object.fromEntries(r.query), probe: r.headers['x-probe'] as string | undefined, params: r.params })
          return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'echo' }
        },
      },
      {
        method: 'POST',
        path: '/echo',
        handle: () => ({ status: 200, body: 'posted' }),
      },
      {
        method: 'GET',
        path: /\/items\/([a-z]+)\/(\d+)/,
        handle: (r) => {
          seen.push({ method: r.method, path: r.path, query: {}, params: r.params })
          return { status: 200, body: `item ${r.params[0]} ${r.params[1]}` }
        },
      },
      {
        method: 'GET',
        path: '/slow',
        // An async answer: the response has to stay open while the handler waits
        handle: async () => {
          await new Promise((r) => setTimeout(r, 30))
          return { status: 200, body: 'late' }
        },
      },
      { method: 'GET', path: '/nothing-here', handle: () => null },
      {
        method: 'GET',
        path: '/boom',
        handle: () => {
          throw new Error('ENOENT: /Users/someone/.centralu/secret-file')
        },
      },
    ]
  }

  it('a route receives method, path, query, and headers, and can answer asynchronously', async () => {
    // Given: a host with gated routes.
    const seen: Seen[] = []
    const port = await startHttp(echoRoutes(seen))

    // When: requests carry the secret, a query and a header.
    const echo = await raw(port, 'GET', `/${SECRET}/echo?x=1&y=two`, { 'x-probe': 'hello' })
    const posted = await raw(port, 'POST', `/${SECRET}/echo`)
    const item = await raw(port, 'GET', `/${SECRET}/items/abc/42`)
    const late = await raw(port, 'GET', `/${SECRET}/slow`)

    // Then: the route sees everything, without the secret segment, and async answers arrive.
    expect(echo).toMatchObject({ status: 200, body: 'echo' })
    expect(posted).toMatchObject({ status: 200, body: 'posted' })
    expect(item).toMatchObject({ status: 200, body: 'item abc 42' })
    expect(late).toMatchObject({ status: 200, body: 'late' })
    expect(seen[0]).toEqual({ method: 'GET', path: '/echo', query: { x: '1', y: 'two' }, probe: 'hello', params: [] })
    expect(seen[1]).toMatchObject({ path: '/items/abc/42', params: ['abc', '42'] })
  })

  it('a different method or a path that does not match in full is a 404', async () => {
    const port = await startHttp(echoRoutes([]))

    // Same path with a different method / a prefix or suffix on a regex route / the handler returning null
    for (const [method, path] of [
      ['DELETE', '/echo'],
      ['HEAD', '/echo'],
      ['GET', '/items/abc/42/more'],
      ['GET', '/x/items/abc/42'],
      ['GET', '/items/ABC/42'],
      ['GET', '/nothing-here'],
    ] as const) {
      const r = await raw(port, method, `/${SECRET}${path}`)
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 404 })
    }
  })

  it('a handler that throws is a 500, and the reason is never carried in the response', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = await startHttp(echoRoutes([]))
      const r = await raw(port, 'GET', `/${SECRET}/boom`)
      expect(r.status).toBe(500)
      expect(r.body).toBe('internal error')
      expect(r.body).not.toContain('ENOENT')
      // Recorded in the host log, but the secret (the URL) is never written there
      const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toContain('ENOENT')
      expect(logged).not.toContain(SECRET)
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * **Nothing at all** must be reachable without the secret. An existing path, a nonexistent path,
   * a value one character off from the secret, a prefix of the secret, the secret placed in the
   * second segment, one twisted with encoding or `..` — all of these must produce the same 404. Not
   * only the status but the body and headers too, so "the secret is wrong" and "the route does not
   * exist" are never distinguishable.
   */
  it('reaching it without the secret is nothing but 404, indistinguishable between a wrong secret and a nonexistent route', async () => {
    const seen: Seen[] = []
    const port = await startHttp(echoRoutes(seen))
    const wrong = SECRET.slice(0, -1) + (SECRET.endsWith('1') ? '2' : '1')
    const paths = [
      '/',
      '/echo',
      '/items/abc/42',
      '/slow',
      '/favicon.ico',
      `/${wrong}/echo`,
      `/${SECRET.slice(0, -1)}/echo`,
      `/${SECRET}x/echo`,
      `/${SECRET.toLowerCase()}/echo`,
      `/x/${SECRET}/echo`,
      `//${SECRET}/echo`,
      `/%2F${SECRET}/echo`,
      `/${encodeURIComponent(SECRET).replace('S', '%53')}/echo`,
      `/x/../echo`,
      `/${wrong}/../echo`,
      `/echo?secret=${SECRET}`,
    ]
    const answers = new Set<string>()
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      for (const path of paths) {
        const r = await raw(port, method, path, { 'x-secret': SECRET, authorization: `Bearer ${SECRET}` })
        answers.add(JSON.stringify({ status: r.status, body: r.body, type: r.headers['content-type'] }))
      }
    }
    // Compared against a nonexistent route: correct secret, nonexistent route
    const noRoute = await raw(port, 'GET', `/${SECRET}/no-such-route`)
    answers.add(JSON.stringify({ status: noRoute.status, body: noRoute.body, type: noRoute.headers['content-type'] }))

    expect([...answers]).toEqual([JSON.stringify({ status: 404, body: 'not found', type: 'text/plain; charset=utf-8' })])
    // The handler was never called even once
    expect(seen).toEqual([])
  })

  it('every response cuts off referrer — the secret is in the path, so a view must never inherit it', async () => {
    const port = await startHttp(echoRoutes([]))
    for (const path of [`/${SECRET}/echo`, '/echo', `/${SECRET}/nope`]) {
      const r = await raw(port, 'GET', path)
      expect(r.headers['referrer-policy']).toBe('no-referrer')
      expect(r.headers['cache-control']).toBe('no-store')
    }
  })

  it('every HTTP request is a 404 with no gate (the same as the old default)', async () => {
    const { port } = await start()
    for (const path of ['/', '/echo', `/${SECRET}/echo`]) expect((await raw(port, 'GET', path)).status).toBe(404)
  })

  it.each(['', 'short-secret', 'x'.repeat(31), `${'y'.repeat(40)}/slash`, `${'z'.repeat(40)} space`])(
    'rejects the secret value %j — too short, or cannot fit in one URL segment',
    (secret) => {
      expect(() => new HostServer({ port: 0, token: TOKEN, onRpc: async () => ({ ok: true }), http: { secret, routes: [] } })).toThrow(/secret/i)
    },
  )

  it("WebSocket's origin and token rules stay unchanged even with an HTTP door present", async () => {
    const port = await startHttp(echoRoutes([]))

    const good = connect(port, 'http://127.0.0.1:5174')
    await good.open()
    good.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await good.wait(() => good.frames.length > 0)
    expect(good.frames[0]).toMatchObject({ kind: 'hello_ok' })
    good.ws.close()

    for (const origin of ['http://evil.example', 'null']) {
      const bad = connect(port, origin)
      const observed = await new Promise<string>((resolve) => {
        bad.ws.on('open', () => resolve('opened'))
        bad.ws.on('error', (err) => resolve(err.message))
      })
      expect(observed).toContain('Unexpected server response')
      bad.ws.close()
    }

    const wrongToken = connect(port)
    await wrongToken.open()
    wrongToken.send({ kind: 'hello', token: 'wrong', protocolVersion: PROTOCOL_VERSION })
    expect(await wrongToken.closed()).toBe(4001)
  })
})

describe('sameSecret', () => {
  it('only equal values are true — it does not bail out early even for different lengths', () => {
    expect(sameSecret('abc', 'abc')).toBe(true)
    expect(sameSecret('abc', 'abd')).toBe(false)
    expect(sameSecret('ab', 'abc')).toBe(false)
    expect(sameSecret('', 'abc')).toBe(false)
  })
})

describe('the HTTP secret under the keeper (#280 step 4)', () => {
  it('is the same for every host given the same keeper token, differs per token, is a valid secret and is not the token', () => {
    const token = 'a3f1c0de9b8e7d6c5b4a39281706f5e4'
    const secret = deriveHttpSecret(token)
    expect(deriveHttpSecret(token)).toBe(secret)
    expect(deriveHttpSecret(`${token}x`)).not.toBe(secret)
    expect(secretError(secret)).toBeNull()
    expect(secret).not.toContain(token)
  })
})

/*
 * #82: recovery hardening, host side. Each test was run against the code before it and failed; the
 * failures are quoted in the pull request.
 */
describe('host lifetime and replay (#82)', () => {
  const hello = (extra: Record<string, unknown> = {}) => ({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, ...extra })
  const events = (c: ReturnType<typeof connect>) => c.frames.filter((f) => f.kind === 'event')

  /** Says hello, then makes one RPC and waits for its answer — by then everything the hello caused has arrived */
  async function greet(port: number, extra: Record<string, unknown> = {}) {
    const c = connect(port)
    await c.open()
    c.send(hello(extra))
    c.send({ kind: 'rpc', id: 'probe', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res' && f.id === 'probe'))
    return c
  }

  it('a cursor issued by a host that has since restarted gets a resync and none of the new host\'s events', async () => {
    const before = await start()
    const epochBefore = before.server.streamEpoch
    for (const t of ['A1', 'A2', 'A3']) before.server.broadcast(ev(t))
    await before.server.close()
    server = null
    // The new lifetime has already numbered past the old cursor
    const after = await start()
    for (const t of ['B1', 'B2', 'B3', 'B4', 'B5']) after.server.broadcast(ev(t))
    expect(after.server.streamEpoch).not.toBe(epochBefore)

    const c = await greet(after.port, { afterSeq: 3, streamEpoch: epochBefore })
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: 5, streamEpoch: after.server.streamEpoch })
    expect(events(c)).toEqual([])
    c.ws.close()
  })

  it('a positive cursor with no epoch gets a resync, even when that seq exists in this lifetime', async () => {
    const { server: srv, port } = await start()
    srv.broadcast(ev('1'))
    srv.broadcast(ev('2'))
    const c = await greet(port, { afterSeq: 1 })
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: 2 })
    expect(events(c)).toEqual([])
    c.ws.close()
  })

  it('a second hello on the same socket does not replay the window again', async () => {
    const { server: srv, port } = await start()
    srv.broadcast(ev('1'))
    srv.broadcast(ev('2'))
    const c = connect(port)
    await c.open()
    c.send(hello({ afterSeq: 1, streamEpoch: srv.streamEpoch }))
    c.send(hello({ afterSeq: 1, streamEpoch: srv.streamEpoch }))
    c.send({ kind: 'rpc', id: 'probe', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res' && f.id === 'probe'))
    expect(events(c).map((f) => f.seq)).toEqual([2])
    expect(c.frames.filter((f) => f.kind === 'hello_ok')).toHaveLength(1)
    c.ws.close()
  })

  /*
   * The livelock the review of #91 found: a replay that starts and is cut halfway leaves the
   * client's cursor where it was, so every reconnect asks for the same window again. The whole
   * replay is priced first; one that does not fit is never started.
   */
  it.each([
    ['one oversized event', ['x'.repeat(1_200)]],
    ['many events that only together exceed the budget', Array.from({ length: 8 }, () => '한'.repeat(40))],
  ])('%s: a resync instead of a replay, on every reconnect, and the socket stays usable', async (_name, texts) => {
    const { server: srv, port } = await start(undefined, { replayBudgetBytes: 600 })
    srv.broadcast(ev('cursor'))
    for (const t of texts) srv.broadcast(ev(t))
    for (const afterSeq of [1, 1, 0]) {
      const c = await greet(port, { afterSeq, streamEpoch: srv.streamEpoch })
      expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: texts.length + 1 })
      expect(events(c)).toEqual([])
      expect(c.ws.readyState).toBe(WebSocket.OPEN)
      c.ws.close()
    }
  })

  it('prices WebSocket framing too: a replay whose payload fits but whose frames do not is a resync', async () => {
    const { server: srv } = await start()
    srv.broadcast(ev('cursor'))
    for (let i = 0; i < 20; i++) srv.broadcast(ev(`e${i}`))
    const frames = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ kind: 'event', seq: i + 2, event: ev(`e${i}`) }),
    )
    const helloOk = JSON.stringify({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false, currentSeq: 21, streamEpoch: srv.streamEpoch })
    // RFC 6455 §5.2: an unmasked server frame adds 2 bytes up to 125 bytes of payload, 4 up to 65,535
    const wire = (f: string) => Buffer.byteLength(f) + (Buffer.byteLength(f) < 126 ? 2 : 4)
    const payload = Buffer.byteLength(helloOk) + frames.reduce((n, f) => n + Buffer.byteLength(f), 0)
    const onWire = wire(helloOk) + frames.reduce((n, f) => n + wire(f), 0)
    // 21 frames add at least 2 header bytes each: a budget between the two numbers fits the payload only
    expect(onWire - payload).toBeGreaterThanOrEqual(42)
    await srv.close()
    server = null

    const tight = await start(undefined, { replayBudgetBytes: payload + 10 })
    tight.server.broadcast(ev('cursor'))
    for (let i = 0; i < 20; i++) tight.server.broadcast(ev(`e${i}`))
    const c = await greet(tight.port, { afterSeq: 1, streamEpoch: tight.server.streamEpoch })
    expect(c.frames[0]).toMatchObject({ resyncRequired: true })
    expect(events(c)).toEqual([])
    c.ws.close()
  })

  it('still replays a window that fits, in order', async () => {
    const { server: srv, port } = await start(undefined, { replayBudgetBytes: 600 })
    for (const t of ['1', '2', '3']) srv.broadcast(ev(t))
    const c = await greet(port, { afterSeq: 1, streamEpoch: srv.streamEpoch })
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: false })
    expect(events(c).map((f) => f.seq)).toEqual([2, 3])
    c.ws.close()
  })
})

describe('bounded outbound work (#82)', () => {
  it('a peer that stopped reading is cut once its backlog passes the bound; other peers keep receiving', async () => {
    const { server: srv, port } = await start(undefined, { maxBufferedBytes: 256 * 1024 })
    const stalled = connect(port)
    const healthy = connect(port)
    await Promise.all([stalled.open(), healthy.open()])
    for (const c of [stalled, healthy]) c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await Promise.all([stalled.wait(() => stalled.frames.length > 0), healthy.wait(() => healthy.frames.length > 0)])
    const stalledClosed = stalled.closed()
    // The stalled peer's process stops reading its socket — a suspended WebView
    const stalledSocket = (stalled.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket
    stalledSocket.pause()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const big = 'y'.repeat(64 * 1024)
    for (let i = 0; i < 200; i++) {
      srv.broadcast(ev(big))
      await new Promise((r) => setImmediate(r))
    }
    expect(errors.mock.calls.some((c) => String(c[0]).includes('stopped reading'))).toBe(true)
    errors.mockRestore()
    await healthy.wait(() => healthy.frames.filter((f) => f.kind === 'event').length === 200, 10_000)
    // The peer wakes up: it reads what reached it before the cut, then finds the socket gone
    stalledSocket.resume()
    await expect(stalledClosed).resolves.toBe(1006)
    expect(stalled.frames.filter((f) => f.kind === 'event').length).toBeLessThan(200)
    healthy.ws.close()
  }, 15_000)

  it('a socket that never says hello is closed after the handshake deadline', async () => {
    const { port } = await start(undefined, { handshakeTimeoutMs: 50 })
    const c = connect(port)
    await c.open()
    expect(await c.closed()).toBe(4001)
  })
})

describe('deterministic shutdown (#82)', () => {
  it('does not wait for a half-sent HTTP request', async () => {
    const { createConnection } = await import('node:net')
    const { server: srv, port } = await start()
    const socket = createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((r) => socket.once('connect', () => r()))
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
    await new Promise((r) => setTimeout(r, 20))
    try {
      const outcome = await Promise.race([srv.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 1000))])
      expect(outcome).toBe('closed')
    } finally {
      socket.destroy()
      server = null
    }
  })

  it('cuts a peer that never answers the close frame after the grace period', async () => {
    const { server: srv, port } = await start(undefined, { closeGraceMs: 100 })
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)
    ;(c.ws as unknown as { _socket: { pause(): void } })._socket.pause()
    const t0 = Date.now()
    const outcome = await Promise.race([srv.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 1500))])
    expect(outcome).toBe('closed')
    expect(Date.now() - t0).toBeLessThan(1000)
    server = null
    c.ws.terminate()
  })

  it('a second close() is the same shutdown, not a new one', async () => {
    const { server: srv } = await start()
    const first = srv.close()
    expect(srv.close()).toBe(first)
    await first
    server = null
  })
})

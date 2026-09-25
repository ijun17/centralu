/** WS 서버 왕복 + 재연결 복원 (T3-1 통합) */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request, type IncomingHttpHeaders } from 'node:http'
import { PROTOCOL_VERSION, type NormalizedEvent } from '@cc/protocol'
import { HostServer, parseAllowedOrigins } from './server.js'
import { sameSecret, type HttpRoute } from './http.js'

const TOKEN = 'test-token'
let server: HostServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

async function start(onRpc = async () => ({ ok: true })) {
  server = new HostServer({ port: 0, token: TOKEN, onRpc })
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

describe('핸드셰이크', () => {
  it('브라우저 dev origin이면 토큰 핸드셰이크를 허용한다', async () => {
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

  it('데스크톱 dev origin이면 토큰 핸드셰이크를 허용한다', async () => {
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
    'Tauri origin %s이면 토큰 핸드셰이크를 허용한다',
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

  it('악성 origin은 올바른 토큰을 보내기 전에 업그레이드에서 거부한다', async () => {
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
    // 거부가 무너지면 이 소켓은 열린 채 남는다 — 그때 afterEach를 10초 태우지 않게
    c.ws.close()
  })

  it('literal null origin은 네이티브 무-origin 연결처럼 취급하지 않는다', async () => {
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

  it('올바른 토큰이면 hello_ok', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false })
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
   * `CC_HOST_TOKEN=" "` 하나로 host와 UI의 판정이 갈렸다: host는 " "를 정상 토큰으로
   * 받아 listen까지 갔고(몇 번만 찍어보면 맞는 비밀), 브라우저는 trim 뒤 비어 있다며
   * MissingHostTokenError를 던져 아예 붙지 못했다. 같은 규칙을 쓰는지 본다.
   */
  it.each([' ', '\t', '\n', '   '])('공백뿐인 토큰(%j)은 브라우저와 같은 규칙으로 거부한다', (token) => {
    // Given / When / Then: whitespace is not a credential on either side of the socket.
    expect(() => new HostServer({ port: 0, token, onRpc: async () => ({ ok: true }) })).toThrow(/token/i)
  })

  it('허용되지 않은 origin을 거부할 때 host가 그 사실을 적는다', async () => {
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
   * 막힌 UI는 포기하지 않는다 — 백오프가 5초에서 멈추므로(web/rpc-client.ts) origin마다
   * 매번 적으면 같은 문장이 시간당 700줄 넘게 host.log에 쌓인다. 첫 줄만 남는지 본다.
   */
  it('같은 origin이 계속 재시도해도 거부 로그는 한 번만 적는다', async () => {
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
   * 그 기억에는 상한이 있어야 한다. 열쇠가 요청이 보낸 Origin 헤더 — 바깥이 고르는 값이라,
   * 무한히 담으면 loopback에 붙을 수 있는 쪽이 매번 다른 origin으로 두드려 host의 메모리를
   * 늘릴 수 있다. 토큰은 필요 없다. 같은 자리에서 종료 멈춤도 인증 없이 됐었다.
   */
  it('거부 로그의 기억은 무한히 자라지 않는다 — origin은 바깥이 고르는 값이다', async () => {
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

  it('CC_HOST_ALLOWED_ORIGINS가 기본 목록을 대체해 붙을 수 있게 한다', async () => {
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
    // 거부되면 open은 영영 안 온다 — 둘 중 먼저 오는 쪽을 받아야 5초 타임아웃 대신
    // "왜 실패했는지"가 적힌 실패가 나온다
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
   * 빈 값이 공집합 허용목록이 되면 **아무도 못 붙는 host**가 된다. 환경변수가 실수로
   * 비는 일은 흔하므로, 빈 값은 오버라이드가 아니라 "설정 안 함"으로 읽어 기본값에 맡긴다.
   */
  it.each([undefined, '', '   ', ',', ' , , '])(
    'CC_HOST_ALLOWED_ORIGINS가 %j면 오버라이드로 치지 않는다',
    (raw) => {
      // Given / When / Then: a blank value falls back to the built-in list, not to nothing.
      expect(parseAllowedOrigins(raw)).toBeUndefined()
    },
  )
  it('잘못된 토큰이면 연결을 끊는다', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: 'wrong', protocolVersion: PROTOCOL_VERSION })
    expect(await c.closed()).toBe(4001)
  })

  it('프로토콜 버전이 다르면 거부한다', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: 999 })
    expect(await c.closed()).toBe(4002)
  })

  it('인증 없이 RPC를 보내면 끊는다', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'rpc', id: '1', method: 'sessions.list', params: {} })
    expect(await c.closed()).toBe(4001)
  })
})

describe('RPC 왕복', () => {
  it('결과를 돌려준다', async () => {
    const { port } = await start(async () => ({ hello: 'world' }) as never)
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    c.send({ kind: 'rpc', id: 'r1', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res'))
    expect(c.frames.find((f) => f.kind === 'res')).toMatchObject({ id: 'r1', ok: true, result: { hello: 'world' } })
    c.ws.close()
  })

  it('핸들러 에러를 ProtocolError로 변환한다', async () => {
    const { port } = await start(async () => {
      throw Object.assign(new Error('세션 없음'), { code: 'session_not_found' })
    })
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    c.send({ kind: 'rpc', id: 'r1', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res'))
    expect(c.frames.find((f) => f.kind === 'res')).toMatchObject({
      ok: false,
      error: { code: 'session_not_found', message: '세션 없음' },
    })
    c.ws.close()
  })

  /**
   * 여기 오는 실패의 대부분은 Node의 실패다 — `fs.stat`은 `ENOENT`를 달고 온다.
   * 그 글자를 그대로 실으면 봉투가 프로토콜 밖의 값을 갖게 되고, 클라이언트는 프레임을
   * 통째로 버린다: 실패가 **도착하지 않는다** (도그푸딩 2026-09-10 — 파일 링크가 빈 화면).
   */
  it('프로토콜이 모르는 에러 코드는 internal로 나가고, 설명은 그대로 실린다', async () => {
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

describe('재연결 복원 (docs/protocol.md §1)', () => {
  it('끊긴 동안 발생한 이벤트를 afterSeq로 받는다', async () => {
    const { server: srv, port } = await start()

    const c1 = connect(port)
    await c1.open()
    c1.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c1.wait(() => c1.frames.length > 0)
    srv.broadcast(ev('1'))
    srv.broadcast(ev('2'))
    await c1.wait(() => c1.frames.filter((f) => f.kind === 'event').length === 2)
    c1.ws.close()

    // UI가 꺼져 있는 동안에도 host는 계속 적재한다
    srv.broadcast(ev('3'))
    srv.broadcast(ev('4'))

    const c2 = connect(port)
    await c2.open()
    c2.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 2 })
    await c2.wait(() => c2.frames.filter((f) => f.kind === 'event').length === 2)

    const replayed = c2.frames.filter((f) => f.kind === 'event')
    expect(replayed.map((f) => f.seq)).toEqual([3, 4])
    expect(c2.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: false, currentSeq: 4 })
    c2.ws.close()
  })

  it('여러 클라이언트에 방송한다', async () => {
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
 * 같은 포트의 HTTP 길 (M4 P-2). 앱 화면의 샌드박스 프록시가 이 포트로 서빙된다. 루프백에
 * 붙는 누구나(같은 기계의 프로그램, 브라우저로 연 아무 웹 페이지) 두드릴 수 있는 문이라
 * **모든 길이 비밀 칸 뒤에 있다**. 비밀이 없거나 틀리면 길이 없는 것과 같은 404가 나간다.
 */
describe('HTTP 길 (M4 P-2)', () => {
  const SECRET = 'S'.repeat(20) + 'ecret-for-the-http-gate-01'

  type Seen = { method: string; path: string; query: Record<string, string>; probe?: string; params: readonly string[] }

  async function startHttp(routes: HttpRoute[]) {
    server = new HostServer({ port: 0, token: TOKEN, onRpc: async () => ({ ok: true }), http: { secret: SECRET, routes } })
    return server.listen()
  }

  /** 경로를 **그대로** 보낸다 — fetch는 `..`와 `//`를 미리 접어 버려서 공격 모양을 못 만든다 */
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
        // 비동기 답: 처리기가 기다리는 동안 응답이 열려 있어야 한다
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

  it('길은 메서드·경로·쿼리·헤더를 받고, 비동기로 답한다', async () => {
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

  it('메서드가 다르거나 경로가 전체로 맞지 않으면 404다', async () => {
    const port = await startHttp(echoRoutes([]))

    // 같은 경로, 다른 메서드 / 정규식 길의 접두사·접미사 / 처리기가 null을 준 경우
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

  it('처리기가 던지면 500이고, 이유는 응답에 싣지 않는다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const port = await startHttp(echoRoutes([]))
      const r = await raw(port, 'GET', `/${SECRET}/boom`)
      expect(r.status).toBe(500)
      expect(r.body).toBe('internal error')
      expect(r.body).not.toContain('ENOENT')
      // host 로그에는 남지만 비밀(URL)은 적지 않는다
      const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(logged).toContain('ENOENT')
      expect(logged).not.toContain(SECRET)
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * 비밀 없이 닿는 것이 **아무것도 없어야** 한다. 길이 있는 경로, 없는 경로, 비밀과 한 글자
   * 다른 값, 비밀의 접두사, 비밀을 둘째 칸에 둔 것, 인코딩·`..`로 비튼 것까지 모두 같은
   * 404여야 한다. 상태만이 아니라 본문과 헤더까지 같아야 "비밀이 틀렸다"와 "길이 없다"가
   * 구별되지 않는다.
   */
  it('비밀 없이 닿는 것은 404뿐이고, 틀린 비밀과 없는 길이 구별되지 않는다', async () => {
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
    // 길이 없는 것과 비교: 비밀은 맞지만 없는 길
    const noRoute = await raw(port, 'GET', `/${SECRET}/no-such-route`)
    answers.add(JSON.stringify({ status: noRoute.status, body: noRoute.body, type: noRoute.headers['content-type'] }))

    expect([...answers]).toEqual([JSON.stringify({ status: 404, body: 'not found', type: 'text/plain; charset=utf-8' })])
    // 처리기는 한 번도 불리지 않았다
    expect(seen).toEqual([])
  })

  it('모든 응답이 referrer를 끊는다 — 비밀이 경로에 있어서 화면이 물려받으면 안 된다', async () => {
    const port = await startHttp(echoRoutes([]))
    for (const path of [`/${SECRET}/echo`, '/echo', `/${SECRET}/nope`]) {
      const r = await raw(port, 'GET', path)
      expect(r.headers['referrer-policy']).toBe('no-referrer')
      expect(r.headers['cache-control']).toBe('no-store')
    }
  })

  it('게이트가 없으면 모든 HTTP 요청이 404다 (예전 기본과 같다)', async () => {
    const { port } = await start()
    for (const path of ['/', '/echo', `/${SECRET}/echo`]) expect((await raw(port, 'GET', path)).status).toBe(404)
  })

  it.each(['', 'short-secret', 'x'.repeat(31), `${'y'.repeat(40)}/slash`, `${'z'.repeat(40)} space`])(
    '비밀값 %j는 거절한다 — 짧거나 URL 한 칸에 설 수 없다',
    (secret) => {
      expect(() => new HostServer({ port: 0, token: TOKEN, onRpc: async () => ({ ok: true }), http: { secret, routes: [] } })).toThrow(/secret/i)
    },
  )

  it('HTTP 길이 있어도 WebSocket의 origin·토큰 규칙은 그대로다', async () => {
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
  it('같은 값만 참이다 — 길이가 달라도 먼저 빠져나가지 않는다', () => {
    expect(sameSecret('abc', 'abc')).toBe(true)
    expect(sameSecret('abc', 'abd')).toBe(false)
    expect(sameSecret('ab', 'abc')).toBe(false)
    expect(sameSecret('', 'abc')).toBe(false)
  })
})

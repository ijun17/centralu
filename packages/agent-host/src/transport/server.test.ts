/** WS 서버 왕복 + 재연결 복원 (T3-1 통합) */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, type NormalizedEvent } from '@cc/protocol'
import { HostServer, parseAllowedOrigins } from './server.js'

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

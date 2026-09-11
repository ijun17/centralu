/** WS 서버 왕복 + 재연결 복원 (T3-1 통합) */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, type NormalizedEvent } from '@cc/protocol'
import { HostServer } from './server.js'

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

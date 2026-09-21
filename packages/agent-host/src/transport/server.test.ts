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

async function start(onRpc = async () => ({ ok: true }), extra: Partial<ConstructorParameters<typeof HostServer>[0]> = {}) {
  server = new HostServer({ port: 0, token: TOKEN, onRpc, ...extra })
  const port = await server.listen()
  return { server: server!, port }
}

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Record<string, unknown>[] = []
  ws.on('message', (d) => frames.push(JSON.parse(String(d))))
  return {
    ws,
    frames,
    open: () => new Promise<void>((r) => ws.on('open', () => r())),
    failed: () => new Promise<Error>((r) => ws.on('error', (err) => r(err))),
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
  it('올바른 토큰이면 hello_ok', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.length > 0)
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false, streamEpoch: expect.any(String) })
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
    c2.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 2, streamEpoch: srv.streamEpoch })
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


describe('서버 회복 경계', () => {
  it('같은 소켓의 중복 hello는 유실분을 두 번 재전송하지 않는다', async () => {
    const { server: srv, port } = await start()
    srv.broadcast(ev('1'))
    srv.broadcast(ev('2'))
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 1, streamEpoch: srv.streamEpoch })
    await c.wait(() => c.frames.filter((f) => f.kind === 'event').length === 1)
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 1, streamEpoch: srv.streamEpoch })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(c.frames.filter((f) => f.kind === 'event').map((f) => f.seq)).toEqual([2])
    c.ws.close()
  })

  it('다른 streamEpoch 커서는 이벤트 재전송 대신 resync만 요구한다', async () => {
    const { server: srv, port } = await start()
    srv.broadcast(ev('1'))
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 1, streamEpoch: 'old-host' })
    await c.wait(() => c.frames.some((f) => f.kind === 'hello_ok'))
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: 1, streamEpoch: expect.any(String) })
    expect(c.frames.some((f) => f.kind === 'event')).toBe(false)
    c.ws.close()
  })

  it('미래 afterSeq 커서는 이벤트 재전송 대신 resync만 요구한다', async () => {
    const { server: srv, port } = await start()
    srv.broadcast(ev('1'))
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 9, streamEpoch: srv.streamEpoch })
    await c.wait(() => c.frames.some((f) => f.kind === 'hello_ok'))
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: 1 })
    expect(c.frames.some((f) => f.kind === 'event')).toBe(false)
    c.ws.close()
  })

  it('close가 인증 전 소켓도 결정적으로 닫는다', async () => {
    const { port } = await start()
    const c = connect(port)
    await c.open()
    const closed = c.closed()
    await server?.close()
    server = null
    await expect(closed).resolves.toBeGreaterThanOrEqual(1000)
  })

})


describe('host stream identity and deterministic close', () => {
  it('requires resync when a reconnect presents a foreign stream epoch', async () => {
    const { port, server: srv } = await start()
    srv.broadcast(ev('x'))
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 1, streamEpoch: 'old-host' })
    await c.wait(() => c.frames.length > 0)
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: 1, streamEpoch: expect.any(String) })
    expect(c.frames.filter((f) => f.kind === 'event')).toHaveLength(0)
    c.ws.close()
  })

  it('close terminates unauthenticated peers instead of waiting forever', async () => {
    const { port, server: srv } = await start()
    const c = connect(port)
    await c.open()
    await expect(srv.close()).resolves.toBeUndefined()
    server = null
  })
})


describe('서버 자원 한도', () => {
  it('handshake timeout은 인증 전 소켓을 닫는다', async () => {
    const { port } = await start(async () => ({ ok: true }), { handshakeTimeoutMs: 20 })
    const c = connect(port)
    await c.open()
    expect(await c.closed()).toBe(4001)
  })

  it('payload 한도 초과 프레임은 서버를 막지 않고 소켓만 닫는다', async () => {
    const { port } = await start(async () => ({ ok: true }), { maxPayloadBytes: 80 })
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, padding: 'x'.repeat(200) })
    expect(await c.closed()).toBe(1009)
  })

  it('socket cap은 초과 연결만 거절한다', async () => {
    const { port } = await start(async () => ({ ok: true }), { maxSockets: 1 })
    const first = connect(port)
    const second = connect(port)
    await first.open()
    await second.open()
    expect(await second.closed()).toBe(1013)
    first.ws.close()
  })

  it('RPC in-flight cap은 추가 호출에 retryable 오류를 보낸다', async () => {
    const releaseFirst: { current?: () => void } = {}
    const { port } = await start(
      () => new Promise((resolve) => { releaseFirst.current = () => resolve({ ok: true }) }),
      { maxRpcInFlightPerSocket: 1 },
    )
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.some((f) => f.kind === 'hello_ok'))
    c.send({ kind: 'rpc', id: 'r1', method: 'x', params: {} })
    c.send({ kind: 'rpc', id: 'r2', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.kind === 'res' && f.id === 'r2'))
    expect(c.frames.find((f) => f.kind === 'res' && f.id === 'r2')).toMatchObject({ ok: false, error: { retryable: true } })
    if (!releaseFirst.current) throw new Error('expected first RPC to start')
    releaseFirst.current()
    await c.wait(() => c.frames.some((f) => f.kind === 'res' && f.id === 'r1'))
    c.ws.close()
  })

  it('outbound buffer cap은 과대 응답 대신 소켓을 닫는다', async () => {
    const { server: srv, port } = await start(async () => ({ ok: true }), { maxBufferedBytes: 200 })
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION })
    await c.wait(() => c.frames.some((f) => f.kind === 'hello_ok'))
    srv.broadcast(ev('x'.repeat(500)))
    expect(await c.closed()).toBe(1013)
  })
})

describe('raw TCP teardown', () => {
  it('does not wait for an incomplete HTTP request when shutting down', async () => {
    const { createConnection } = await import('node:net')
    const { port, server: srv } = await start()
    const socket = createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
    await new Promise((resolve) => setTimeout(resolve, 20))
    try {
      const result = await Promise.race([srv.close().then(() => 'closed'), new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 100))])
      expect(result).toBe('closed')
    } finally {
      socket.destroy()
      await srv.close()
      server = null
    }
  })
})

describe('review regressions: bounded replay with lifetime identity', () => {
  it('resyncs a positive cursor without an epoch, even when its sequence exists', async () => {
    const { port, server: srv } = await start()
    srv.broadcast(ev('different lifetime 1'))
    srv.broadcast(ev('different lifetime 2'))
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 1 })
    c.send({ kind: 'rpc', id: 'ready', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.id === 'ready'))
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: 2 })
    expect(c.frames.filter((f) => f.kind === 'event')).toEqual([])
    c.ws.close()
  })

  it.each([
    ['one oversized event', ['x'.repeat(1200)]],
    ['aggregate replay budget', Array.from({ length: 8 }, () => '한'.repeat(20))],
  ])('resyncs %s before any replay and keeps RPC usable', async (_name, texts) => {
    const { port, server: srv } = await start(async () => ({ ok: true }), { maxBufferedBytes: 600 })
    srv.broadcast(ev('cursor'))
    for (const text of texts) srv.broadcast(ev(text))
    // Both a cursor-less first connection and repeated reconnects must converge.
    for (const afterSeq of [0, 1, 1]) {
      const c = connect(port)
      await c.open()
      c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq, streamEpoch: srv.streamEpoch })
      await c.wait(() => c.frames.length > 0)
      expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: true, currentSeq: texts.length + 1 })
      c.send({ kind: 'rpc', id: 'ready', method: 'x', params: {} })
      await c.wait(() => c.frames.some((f) => f.id === 'ready'))
      expect(c.frames.filter((f) => f.kind === 'event')).toEqual([])
      expect(c.ws.readyState).toBe(WebSocket.OPEN)
      c.ws.close()
    }
  })

  it('still replays a fitting window in order with a matching epoch', async () => {
    const { port, server: srv } = await start(async () => ({ ok: true }), { maxBufferedBytes: 600 })
    srv.broadcast(ev('1'))
    srv.broadcast(ev('2'))
    srv.broadcast(ev('3'))
    const c = connect(port)
    await c.open()
    c.send({ kind: 'hello', token: TOKEN, protocolVersion: PROTOCOL_VERSION, afterSeq: 1, streamEpoch: srv.streamEpoch })
    c.send({ kind: 'rpc', id: 'ready', method: 'x', params: {} })
    await c.wait(() => c.frames.some((f) => f.id === 'ready'))
    expect(c.frames[0]).toMatchObject({ kind: 'hello_ok', resyncRequired: false })
    expect(c.frames.filter((f) => f.kind === 'event').map((f) => f.seq)).toEqual([2, 3])
    c.ws.close()
  })
})

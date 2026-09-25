/**
 * 앱별 출처의 포트 (M4 B-3). WebKit은 저장소를 출처(포트 포함)별로 남긴다. 그래서 같은 앱은
 * 실행이 바뀌어도 같은 포트를 받아야 하고, 한 번 준 포트는 다른 앱에 다시 주면 안 된다.
 * 배정표를 들고 있는 저장소만 남기고 할당기를 새로 만드는 것이 "host 재시작"이다.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OriginPorts, type PortBook, type PortBookStore } from './origin-ports.js'

const open: Server[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))))
})

/** 디스크처럼 굴러가는 배정표 — 저장할 때마다 직렬화한다 (참조를 나눠 쓰면 재시작을 흉내 낼 수 없다) */
function diskStore(): PortBookStore & { raw: string | null } {
  return {
    raw: null,
    load() {
      return this.raw ? (JSON.parse(this.raw) as PortBook) : null
    },
    save(book) {
      this.raw = JSON.stringify(book)
    },
  }
}

/** 지금 비어 있는 포트 n개. OS에게 받아서 곧바로 놓는다 */
async function freePorts(n: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const s = createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    out.push((s.address() as AddressInfo).port)
    await new Promise<void>((r) => s.close(() => r()))
  }
  return out
}

/** 정해 둔 순서로 후보를 내놓는다. 다 쓰면 실패하게 범위 밖 값을 준다 */
function sequence(ports: number[]): () => number {
  let i = 0
  return () => ports[i++] ?? -1
}

const noop = () => {}
const RANGE = [1024, 65535] as const

async function serve(ports: OriginPorts, key: string) {
  const got = await ports.serve(key, (_req, res) => res.end(key))
  open.push(got.server)
  return got
}

async function stop(server: Server) {
  await new Promise<void>((r) => server.close(() => r()))
}

describe('OriginPorts', () => {
  it('같은 열쇠는 재시작 뒤에도 같은 포트를 받고, 남의 포트는 비어 있어도 받지 못한다', async () => {
    const [pA, pB, pC] = await freePorts(3)
    const disk = diskStore()

    // 첫 실행: 두 프로젝트의 같은 이름 앱이 각자 포트를 받는다
    const first = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pB!]), log: noop })
    const a = await serve(first, 'p1/notes')
    const b = await serve(first, 'p2/notes')
    expect([a.port, b.port]).toEqual([pA, pB])
    await stop(a.server)
    await stop(b.server)

    // 재시작: 할당기는 새것이고 남은 것은 저장소뿐이다. 후보가 남의 포트부터 나와도 받지 않는다
    const second = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pB!, pC!]), log: noop })
    const again = await serve(second, 'p1/notes')
    expect(again.port).toBe(pA)
    const fresh = await serve(second, '_user/new-app')
    // p2/notes는 지금 떠 있지 않아서 pB는 비어 있다 — 그래도 새 앱에 주지 않는다
    expect(fresh.port).toBe(pC)
    expect(disk.load()).toEqual({ assigned: { 'p1/notes': pA, 'p2/notes': pB, '_user/new-app': pC }, retired: [] })
  })

  it('루프백에만 묶는다', async () => {
    const [p] = await freePorts(1)
    const got = await serve(new OriginPorts(diskStore(), { range: RANGE, pick: sequence([p!]), log: noop }), 'k')
    expect((got.server.address() as AddressInfo).address).toBe('127.0.0.1')
  })

  it('배정된 포트를 다른 프로그램이 쥐고 있으면 옮기고, 옛 포트는 은퇴해 아무에게도 가지 않는다', async () => {
    const [pA, pB, pC] = await freePorts(3)
    const disk = diskStore()
    const first = await serve(new OriginPorts(disk, { range: RANGE, pick: sequence([pA!]), log: noop }), 'p1/notes')
    await stop(first.server)

    // 다른 프로그램이 pA를 쥔다
    const squatter = createServer()
    await new Promise<void>((r) => squatter.listen(pA, '127.0.0.1', () => r()))
    open.push(squatter)

    const lines: string[] = []
    const second = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pB!]), log: (l) => lines.push(l) })
    const moved = await serve(second, 'p1/notes')
    expect(moved.port).toBe(pB)
    expect(disk.load()).toEqual({ assigned: { 'p1/notes': pB }, retired: [pA] })
    expect(lines.join('\n')).toMatch(new RegExp(`port ${pA} for p1/notes is taken`))

    // 그 프로그램이 떠나도 pA는 다시 나오지 않는다
    await stop(squatter)
    const third = new OriginPorts(disk, { range: RANGE, pick: sequence([pA!, pC!]), log: noop })
    expect((await serve(third, 'p3/other')).port).toBe(pC)
  })

  it('지금 쥐인 후보는 건너뛰되 배정하지 않는다', async () => {
    const [busy, free] = await freePorts(2)
    const squatter = createServer()
    await new Promise<void>((r) => squatter.listen(busy, '127.0.0.1', () => r()))
    open.push(squatter)
    const disk = diskStore()
    const got = await serve(new OriginPorts(disk, { range: RANGE, pick: sequence([busy!, free!]), log: noop }), 'k')
    expect(got.port).toBe(free)
    expect(disk.load()).toEqual({ assigned: { k: free }, retired: [] })
  })

  it('배정을 적지 못하면 서버를 닫고 던진다 — 적히지 않은 포트는 다음 실행에서 남에게 갈 수 있다', async () => {
    const [p] = await freePorts(1)
    const ports = new OriginPorts(
      {
        load: () => null,
        save: () => {
          throw new Error('disk full')
        },
      },
      { range: RANGE, pick: sequence([p!]), log: noop },
    )
    await expect(ports.serve('k', (_q, r) => r.end())).rejects.toThrow('disk full')
    // 포트가 풀려 있다 — 누가 쥐고 있지 않다
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(p, '127.0.0.1', () => resolve())
    })
    await stop(probe)
  })

  it('망가진 배정표는 비어 있는 것으로 읽고, 틀린 항목만 버린다', async () => {
    const [p, q] = await freePorts(2)
    const disk = diskStore()
    disk.raw = JSON.stringify({ assigned: { good: p, bad: 'x', neg: -1, huge: 70000 }, retired: [q, 'y', 0] })
    const ports = new OriginPorts(disk, { range: RANGE, pick: sequence([q!, p!]), log: noop })
    expect(ports.book()).toEqual({ assigned: { good: p }, retired: [q] })
    disk.raw = '"not an object"'
    expect(ports.book()).toEqual({ assigned: {}, retired: [] })
  })
})

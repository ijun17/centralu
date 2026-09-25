import { createServer, type RequestListener, type Server } from 'node:http'
import { randomInt } from 'node:crypto'

/**
 * 앱별 출처의 포트 (M4 B-3, 스파이크 S-1).
 *
 * 불투명 출처에서 깨지는 앱(공개 앱 86개 중 5개, S-8)에는 자기 출처를 준다.
 * `http://127.0.0.1:<그 앱의 포트>`다. WebKit은 브라우저 저장소를 **출처별로** 남긴다. 그래서
 * 포트는 두 가지를 지켜야 한다.
 *
 *   고정   같은 앱은 실행이 바뀌어도 같은 포트를 받는다. 아니면 앱의 저장소가 실행마다 사라진다.
 *   불변   한 번 어떤 앱에 준 포트는 **다른 앱에 다시 주지 않는다.** 앱이 지워져도 마찬가지다.
 *          그 출처의 저장소는 WebKit에 남아 있어서, 포트를 다시 주면 새 앱이 남의 저장소를 읽는다.
 *
 * 그래서 배정표(열쇠 → 포트)와 은퇴 목록을 host 쪽에 저장하고, 표는 줄지 않는다.
 *
 * 포트 범위는 20000–32767이다. macOS의 임시 포트(49152–65535)와 Linux의 임시 포트
 * (32768–60999)를 피한다. 거기서 고르면 OS가 바깥 연결에 같은 번호를 잠깐씩 빌려 쓴다.
 *
 * 배정된 포트를 다른 프로그램이 쥐고 있으면 그 앱을 새 포트로 옮기고, 옛 포트는 은퇴시킨다.
 * 앱은 그 출처의 저장소를 잃는다. 대신 화면은 뜬다. 상태는 서버에 두는 것이 이 설계의 원칙이라
 * 저장소를 잃는 쪽이 화면이 영영 안 뜨는 쪽보다 작다. 옮긴 사실은 host 로그에 남긴다.
 *
 * 쿠키는 이 격리 밖이다. 최상위가 `http://127.0.0.1`인 개발·웹 모드에서는 모든 포트가 쿠키를
 * 함께 쓴다(S-1 실측: Chromium, WebKit, WKWebView). localStorage·IndexedDB는 나뉜다.
 */

export type PortBook = {
  /** 열쇠 → 포트. 열쇠는 `<프로젝트 id 또는 _user>/<앱 id>` (views/view-host.ts) */
  assigned: Record<string, number>
  /** 쥐여 있어서 떠난 포트들. 누구에게도 다시 주지 않는다 */
  retired: number[]
}

export interface PortBookStore {
  load(): PortBook | null
  save(book: PortBook): void
}

export type OriginPortsOptions = {
  range?: readonly [number, number]
  /** 시험이 순서를 정할 수 있게. 기본은 범위 안의 균등 난수 */
  pick?: (lo: number, hi: number) => number
  attempts?: number
  log?: (line: string) => void
}

export const ORIGIN_PORT_RANGE = [20000, 32767] as const

/** 저장된 값은 파일이다 — 모양이 틀린 부분은 버리고 읽는다 (버린 포트가 재배정될 위험보다 기동 실패가 크다) */
function readBook(raw: PortBook | null): PortBook {
  const book: PortBook = { assigned: {}, retired: [] }
  if (!raw || typeof raw !== 'object') return book
  const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536
  if (raw.assigned && typeof raw.assigned === 'object') {
    for (const [k, v] of Object.entries(raw.assigned)) if (validPort(v)) book.assigned[k] = v
  }
  if (Array.isArray(raw.retired)) book.retired = raw.retired.filter(validPort)
  return book
}

function listenOn(port: number, handler: RequestListener): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.once('error', reject)
    // 루프백에만 묶는다 — 같은 네트워크의 다른 기계는 이 화면에 닿을 이유가 없다
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

export class OriginPorts {
  private readonly range: readonly [number, number]
  private readonly pick: (lo: number, hi: number) => number
  private readonly attempts: number
  private readonly log: (line: string) => void

  constructor(
    private readonly store: PortBookStore,
    opts: OriginPortsOptions = {},
  ) {
    this.range = opts.range ?? ORIGIN_PORT_RANGE
    this.pick = opts.pick ?? ((lo, hi) => randomInt(lo, hi + 1))
    this.attempts = opts.attempts ?? 200
    this.log = opts.log ?? ((line) => console.error(line))
  }

  /** 지금 배정표 (시험·진단용). 저장소의 값을 그대로 읽는다 */
  book(): PortBook {
    return readBook(this.store.load())
  }

  /**
   * 이 열쇠의 포트에 처리기를 건 서버를 띄운다. 처음 보는 열쇠면 포트를 새로 정해 **적은 뒤에**
   * 돌려준다. 적지 못하면 서버를 닫고 던진다. 적히지 않은 포트를 쓰면 다음 실행에서 그 포트가
   * 다른 앱에 갈 수 있다.
   */
  async serve(key: string, handler: RequestListener): Promise<{ port: number; server: Server }> {
    const book = this.book()
    const own = book.assigned[key]
    if (own !== undefined) {
      try {
        return { port: own, server: await listenOn(own, handler) }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        this.log(
          `[agent-host] view origin port ${own} for ${key} is taken by another program — ` +
            `moving it to a new port; storage the view kept under the old origin is no longer visible`,
        )
        book.retired.push(own)
        delete book.assigned[key]
      }
    }
    const taken = new Set<number>([...Object.values(book.assigned), ...book.retired])
    const [lo, hi] = this.range
    for (let i = 0; i < this.attempts; i++) {
      const port = this.pick(lo, hi)
      if (port < lo || port > hi || taken.has(port)) continue
      let server: Server
      try {
        server = await listenOn(port, handler)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        // 지금 쥐인 포트는 누구의 것도 아니다 — 이번 시도에서만 건너뛴다
        taken.add(port)
        continue
      }
      book.assigned[key] = port
      try {
        this.store.save(book)
      } catch (e) {
        await new Promise<void>((r) => server.close(() => r()))
        throw e
      }
      return { port, server }
    }
    throw new Error(`No free view origin port for ${key} in ${lo}-${hi}`)
  }
}

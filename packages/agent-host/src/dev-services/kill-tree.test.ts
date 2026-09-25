import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { killTargets, parsePs, stopTree, survivorTargets } from './kill-tree.js'

/**
 * 트리 킬의 과녁 고르기 (실측 2026-09-07의 결론).
 *
 * 핵심은 **잡 컨트롤**이다. 대화형 셸에서 띄운 프로그램은 자기 프로세스 그룹을 갖기
 * 때문에, 셸의 그룹만 쏘면 정작 데브 서버가 안 맞는다. 여기서 시험하는 것은 그
 * 판단뿐이다 — 실제로 시그널을 보내는 일은 맨 아래 "진짜 트리"가 본다.
 */
describe('killTargets', () => {
  const rows = (s: string) => parsePs(s)

  it('비대화형 셸: 자식이 같은 그룹에 있으면 과녁은 하나다', () => {
    // zsh -lc "pnpm dev" → 셸 100, pnpm 200, node 300 전부 pgid 100
    const table = rows('  100   50  100\n  200  100  100\n  300  200  100\n  900   50  900\n')
    expect(killTargets(table, 100, 900)).toEqual([100])
  })

  it('대화형 셸: 잡이 자기 그룹을 가지면 그 그룹도 과녁이다', () => {
    // zsh -l 100(pgid 100) → 데브 서버 200이 pgid 200으로 떨어져 나간다
    const table = rows('  100   50  100\n  200  100  200\n  300  200  200\n  900   50  900\n')
    expect(killTargets(table, 100, 900).sort()).toEqual([100, 200])
  })

  it('손자까지 따라간다 — 트리지 자식 목록이 아니다', () => {
    const table = rows('  100   50  100\n  200  100  200\n  300  200  300\n  400  300  400\n')
    expect(killTargets(table, 100, 999).sort()).toEqual([100, 200, 300, 400])
  })

  it('남의 가지는 건드리지 않는다', () => {
    // 400은 50의 자식이지 100의 자손이 아니다
    const table = rows('  100   50  100\n  200  100  200\n  400   50  400\n')
    expect(killTargets(table, 100, 999).sort()).toEqual([100, 200])
  })

  it('내가 속한 그룹은 절대 쏘지 않는다 — 정리하다 자기를 죽이면 나머지가 남는다', () => {
    // 200이 어쩌다 호스트(900)와 같은 그룹에 있다
    const table = rows('  100   50  100\n  200  100  900\n  900   50  900\n')
    expect(killTargets(table, 100, 900)).toEqual([100])
  })

  it('ps는 읽혔는데 root가 없으면 아무것도 안 쏜다 — 재사용된 pid를 때릴 자리다', () => {
    // 셸이 이미 죽은 뒤의 유예 타이머. 54321은 그새 남의 프로세스일 수 있다
    const table = rows('  100   50  100\n  900   50  900\n')
    expect(killTargets(table, 54321, 900)).toEqual([])
  })

  it('ps를 못 읽으면 root의 그룹 하나 — 예전 동작으로 내려앉는다', () => {
    expect(killTargets([], 54321, 900)).toEqual([54321])
  })

  it('init(1)이나 그룹 0은 과녁이 아니다 — 시스템을 쏠 뻔한 자리다', () => {
    const table = rows('  100   50    1\n  200  100    0\n')
    expect(killTargets(table, 100, 900)).toEqual([])
  })
})

/**
 * 두 번째 발의 과녁 (#149). `first`는 첫 발 때 본 트리, `rows`는 유예 뒤의 ps다. root(100)는 SIGTERM에
 * 먼저 죽었고, 버틴 자손은 init(1)에 입양되어 있다 — root에서 다시 훑으면 아무도 안 보이는 자리다.
 */
describe('survivorTargets', () => {
  const rows = (s: string) => parsePs(s)
  // 첫 발 때: 셸 100 → 200 → 손자 300. 호스트는 900
  const first = rows('  100   50  100\n  200  100  100\n  300  200  100\n')

  it('root가 먼저 죽어도 그 그룹에 남은 자손이 있으면 그룹째 쏜다', () => {
    const now = rows('  300    1  100\n  900   50  900\n')
    expect(survivorTargets(now, first, 900)).toEqual([100])
  })

  it('잡 컨트롤로 자기 그룹에 있던 자손도 — 그 그룹을 쏜다', () => {
    const jobs = rows('  100   50  100\n  200  100  200\n  300  200  300\n')
    const now = rows('  300    1  300\n  900   50  900\n')
    expect(survivorTargets(now, jobs, 900)).toEqual([300])
  })

  it('다 끝났으면 쏠 것이 없다', () => {
    expect(survivorTargets(rows('  900   50  900\n'), first, 900)).toEqual([])
  })

  it('같은 pid라도 그룹이 달라졌으면 남이다 — 그새 번호가 재사용된 자리다', () => {
    const now = rows('  300   77  777\n  900   50  900\n')
    expect(survivorTargets(now, first, 900)).toEqual([])
  })

  it('버틴 자손이 유예 사이에 새로 띄운 것도 — 자기 그룹을 새로 만들었어도 쏜다', () => {
    const now = rows('  300    1  100\n  400  300  400\n  500  400  400\n  900   50  900\n')
    expect(survivorTargets(now, first, 900).sort()).toEqual([100, 400])
  })

  it('남의 가지는 건드리지 않는다 — 명단에 없던 init의 다른 자식', () => {
    const now = rows('  300    1  100\n  600    1  600\n  900   50  900\n')
    expect(survivorTargets(now, first, 900)).toEqual([100])
  })

  it('내가 속한 그룹은 여기서도 쏘지 않는다', () => {
    const mixed = rows('  100   50  100\n  200  100  900\n')
    const now = rows('  200    1  900\n  900   50  900\n')
    expect(survivorTargets(now, mixed, 900)).toEqual([])
  })

  it('init(1)이나 그룹 0은 과녁이 아니다', () => {
    const odd = rows('  100   50  100\n  200  100    1\n  300  100    0\n')
    const now = rows('  200    1    1\n  300    1    0\n')
    expect(survivorTargets(now, odd, 900)).toEqual([])
  })
})

describe('parsePs', () => {
  it('숫자 세 칸인 줄만 읽는다 — 헤더나 깨진 줄은 버린다', () => {
    const out = '  PID  PPID  PGID\n  100   50  100\n쓰레기\n  200  100  200\n'
    expect(parsePs(out)).toEqual([
      { pid: 100, ppid: 50, pgid: 100 },
      { pid: 200, ppid: 100, pgid: 200 },
    ])
  })
})

/**
 * 두 번째 발을 **진짜 프로세스 트리로** 잰다 (#149). 위의 표 검사는 누구를 쏠지만 보고, 여기서는 유예 뒤에
 * 트리의 그룹에 아무도 남지 않는지를 OS의 프로세스 표로 본다.
 *
 * 고정물: root(sh) → 자식(sh) → 손자(sleep). root와 자식은 SIGTERM에 바로 죽고, 손자만 SIGTERM을 무시한다 —
 * trap을 건 데브 서버 자리다. `trap '' TERM`으로 무시한 시그널은 exec 뒤에도 무시된 채 남아서 sleep이 버틴다.
 * root는 detached로 띄워 자기 그룹을 준다(pty의 셸과 앱 프로세스가 그렇게 뜬다) — 우리 그룹에 붙어 있으면
 * kill-tree가 "자기 자신"으로 보고 건너뛴다.
 */
describe.skipIf(process.platform === 'win32')('stopTree — 진짜 트리 (#149)', () => {
  const GRACE_MS = 500
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const table = () => parsePs(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }))
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /** 조건이 설 때까지 기다리고 마지막 값을 돌려준다. 시간 안에 안 서도 던지지 않는다 — 판정은 expect가 한다 */
  const settle = async <T,>(read: () => T, ok: (v: T) => boolean, ms: number): Promise<T> => {
    const deadline = Date.now() + ms
    let v = read()
    while (!ok(v) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      v = read()
    }
    return v
  }

  /** 테스트가 실패해도 고아가 남지 않게 — 고정물의 그룹을 전부 치운다 */
  const planted: number[] = []
  afterEach(() => {
    for (const g of planted.splice(0)) {
      try {
        process.kill(-g, 'SIGKILL')
      } catch {
        // 이미 비었다
      }
    }
  })

  /** 고정물을 띄우고 손자를 찾는다. `jobControl`이면 자식이 `set -m`을 켜서 손자가 자기 그룹을 갖는다 — 터미널 탭의 대화형 셸처럼 */
  async function plantTree(jobControl: boolean): Promise<{ root: ChildProcess; rootExited: () => boolean; grandchild: number; groups: number[] }> {
    const grandchild = `trap '' TERM; echo $$; exec sleep 30`
    const child = `${jobControl ? 'set -m; ' : ''}sh -c ${quote(grandchild)} & wait`
    const root = spawn('sh', ['-c', `sh -c ${quote(child)} & wait`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    planted.push(root.pid!)
    let exited = false
    root.once('exit', () => (exited = true))
    const pid = await new Promise<number>((resolve, reject) => {
      let out = ''
      root.stdout!.on('data', (d: Buffer) => {
        out += String(d)
        if (out.includes('\n')) resolve(Number(out.trim()))
      })
      root.once('exit', () => reject(new Error(`고정물이 손자를 띄우기 전에 끝났다: ${JSON.stringify(out)}`)))
    })
    const pgid = table().find((r) => r.pid === pid)!.pgid
    planted.push(pgid)
    return { root, rootExited: () => exited, grandchild: pid, groups: [...new Set([root.pid!, pgid])] }
  }

  /**
   * SIGTERM에 root가 먼저 끝나고, 유예 뒤에 트리의 그룹이 비어야 한다.
   * `rootAlive`는 호출자가 root에 대해 아는 것이다: 명령 실행기와 앱 프로세스는 root의 끝남을 보면 false를,
   * 터미널 탭(셸 다시 띄우기)은 언제나 true를 준다.
   */
  async function expectTreeGone(jobControl: boolean, rootAlive: 'until-it-exits' | 'always'): Promise<void> {
    const t = await plantTree(jobControl)
    // 고정물 확인 — 손자는 SIGTERM을 무시하고, 잡 컨트롤이면 root와 다른 그룹에 있다
    process.kill(t.grandchild, 'SIGTERM')
    await new Promise((r) => setTimeout(r, 50))
    expect(alive(t.grandchild)).toBe(true)
    expect(t.groups).toHaveLength(jobControl ? 2 : 1)

    const handle = { pid: t.root.pid, kill: (s?: string) => void t.root.kill(s as NodeJS.Signals) }
    stopTree(handle, GRACE_MS, rootAlive === 'always' ? () => true : () => !t.rootExited())
    expect(await settle(t.rootExited, (x) => x, 5_000)).toBe(true) // 첫 발에 root는 끝난다

    // 유예 뒤의 SIGKILL, 그리고 init이 거두는 시간까지 기다린다. 남은 것이 있으면 그 행이 실패 메시지가 된다
    expect(await settle(() => table().filter((r) => t.groups.includes(r.pgid)), (left) => left.length === 0, GRACE_MS + 3_000)).toEqual([])
  }

  it('손자가 root의 그룹에 있고(zsh -lc·앱 프로세스) root의 끝남을 본 호출자여도, 유예 뒤 SIGKILL을 맞는다', async () => {
    await expectTreeGone(false, 'until-it-exits')
  }, 15_000)

  it('손자가 잡 컨트롤로 자기 그룹에 있어도 — 터미널 탭처럼 alive가 언제나 true일 때', async () => {
    await expectTreeGone(true, 'always')
  }, 15_000)

  it('손자가 잡 컨트롤로 자기 그룹에 있어도 — root의 끝남을 본 호출자일 때', async () => {
    await expectTreeGone(true, 'until-it-exits')
  }, 15_000)
})

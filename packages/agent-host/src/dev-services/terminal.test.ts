import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalService, shellPath, shortCwd } from './terminal.js'

/**
 * 터미널의 핵심 규칙은 하나다: **정체성은 cwd다.**
 *
 * 그래서 같은 프로젝트에서 세션을 바꿔도 같은 터미널이 이어지고,
 * 깃 워크트리 세션(다른 cwd)은 자기 터미널을 자동으로 갖는다.
 * 여기서는 그 규칙과, 셸이 죽거나 못 뜨는 경우의 처신을 확인한다.
 */

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-term-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 실제 셸을 띄우지 않고 규칙만 본다 — 검증 대상은 묶는 방식이지 셸이 아니다 */
function fakePty() {
  const spawned: { cwd: string; cols: number; rows: number }[] = []
  const instances: {
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    emitData: (d: string) => void
    emitExit: (code: number) => void
  }[] = []
  const mod = {
    spawn(_file: string, _args: string[], opts: Record<string, unknown>) {
      spawned.push({ cwd: opts.cwd as string, cols: opts.cols as number, rows: opts.rows as number })
      let onData = (_d: string) => {}
      let onExit = (_e: { exitCode: number }) => {}
      const inst = {
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        emitData: (d: string) => onData(d),
        emitExit: (code: number) => onExit({ exitCode: code }),
        onData: (cb: (d: string) => void) => (onData = cb),
        onExit: (cb: (e: { exitCode: number }) => void) => (onExit = cb),
      }
      instances.push(inst)
      return inst
    },
  }
  return { mod, spawned, instances }
}

describe('터미널은 cwd로 묶인다', () => {
  it('목록은 디렉토리의 것이다 — 세션을 바꿔도 그대로다', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const a = svc.create(cwd, 80, 24)
    // 세션을 바꿔 다시 조회해도 같은 터미널이 나온다 (새로 띄우지 않는다)
    expect(svc.list(cwd).map((t) => t.id)).toEqual([a.id])
    expect(fake.spawned).toHaveLength(1)
  })

  it('디렉토리가 다르면 목록도 다르다 (깃 워크트리 세션을 위한 준비)', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const one = tmp()
    const two = tmp()
    svc.create(one, 80, 24)
    svc.create(two, 80, 24)

    expect(svc.list(one)).toHaveLength(1)
    expect(svc.list(two)).toHaveLength(1)
    expect(svc.list(one)[0]!.id).not.toBe(svc.list(two)[0]!.id)
  })

  it('다시 조회하면 지금까지의 출력을 돌려준다 (빈 화면이면 터미널이 아니다)', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    svc.create(cwd, 80, 24)
    fake.instances[0]!.emitData('$ pnpm test\r\n254 passed\r\n')

    expect(svc.list(cwd)[0]!.history()).toContain('254 passed')
  })

  it('붙는 쪽 화면 크기에 맞춘다', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const h = svc.create(tmp(), 80, 24)
    svc.resize(h.id, 120, 40)
    expect(fake.instances[0]!.resize).toHaveBeenCalledWith(120, 40)
  })
})

describe('터미널 여러 개', () => {
  it('한 디렉토리에 여러 개를 열고 순서대로 이름을 붙인다', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)

    expect(svc.list(cwd).map((t) => t.title)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])
    expect(fake.spawned).toHaveLength(3)
  })

  it('닫으면 셸이 죽고 번호가 다시 매겨진다', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    svc.create(cwd, 80, 24)
    const second = svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)

    svc.close(second.id)

    expect(fake.instances[1]!.kill).toHaveBeenCalled()
    // 2번을 지웠는데 1,3이 남으면 세는 사람이 헷갈린다
    expect(svc.list(cwd).map((t) => t.title)).toEqual(['Terminal 1', 'Terminal 2'])
    expect(svc.list(cwd).map((t) => t.id)).not.toContain(second.id)
  })

  it('마지막 하나까지 닫으면 목록이 빈다', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const only = svc.create(cwd, 80, 24)
    svc.close(only.id)
    expect(svc.list(cwd)).toEqual([])
  })
})

describe('셸이 끝나거나 못 뜰 때', () => {
  it('종료를 알리고, 기록은 남긴 채 다시 띄울 수 있다', () => {
    const fake = fakePty()
    const seen: { terminalId: string; exitCode?: number | null }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const h = svc.create(cwd, 80, 24)
    fake.instances[0]!.emitData('작업하던 흔적\r\n')
    fake.instances[0]!.emitExit(0)

    expect(seen.some((e) => e.exitCode === 0)).toBe(true)

    const again = svc.restart(h.id, 80, 24)!
    expect(again.alive).toBe(true)
    // 뭘 하다 이렇게 됐는지가 단서다 — 기록을 지우지 않는다
    expect(again.history()).toContain('작업하던 흔적')
    expect(fake.spawned).toHaveLength(2)
  })

  /*
   * restart가 곧 터미널을 영영 죽이는 버튼이던 문제.
   * kill한 옛 셸의 onExit은 새 셸이 앉은 **뒤에** 늦게 오는데,
   * 그 콜백이 무조건 pty를 비워서 방금 띄운 새 셸을 죽은 것으로 만들었다.
   */
  it('옛 셸의 늦은 종료가 새 셸을 덮어쓰지 않는다', () => {
    const fake = fakePty()
    const seen: { terminalId: string; data?: string; exitCode?: number | null }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const h = svc.create(cwd, 80, 24)
    svc.restart(h.id, 80, 24)
    expect(fake.instances[0]!.kill).toHaveBeenCalled()

    // kill의 결과인 onExit이 이제야 도착한다
    fake.instances[0]!.emitExit(0)

    // 새 셸은 멀쩡히 살아 있어야 하고, 죽었다는 방송도 나가면 안 된다
    expect(svc.list(cwd)[0]!.alive).toBe(true)
    expect(seen.some((e) => e.exitCode !== undefined)).toBe(false)

    // 옛 셸이 마지막으로 뱉는 출력도 새 화면에 섞이지 않는다
    fake.instances[0]!.emitData('죽어가며 남긴 말')
    expect(svc.list(cwd)[0]!.history()).not.toContain('죽어가며 남긴 말')

    // 진짜 새 셸의 종료는 그대로 전해진다
    fake.instances[1]!.emitExit(1)
    expect(svc.list(cwd)[0]!.alive).toBe(false)
    expect(seen.some((e) => e.exitCode === 1)).toBe(true)
  })

  it('셸을 못 띄우면 조용히 죽지 않고 이유를 화면에 남긴다', () => {
    const seen: { terminalId: string; data?: string }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, {
      spawn() {
        throw new Error('posix_spawnp failed')
      },
    })

    const h = svc.create(tmp(), 80, 24)
    expect(h.alive).toBe(false)
    expect(h.history()).toContain('posix_spawnp failed')
    expect(seen.some((e) => e.data?.includes('posix_spawnp failed'))).toBe(true)
  })
})

describe('셸 선택', () => {
  it('사용자가 쓰는 셸을 고른다 (별칭·프롬프트가 그대로 나오도록)', () => {
    expect(shellPath()).toMatch(/\/(zsh|bash|sh|fish)$/)
  })

  it('홈 경로는 ~로 줄인다', () => {
    expect(shortCwd(`${process.env.HOME}/work`)).toBe('~/work')
    expect(shortCwd('/opt/x')).toBe('/opt/x')
  })
})

/**
 * node-pty를 가짜로 갈아 끼운다.
 * 실제 셸을 띄우면 테스트가 환경(셸 설정·로그인 스크립트)에 휘둘린다 —
 * 진짜 PTY 동작은 L3 스모크에서 따로 확인한다.
 */
function stubPty(svc: TerminalService, mod: unknown): void {
  ;(svc as unknown as { loadPty: () => unknown }).loadPty = () => mod
}

/**
 * 터미널을 여는 일은 눈에 띄게 빨라야 한다.
 *
 * 예전에는 create()마다 ensureToolPath()가 로그인 셸을 통째로 띄워서
 * 터미널 하나 여는 데 1~4초가 들었다 (테스트 러너에서 실측). 사용자에게는
 * '+ 추가'를 눌러도 한참 아무 일이 없는 것으로 보인다.
 * 시간을 재는 테스트는 무르지만, 예산을 크게 잡아 '셸을 다시 띄우는' 급의
 * 퇴행만 잡는다 (셸 1회 탐색이 ~1초, 여기 예산은 3개에 1.5초).
 */
describe('여는 속도', () => {
  it('여러 개를 연달아 열어도 셸 탐색을 되풀이하지 않는다', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)
    const cwd = tmp()

    const started = process.hrtime.bigint()
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)
    svc.create(cwd, 80, 24)
    const ms = Number(process.hrtime.bigint() - started) / 1e6

    expect(fake.spawned).toHaveLength(3)
    expect(ms).toBeLessThan(1500)
  })
})

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
  it('같은 디렉토리에 두 번 붙으면 같은 터미널이다 (세션을 바꿔도 이어진다)', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const a = svc.attach(cwd, 80, 24)
    const b = svc.attach(cwd, 80, 24)

    expect(b.id).toBe(a.id)
    expect(fake.spawned).toHaveLength(1) // 셸은 한 번만 뜬다
  })

  it('디렉토리가 다르면 다른 터미널이다 (깃 워크트리 세션을 위한 준비)', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const a = svc.attach(tmp(), 80, 24)
    const b = svc.attach(tmp(), 80, 24)

    expect(b.id).not.toBe(a.id)
    expect(fake.spawned).toHaveLength(2)
  })

  it('다시 붙을 때 지금까지의 출력을 돌려준다 (빈 화면이면 터미널이 아니다)', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    svc.attach(cwd, 80, 24)
    fake.instances[0]!.emitData('$ pnpm test\r\n254 passed\r\n')

    const again = svc.attach(cwd, 80, 24)
    expect(again.history()).toContain('254 passed')
  })

  it('붙는 쪽 화면 크기에 맞춘다', () => {
    const fake = fakePty()
    const svc = new TerminalService(() => {})
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const h = svc.attach(cwd, 80, 24)
    svc.resize(h.id, 120, 40)
    expect(fake.instances[0]!.resize).toHaveBeenCalledWith(120, 40)
  })
})

describe('셸이 끝나거나 못 뜰 때', () => {
  it('종료를 알리고, 기록은 남긴 채 다시 띄울 수 있다', () => {
    const fake = fakePty()
    const seen: { terminalId: string; exitCode?: number | null }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, fake.mod)

    const cwd = tmp()
    const h = svc.attach(cwd, 80, 24)
    fake.instances[0]!.emitData('작업하던 흔적\r\n')
    fake.instances[0]!.emitExit(0)

    expect(seen.some((e) => e.exitCode === 0)).toBe(true)

    const again = svc.restart(h.id, 80, 24)!
    expect(again.alive).toBe(true)
    // 뭘 하다 이렇게 됐는지가 단서다 — 기록을 지우지 않는다
    expect(again.history()).toContain('작업하던 흔적')
    expect(fake.spawned).toHaveLength(2)
  })

  it('셸을 못 띄우면 조용히 죽지 않고 이유를 화면에 남긴다', () => {
    const seen: { terminalId: string; data?: string }[] = []
    const svc = new TerminalService((e) => seen.push(e))
    stubPty(svc, {
      spawn() {
        throw new Error('posix_spawnp failed')
      },
    })

    const h = svc.attach(tmp(), 80, 24)
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

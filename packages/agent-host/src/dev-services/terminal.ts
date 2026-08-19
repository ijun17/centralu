import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { ensureToolPath } from '../env-path.js'

/**
 * 프로젝트 터미널 (M2.7).
 *
 * **터미널의 정체성은 cwd다.** 세션이 아니다.
 *   - 같은 프로젝트에서 세션을 바꿔도 같은 터미널이 그대로 이어진다 (요구사항)
 *   - 나중에 깃 워크트리 세션이 생기면 cwd가 다르므로 자기 터미널을 자동으로 갖는다
 *     (별도 분기 없이 규칙 하나로 둘 다 만족한다)
 *
 * 화면 복원은 **host의 스크롤백**이 담당한다. UI가 탭을 옮기거나 창을 껐다 켜도
 * 다시 붙을 때 지금까지의 출력을 통째로 받는다 — 터미널이 초기화되면 쓸모가 없다.
 */

const require = createRequire(import.meta.url)

/** node-pty의 표면 중 우리가 쓰는 부분만 (네이티브 타입을 밖으로 내보내지 않는다) */
type Pty = {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
type PtyModule = {
  spawn(file: string, args: string[], opts: Record<string, unknown>): Pty
}

/**
 * 스크롤백 상한. 넘으면 앞쪽을 버린다.
 * 빌드 로그 하나가 수십 MB가 되는 일이 흔한데, 그걸 통째로 들고 있으면
 * host 메모리가 대화가 아니라 로그로 찬다.
 */
const SCROLLBACK_BYTES = 256 * 1024

export type TerminalHandle = {
  id: string
  cwd: string
  /** 화면에 붙일 이름 (터미널 1, 터미널 2…) */
  title: string
  history(): string
  alive: boolean
}

type Entry = {
  id: string
  cwd: string
  title: string
  pty: Pty | null
  buffer: string
  cols: number
  rows: number
}

export type TerminalSink = (e: { terminalId: string; data?: string; exitCode?: number | null }) => void

export class TerminalService {
  /** 디렉토리 하나에 터미널 여러 개. 순서가 곧 화면에 쌓이는 순서다 */
  private byCwd = new Map<string, Entry[]>()
  private byId = new Map<string, Entry>()
  private counter = 0

  constructor(private emit: TerminalSink) {}

  /** 그 디렉토리의 터미널 목록. 세션을 바꿔도 이 목록은 그대로다 */
  list(cwd: string): TerminalHandle[] {
    return (this.byCwd.get(cwd) ?? []).map((e) => this.toHandle(e))
  }

  /** 터미널을 하나 더 연다 */
  create(cwd: string, cols: number, rows: number): TerminalHandle {
    const siblings = this.byCwd.get(cwd) ?? []
    const entry: Entry = {
      id: `term-${++this.counter}`,
      cwd,
      // 번호는 자리 순서로 붙인다 — 지우고 다시 만들어도 1,2,3이 이어진다
      title: `Terminal ${siblings.length + 1}`,
      pty: null,
      buffer: '',
      cols,
      rows,
    }
    siblings.push(entry)
    this.byCwd.set(cwd, siblings)
    this.byId.set(entry.id, entry)
    this.start(entry, cols, rows)
    return this.toHandle(entry)
  }

  /** 터미널 하나를 닫는다 (셸 종료 + 기록 폐기) */
  close(terminalId: string): void {
    const e = this.byId.get(terminalId)
    if (!e) return
    e.pty?.kill()
    this.byId.delete(terminalId)
    const siblings = (this.byCwd.get(e.cwd) ?? []).filter((x) => x.id !== terminalId)
    if (siblings.length === 0) this.byCwd.delete(e.cwd)
    else {
      // 번호를 다시 매긴다 — 2번을 지웠는데 1,3이 남으면 세는 사람이 헷갈린다
      siblings.forEach((x, i) => (x.title = `Terminal ${i + 1}`))
      this.byCwd.set(e.cwd, siblings)
    }
  }

  input(terminalId: string, data: string): void {
    this.byId.get(terminalId)?.pty?.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const e = this.byId.get(terminalId)
    if (e) this.doResize(e, cols, rows)
  }

  /** 먹통이 됐을 때 셸만 새로 띄운다. 기록은 남긴다 — 뭘 하다 이렇게 됐는지가 단서다 */
  restart(terminalId: string, cols: number, rows: number): TerminalHandle | null {
    const e = this.byId.get(terminalId)
    if (!e) return null
    e.pty?.kill()
    e.pty = null
    this.append(e, '\r\n[2m— shell restarted —[0m\r\n')
    this.start(e, cols, rows)
    return this.toHandle(e)
  }

  /** 프로젝트가 사라질 때 정리 */
  closeCwd(cwd: string): void {
    for (const e of this.byCwd.get(cwd) ?? []) {
      e.pty?.kill()
      this.byId.delete(e.id)
    }
    this.byCwd.delete(cwd)
  }

  disposeAll(): void {
    for (const e of this.byId.values()) e.pty?.kill()
    this.byCwd.clear()
    this.byId.clear()
  }

  /**
   * 네이티브 PTY 모듈을 불러온다.
   * 테스트가 갈아 끼울 수 있게 메서드로 둔다 — 진짜 셸을 띄우면 테스트가
   * 환경(셸 설정·로그인 스크립트)에 휘둘려서 무엇을 검증하는지 흐려진다.
   */
  protected loadPty(): PtyModule {
    return require('node-pty') as PtyModule
  }

  private toHandle(e: Entry): TerminalHandle {
    return { id: e.id, cwd: e.cwd, title: e.title, history: () => e.buffer, alive: !!e.pty }
  }

  private doResize(e: Entry, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    e.cols = cols
    e.rows = rows
    try {
      e.pty?.resize(cols, rows)
    } catch {
      // 죽어가는 중일 수 있다 — 크기 조절 실패로 터미널을 잃을 이유는 없다
    }
  }

  private start(e: Entry, cols: number, rows: number): void {
    e.cols = cols
    e.rows = rows

    let pty: PtyModule
    try {
      pty = this.loadPty()
    } catch (err) {
      this.append(e, `\r\n[2mCould not open terminal: ${(err as Error).message}[0m\r\n`)
      return
    }

    // GUI 앱은 로그인 셸의 PATH를 물려받지 못한다 (세션 생성에서 이미 겪은 문제)
    ensureToolPath()

    try {
      const handle = pty.spawn(shellPath(), ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: e.cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      })
      e.pty = handle
      handle.onData((data) => {
        // 재시작 뒤 옛 셸이 마지막으로 뱉는 출력은 버린다 — 새 셸의 화면에 섞이면 안 된다
        if (e.pty !== handle) return
        this.append(e, data)
        this.emit({ terminalId: e.id, data })
      })
      handle.onExit(({ exitCode }) => {
        /*
         * **지금 자리의 주인일 때만 비운다.**
         *
         * restart()가 옛 pty를 kill하면 그 onExit은 새 pty가 앉은 **뒤에** 늦게 온다.
         * 무조건 e.pty = null 하면 방금 띄운 새 셸을 죽은 것으로 만들어
         * 재시작이 곧 터미널을 영영 죽이는 버튼이 됐다.
         */
        if (e.pty !== handle) return
        e.pty = null
        this.emit({ terminalId: e.id, exitCode: exitCode ?? null })
      })
    } catch (err) {
      // 조용히 죽지 않는다 — 빈 검은 화면만 남으면 원인을 알 길이 없다
      const msg = `\r\n[2mCould not start shell: ${(err as Error).message}[0m\r\n`
      this.append(e, msg)
      this.emit({ terminalId: e.id, data: msg })
      this.emit({ terminalId: e.id, exitCode: null })
    }
  }

  private append(e: Entry, data: string): void {
    e.buffer += data
    if (e.buffer.length > SCROLLBACK_BYTES) {
      e.buffer = e.buffer.slice(e.buffer.length - SCROLLBACK_BYTES)
    }
  }
}

/** 사용자가 평소 쓰는 셸. 그래야 별칭·프롬프트가 그대로 나온다 */
export function shellPath(): string {
  const fromEnv = process.env.SHELL
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
}

/** 홈 디렉토리 표기 — 프롬프트가 없을 때의 폴백 표시용 */
export function shortCwd(cwd: string): string {
  const home = homedir()
  return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

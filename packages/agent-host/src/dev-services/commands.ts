import { createRequire } from 'node:module'
import { ensureToolPath } from '../env-path.js'
import { shellPath } from './terminal.js'

/**
 * 자주 쓰는 명령어 실행기 (#60).
 *
 * **터미널 탭과 별개다.** 예전에는 저장된 명령을 첫 터미널 PTY에 타이핑해 넣었는데,
 * 그러면 단발성 빌드도 데브 서버도 전부 터미널 탭에 눌러앉았다. 여기서는 명령마다
 * 자기 프로세스를 띄우고 출력을 자기 로그로 받는다 — 단발/상주 구분이 필요 없다:
 * 안 끝나면 계속 흐르고, 끝나면 종료 코드와 함께 로그가 남는 것뿐이다.
 *
 * 사용자 결정 (2026-08-26):
 *   - 로그는 host가 살아 있는 동안만 (명령별 마지막 실행 하나)
 *   - 같은 명령을 다시 실행하면 죽이고 새로 시작
 *   - 서로 다른 명령은 동시 실행 허용 (명령당 프로세스 하나)
 *
 * 출력은 터미널과 **같은 프레임 레인**을 탄다 (pushTerminal — runId가 terminalId 자리).
 * 이벤트 로그(seq 링 버퍼)를 태우지 않는 이유도 터미널과 같다: 출력량의 자릿수가 다르다.
 */

const require = createRequire(import.meta.url)

type Pty = {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): Pty }

/** 터미널과 같은 상한 — 빌드 로그 하나가 수십 MB가 되는 일이 흔하다 */
const LOG_BYTES = 256 * 1024

export type CommandRun = {
  command: string
  /** 실행마다 새 id — 화면이 스트림을 갈아탈 기준이다 */
  runId: string
  running: boolean
  exitCode: number | null
  startedAt: number
  history: string
}

type Entry = {
  cwd: string
  command: string
  runId: string
  pty: Pty | null
  buffer: string
  exitCode: number | null
  startedAt: number
}

export type CommandSink = (e: { terminalId: string; data?: string; exitCode?: number | null }) => void

export class CommandRunner {
  /** (cwd, command) 당 마지막 실행 하나 */
  private entries = new Map<string, Entry>()
  private counter = 0

  constructor(private emit: CommandSink) {}

  private key(cwd: string, command: string): string {
    return `${cwd}\u0000${command}`
  }

  /** 실행. 같은 명령이 돌고 있으면 죽이고 새로 시작한다 (사용자 결정) */
  run(cwd: string, command: string, cols = 100, rows = 30): CommandRun {
    const existing = this.entries.get(this.key(cwd, command))
    existing?.pty?.kill()

    const entry: Entry = {
      cwd,
      command,
      runId: `run-${++this.counter}`,
      pty: null,
      buffer: '',
      exitCode: null,
      startedAt: Date.now(),
    }
    this.entries.set(this.key(cwd, command), entry)
    this.start(entry, cols, rows)
    return this.toRun(entry)
  }

  /** 데브 서버를 끄는 버튼의 뒷면. 로그는 남는다 — 종료도 결과다 */
  stop(cwd: string, command: string): void {
    this.entries.get(this.key(cwd, command))?.pty?.kill()
  }

  /** 그 디렉토리에서 실행된 적 있는 명령들의 상태 (목록의 뱃지용 — 로그는 뺀다) */
  state(cwd: string): Omit<CommandRun, 'history'>[] {
    const out: Omit<CommandRun, 'history'>[] = []
    for (const e of this.entries.values()) {
      if (e.cwd !== cwd) continue
      const { history: _history, ...rest } = this.toRun(e)
      out.push(rest)
    }
    return out
  }

  /** 명령 하나의 마지막 실행 — 로그째. 실행된 적 없으면 null */
  log(cwd: string, command: string): CommandRun | null {
    const e = this.entries.get(this.key(cwd, command))
    return e ? this.toRun(e) : null
  }

  resize(cwd: string, command: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    try {
      this.entries.get(this.key(cwd, command))?.pty?.resize(cols, rows)
    } catch {
      // 죽어가는 중일 수 있다 — 크기 조절 실패로 실행을 잃을 이유는 없다
    }
  }

  disposeAll(): void {
    for (const e of this.entries.values()) e.pty?.kill()
    this.entries.clear()
  }

  /** 테스트가 갈아 끼운다 (terminal.ts와 같은 이유) */
  protected loadPty(): PtyModule {
    return require('node-pty') as PtyModule
  }

  private toRun(e: Entry): CommandRun {
    return {
      command: e.command,
      runId: e.runId,
      running: !!e.pty,
      exitCode: e.exitCode,
      startedAt: e.startedAt,
      history: e.buffer,
    }
  }

  private start(e: Entry, cols: number, rows: number): void {
    let pty: PtyModule
    try {
      pty = this.loadPty()
    } catch (err) {
      this.append(e, `Could not run: ${(err as Error).message}\r\n`)
      this.emit({ terminalId: e.runId, exitCode: null })
      return
    }

    // GUI 앱은 로그인 셸의 PATH를 물려받지 못한다 (터미널과 같은 대비)
    ensureToolPath()

    try {
      /*
       * 로그인 셸 -lc로 돈다: 사용자의 별칭·PATH가 그대로 산다. PTY인 이유는 색이다 —
       * 파이프로 띄우면 대부분의 도구가 색을 끈 채 출력하고, 데브 서버 로그는
       * 색이 곧 가독성이다.
       */
      const handle = pty.spawn(shellPath(), ['-lc', e.command], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: e.cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      })
      e.pty = handle
      handle.onData((data) => {
        // 재실행 뒤 옛 프로세스의 마지막 출력은 버린다 — 새 로그에 섞이면 안 된다
        if (e.pty !== handle) return
        this.append(e, data)
        this.emit({ terminalId: e.runId, data })
      })
      handle.onExit(({ exitCode }) => {
        if (e.pty !== handle) return
        e.pty = null
        e.exitCode = exitCode ?? null
        this.emit({ terminalId: e.runId, exitCode: exitCode ?? null })
      })
    } catch (err) {
      // 조용히 죽지 않는다 — 빈 로그만 남으면 원인을 알 길이 없다
      const msg = `Could not run: ${(err as Error).message}\r\n`
      this.append(e, msg)
      this.emit({ terminalId: e.runId, data: msg })
      this.emit({ terminalId: e.runId, exitCode: null })
    }
  }

  private append(e: Entry, data: string): void {
    e.buffer += data
    if (e.buffer.length > LOG_BYTES) e.buffer = e.buffer.slice(e.buffer.length - LOG_BYTES)
  }
}

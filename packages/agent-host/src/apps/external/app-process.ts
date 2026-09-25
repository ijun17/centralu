import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'
import { Client, type PriorDiscovery, type Tool } from '@modelcontextprotocol/client'
import { CLIENT_INFO } from '@cc/protocol'
import { KILL_GRACE_MS, stopTree } from '../../dev-services/kill-tree.js'
import { rotateIfLarge } from '../../log-file.js'
import { StreamTransport } from './stream-transport.js'

/**
 * 앱 프로세스 하나 (M4 A-3) — 띄우고, MCP로 붙고, 말한 것을 적고, 끝낸다.
 *
 *   fd 0/1  host = MCP 클라이언트, 앱 = 서버 (우리 StreamTransport, 제자리 세대 탐색)
 *   fd 2    앱의 표준에러 → 앱별 로그 파일 (비밀 값은 가린다)
 *   fd 3    중개 파이프 — host가 서버, 앱이 클라이언트 (A-4가 그 위에 중개 서버를 연다)
 *
 * 수명의 규칙(언제 띄우고 언제 내리나, 몇 번 되살리나)은 여기 없다 — 런타임이 정한다.
 * 이 파일은 "한 번 띄운 프로세스"의 물리만 안다.
 */

export type SpawnSpec = {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  logMaxBytes: number
  /** 로그에 쓰기 전에 비밀 값을 가린다 */
  redact: (text: string) => string
  /** 이 앱에 대해 지난번에 알아낸 규격 세대 — 있으면 탐색을 건너뛴다 */
  prior?: PriorDiscovery
  probeTimeoutMs: number
  connectTimeoutMs: number
}

export type ExitInfo = { code: number | null; signal: string | null; error: string | null }

export class AppProcess {
  readonly startedAt = Date.now()
  readonly client: Client
  /** 연결할 때 받은 도구 목록 (거르기 전 원문) — 프로세스마다 한 번 묻는다 */
  tools: Tool[] = []
  exit: ExitInfo | null = null
  /** 우리가 내리는 중이 아닌데 끝났을 때 — 런타임이 크래시로 센다 */
  onUnexpectedExit?: (reason: string) => void

  private stopping: Promise<void> | null = null
  private exitWaiters: (() => void)[] = []

  private constructor(
    readonly child: ChildProcess,
    readonly fd3: Socket | null,
    readonly log: AppLog,
    probeTimeoutMs: number,
  ) {
    this.client = new Client(
      { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
      /*
       * **세대를 명시한다.** v2 클라이언트의 기본은 2025 규격이다(S-4: 기본값으로 붙으면
       * 2026-07-28 서버와도 legacy로 이야기했다). `auto`는 `server/discover`로 묻고, 답이
       * 없거나 모르는 메서드라고 하면 옛 `initialize`로 내려간다 — 두 세대 서버 모두 붙는다.
       */
      { versionNegotiation: { mode: 'auto', probe: { timeoutMs: probeTimeoutMs } }, capabilities: {} },
    )
    const settle = (info: ExitInfo) => {
      if (this.exit) return
      this.exit = info
      /*
       * 'exit'는 표준에러가 다 흘러나오기 전에 올 수 있다 — 크래시 이유의 마지막 줄이 바로
       * 그 줄이다. 'close'(모든 파이프가 닫힘)를 잠깐 기다리되, 앱이 띄운 손주가 파이프를
       * 물려받아 붙들고 있으면 'close'는 영영 안 온다. 그래서 짧은 상한을 둔다.
       */
      let done = false
      const finish = () => {
        if (done) return
        done = true
        this.log.flush()
        this.log.note(`exited (${describeExit(info)})`)
        for (const w of this.exitWaiters.splice(0)) w()
        if (!this.stopping) this.onUnexpectedExit?.(this.reason(`exited (${describeExit(info)})`))
      }
      child.once('close', finish)
      setTimeout(finish, 150).unref()
    }
    child.once('exit', (code, signal) => settle({ code, signal, error: null }))
    child.once('error', (e) => settle({ code: null, signal: null, error: e.message }))
    child.stderr?.on('data', (chunk: Buffer) => this.log.stderr(chunk))
    // 파이프의 오류(EPIPE 등)가 host의 미처리 예외가 되지 않게 — 끝남은 'exit'가 말한다
    child.stdin?.on('error', () => {})
    fd3?.on('error', () => {})
  }

  /**
   * 띄우고 붙고 도구 목록까지 읽어야 "떴다"다.
   *
   * 도구 목록을 여기서 읽는 이유(S-6): 시작에 실패한 서버도 **프로세스는 살아 있었고**
   * 모든 요청에 `-32603`만 돌려줬다. 연결만 보고 "떴다"고 하면 그 앱은 이유도 없이
   * 모든 호출이 실패하는 앱이 된다. 목록까지 받아야 시작으로 친다 — 못 받으면 그것이
   * 실패의 이유가 되어 사람과 만드는 에이전트에게 간다.
   */
  static async start(spec: SpawnSpec): Promise<AppProcess> {
    const log = new AppLog(spec.logPath, spec.logMaxBytes, spec.redact)
    log.note(`starting: ${spec.command} ${spec.args.join(' ')}`)
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      /*
       * 자기 프로세스 그룹을 준다. kill-tree는 host 자신의 그룹을 절대 쏘지 않으므로,
       * 그룹을 나누지 않으면 앱과 그 자손을 그룹 단위로 끝낼 수 없다.
       */
      detached: true,
    })
    const proc = new AppProcess(child, (child.stdio[3] as Socket | undefined) ?? null, log, spec.probeTimeoutMs)
    try {
      await proc.connect(spec)
      log.note(`ready: pid ${child.pid} era ${proc.client.getProtocolEra()} (${proc.client.getNegotiatedProtocolVersion()})${spec.prior ? ' via cached verdict' : ''}`)
      return proc
    } catch (e) {
      /*
       * 연결이 끊긴 이유는 대개 프로세스의 죽음이고, 그 사실을 먼저 말해야 한다. 실측: 시작하자마자
       * `exit(3)`하는 앱에서 SDK의 "connection closed during the server/discover probe"가
       * 종료 소식보다 먼저 도착했다 — 그 문구만 보면 세대 탐색이 문제인 것처럼 읽힌다.
       */
      await proc.waitExit(250)
      const head = proc.exit ? `exited before it was ready (${describeExit(proc.exit)})` : (e as Error).message
      const reason = proc.reason(head)
      await proc.stop(0)
      throw new Error(reason)
    }
  }

  /** 다음 기동이 탐색 없이 붙을 수 있게 — 알아낸 세대 (S-4의 `connect({ prior })`) */
  verdict(): PriorDiscovery | undefined {
    const era = this.client.getProtocolEra()
    if (era === 'modern') {
      const discover = this.client.getDiscoverResult()
      return discover ? { kind: 'modern', discover } : undefined
    }
    return era === 'legacy' ? { kind: 'legacy' } : undefined
  }

  get alive(): boolean {
    return this.exit === null
  }

  /**
   * 종료 규칙 (S-5).
   *
   * **표준 입력과 fd 3을 함께 닫는다.** 표준 입력만 닫으면 앱이 끝나지 않았다 — Node 앱은
   * fd 3 소켓이, 공식 Python SDK 앱은 읽기 스레드가 붙잡았다(S-5 실측). 둘 다 닫히면 잘 만든
   * 앱은 스스로 끝난다(Node 11ms, Python 2~7ms). 유예 안에 안 끝나면 **자손까지** 끝낸다
   * (kill-tree — 터미널·명령 실행기와 같은 방법).
   *
   * 스스로 끝났어도 그 그룹에 남은 자손이 있을 수 있다(앱이 띄운 도우미). 앱의 그룹은 우리가
   * 만들어 준 것이라(detached) 그룹째 한 번 더 쏜다. 그룹에 누가 남아 있는 동안 그 번호는
   * 재사용되지 않으므로, 끝난 직후의 이 한 발은 남의 그룹에 닿지 않는다.
   */
  stop(graceMs: number, opts: { awaitKill?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      void this.client.close().catch(() => {})
      this.child.stdin?.end()
      this.fd3?.end()
      if (this.alive && !(await this.waitExit(graceMs))) {
        this.log.note(`did not exit within ${graceMs}ms of stdin and fd 3 closing — stopping the process tree`)
        stopTree({ pid: this.child.pid, kill: (s) => this.child.kill(s as NodeJS.Signals) }, KILL_GRACE_MS, () => this.alive)
        if (opts.awaitKill !== false) await this.waitExit(KILL_GRACE_MS + 1000)
      } else {
        this.signalOwnGroup()
      }
      this.fd3?.destroy()
      this.log.close()
    })()
    return this.stopping
  }

  /** 실패 문구 + 앱이 표준에러에 남긴 마지막 줄들 — 사람과 만드는 에이전트가 읽는다 */
  reason(head: string): string {
    const tail = this.log.tail()
    return tail ? `${head}\n--- stderr (last lines) ---\n${tail}` : head
  }

  private async connect(spec: SpawnSpec): Promise<void> {
    const { stdout, stdin } = this.child
    if (!stdout || !stdin) throw new Error('the app process has no stdio pipes')
    const died = new Promise<never>((_, reject) => {
      this.exitWaiters.push(() => reject(new Error(`exited before it was ready (${describeExit(this.exit!)})`)))
    })
    died.catch(() => {})
    const transport = new StreamTransport(stdout, stdin, { pid: this.child.pid ?? null })
    const opts = { timeout: spec.connectTimeoutMs }
    await Promise.race([this.client.connect(transport, spec.prior ? { ...opts, prior: spec.prior } : opts), died])
    const listed = await Promise.race([this.client.listTools(undefined, opts), died])
    this.tools = listed.tools
  }

  private waitExit(ms: number): Promise<boolean> {
    if (!this.alive) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      t.unref()
      this.exitWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  private signalOwnGroup(): void {
    const pid = this.child.pid
    if (process.platform === 'win32' || typeof pid !== 'number' || pid <= 1) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // ESRCH — 그룹에 남은 것이 없다. 흔한 경우다
    }
  }
}

function describeExit(e: ExitInfo): string {
  if (e.error) return `could not run: ${e.error}`
  if (e.signal) return `signal ${e.signal}`
  return `code ${e.code}`
}

/** 크래시 이유에 붙일 표준에러 끝부분 — 줄 수와 줄 길이 모두 상한을 둔다 */
const TAIL_LINES = 20
const TAIL_LINE_CHARS = 500

/**
 * 앱별 로그 파일. host.log(`log-file.ts`)와 같은 규칙: 넘치면 `.1`로 한 세대 밀어내고,
 * 동기로 쓰고, 실패는 삼킨다 — 로그를 못 남기는 것이 앱을 멈출 이유는 못 된다.
 *
 * 앱의 표준에러는 **줄 단위로 가린 뒤에** 쓴다. 앱이 자기 비밀을 찍어도 파일에는 이름만 남는다
 * (비밀은 로그 어디에도 싣지 않는다 — 플랜 "데이터와 비밀").
 */
class AppLog {
  private fd: number | null = null
  private written = 0
  private partial = ''
  private recent: string[] = []

  constructor(
    private path: string,
    private maxBytes: number,
    private redact: (text: string) => string,
  ) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      rotateIfLarge(path, maxBytes)
      this.written = existsSync(path) ? statSync(path).size : 0
      this.fd = openSync(path, 'a')
    } catch {
      this.fd = null
    }
  }

  note(text: string): void {
    this.write(`${new Date().toISOString()} [centralu] ${this.redact(text)}\n`)
  }

  stderr(chunk: Buffer): void {
    const lines = (this.partial + chunk.toString('utf8')).split('\n')
    this.partial = lines.pop() ?? ''
    // 끝나지 않는 한 줄이 메모리를 먹지 않게 — 길면 끊어서라도 적는다
    if (this.partial.length > 8192) {
      lines.push(this.partial)
      this.partial = ''
    }
    for (const line of lines) this.appLine(line)
  }

  flush(): void {
    if (this.partial) this.appLine(this.partial)
    this.partial = ''
  }

  tail(): string {
    return this.recent.join('\n')
  }

  close(): void {
    this.flush()
    try {
      if (this.fd !== null) closeSync(this.fd)
    } catch {
      /* 이미 닫혔다 */
    }
    this.fd = null
  }

  private appLine(line: string): void {
    const red = this.redact(line)
    this.recent.push(red.length > TAIL_LINE_CHARS ? `${red.slice(0, TAIL_LINE_CHARS)}…` : red)
    if (this.recent.length > TAIL_LINES) this.recent.shift()
    this.write(`${red}\n`)
  }

  private write(text: string): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, text)
      this.written += Buffer.byteLength(text)
      if (this.written >= this.maxBytes) this.roll()
    } catch {
      /* 파일에 못 적어도 앱은 계속 돈다 */
    }
  }

  /** log-file.ts의 roll과 같은 이유로, 닫은 fd 번호를 붙들지 않는다 */
  private roll(): void {
    try {
      if (this.fd !== null) closeSync(this.fd)
    } catch {
      /* 이미 닫혔다 */
    }
    this.fd = null
    try {
      renameSync(this.path, `${this.path}.1`)
    } catch {
      /* 못 밀어내면 같은 파일에 이어 쓴다 */
    }
    try {
      this.fd = openSync(this.path, 'a')
    } catch {
      /* 못 열면 파일 쪽만 조용해진다 */
    }
    this.written = 0
  }
}

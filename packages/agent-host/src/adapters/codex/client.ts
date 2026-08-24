import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * `codex app-server` JSON-RPC 클라이언트 (stdio, newline-delimited).
 *
 * 프로토콜 세부는 여기서 끝난다 — 바깥으로 나가는 것은 normalize.ts를 거친 NormalizedEvent뿐이다
 * (anti-corruption, docs/agent-host.md §2).
 *
 * 주의: `jsonrpc` 필드가 없는 경량 형식이다 (M0에서 확인).
 *   요청  {id, method, params}
 *   응답  {id, result} | {id, error}
 *   알림  {method, params}
 *   서버→클라 요청(승인)  {id, method, params} — 클라이언트가 {id, result}로 답해야 한다
 */

export type ServerNotification = { method: string; params?: unknown }
export type ServerRequest = { id: number | string; method: string; params?: unknown }

export type CodexClientHandlers = {
  onNotification: (n: ServerNotification) => void
  /** 서버가 승인을 요청한다. 반환값이 곧 응답 result */
  onServerRequest: (r: ServerRequest) => void
  /**
   * 프로세스가 끝났다. `expected`는 **우리가 닫은 것인지**를 말한다.
   *
   * 이 한 값이 없어서 정상 종료가 크래시로 둔갑했다: dispose로 얌전히 닫아도
   * 어댑터가 "codex app-server exited"를 error로 올렸고, 그 메시지가 진짜 원인
   * (잠금 충돌)을 덮어썼다. 아래 exit 핸들러는 이미 둘을 구분하고 있었는데
   * 그 사실을 밖으로 내보내지 않았을 뿐이다.
   */
  onExit: (code: number | null, expected: boolean) => void
}

export class CodexClient {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false
  /** onExit를 한 번만 부르기 위한 표식 ('error'와 'exit'이 둘 다 올 수 있다) */
  private finished = false

  constructor(
    private handlers: CodexClientHandlers,
    opts: { command?: string; args?: string[]; cwd?: string } = {},
  ) {
    this.proc = spawn(opts.command ?? 'codex', opts.args ?? ['app-server'], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 부모가 죽으면 함께 정리되도록 자기 그룹으로 (좀비 방지 — M1.5 결함 1번 규칙)
      detached: false,
    })

    /**
     * spawn 실패(ENOENT — nvm 전환·codex 삭제로 경로가 어긋난 경우)는 'exit'이 아니라
     * 'error'로 온다. 리스너가 없으면 uncaughtException으로 올라가 **host 전체가 죽고,
     * codex 하나 없다는 이유로 살아 있는 Claude 세션까지 전부 끊긴다.** 여기서 받아서
     * 이 세션만 실패시킨다.
     */
    this.proc.on('error', (err) => {
      if (this.finished) return
      this.finished = true
      this.closed = true
      const why = `codex app-server failed to start: ${err.message}`
      for (const [, p] of this.pending) p.reject(new Error(why))
      this.pending.clear()
      this.handlers.onExit(null, false)
    })
    // spawn이 실패한 뒤의 stdin write는 스트림 'error'로 또 던진다 — 위에서 이미 처리했으므로 삼킨다
    this.proc.stdin.on('error', () => {})

    /*
     * **readline이 아니라 손으로 자른다.** `readline.createInterface`는 아주 긴 한 줄을
     * 조용히 조각내서 내놓는다 — 실측: 23,244,422바이트짜리 `thread/resume` 응답(대화가
     * 164MB인 스레드)이 22,049,101 + 나머지로 갈라져 둘 다 JSON이 아니게 됐고, 응답이
     * "non-JSON output"으로 버려지니 그 요청의 약속은 영원히 안 풀렸다. 화면에는
     * "RPC timed out: agents.resumeSession"과 눌러도 소용없는 Retry만 남았다 (MGH 세션).
     *
     * 원시 스트림을 그대로 떠 보면 코덱스는 결백하다 — 한 줄은 온전했다. 자른 것은
     * 우리 쪽 readline이다. 그래서 개행에서만 자르는 버퍼로 바꾼다. 23MB 문자열 연결이
     * 아깝지 않냐면: 이 코드는 응답이 올 때만 일하고, 거대한 줄은 재개 순간 한 번이다.
     */
    let stdoutBuf = ''
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk
      let nl
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        this.onLine(line)
      }
    })
    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim()
      if (s) console.error('[codex]', s.slice(0, 500))
    })
    this.proc.on('exit', (code) => {
      if (this.finished) return
      this.finished = true
      /*
       * **우리가 닫은 것과 저쪽이 죽은 것은 다르다.**
       *
       * dispose()가 closed를 세운 뒤 kill하므로 여기 올 때 closed면 정상 종료다.
       * 그런데도 남은 요청을 전부 실패로 만들고 있었고, 그 거절을 아무도 받지 않아
       * **프로세스가 통째로 죽었다** (모델 목록을 읽고 정리하는 순간 그랬다).
       * 정상 종료인지 아닌지를 메시지로 구분한다 — 원인을 찾을 때 이 한 줄이 갈림길이다.
       */
      const unexpected = !this.closed
      this.closed = true
      // 조용히 흘리면 기다리던 쪽이 영원히 멈춘다 — 어느 쪽이든 이유를 붙여 거절한다
      const why = unexpected ? 'codex app-server exited' : 'request cancelled while closing the codex connection'
      for (const [, p] of this.pending) p.reject(new Error(why))
      this.pending.clear()
      this.handlers.onExit(code, !unexpected)
    })
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      /*
       * **`{`로 시작했는데 JSON이 아니면, 그건 남의 낙서가 아니라 깨진 프레임이다.**
       *
       * readline이 23MB 응답을 조각냈을 때 이 자리는 그 조각들을 "non-JSON output"으로
       * 로그에만 적고 버렸다 — 그리고 그 로그는 Finder로 띄운 앱에서 아무도 못 본다
       * (#56). 기다리던 요청은 답이 이미 도착해 파괴됐다는 사실을 모른 채 시간제한까지
       * 매달렸고, 화면에는 원인 없는 "RPC timed out"만 남았다. 조용한 버림이 행이 됐다.
       *
       * 그래서 깨진 프레임은 **기다리는 모든 요청을 그 자리에서, 이유를 붙여** 깨운다.
       * 어느 응답의 조각인지는 알 수 없으므로(id가 조각 어딘가에 있다) 전부 깨우는 것이
       * 정직하다 — 부르는 쪽(매니저)은 어차피 실패를 재시도로 잇는다. 연결은 죽이지
       * 않는다: 개행 분할이 고쳐진 지금 이 길은 미래의 회귀나 코덱스 쪽 끼어쓰기를
       * 위한 안전망이고, 다음 프레임부터 멀쩡할 수 있다.
       *
       * `{`로 시작하지 않는 줄은 그대로 흘린다 — 코덱스가 stdout에 배너·경고를 섞는
       * 일이 실제로 있고, 그때마다 세션을 실패시키면 그게 새 버그다.
       */
      if (line.startsWith('{')) {
        const why = `codex sent a frame this client could not parse (${line.length.toLocaleString()} bytes) — a waiting reply may have been destroyed`
        for (const [, p] of this.pending) p.reject(new Error(why))
        this.pending.clear()
      }
      console.error('[codex] non-JSON output:', line.slice(0, 200))
      return
    }

    const id = msg.id as string | number | undefined
    // 응답 (우리가 보낸 요청에 대한)
    if (id !== undefined && msg.method === undefined) {
      const p = this.pending.get(String(id))
      if (!p) return
      this.pending.delete(String(id))
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    // 서버 → 클라이언트 요청 (승인 등)
    if (id !== undefined && typeof msg.method === 'string') {
      this.handlers.onServerRequest({ id, method: msg.method, params: msg.params })
      return
    }
    // 알림
    if (typeof msg.method === 'string') {
      this.handlers.onNotification({ method: msg.method, params: msg.params })
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('codex app-server has already exited'))
    const id = String(this.nextId++)
    this.write({ id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`No response for ${method}`))
      }, timeoutMs)
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params })
  }

  /** 서버 요청(승인)에 답한다 */
  respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  private write(obj: unknown): void {
    if (this.closed) return
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.proc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 100))
    if (!this.proc.killed) this.proc.kill('SIGKILL')
  }
}

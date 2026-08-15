import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

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
  onExit: (code: number | null) => void
}

export class CodexClient {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false

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

    createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line))
    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim()
      if (s) console.error('[codex]', s.slice(0, 500))
    })
    this.proc.on('exit', (code) => {
      this.closed = true
      for (const [, p] of this.pending) p.reject(new Error('codex app-server가 종료되었습니다'))
      this.pending.clear()
      this.handlers.onExit(code)
    })
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.error('[codex] 비JSON 출력:', line.slice(0, 200))
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
    if (this.closed) return Promise.reject(new Error('codex app-server가 이미 종료되었습니다'))
    const id = String(this.nextId++)
    this.write({ id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 응답이 없습니다`))
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

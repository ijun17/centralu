/* eslint-disable @typescript-eslint/no-explicit-any -- the driver reads the host's raw frames directly */
/**
 * A host for the measurement (#513): started on a temporary data folder (`CC_DATA_DIR` and `--db`
 * both inside it, never `~/.centralu`), driven over its WebSocket the way the UI drives it, and
 * restartable on the same store so a session can be woken the way a person's is.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

export type Json = Record<string, any>

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url))

export type ApprovalPolicy = (event: Json) => 'allow' | 'deny' | 'always'

export class MeasuredHost {
  readonly events: Json[] = []
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private n = 1
  private pending = new Map<string, { method: string; r: (v: Json) => void; j: (e: Error) => void }>()
  private readonly token = `measure-${process.pid}-${Date.now()}`
  /** Who answers approval cards: the driver sets it per step */
  approvals: ApprovalPolicy = () => 'deny'
  readonly answered: { kind: string; tool?: string; decision: string }[] = []
  /**
   * The host's `[commands]` lines (#512): which command each centralu_run ran, and whether it got past the
   * schema. A Codex call from inside `exec` carries no arguments on its event, so this is where its command is.
   */
  readonly commandRuns: { sessionId: string; command: string; outcome: string }[] = []

  constructor(
    private dataDir: string,
    private env: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    const proc = spawn(process.execPath, ['--import', 'tsx', MAIN, '--port', '0', '--token', this.token, '--db', join(this.dataDir, 'store.db')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env, CC_DATA_DIR: this.dataDir },
    })
    this.proc = proc
    // The host's own log stays out of the table; the last lines are kept for a failure
    const tail: string[] = []
    proc.stderr!.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        const m = /^\[commands\] (\S+) centralu_run ("[^"]*"): (.+)$/.exec(line)
        if (m) this.commandRuns.push({ sessionId: m[1]!, command: JSON.parse(m[2]!) as string, outcome: m[3]! })
      }
      tail.push(...String(d).split('\n').filter(Boolean))
      tail.splice(0, Math.max(0, tail.length - 40))
    })
    const port: number = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`host did not start:\n${tail.join('\n')}`)), 30_000)
      proc.on('exit', (code) => rej(new Error(`host exited (${code}):\n${tail.join('\n')}`)))
      proc.stdout!.on('data', (d) => {
        for (const line of String(d).split('\n')) {
          try {
            const j = JSON.parse(line)
            if (j.ready) {
              clearTimeout(t)
              res(j.port)
            }
          } catch {
            /* not the handshake */
          }
        }
      })
    })
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('message', (raw: unknown) => this.frame(JSON.parse(String(raw))))
    await new Promise<void>((r, j) => {
      ws.on('open', () => r())
      ws.on('error', j)
    })
    ws.send(JSON.stringify({ kind: 'hello', token: this.token, protocolVersion: 1 }))
    this.ws = ws
    await new Promise((r) => setTimeout(r, 300))
  }

  /** Stops the host this driver started, and waits for it to be gone */
  async stop(): Promise<void> {
    this.ws?.close()
    this.ws = null
    const proc = this.proc
    this.proc = null
    if (!proc || proc.exitCode !== null) return
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL')
        r()
      }, 20_000)
      proc.on('exit', () => {
        clearTimeout(t)
        r()
      })
      proc.kill('SIGTERM')
    })
  }

  private frame(f: Json): void {
    if (f.kind === 'res') {
      const p = this.pending.get(f.id)
      if (!p) return
      this.pending.delete(f.id)
      if (f.ok) p.r(f.result)
      else p.j(new Error(`${p.method}: ${f.error?.message ?? 'rpc failed'}`))
      return
    }
    if (f.kind !== 'event') return
    this.events.push(f.event)
    if (f.event.type === 'approval_request') {
      const decision = this.approvals(f.event)
      this.answered.push({ kind: String(f.event.detail?.kind ?? ''), tool: f.event.detail?.tool, decision })
      void this.rpc('agents.respondApproval', { sessionId: f.event.sessionId, requestId: f.event.requestId, decision }).catch(() => {})
    }
    // A question the model asks the person is not part of any measurement: it is declined
    if (f.event.type === 'question_request') {
      void this.rpc('agents.answerQuestion', { sessionId: f.event.sessionId, requestId: f.event.requestId, answers: [] }).catch(() => {})
    }
  }

  rpc(method: string, params: unknown = {}, timeoutMs = 240_000): Promise<Json> {
    const ws = this.ws
    if (!ws) return Promise.reject(new Error('host not connected'))
    const id = String(this.n++)
    ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
    return new Promise((r, j) => {
      this.pending.set(id, { method, r, j })
      setTimeout(() => this.pending.delete(id) && j(new Error(`${method} timed out`)), timeoutMs)
    })
  }

  /** Sends a message and waits for the turn to end; returns the session's events of that turn */
  async turn(sessionId: string, text: string, timeoutMs = 240_000): Promise<Json[]> {
    const mark = this.events.length
    await this.rpc('agents.send', { sessionId, text })
    const done = (e: Json) => e.sessionId === sessionId && (e.type === 'turn_complete' || (e.type === 'state_change' && e.state === 'error'))
    const until = Date.now() + timeoutMs
    while (Date.now() < until && !this.events.slice(mark).some(done)) await new Promise((r) => setTimeout(r, 250))
    // Usage and the last results can trail the turn's end by a moment
    await new Promise((r) => setTimeout(r, 800))
    return this.events.slice(mark).filter((e) => e.sessionId === sessionId)
  }
}

export type Call = { name: string; args: unknown; callId: string; ok: boolean | null }

/** Whether each tool call of a turn succeeded, by call id */
export function toolResults(events: Json[]): Map<string, boolean> {
  const results = new Map<string, boolean>()
  for (const e of events) if (e.type === 'tool_result') results.set(String(e.callId), e.ok === true)
  return results
}

/**
 * The tool calls in a turn's events, with their arguments. Codex's carry them whole; a Claude call's
 * event can go out while its arguments are still streaming (measured: `{}` for a `recall` whose query
 * the API had), so for Claude the driver reads the arguments from the recorded answer instead.
 */
export function toolCalls(events: Json[]): Call[] {
  const results = toolResults(events)
  return events
    .filter((e) => e.type === 'tool_call')
    .map((e) => {
      const input = (e.input ?? {}) as Json
      /*
       * Codex carries the MCP call's own fields (server, tool, arguments), and no arguments at all for a
       * call the model made from inside its `exec` tool (codex-cli 0.160.0: `tools.mcp__centralu__recall({…})`
       * in JavaScript), where they are code, not a record: undefined, and the call's result says whether it worked
       */
      let args: unknown = 'tool' in input && 'server' in input ? input.arguments : input
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          /* kept as written */
        }
      }
      return { name: String(e.summary?.tool ?? ''), args, callId: String(e.callId), ok: results.has(String(e.callId)) ? results.get(String(e.callId))! : null }
    })
}

/** A tool's own name, whichever CLI named it: `mcp__centralu__recall` and Codex's `recall` are both `recall` */
export function bareName(name: string): string {
  const m = /^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/.exec(name)
  return m ? m[2]! : name
}

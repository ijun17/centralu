import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { errorMessage } from '@cc/protocol'
import type { AgentProcess } from '../contract.js'
import { waitForExit } from '../../timing.js'
import { lineSplitter, PendingRequests } from '../../transport/json-lines.js'

/**
 * JSON-RPC 2.0 over newline-delimited stdio, as the Agent Client Protocol speaks it (docs/plans/acp-adapter.md §11).
 * Requests go both ways: the agent asks the client for permission (`session/request_permission`) and for its own
 * extensions. Nothing of ACP's meaning lives here; `wire.ts` reads the params and `session.ts` acts on them.
 */

export type RpcId = string | number

/** A JSON-RPC error, from either side. Callers branch on `code`, never on the message */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export const METHOD_NOT_FOUND = -32601
/** ACP's code for "authenticate first" (measured on Cursor: `{code: -32000, message: "Authentication required"}`) */
export const AUTH_REQUIRED = -32000
/** ACP's code for a session or resource that does not exist */
export const RESOURCE_NOT_FOUND = -32002

export type AcpConnectionHandlers = {
  onNotification(method: string, params: unknown): void
  /** The agent's request. A thrown `RpcError` is answered as that error; any other throw as an internal error */
  onRequest(id: RpcId, method: string, params: unknown): Promise<unknown>
  /** `expected`: this side closed it */
  onExit(code: number | null, expected: boolean): void
  /** An answer to a request this connection never sent: the previous host's, after a swap (§4.4) */
  onStrayResponse?(id: RpcId, result: unknown, error: RpcError | null): void
}

const FRAME = z.looseObject({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
})

/** A turn may run for hours; a request still has to end if the agent never answers. The longest a timer can wait */
export const NO_TIMEOUT_MS = 2 ** 31 - 1

export class AcpConnection {
  /**
   * String ids with a per-connection prefix: a host that adopts a process the previous host was talking to can
   * receive answers to that host's requests (§4.4), and plain counters on both would have collided.
   */
  private readonly idPrefix = `c${randomBytes(3).toString('hex')}-`
  private nextId = 1
  private readonly pending = new PendingRequests()
  private closed = false
  private finished = false

  constructor(
    private readonly proc: AgentProcess,
    private readonly handlers: AcpConnectionHandlers,
    private readonly label: string,
  ) {
    proc.on('error', (err) => this.finish(null, new Error(`${label} failed to start: ${err.message}`)))
    proc.stdin.on('error', () => {})
    const lines = lineSplitter((line) => this.onLine(line))
    proc.stdout.on('data', (chunk: Buffer | string) => lines.push(chunk))
    proc.stderr?.on('data', (d) => {
      const s = String(d).trim()
      if (s) console.error(`[${label}]`, s.slice(0, 500))
    })
    proc.on('exit', (code) => this.finish(code, null))
  }

  private finish(code: number | null, startError: Error | null): void {
    if (this.finished) return
    this.finished = true
    const expected = this.closed && !startError
    this.closed = true
    this.pending.rejectAll(startError ?? new Error(expected ? `request cancelled while closing ${this.label}` : `${this.label} exited`))
    this.handlers.onExit(code, expected)
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      // Logged, not fatal: failing the waiting requests would end a running prompt while the agent goes on with it, and the
      // next prompt would go into a busy agent. A broken answer leaves its request to its timeout (a prompt, to Stop)
      console.error(`[${this.label}] non-JSON output:`, line.slice(0, 200))
      return
    }
    const parsed = FRAME.safeParse(raw)
    if (!parsed.success) {
      console.error(`[${this.label}] a frame that is not a JSON-RPC message:`, line.slice(0, 200))
      return
    }
    const msg = parsed.data
    const id = msg.id ?? undefined
    if (id !== undefined && msg.method === undefined) {
      const error = msg.error ? new RpcError(msg.error.code, msg.error.message, msg.error.data) : null
      const settled = error ? this.pending.reject(id, error) : this.pending.resolve(id, msg.result)
      if (!settled) this.handlers.onStrayResponse?.(id, msg.result, error)
      return
    }
    if (id !== undefined && msg.method !== undefined) {
      void this.answer(id, msg.method, msg.params)
      return
    }
    if (msg.method !== undefined) this.handlers.onNotification(msg.method, msg.params)
  }

  private async answer(id: RpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(id, method, params)
      this.write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(-32603, errorMessage(err))
      this.write({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } })
    }
  }

  /** The answer, unread: each caller parses it with the schema of what it asked (`wire.ts`) */
  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.label} has already exited`))
    const id = `${this.idPrefix}${this.nextId++}`
    const answer = this.pending.wait(id, timeoutMs, `No response for ${method}`)
    this.write({ jsonrpc: '2.0', id, method, params })
    return answer
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  get isClosed(): boolean {
    return this.closed
  }

  stderrTail(): string {
    return this.proc.stderrTail?.() ?? ''
  }

  private write(obj: unknown): void {
    if (this.closed) return
    const line = JSON.stringify(obj)
    this.proc.stdin.write(line + '\n')
  }

  /** stdin EOF first, so the agent can end its own children; the whole tree is killed after `graceMs` */
  async dispose(graceMs = 2000): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.proc.stdin.end()
    const exited = this.finished || (await waitForExit(this.proc, graceMs))
    if (!exited) this.proc.kill('SIGKILL')
  }

  /** Lets go of the process without closing it (a host swap under the keeper): no EOF, no signal */
  async detach(): Promise<void> {
    if (this.closed) return
    await this.proc.detach?.()
    this.closed = true
    this.finished = true
    this.pending.rejectAll(new Error(`request abandoned: this host let go of ${this.label}`))
  }
}

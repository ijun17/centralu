import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { launchFor } from '../../tool-launch.js'
import type { AgentProcess } from '../contract.js'

/**
 * A JSON-RPC client for `codex app-server` (stdio, newline-delimited).
 *
 * Protocol detail ends here — the only thing that leaves is a NormalizedEvent that has gone
 * through normalize.ts (anti-corruption, docs/agent-host.md §2).
 *
 * Note: this is a lightweight format with no `jsonrpc` field (confirmed in M0).
 *   request                        {id, method, params}
 *   response                       {id, result} | {id, error}
 *   notification                   {method, params}
 *   server-to-client request (approval)  {id, method, params} — the client must answer with {id, result}
 */

export type ServerNotification = { method: string; params?: unknown }
export type ServerRequest = { id: number | string; method: string; params?: unknown }

export type CodexClientHandlers = {
  onNotification: (n: ServerNotification) => void
  /** The server is requesting approval. The return value becomes the response result */
  onServerRequest: (r: ServerRequest) => void
  /**
   * The process has ended. `expected` says **whether we are the ones who closed it.**
   *
   * Without this one value, an ordinary shutdown masqueraded as a crash: even closing gracefully
   * through dispose made the adapter raise "codex app-server exited" as an error, and that
   * message buried the real cause (a lock conflict). The exit handler below already
   * distinguished the two cases — it just never surfaced that fact.
   */
  onExit: (code: number | null, expected: boolean) => void
}

export class CodexClient {
  private proc: AgentProcess
  private nextId = 1
  /**
   * Request ids carry a per-client prefix (#280 step 2). A client that adopts an app-server another
   * host was talking to can receive answers to that host's requests, still in flight when it left;
   * with plain counters both hosts would have sent `1`, `2`, … and an old answer would resolve a new
   * request. codex echoes string ids back as given.
   */
  private readonly idPrefix = `${randomBytes(3).toString('hex')}-`
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private closed = false
  /** A flag to call onExit only once (both 'error' and 'exit' can fire) */
  private finished = false

  constructor(
    private handlers: CodexClientHandlers,
    opts: {
      command?: string
      args?: string[]
      cwd?: string
      /**
       * The app-server's process when it does not come from this host's `spawn` — one the keeper
       * started or already holds (#280 step 2). Same stdio, same protocol.
       */
      process?: AgentProcess
    } = {},
  ) {
    if (opts.process) {
      this.proc = opts.process
    } else {
      // On Windows an npm-installed codex is a `.cmd` shim, which cannot be spawned without a shell (tool-launch.ts)
      const launch = launchFor(opts.command ?? 'codex')
      this.proc = spawn(launch.command, [...launch.args, ...(opts.args ?? ['app-server'])], {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Kept in its own group so it gets cleaned up together if the parent dies (avoids a zombie — M1.5 defect 1 rule)
        detached: false,
        windowsHide: true,
      })
    }

    /**
     * A spawn failure (ENOENT — when the path is off because of an nvm switch or codex being
     * removed) arrives as 'error', not 'exit'. With no listener, it bubbles up as an
     * uncaughtException, **killing the entire host and disconnecting every live Claude session
     * too, just because one codex was missing.** This is caught here so only this session fails.
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
    // A stdin write after a failed spawn also throws a stream 'error' — swallowed here since it is already handled above
    this.proc.stdin.on('error', () => {})

    /*
     * **Split by hand, not with readline.** `readline.createInterface` silently chops a very long
     * line into pieces — measured: a 23,244,422-byte `thread/resume` response (from a thread with
     * a 164MB conversation) got split into 22,049,101 bytes plus the remainder, neither of which
     * was valid JSON anymore, and once the response was dropped as "non-JSON output", that
     * request's promise never resolved. The screen was left with "RPC timed out:
     * agents.resumeSession" and a Retry button that did nothing (the MGH session).
     *
     * Capturing the raw stream directly clears codex of blame — the line arrived whole. What did
     * the splitting was our own readline. So this switches to a buffer that only splits at
     * newlines. Is concatenating a 23MB string not wasteful? This code only runs when a response
     * arrives, and a line that huge happens once, at the moment of resume.
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
    this.proc.stderr?.on('data', (d) => {
      const s = String(d).trim()
      if (s) console.error('[codex]', s.slice(0, 500))
    })
    this.proc.on('exit', (code) => {
      if (this.finished) return
      this.finished = true
      /*
       * **A shutdown we caused is not the same as the other side dying.**
       *
       * dispose() sets closed before killing, so arriving here with closed already true is an
       * ordinary shutdown. Even so, this used to fail every pending request, and since nobody
       * caught that rejection, **the entire process crashed** (this happened exactly at the
       * moment of reading the model list and cleaning up). We distinguish the two cases by
       * message — that one line is the fork in the road when tracking down the cause.
       */
      const unexpected = !this.closed
      this.closed = true
      // Letting it pass silently would leave whoever was waiting stuck forever — reject with a reason either way
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
       * **If a line starts with `{` but is not JSON, that is not someone else's stray text — it
       * is a broken frame.**
       *
       * When readline chopped up a 23MB response, this spot logged the pieces as "non-JSON
       * output" and dropped them — and nobody ever sees that log from an app launched from Finder
       * (#56). The waiting request hung all the way to its timeout with no idea its answer had
       * already arrived and been destroyed, and the screen was left with a "RPC timed out" and no
       * cause. A silent drop turned into a hang.
       *
       * So a broken frame wakes **every waiting request, on the spot, with a reason.** We cannot
       * tell which response's piece it was (the id is somewhere inside the fragment), so waking
       * all of them is the honest move — the caller (the manager) already follows failure with a
       * retry. The connection itself is not killed: now that the newline splitting is fixed, this
       * path is a safety net for a future regression or codex writing over the buffer, and the
       * very next frame can arrive fine.
       *
       * A line that does not start with `{` is passed through as-is — codex actually does mix
       * banners and warnings into stdout, and failing the session every time that happens would
       * be a new bug.
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
    // A response (to a request we sent)
    if (id !== undefined && msg.method === undefined) {
      const p = this.pending.get(String(id))
      if (!p) return
      this.pending.delete(String(id))
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    // A server-to-client request (approval, etc.)
    if (id !== undefined && typeof msg.method === 'string') {
      this.handlers.onServerRequest({ id, method: msg.method, params: msg.params })
      return
    }
    // A notification
    if (typeof msg.method === 'string') {
      this.handlers.onNotification({ method: msg.method, params: msg.params })
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('codex app-server has already exited'))
    const id = `${this.idPrefix}${this.nextId++}`
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

  /** Answers a server request (approval) */
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
    /*
     * Closed with **stdin EOF**, not SIGTERM. Measured (#57, codex-cli 0.147.0):
     *
     *   stdin EOF → exits on its own within 18ms, removing thread-writer-locks/<id>.lock
     *   SIGTERM   → dies instantly and leaves the lock file behind (same for both the wrapper and the vendor binary)
     *
     * A leftover file does not block a resume — the lock is a flock, not mere existence, and the
     * kernel releases a dead holder's flock (measured: resume succeeds even with the stray file
     * left behind). Even so, the old dispose was piling up one piece of garbage every time a
     * session closed. codex is the one best positioned to clean up, so we close it in a way that
     * gives it the chance to. If it has not exited within 2 seconds, we kill it then.
     */
    this.proc.stdin.end()
    const exited = await new Promise<boolean>((resolve) => {
      if (this.proc.exitCode !== null || this.finished) return resolve(true)
      const t = setTimeout(() => resolve(false), 2000)
      this.proc.once('exit', () => {
        clearTimeout(t)
        resolve(true)
      })
    })
    if (!exited) this.proc.kill('SIGKILL')
  }

  /**
   * Lets go of the app-server **without** closing it (#280 step 2): a host leaving for a restart
   * under the keeper. No EOF, no signal; frames that arrive until the keeper ends the stream are
   * still handled. Waiting requests are rejected — their answers will go to the next host.
   */
  async detach(): Promise<void> {
    if (this.closed) return
    await this.proc.detach?.()
    this.closed = true
    this.finished = true
    for (const [, p] of this.pending) p.reject(new Error('request abandoned: this host let go of codex'))
    this.pending.clear()
  }
}

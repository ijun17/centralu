import type { Readable } from 'node:stream'
import { DEFAULT_DRAIN_MS, type Drain, type DrainReport } from './drain.js'
import type { StoreInspection } from './dev-services/store.js'

/**
 * The host's half of a blue-green swap (#280, option C step 3).
 *
 * The keeper holds the host's stdin (it is the pipe whose end tells the host its keeper is gone,
 * `--watch-parent`). Under a keeper that pipe also carries a few control lines, one JSON object per
 * line, and the host answers on stdout next to its ready line:
 *
 * | keeper -> host (stdin)                | host -> keeper (stdout)                                  |
 * |---------------------------------------|----------------------------------------------------------|
 * | (host started with `--standby`)       | `{"standby":{pid,schema}}` once its own checks pass        |
 * | `{"op":"activate"}`                   | the ordinary ready line once it serves                    |
 * | `{"op":"drain","timeoutMs":N}`        | `{"drained":{waitedFor,cut,ms,keptAgents}}`, then it exits |
 *
 * The keeper parses nothing else the host says and the host parses nothing else the keeper sends:
 * neither side learns the other's protocol (#280, "the keeper does not parse any protocol").
 */

/**
 * Whether this build hands its agents over in a swap rather than stopping them. Step 2 (the keeper
 * holding claude, codex, terminals and commands) turned it on. A host whose keeper offers no child
 * service still spawns its own children and stops them, so what is reported (once per start, so the
 * app can say truthfully what a switch costs) is this **and** having the child service.
 */
export const KEEPS_AGENTS_ACROSS_SWAP = true

/**
 * The address and token a Codex orchestrator bridge is started with. Under a keeper that is the
 * front door, never this host's own port: a running codex keeps the bridge it started for as long
 * as its thread lives, and the bridge reads its address once, from its environment, so an address
 * that dies with this host would cut every bridge at the next swap.
 */
export function bridgeAddress(frontDoor: string | undefined, port: number | undefined, token: string): { url: string; token: string } | null {
  if (!port) return null
  return { url: frontDoor || `ws://127.0.0.1:${port}`, token }
}

/** The longest control line accepted. The real ones are tens of bytes */
const MAX_LINE = 64 * 1024

export type ControlMessage = { op: string; timeoutMs?: number }

/**
 * Control lines on the host's stdin. One handler per op; `next(op)` waits for one. The stream
 * ending (the keeper went away) rejects every waiter; the caller decides what that means.
 */
export class ControlChannel {
  private buf = ''
  private handlers = new Map<string, (m: ControlMessage) => void>()
  private waiters = new Map<string, { resolve: (m: ControlMessage) => void; reject: (e: Error) => void }[]>()
  private ended = false

  constructor(input: Readable) {
    input.setEncoding?.('utf8')
    input.on('data', (chunk: string | Buffer) => this.feed(String(chunk)))
    const end = () => this.end()
    input.on('end', end)
    input.on('close', end)
    input.on('error', end)
  }

  on(op: string, handler: (m: ControlMessage) => void): void {
    this.handlers.set(op, handler)
  }

  next(op: string): Promise<ControlMessage> {
    if (this.ended) return Promise.reject(new Error('the keeper closed the control channel'))
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(op) ?? []
      list.push({ resolve, reject })
      this.waiters.set(op, list)
    })
  }

  private feed(chunk: string): void {
    this.buf += chunk
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) break
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this.dispatch(line)
    }
    // A peer that never sends a newline does not get to grow this without bound
    if (this.buf.length > MAX_LINE) this.buf = ''
  }

  private dispatch(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as ControlMessage).op !== 'string') return
    const m = msg as ControlMessage
    const waiting = this.waiters.get(m.op)
    if (waiting?.length) {
      this.waiters.delete(m.op)
      for (const w of waiting) w.resolve(m)
      return
    }
    this.handlers.get(m.op)?.(m)
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    for (const list of this.waiters.values()) for (const w of list) w.reject(new Error('the keeper closed the control channel'))
    this.waiters.clear()
  }
}

export type StandbyDeps = {
  control: ControlChannel
  inspect: () => StoreInspection
  /** Writes one line to stdout, synchronously (an exit may follow at once) */
  write: (line: string) => void
  log: (line: string) => void
  exit: (code: number) => never
}

/**
 * Standby: the host the keeper starts next to a running one (#280 step 3, step 1 of the swap).
 *
 * By the time this runs the host has loaded its whole bundle (every static import, both native
 * modules) and found its tools on PATH. Here it reads the store **without writing to it** — the
 * other host still owns it — and refuses at once if the store is past what this build can read, so
 * a doomed swap fails while the running host is untouched. Then it reports, and waits for the
 * keeper to say the other host has let go. It does not take the ownership lock, migrate, or attach
 * to any agent until then.
 *
 * It does not listen yet either: the front door hides the port, so binding one early proves
 * nothing a client could use, and the server needs the session manager, which needs the store open
 * for writing. The ready line after activation is the last check before the keeper points the front
 * door at this host.
 */
export async function standby(deps: StandbyDeps): Promise<void> {
  let seen: StoreInspection
  try {
    seen = deps.inspect()
  } catch (err) {
    const message = `[agent-host] standby check failed: could not read the store: ${(err as Error).message}`
    deps.log(message)
    deps.write(message)
    return deps.exit(1)
  }
  if (seen.tooNew) {
    deps.log(seen.tooNew)
    deps.write(seen.tooNew)
    return deps.exit(1)
  }
  deps.write(
    JSON.stringify({
      standby: {
        pid: process.pid,
        schema: {
          userVersion: seen.userVersion,
          latestKnownVersion: seen.latestKnownVersion,
          minReaderVersion: seen.minReaderVersion,
          pending: seen.pending,
        },
      },
    }),
  )
  deps.log(`[agent-host] standing by for a swap (store v${seen.userVersion}, ${seen.pending.length} step(s) pending)`)
  try {
    await deps.control.next('activate')
  } catch {
    // The keeper gave up on this swap (or died): this host never touched anything, so it just goes
    deps.log('[agent-host] the keeper ended the standby; exiting')
    return deps.exit(0)
  }
  deps.log('[agent-host] activated: taking over the data folder')
}

export type DrainDeps = {
  drain: Drain
  /** Hands off or stops what the host holds (step 2 fills in the hand-off), closes the server and the store */
  detach: () => Promise<void>
  /** Lets go of the #278 ownership lock, so the next host can take it */
  release: () => void
  write: (line: string) => void
  log: (line: string) => void
  exit: (code: number) => never
  /** How long to let a cut call's error reach its agent before the hand-off; tests pass 0 */
  settleMs?: number
  /** The detach hands agents over to the next host (step 2: the keeper holds them) */
  keepsAgents?: boolean
}

/**
 * Drain: step 3 of the swap, on the host being replaced.
 *
 *   1. stop taking calls; let running RPCs and in-process tool calls finish within the bound, then
 *      cut the rest with an error the model can retry (drain.ts);
 *   2. give a cut call's error a moment to reach its agent (the SDK writes it to the agent's stdin
 *      on its next turn of the event loop; with step 2 the agent outlives this host and must get it);
 *   3. the detach hook: hand over or stop agents, terminals and commands, close the server and
 *      flush and close the store;
 *   4. let go of the ownership lock, say `drained`, exit.
 */
export function onDrain(control: ControlChannel, deps: DrainDeps): void {
  let started = false
  control.on('drain', (m) => {
    if (started) return
    started = true
    const bound = typeof m.timeoutMs === 'number' && m.timeoutMs >= 0 ? m.timeoutMs : DEFAULT_DRAIN_MS
    void runDrain(bound, deps)
  })
}

export async function runDrain(bound: number, deps: DrainDeps): Promise<DrainReport> {
  deps.log(`[agent-host] draining for a swap (bound ${bound}ms)`)
  const report = await deps.drain.drain(bound)
  if (report.cut.length > 0) {
    deps.log(`[agent-host] cut after ${bound}ms: ${report.cut.join(', ')}`)
    await new Promise((r) => setTimeout(r, deps.settleMs ?? 200))
  }
  try {
    await deps.detach()
  } catch (err) {
    // Nothing is left to hand back to: the lock still has to go, or the next host cannot start
    deps.log(`[agent-host] detach failed: ${(err as Error).stack ?? String(err)}`)
  }
  deps.release()
  deps.write(JSON.stringify({ drained: { ...report, keptAgents: deps.keepsAgents === true } }))
  deps.log(`[agent-host] drained (pid ${process.pid})`)
  deps.exit(0)
  return report
}

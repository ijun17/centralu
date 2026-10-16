import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { lineSplitter, PendingRequests } from '../transport/json-lines.js'

/**
 * The host's side of the keeper's child service (#280, option C step 2).
 *
 * Under a keeper (`CC_KEEPER=1`) the long-lived children — claude, codex app-server, terminals and
 * project commands — are spawned by the keeper over `<data>/children.sock`, so a host that crashes,
 * restarts or is switched to another build leaves them running and the next host re-attaches.
 * The wire protocol is the keeper's (`apps/desktop/src-tauri/keeper/src/keeper/children/mod.rs`):
 *
 *   control  one connection per host: `hello`, then `{rid, op}` requests and pushed events
 *            (`exit` — a child ended; `stop` — the keeper is stopping, stop your children)
 *   attach   one connection per stream: an answer line, then raw bytes both ways
 *
 * Nothing here decides anything about sessions or terminals; it only moves requests and bytes.
 */

/** Must match the keeper's `CHILDREN_PROTOCOL`. */
export const CHILDREN_PROTOCOL = 1

export type ChildExit = { code: number | null; signal: number | null }

/** One child the keeper holds, as `list` and `spawn` describe it. */
export type KeptChild = {
  id: string
  kind: 'pipes' | 'pty'
  pid: number
  cmd: string
  args: string[]
  cwd: string
  startedAt: number
  alive: boolean
  exit: ChildExit | null
  /** What the host said this child is when it spawned it (see `tags.ts`) — the keeper never reads it. */
  tag: unknown
  cols: number
  rows: number
  /** Output not yet sent to any host */
  buffered: number
  attached: boolean
}

export type SpawnRequest = {
  kind: 'pipes' | 'pty'
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols?: number
  rows?: number
  tag: unknown
}

const REQUEST_TIMEOUT_MS = 15_000

/** A child service answer line, read off the front of a socket before its raw bytes start. */
function readAnswer(sock: Socket, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const done = (err: Error | null, v?: Record<string, unknown>) => {
      clearTimeout(timer)
      sock.off('data', onData)
      sock.off('error', onError)
      sock.off('close', onClose)
      if (err) reject(err)
      else resolve(v!)
    }
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      const nl = buf.indexOf(10)
      if (nl < 0) return
      // Stop the flow before handing the rest back, so no raw byte is emitted to nobody.
      sock.pause()
      const rest = buf.subarray(nl + 1)
      if (rest.length > 0) sock.unshift(rest)
      let v: Record<string, unknown>
      try {
        v = JSON.parse(buf.subarray(0, nl).toString('utf8')) as Record<string, unknown>
      } catch (e) {
        return done(new Error(`the keeper sent a line that is not JSON: ${(e as Error).message}`))
      }
      done(null, v)
    }
    const onError = (e: Error) => done(e)
    const onClose = () => done(new Error('the keeper closed the connection'))
    const timer = setTimeout(() => {
      sock.destroy()
      done(new Error('the keeper did not answer'))
    }, timeoutMs)
    sock.on('data', onData)
    sock.on('error', onError)
    sock.on('close', onClose)
  })
}

function connect(path: string, first: Record<string, unknown>, timeoutMs: number): Promise<{ sock: Socket; answer: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path)
    const onError = (e: Error) => reject(e)
    sock.once('error', onError)
    sock.once('connect', () => {
      sock.off('error', onError)
      sock.write(`${JSON.stringify({ ...first, protocol: CHILDREN_PROTOCOL })}\n`)
      readAnswer(sock, timeoutMs).then(
        (answer) => {
          if (answer.ok !== true) {
            sock.destroy()
            return reject(new Error(String(answer.error ?? 'the keeper refused')))
          }
          resolve({ sock, answer })
        },
        (e: Error) => {
          sock.destroy()
          reject(e)
        },
      )
    })
  })
}

/**
 * One host's control connection to the keeper's child service.
 *
 * Events: `exit` (id, ChildExit) when a child ends; `stop` when the keeper is stopping and asks
 * this host to stop its children; `lost` when the connection to the keeper is gone (the keeper died,
 * and with it every child's pipes).
 */
export class KeeperChildren extends EventEmitter {
  private nextRid = 1
  private pending = new PendingRequests<Record<string, unknown>>()
  private closed = false
  /** Exits already reported — a listener that subscribes late (right after a spawn) still learns of one. */
  private exits = new Map<string, ChildExit>()

  private constructor(
    readonly path: string,
    private sock: Socket,
    readonly keeperPid: number,
  ) {
    super()
    const lines = lineSplitter((line) => this.onLine(line))
    sock.on('data', (d: Buffer) => lines.push(d))
    const gone = () => this.onLost()
    sock.on('close', gone)
    sock.on('error', gone)
    sock.resume()
  }

  /** Connects and says hello. Rejects when no keeper child service answers at `path`. */
  static async connect(path: string, timeoutMs = 3000): Promise<KeeperChildren> {
    const { sock, answer } = await connect(path, { op: 'hello' }, timeoutMs)
    return new KeeperChildren(path, sock, Number(answer.keeperPid) || 0)
  }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.error('[keeper] the child service sent a line that is not JSON:', line.slice(0, 200))
      return
    }
    if (typeof msg.event === 'string') {
      if (msg.event === 'exit' && typeof msg.id === 'string') {
        const exit = { code: (msg.code as number | null) ?? null, signal: (msg.signal as number | null) ?? null }
        this.exits.set(msg.id, exit)
        this.emit('exit', msg.id, exit)
      } else if (msg.event === 'stop') {
        this.emit('stop')
      }
      return
    }
    const rid = Number(msg.rid)
    if (msg.ok === true) this.pending.resolve(rid, msg)
    else this.pending.reject(rid, new Error(String(msg.error ?? 'the keeper refused')))
  }

  private onLost(): void {
    if (this.closed) return
    this.closed = true
    this.pending.rejectAll(new Error('the connection to the keeper was lost'))
    this.emit('lost')
  }

  get connected(): boolean {
    return !this.closed
  }

  private request(op: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('the connection to the keeper was lost'))
    const rid = this.nextRid++
    const answer = this.pending.wait(rid, REQUEST_TIMEOUT_MS, `the keeper did not answer ${op}`)
    this.sock.write(`${JSON.stringify({ ...body, op, rid })}\n`)
    return answer
  }

  async spawn(req: SpawnRequest): Promise<KeptChild> {
    const r = await this.request('spawn', req)
    return r.child as KeptChild
  }

  async list(): Promise<KeptChild[]> {
    const r = await this.request('list')
    return (r.children as KeptChild[]) ?? []
  }

  /** `group`: the child's whole process group (it leads its own session). Default: the child alone, like `ChildProcess.kill`. */
  async signal(id: string, signal: string, group = false): Promise<void> {
    await this.request('signal', { id, signal, group })
  }

  /** EOF on the child's stdin once what was written has gone through. */
  async closeStdin(id: string): Promise<void> {
    await this.request('close_stdin', { id })
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.request('resize', { id, cols, rows })
  }

  async setTag(id: string, tag: unknown): Promise<void> {
    await this.request('set_tag', { id, tag })
  }

  /** Forgets an exited child. A running one is refused: signal it first. */
  async release(id: string): Promise<void> {
    await this.request('release', { id })
    // The exit was read before the release; keeping it would add an entry per child for the host's life (#392)
    this.exits.delete(id)
  }

  /** The exit already reported for this child, if any. */
  exitOf(id: string): ChildExit | undefined {
    return this.exits.get(id)
  }

  /**
   * Opens a stream of one child: `out` (stdout, or the pty) or `err` (stderr). The keeper sends
   * what it buffered, then live output; what is written goes to the child's stdin or pty. The
   * socket comes back paused, with nothing read past the answer line.
   *
   * Half-closing it (`end()`) is a detach: the keeper sends the rest of the current line and then
   * ends the stream, and the child keeps running. Destroying it loses whatever was in flight.
   */
  async attach(id: string, stream: 'out' | 'err'): Promise<Socket> {
    const { sock } = await connect(this.path, { op: 'attach', id, stream }, 5000)
    return sock
  }

  close(): void {
    this.closed = true
    this.sock.destroy()
  }
}

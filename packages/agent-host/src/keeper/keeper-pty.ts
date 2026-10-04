import type { Socket } from 'node:net'
import { constants } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { ChildExit, KeeperChildren, KeptChild } from './children-client.js'
import type { CommandTag, TerminalTag } from './tags.js'

/**
 * A terminal or project command whose pty the keeper owns (#280 step 2), with the surface of the
 * node-pty handle `terminal.ts` and `commands.ts` already use: `pid`, `onData`, `onExit`,
 * `write`, `resize`, `kill`.
 *
 * node-pty keeps the master in the host, so a host that went away took the screen and, with
 * SIGHUP, the shell. Here the keeper holds the master and keeps draining it while no host is
 * attached; a new host's first attach replays the last 256 KiB, which becomes its scrollback.
 */

export type PtyExit = { exitCode: number; signal?: number }

export type KeeperPtySpawnOpts = {
  cwd: string
  env: Record<string, string | undefined>
  cols: number
  rows: number
  tag: TerminalTag | CommandTag
}

const EXIT_AFTER_OUTPUT_MS = 1000

export class KeeperPty {
  pid: number | undefined
  childId: string | null = null
  private sock: Socket | null = null
  private dataCbs: ((d: string) => void)[] = []
  private exitCbs: ((e: PtyExit) => void)[] = []
  private decoder = new StringDecoder('utf8')
  private queued: string[] = []
  private exit: ChildExit | null = null
  private streamEnded = false
  private exitFired = false
  private exitTimer: NodeJS.Timeout | null = null
  private detached = false
  private readonly ready: Promise<void>

  private constructor(
    private keeper: KeeperChildren,
    child: Promise<KeptChild>,
  ) {
    this.ready = this.start(child)
  }

  static spawn(keeper: KeeperChildren, file: string, args: string[], opts: KeeperPtySpawnOpts): KeeperPty {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.env)) if (typeof v === 'string') env[k] = v
    return new KeeperPty(
      keeper,
      keeper.spawn({ kind: 'pty', cmd: file, args, cwd: opts.cwd, env, cols: opts.cols, rows: opts.rows, tag: opts.tag }),
    )
  }

  static adopt(keeper: KeeperChildren, child: KeptChild): KeeperPty {
    return new KeeperPty(keeper, Promise.resolve(child))
  }

  private async start(childP: Promise<KeptChild>): Promise<void> {
    let child: KeptChild
    try {
      child = await childP
      this.childId = child.id
      this.pid = child.pid
      this.keeper.on('exit', this.onChildExit)
      this.keeper.once('lost', this.onLost)
      this.sock = await this.keeper.attach(child.id, 'out')
    } catch (e) {
      // Never a silent black screen: the reason is the only clue
      this.deliver(`\r\n\x1b[2mCould not start: ${(e as Error).message}\x1b[0m\r\n`)
      this.exit = { code: 1, signal: null }
      this.streamEnded = true
      return this.fireExit()
    }
    if (this.detached) return void this.sock.destroy()
    const sock = this.sock
    sock.on('data', (d: Buffer) => this.deliver(this.decoder.write(d)))
    sock.on('end', () => {
      this.streamEnded = true
      if (this.exit) this.fireExit()
    })
    sock.on('error', () => {})
    sock.resume()
    const known = child.exit ?? this.keeper.exitOf(child.id)
    if (known) this.recordExit(known)
    for (const q of this.queued.splice(0)) sock.write(q)
  }

  private deliver(data: string): void {
    if (!data) return
    for (const cb of this.dataCbs) cb(data)
  }

  private onChildExit = (id: string, exit: ChildExit): void => {
    if (id === this.childId) this.recordExit(exit)
  }

  private onLost = (): void => {
    if (this.detached || this.exit) return
    this.recordExit({ code: null, signal: constants.signals.SIGHUP })
    this.streamEnded = true
    this.fireExit()
  }

  private recordExit(exit: ChildExit): void {
    this.exit = exit
    if (this.streamEnded) return this.fireExit()
    // The exit is reported after the last output, never before it
    this.exitTimer ??= setTimeout(() => this.fireExit(), EXIT_AFTER_OUTPUT_MS)
  }

  private fireExit(): void {
    if (this.exitFired || this.detached || !this.exit) return
    this.exitFired = true
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.keeper.off('exit', this.onChildExit)
    this.keeper.off('lost', this.onLost)
    const tail = this.decoder.end()
    if (tail) this.deliver(tail)
    // node-pty's shape: a signalled child reports exit code 0 and the signal
    const e: PtyExit = { exitCode: this.exit.code ?? 0, ...(this.exit.signal !== null ? { signal: this.exit.signal } : {}) }
    for (const cb of this.exitCbs) cb(e)
    if (this.childId) void this.keeper.release(this.childId).catch(() => {})
  }

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (e: PtyExit) => void): void {
    this.exitCbs.push(cb)
  }

  write(data: string): void {
    if (this.detached || this.exit) return
    if (this.sock) this.sock.write(data)
    else this.queued.push(data)
  }

  resize(cols: number, rows: number): void {
    if (this.detached || this.exit) return
    void this.ready.then(() => (this.childId ? this.keeper.resize(this.childId, cols, rows) : undefined)).catch(() => {})
  }

  /** node-pty's default is SIGHUP, a terminal closing. */
  kill(signal = 'SIGHUP'): void {
    if (this.detached || this.exit) return
    void this.ready
      .then(() => (this.childId ? this.keeper.signal(this.childId, signal) : undefined))
      .catch((e: Error) => console.error(`[keeper] could not signal ${this.childId ?? 'a pty'}: ${e.message}`))
  }

  /** Lets go of the pty and leaves the child running; the keeper keeps draining it for the next host. */
  async detach(): Promise<void> {
    if (this.detached) return
    this.detached = true
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.keeper.off('exit', this.onChildExit)
    this.keeper.off('lost', this.onLost)
    await Promise.race([this.ready, new Promise((r) => setTimeout(r, 1000))])
    const sock = this.sock
    if (!sock) return
    await new Promise<void>((resolve) => {
      if (sock.readableEnded || sock.destroyed) return resolve()
      const t = setTimeout(resolve, 1000)
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      sock.once('end', done)
      sock.once('close', done)
      sock.end()
    })
    sock.destroy()
  }
}

/** A node-pty-shaped module whose `spawn` asks the keeper. The spawn options carry the tag. */
export function keeperPtyModule(keeper: KeeperChildren) {
  return {
    // A single string is node-pty's Windows command line; the keeper is unix-only and always gets an array
    spawn(file: string, args: string[] | string, opts: Record<string, unknown>): KeeperPty {
      return KeeperPty.spawn(keeper, file, Array.isArray(args) ? args : [args], {
        cwd: String(opts.cwd ?? process.cwd()),
        env: (opts.env as Record<string, string | undefined>) ?? process.env,
        cols: Number(opts.cols) || 80,
        rows: Number(opts.rows) || 24,
        tag: opts.tag as TerminalTag | CommandTag,
      })
    },
  }
}

import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import type { ChildExit, KeeperChildren, KeptChild } from './children-client.js'
import { HeldChild } from './held-child.js'
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

export class KeeperPty extends HeldChild {
  private sock: Socket | null = null
  private dataCbs: ((d: string) => void)[] = []
  private exitCbs: ((e: PtyExit) => void)[] = []
  private decoder = new StringDecoder('utf8')
  private queued: string[] = []

  private constructor(keeper: KeeperChildren, child: Promise<KeptChild>) {
    super(keeper)
    this.begin(child, ['out'])
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

  protected attached([sock]: Socket[]): void {
    this.sock = sock!
    sock!.on('data', (d: Buffer) => this.deliver(this.decoder.write(d)))
    sock!.resume()
    for (const q of this.queued.splice(0)) sock!.write(q)
  }

  protected failed(e: Error): void {
    // Never a silent black screen: the reason is the only clue
    this.deliver(`\r\n\x1b[2mCould not start: ${e.message}\x1b[0m\r\n`)
    this.exit = { code: 1, signal: null }
    for (const cb of this.exitCbs) cb({ exitCode: 1 })
  }

  private deliver(data: string): void {
    if (!data) return
    for (const cb of this.dataCbs) cb(data)
  }

  protected exited(exit: ChildExit): void {
    const tail = this.decoder.end()
    if (tail) this.deliver(tail)
    // node-pty's shape: a signalled child reports exit code 0 and the signal
    const e: PtyExit = { exitCode: exit.code ?? 0, ...(exit.signal !== null ? { signal: exit.signal } : {}) }
    for (const cb of this.exitCbs) cb(e)
  }

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (e: PtyExit) => void): void {
    this.exitCbs.push(cb)
  }

  write(data: string): void {
    if (this.gone) return
    if (this.sock) this.sock.write(data)
    else this.queued.push(data)
  }

  resize(cols: number, rows: number): void {
    if (this.gone) return
    void this.ready.then(() => (this.childId ? this.keeper.resize(this.childId, cols, rows) : undefined)).catch(() => {})
  }

  /** node-pty's default is SIGHUP, a terminal closing. */
  kill(signal = 'SIGHUP'): void {
    if (this.gone) return
    this.signalChild(signal, false, 'a pty')
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

import { isObj } from '../json-value.js'
import type { Readable, Writable } from 'node:stream'
import { spawn as startProcess, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isPtyModule, type Pty, type PtyModule } from './pty-slot.js'

/**
 * **Terminals outside the work job** (Windows, #1067; the broker itself is `pty-broker.mjs`).
 *
 * The host joins a job object that ends its work with it (`lifecycle/work-job.ts`). A terminal is the person's, not
 * the host's work: what they start there (`code .`, the browser `claude auth login` opens) must outlive a host that
 * crashes or is replaced (the owner's decision on #840 item 7). So terminals are started by the broker, a process the
 * host starts **before** it joins the job, which is in no job of the host's; Run commands, agents, git and app servers
 * are still started here, in the job.
 *
 * `brokerPtyModule` has the surface `terminal.ts` already takes from node-pty and from the keeper
 * (`keeper/keeper-pty.ts`'s `keeperPtyModule`): `spawn(file, args, opts)`, and a handle with `pid`, `onData`,
 * `onExit`, `write`, `resize`, `kill`. The pid arrives a moment after the spawn: a kill before it goes to the broker,
 * which ends the pty once it exists (kill-tree's Windows shot falls back to `kill()` when there is no pid).
 *
 * A broker that is gone (it could not start, or it ended) ends its terminals with the reason in their output, and the
 * terminals opened after it are started here, as before the broker, rather than not at all.
 */

type BrokerEvent =
  | { ev: 'ready' }
  | { ev: 'spawned'; id: number; pid: number }
  | { ev: 'error'; id: number; message: string }
  | { ev: 'data'; id: number; data: string }
  | { ev: 'exit'; id: number; exitCode: number; signal: number | null }

/**
 * Where the broker's script is: beside this file in the source tree, and beside `main.mjs` (which this file is bundled
 * into) in the bundle, where `scripts/bundle.mjs` copies it. The same relative name either way.
 */
/**
 * One line of the broker's output as an event, or null for a line that is none: not JSON, not an object (`null` used to
 * throw out of the line handler), or an event whose fields are not what it names (a `data` event with no text).
 */
export function parseBrokerEvent(line: string): BrokerEvent | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(v)) return null
  const { ev, id } = v
  if (ev === 'ready') return { ev }
  if (typeof id !== 'number') return null
  if (ev === 'spawned') return typeof v.pid === 'number' ? { ev, id, pid: v.pid } : null
  if (ev === 'error') return typeof v.message === 'string' ? { ev, id, message: v.message } : null
  if (ev === 'data') return typeof v.data === 'string' ? { ev, id, data: v.data } : null
  if (ev === 'exit') {
    if (typeof v.exitCode !== 'number') return null
    return v.signal === null || typeof v.signal === 'number' ? { ev, id, exitCode: v.exitCode, signal: v.signal } : null
  }
  return null
}

export function brokerPath(): string {
  const path = fileURLToPath(new URL('./pty-broker.mjs', import.meta.url))
  if (!existsSync(path)) throw new Error(`terminal broker not found: ${path}`)
  return path
}

export class BrokerPty implements Pty {
  pid: number | undefined
  private dataCbs: ((d: string) => void)[] = []
  private exitCbs: ((e: { exitCode: number; signal?: number }) => void)[] = []
  private ended = false

  constructor(
    private readonly broker: PtyBroker,
    readonly id: number,
  ) {}

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCbs.push(cb)
  }

  write(data: string): void {
    if (!this.ended) this.broker.send({ op: 'write', id: this.id, data })
  }

  resize(cols: number, rows: number): void {
    if (!this.ended) this.broker.send({ op: 'resize', id: this.id, cols, rows })
  }

  /** node-pty's kill on Windows ends the pseudoconsole and its shell; the signal means nothing there */
  kill(): void {
    if (!this.ended) this.broker.send({ op: 'kill', id: this.id })
  }

  /** @internal the broker's events for this pty */
  spawned(pid: number): void {
    this.pid = pid
  }

  /** @internal */
  data(data: string): void {
    if (this.ended) return
    for (const cb of this.dataCbs) cb(data)
  }

  /** @internal node-pty's shape: a signalled child reports exit code 0 and the signal */
  exited(exitCode: number, signal: number | null): void {
    if (this.ended) return
    this.ended = true
    for (const cb of this.exitCbs) cb({ exitCode, ...(signal !== null ? { signal } : {}) })
  }

  /** @internal never a silent black screen: the reason is the only clue (as `KeeperPty.failed`) */
  failed(message: string): void {
    this.data(`\r\n\x1b[2mCould not start: ${message}\x1b[0m\r\n`)
    this.exited(1, null)
  }
}

export class PtyBroker {
  private readonly ptys = new Map<number, BrokerPty>()
  private next = 1
  private gone: string | null = null

  private constructor(
    private readonly child: ChildProcess,
    private readonly stdin: Writable,
    stdout: Readable,
    stderr: Readable,
  ) {
    const lines = createInterface({ input: stdout })
    lines.on('line', (line) => this.receive(line))
    stderr.on('data', (d: Buffer) => process.stderr.write(d))
    child.once('error', (e) => this.end(`the terminal service could not start: ${e.message}`))
    child.once('exit', (code) => this.end(`the terminal service ended (${code})`))
    // A write after it ended must not become an uncaught error in the host
    stdin.on('error', () => {})
  }

  /** Starts the broker. Called before the host joins its work job, so the broker is outside it */
  static start(script: string = brokerPath()): PtyBroker {
    const child = startProcess(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const { stdin, stdout, stderr } = child
    if (!stdin || !stdout || !stderr) {
      child.kill()
      throw new Error('the terminal service started without its pipes')
    }
    return new PtyBroker(child, stdin, stdout, stderr)
  }

  get alive(): boolean {
    return this.gone === null
  }

  /** The broker's pid, for tests and the log */
  get pid(): number | undefined {
    return this.child.pid
  }

  spawn(file: string, args: string[] | string, opts: { cwd: string; env: Record<string, string | undefined>; cols: number; rows: number }): BrokerPty {
    const id = this.next++
    const p = new BrokerPty(this, id)
    this.ptys.set(id, p)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.env)) if (typeof v === 'string') env[k] = v
    this.send({ op: 'spawn', id, file, args, cwd: opts.cwd, env, cols: opts.cols, rows: opts.rows })
    return p
  }

  /** @internal */
  send(message: Record<string, unknown>): void {
    if (this.gone) return
    this.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Ends the broker; its terminals end with it */
  close(): void {
    this.stdin.end()
  }

  private receive(line: string): void {
    const e = parseBrokerEvent(line)
    if (!e) return
    if (e.ev === 'ready') return
    const p = this.ptys.get(e.id)
    if (!p) return
    if (e.ev === 'spawned') p.spawned(e.pid)
    else if (e.ev === 'data') p.data(e.data)
    else if (e.ev === 'error') {
      this.ptys.delete(e.id)
      p.failed(e.message)
    } else if (e.ev === 'exit') {
      this.ptys.delete(e.id)
      p.exited(e.exitCode, e.signal)
    }
  }

  private end(reason: string): void {
    if (this.gone) return
    this.gone = reason
    console.error(`[agent-host] ${reason}; new terminals start in the host`)
    for (const p of this.ptys.values()) p.failed(reason)
    this.ptys.clear()
  }
}

const require = createRequire(import.meta.url)

function loadNodePty(): PtyModule {
  const loaded: unknown = require('node-pty')
  if (!isPtyModule(loaded)) throw new Error('node-pty did not load as a terminal module')
  return loaded
}

/** An environment as the values that are text; a value that is not text is no variable */
function stringEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (typeof value === 'string') out[name] = value
  return out
}

/**
 * A node-pty-shaped module whose `spawn` asks the broker (as `keeperPtyModule` asks the keeper), or node-pty in this
 * host once the broker is gone (`fallback`, for tests).
 */
export function brokerPtyModule(broker: PtyBroker, fallback: () => PtyModule = loadNodePty): PtyModule {
  return {
    spawn(file: string, args: string[] | string, opts: Record<string, unknown>): Pty {
      if (!broker.alive) return fallback().spawn(file, args, opts)
      return broker.spawn(file, args, {
        cwd: typeof opts.cwd === 'string' ? opts.cwd : process.cwd(),
        env: isObj(opts.env) ? stringEnv(opts.env) : process.env,
        cols: Number(opts.cols) || 80,
        rows: Number(opts.rows) || 24,
      })
    },
  }
}

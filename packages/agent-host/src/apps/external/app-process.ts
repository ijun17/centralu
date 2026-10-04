import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'
import { Client, type PriorDiscovery, type Tool } from '@modelcontextprotocol/client'
import { CLIENT_INFO } from '@cc/protocol'
import { KILL_GRACE_MS, stopGroup, stopTree } from '../../dev-services/kill-tree.js'
import { rotateIfLarge } from '../../log-file.js'
import { resolveCommand } from '../../tool-launch.js'
import { StreamTransport } from './stream-transport.js'

/**
 * One app process (M4 A-3) — starts it, connects over MCP, records what it says, and ends it.
 *
 *   fd 0/1  host = MCP client, app = server (our StreamTransport, generation probing in place)
 *   fd 2    the app's stderr → the app's own log file (secret values masked)
 *   fd 3    the broker pipe — the host is the server, the app is the client (A-4 opens the broker
 *           server on top of it)
 *
 * Lifecycle rules (when to start, when to stop, how many times to revive it) do not live here — the
 * runtime decides that. This file knows only the physics of "a process, started once".
 */

export type SpawnSpec = {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  logMaxBytes: number
  /** Masks secret values before writing to the log */
  redact: (text: string) => string
  /** The spec generation discovered last time for this app — skips the probe if present */
  prior?: PriorDiscovery
  probeTimeoutMs: number
  connectTimeoutMs: number
  /** After a failed start, how long to wait for the process to exit before writing the reason (`RuntimeTiming.startExitWaitMs`) */
  exitWaitMs: number
  /**
   * Opens the broker server on fd 3 — right after starting, before the connection. The app has to be
   * able to call the broker from within its very first tool call. Closed with the function this
   * returns (together with the shutdown rule).
   */
  serveFd3?: (fd3: Socket, note: (line: string) => void) => () => void
}

export type ExitInfo = { code: number | null; signal: string | null; error: string | null }

/**
 * The app failed to start — carries a reason a person can read (`message`: the headline plus the
 * tail of stderr), and **also** keeps the two parts separately (C-6). An error bundle needs to show
 * "what happened" and "what the app printed" separately without having to split the text apart
 * again.
 */
export class AppStartError extends Error {
  constructor(
    message: string,
    readonly head: string,
    readonly stderr: string[],
  ) {
    super(message)
  }
}

export class AppProcess {
  readonly startedAt = Date.now()
  readonly client: Client
  /** The tool list received on connection (the raw text, before filtering) — asked once per process */
  tools: Tool[] = []
  exit: ExitInfo | null = null
  /** Fires when the process ends while we are not the ones stopping it — the runtime counts this as a crash */
  onUnexpectedExit?: (reason: string) => void

  private stopping: Promise<void> | null = null
  private exitWaiters: (() => void)[] = []
  private closeFd3Server: (() => void) | null = null

  private constructor(
    readonly child: ChildProcess,
    readonly fd3: Socket | null,
    readonly log: AppLog,
    probeTimeoutMs: number,
  ) {
    this.client = new Client(
      { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
      /*
       * **The generation is stated explicitly.** The v2 client's default is the 2025 spec (S-4:
       * connecting with the default even spoke legacy to a 2026-07-28 server). `auto` asks with
       * `server/discover`, and if there is no answer or the method is unrecognized, it falls back to
       * the old `initialize` — this connects to servers of either generation.
       */
      { versionNegotiation: { mode: 'auto', probe: { timeoutMs: probeTimeoutMs } }, capabilities: {} },
    )
    const settle = (info: ExitInfo) => {
      if (this.exit) return
      this.exit = info
      /*
       * 'exit' can arrive before stderr has finished flowing out — and it is exactly the last line
       * that carries the crash reason. This waits briefly for 'close' (every pipe closed), but if a
       * grandchild the app spawned inherited the pipe and is holding it open, 'close' never comes. So
       * a short cap is used instead.
       */
      let done = false
      const finish = () => {
        if (done) return
        done = true
        this.log.flush()
        this.log.note(`exited (${describeExit(info)})`)
        for (const w of this.exitWaiters.splice(0)) w()
        if (!this.stopping) this.onUnexpectedExit?.(this.reason(`exited (${describeExit(info)})`))
      }
      child.once('close', finish)
      setTimeout(finish, 150).unref()
    }
    child.once('exit', (code, signal) => settle({ code, signal, error: null }))
    child.once('error', (e) => settle({ code: null, signal: null, error: e.message }))
    child.stderr?.on('data', (chunk: Buffer) => this.log.stderr(chunk))
    // So a pipe error (EPIPE and similar) never becomes an unhandled exception in the host — 'exit' is what reports the ending
    child.stdin?.on('error', () => {})
    fd3?.on('error', () => {})
  }

  /**
   * "Started" means starting the process, connecting, and reading the tool list — all three.
   *
   * Why the tool list is read here (S-6): a server that had failed to start still had **a live
   * process**, and returned nothing but `-32603` for every request. If success were judged by the
   * connection alone, that app would look started while every call fails for no visible reason. It
   * only counts as started once the tool list comes back — if it does not, that failure itself
   * becomes the reason shown to a person and the building agent.
   */
  static async start(spec: SpawnSpec): Promise<AppProcess> {
    const log = new AppLog(spec.logPath, spec.logMaxBytes, spec.redact)
    log.note(`starting: ${spec.command} ${spec.args.join(' ')}`)
    // Windows: `npx` is `npx.cmd`, which cannot be spawned without a shell (tool-launch.ts)
    const launch = resolveCommand(spec.command, spec.env)
    const child = spawn(launch.command, [...launch.args, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      /*
       * Gives it its own process group. kill-tree never signals the host's own group, so without a
       * separate group there would be no way to end the app and its descendants group-wide.
       *
       * Not on Windows (#14): there `detached` means DETACHED_PROCESS, which leaves the app with no
       * console at all, so every console program it starts opens a visible window of its own. Windows
       * has no groups to gain, and its tree is ended with `taskkill /T` (kill-tree.ts). Attached and
       * hidden, the app shares the host's windowless console.
       */
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const proc = new AppProcess(child, (child.stdio[3] as Socket | undefined) ?? null, log, spec.probeTimeoutMs)
    if (proc.fd3 && spec.serveFd3) proc.closeFd3Server = spec.serveFd3(proc.fd3, (line) => log.note(line))
    try {
      await proc.connect(spec)
      log.note(`ready: pid ${child.pid} era ${proc.client.getProtocolEra()} (${proc.client.getNegotiatedProtocolVersion()})${spec.prior ? ' via cached verdict' : ''}`)
      return proc
    } catch (e) {
      /*
       * The reason the connection broke is usually the process dying, and that fact needs to be
       * stated first. Measured: for an app that immediately does `exit(3)`, the SDK's "connection
       * closed during the server/discover probe" arrived before news of the exit — reading that
       * message alone makes it look like the generation probe itself is the problem.
       */
      await proc.waitExit(spec.exitWaitMs)
      const head = proc.exit ? `exited before it was ready (${describeExit(proc.exit)})` : (e as Error).message
      const reason = proc.reason(head)
      const stderr = proc.log.tailLines()
      await proc.stop(0)
      throw new AppStartError(reason, head, stderr)
    }
  }

  /** So the next startup can connect without probing — the generation discovered (S-4's `connect({ prior })`) */
  verdict(): PriorDiscovery | undefined {
    const era = this.client.getProtocolEra()
    if (era === 'modern') {
      const discover = this.client.getDiscoverResult()
      return discover ? { kind: 'modern', discover } : undefined
    }
    return era === 'legacy' ? { kind: 'legacy' } : undefined
  }

  get alive(): boolean {
    return this.exit === null
  }

  /**
   * The shutdown rule (S-5).
   *
   * **Stdin and fd 3 are closed together.** Closing only stdin was not enough to end the app — a
   * Node app was held open by the fd 3 socket, and the official Python SDK's app was held open by its
   * read thread (measured in S-5). Once both are closed, a well-built app ends on its own (Node
   * 11ms, Python 2–7ms). If it does not end within the grace period, **its descendants** are ended
   * too (kill-tree — the same method used for the terminal and the command runner).
   *
   * Even when it ends on its own, descendants can remain in its group (a helper the app started). The
   * app's group is one we created ourselves (detached), so it is collected group-wide — the same two
   * blows as other shutdown paths (SIGTERM, then SIGKILL for anything left after the grace period,
   * via kill-tree's `stopGroup`). Previously there was only one blow, SIGTERM, and a helper that
   * ignored it was left orphaned under launchd. While anyone remains in a group, its pgid is not
   * reused, so this never reaches into someone else's group.
   */
  stop(graceMs: number, opts: { awaitKill?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      void this.client.close().catch(() => {})
      this.closeFd3Server?.()
      this.child.stdin?.end()
      this.fd3?.end()
      if (this.alive && !(await this.waitExit(graceMs))) {
        this.log.note(`did not exit within ${graceMs}ms of stdin and fd 3 closing — stopping the process tree`)
        stopTree({ pid: this.child.pid, kill: (s) => this.child.kill(s as NodeJS.Signals) }, KILL_GRACE_MS, () => this.alive)
        if (opts.awaitKill !== false) await this.waitExit(KILL_GRACE_MS + 1000)
      } else {
        this.signalOwnGroup()
      }
      this.fd3?.destroy()
      this.log.close()
    })()
    return this.stopping
  }

  /** The failure text plus the last lines the app left on stderr — read by a person and the building agent */
  reason(head: string): string {
    const tail = this.log.tail()
    return tail ? `${head}\n--- stderr (last lines) ---\n${tail}` : head
  }

  private async connect(spec: SpawnSpec): Promise<void> {
    const { stdout, stdin } = this.child
    if (!stdout || !stdin) throw new Error('the app process has no stdio pipes')
    const died = new Promise<never>((_, reject) => {
      this.exitWaiters.push(() => reject(new Error(`exited before it was ready (${describeExit(this.exit!)})`)))
    })
    died.catch(() => {})
    const transport = new StreamTransport(stdout, stdin, { pid: this.child.pid ?? null })
    const opts = { timeout: spec.connectTimeoutMs }
    await Promise.race([this.client.connect(transport, spec.prior ? { ...opts, prior: spec.prior } : opts), died])
    const listed = await Promise.race([this.client.listTools(undefined, opts), died])
    this.tools = listed.tools
  }

  private waitExit(ms: number): Promise<boolean> {
    if (!this.alive) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      t.unref()
      this.exitWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  private signalOwnGroup(): void {
    const pid = this.child.pid
    if (typeof pid !== 'number') return
    stopGroup(pid, KILL_GRACE_MS)
  }
}

function describeExit(e: ExitInfo): string {
  if (e.error) return `could not run: ${e.error}`
  if (e.signal) return `signal ${e.signal}`
  return `code ${e.code}`
}

/** The tail of stderr to attach to a crash reason — both the number of lines and each line's length are capped */
const TAIL_LINES = 20
const TAIL_LINE_CHARS = 500

/**
 * An app's own log file. The same rules as host.log (`log-file.ts`): overflow rolls it to `.1`,
 * writes are synchronous, and failures are swallowed — failing to write a log is never a reason to
 * stop the app.
 *
 * An app's stderr is written **only after masking it line by line.** Even if an app prints its own
 * secret, only the name survives in the file (a secret is never written anywhere in a log — from the
 * plan "data and secrets").
 */
class AppLog {
  private fd: number | null = null
  private written = 0
  private partial = ''
  private recent: string[] = []

  constructor(
    private path: string,
    private maxBytes: number,
    private redact: (text: string) => string,
  ) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      rotateIfLarge(path, maxBytes)
      this.written = existsSync(path) ? statSync(path).size : 0
      this.fd = openSync(path, 'a')
    } catch {
      this.fd = null
    }
  }

  note(text: string): void {
    this.write(`${new Date().toISOString()} [centralu] ${this.redact(text)}\n`)
  }

  stderr(chunk: Buffer): void {
    const lines = (this.partial + chunk.toString('utf8')).split('\n')
    this.partial = lines.pop() ?? ''
    // So a line that never ends does not consume memory — if it gets long, it is written even if that means cutting it off
    if (this.partial.length > 8192) {
      lines.push(this.partial)
      this.partial = ''
    }
    for (const line of lines) this.appLine(line)
  }

  flush(): void {
    if (this.partial) this.appLine(this.partial)
    this.partial = ''
  }

  tail(): string {
    return this.recent.join('\n')
  }

  /** The last lines of stderr (after masking) — a copy. An error bundle (C-6) carries away the ones from that moment */
  tailLines(): string[] {
    return [...this.recent]
  }

  close(): void {
    this.flush()
    try {
      if (this.fd !== null) closeSync(this.fd)
    } catch {
      /* already closed */
    }
    this.fd = null
  }

  private appLine(line: string): void {
    const red = this.redact(line)
    this.recent.push(red.length > TAIL_LINE_CHARS ? `${red.slice(0, TAIL_LINE_CHARS)}…` : red)
    if (this.recent.length > TAIL_LINES) this.recent.shift()
    this.write(`${red}\n`)
  }

  private write(text: string): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, text)
      this.written += Buffer.byteLength(text)
      if (this.written >= this.maxBytes) this.roll()
    } catch {
      /* even if the write fails, the app keeps running */
    }
  }

  /** For the same reason as roll in log-file.ts, never hold onto a closed fd number */
  private roll(): void {
    try {
      if (this.fd !== null) closeSync(this.fd)
    } catch {
      /* already closed */
    }
    this.fd = null
    try {
      renameSync(this.path, `${this.path}.1`)
    } catch {
      /* if it cannot be rolled, keep writing to the same file */
    }
    try {
      this.fd = openSync(this.path, 'a')
    } catch {
      /* if it cannot be opened, only the file side goes quiet */
    }
    this.written = 0
  }
}

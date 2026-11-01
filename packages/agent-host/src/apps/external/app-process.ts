import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { Socket } from 'node:net'
import { dirname } from 'node:path'
import { Client, type PriorDiscovery, type Tool } from '@modelcontextprotocol/client'
import { CLIENT_INFO } from '@cc/protocol'
import { KILL_GRACE_MS, hasProcessGroups, stopTree } from '../../dev-services/kill-tree.js'
import { killHandle, spawnGrouped, sweepLeftovers, type GroupedChild } from '../../dev-services/grouped-child.js'
import { RollingFile } from '../../log-file.js'
import { LineTail, lineSplitter, type LineSplitter } from '../../stream-text.js'
import { ExitAfterDrain } from '../../exit-after-drain.js'
import { resolveCommand, type ToolLaunch } from '../../tool-launch.js'
import type { Redact } from './secrets.js'
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
  /** Masks secret values: in the log, and in the text of a failed start (`AppStartError`) */
  redact: Redact
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
  /**
   * The process is spawned, before it is ready (#839): whoever must be able to stop it while it starts (the host
   * quitting) learns of it here, not only once it answers
   */
  onSpawn?: (proc: AppProcess) => void
}

/**
 * How long an app's exit waits for `close` (every pipe closed) before it is reported anyway. Shorter than an agent's
 * `EXIT_AFTER_OUTPUT_MS`: a failed start waits only `RuntimeTiming.startExitWaitMs` (250 ms) for the exit, and the
 * reason it reports needs the stderr flushed by then.
 */
const EXIT_AFTER_CLOSE_MS = 150

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
  /** Settles once it has exited and, on Windows, what it left running has been collected (`stop`) */
  private leftovers: Promise<void> | null = null
  private exitWaiters: (() => void)[] = []
  private closeFd3Server: (() => void) | null = null

  private constructor(
    readonly child: ChildProcess,
    readonly fd3: Socket | null,
    readonly log: AppLog,
    probeTimeoutMs: number,
    /** Its start and exit times (`spawnGrouped`): how Windows tells what it left behind (`collectLeftovers`) */
    private readonly started: GroupedChild,
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
      const finish = () => {
        this.log.flush()
        this.log.note(`exited (${describeExit(info)})`)
        for (const w of this.exitWaiters.splice(0)) w()
        if (!this.stopping) this.onUnexpectedExit?.(this.reason(`exited (${describeExit(info)})`))
      }
      const report = new ExitAfterDrain(finish, EXIT_AFTER_CLOSE_MS)
      child.once('close', () => report.drained())
      report.exited()
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
    let launch: ToolLaunch = { command: spec.command, args: [] }
    let started: ReturnType<typeof spawnGrouped>
    try {
      // Windows: `npx` is `npx.cmd`, which cannot be spawned without a shell (tool-launch.ts); a path is the app folder's
      launch = resolveCommand(spec.command, spec.env, undefined, spec.cwd)
      started = spawnGrouped(launch.command, [...launch.args, ...spec.args], {
        cwd: spec.cwd,
        env: withUtf8Python(spec.env),
        /*
         * fd 3 is the broker pipe, and the one stdio pipe used in both directions. On Windows a plain
         * 'pipe' reaches the child as a synchronous handle, and Windows serialises I/O on a
         * synchronous handle: the app's read waiting on fd 3 holds back its own write of the request,
         * so the host never sees it and every broker call timed out (the first Windows test run,
         * #14). 'overlapped' hands the child an overlapped handle, which Node's net.Socket reads and
         * writes at once; off Windows it is the same as 'pipe'. stdin and stdout each go one way.
         */
        stdio: ['pipe', 'pipe', 'pipe', 'overlapped'],
        /*
         * Gives it its own process group. kill-tree never signals the host's own group, so without a
         * separate group there would be no way to end the app and its descendants group-wide.
         *
         * Not on Windows (#14): there `detached` means DETACHED_PROCESS, which leaves the app with no
         * console at all, so every console program it starts opens a visible window of its own. Windows
         * has no groups to gain, and its tree is ended with `taskkill /T` (kill-tree.ts). Attached and
         * hidden, the app shares the host's windowless console (`spawnGrouped`).
         */
      })
    } catch (e) {
      /*
       * A spawn that fails before there is a process (EINVAL for a `.cmd` on Windows, #849) throws instead of reporting
       * an 'error': it is a failed start like any other, with the log closed rather than held open for good.
       */
      const shim = /\.(cmd|bat)$/i.test(launch.command) ? ' (a .cmd or .bat that is not a package manager shim needs a shell: name the program it starts)' : ''
      const head = spec.redact(`could not run ${launch.command}: ${(e as Error).message}${shim}`)
      log.note(head)
      log.close()
      throw new AppStartError(head, head, [])
    }
    const { child } = started
    const proc = new AppProcess(child, (child.stdio[3] as Socket | undefined) ?? null, log, spec.probeTimeoutMs, started)
    if (proc.fd3 && spec.serveFd3) proc.closeFd3Server = spec.serveFd3(proc.fd3, (line) => log.note(line))
    spec.onSpawn?.(proc)
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
      /*
       * Masked like the stderr lines in the log (`AppLog`): the text is the app's own (an error its tool list threw), and
       * it goes on to the list, the error bundle, a check report and a caller's refusal.
       */
      const head = proc.exit ? `exited before it was ready (${describeExit(proc.exit)})` : spec.redact((e as Error).message)
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
   *
   * Windows has no groups. Once the app has ended, what it left running is found by parent links
   * and ended (`collectLeftovers`). That takes a process listing (~0.5 s), so by default it runs
   * after this returns; `awaitTree` waits for it, for a caller about to move or delete the app's
   * folder, which Windows refuses while a process has it as its working directory.
   *
   * `awaitTree` waits for the app's own exit too, not for the bounded waits below (#1818): on a loaded machine the
   * exit can land after them, and the caller then deleted a folder the app still held. What it left running is
   * collected once it has exited, however late, since only then is the window of its leftovers known.
   */
  stop(graceMs: number, opts: { awaitKill?: boolean; awaitTree?: boolean } = {}): Promise<void> {
    // A stop already under way, started by someone who did not wait for the tree: this caller still does
    if (this.stopping) return opts.awaitTree ? this.stopping.then(() => this.leftovers ?? undefined) : this.stopping
    this.stopping = (async () => {
      void this.client.close().catch(() => {})
      this.closeFd3Server?.()
      this.child.stdin?.end()
      this.fd3?.end()
      if (this.alive && !(await this.waitExit(graceMs))) {
        this.log.note(`did not exit within ${graceMs}ms of stdin and fd 3 closing — stopping the process tree`)
        stopTree(killHandle(this.child), KILL_GRACE_MS, () => this.alive)
        if (opts.awaitKill !== false) await this.waitExit(KILL_GRACE_MS + 1000)
      } else if (hasProcessGroups()) {
        void this.collectLeftovers()
      }
      this.fd3?.destroy()
      const exited = this.waitExit().then(() => {})
      const leftovers = hasProcessGroups() ? exited : exited.then(() => this.collectLeftovers())
      this.leftovers = leftovers
      if (opts.awaitTree) await leftovers
      // The log stays open for the leftovers' note, if they are collected after this returns
      if (!hasProcessGroups() && !opts.awaitTree) void leftovers.finally(() => this.log.close())
      else this.log.close()
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

  /** Whether it exited within `ms`; without `ms`, once it has exited, however long that takes */
  private waitExit(ms?: number): Promise<boolean> {
    if (!this.alive) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = ms === undefined ? undefined : setTimeout(() => resolve(false), ms)
      t?.unref()
      this.exitWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  /**
   * Ends what the app left running once it has ended (`sweepLeftovers`): its group on macOS and Linux, at once; on
   * Windows what descends from it by parent links (kill-tree's `collectOrphansWindows`). Never rejects
   */
  private async collectLeftovers(): Promise<void> {
    const ended = await sweepLeftovers(this.started)
    if (ended.length > 0) this.log.note(`ended ${ended.length} process(es) it left running: ${ended.join(', ')}`)
  }
}

/**
 * An app's environment with Python's standard streams in UTF-8, unless the app's environment already chooses (#849).
 *
 * The host reads an app's stderr as UTF-8 (`AppLog`). Python writes a pipe in the locale's code page instead, which on
 * Windows is the ANSI one: on a Korean machine every Korean line of a Python app's stderr (its crash reason) reached the
 * log and the person as U+FFFD. `PYTHONIOENCODING=utf-8` changes the standard streams and nothing else. Not
 * `PYTHONUTF8=1`: that also makes UTF-8 what `open()` and the locale default to, so an app, or a Python program a Node
 * app starts, reading its own code page's files without naming an encoding would fail. An app that sets either itself
 * keeps its choice. Other programs ignore both.
 */
export function withUtf8Python(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Windows spells names in any case, and a copy of its environment is a plain object
  const chosen = Object.entries(env).some(([k, v]) => v !== undefined && (k.toUpperCase() === 'PYTHONIOENCODING' || k.toUpperCase() === 'PYTHONUTF8'))
  return chosen ? env : { ...env, PYTHONIOENCODING: 'utf-8' }
}

function describeExit(e: ExitInfo): string {
  if (e.error) return `could not run: ${e.error}`
  if (e.signal) return `signal ${e.signal}`
  return `code ${e.code}`
}

/** The tail of stderr to attach to a crash reason — both the number of lines and each line's length are capped */
const TAIL_LINES = 20
const TAIL_LINE_CHARS = 500
/** A stderr line longer than this is written in pieces */
const MAX_LINE_CHARS = 8192

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
  private readonly file: RollingFile
  private readonly lines: LineSplitter
  private readonly recent = new LineTail(TAIL_LINES, TAIL_LINE_CHARS)

  constructor(
    path: string,
    maxBytes: number,
    private redact: Redact,
  ) {
    /*
     * So a line that never ends does not consume memory — if it gets long, it is written even if that means cutting it off.
     * The cut is made on the masked text, and the end of it stays for the next chunk: that end may be the start of a value
     * the next chunk finishes, and a value cut in two is masked in neither piece (#1142). The longest value fits in what is
     * kept back, so a line with secrets is cut only after MAX_LINE_CHARS and that much more.
     */
    const hold = Math.max(0, (redact.reach ?? 0) - 1)
    this.lines = lineSplitter((line) => this.appLine(line), {
      maxLine: MAX_LINE_CHARS + hold,
      cut: (unfinished) => {
        const masked = this.redact(unfinished)
        return masked.length <= hold ? { line: masked, keep: '' } : { line: masked.slice(0, masked.length - hold), keep: masked.slice(masked.length - hold) }
      },
    })
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      /* the file below goes quiet if its folder is not there */
    }
    this.file = new RollingFile(path, maxBytes)
  }

  note(text: string): void {
    this.write(`${new Date().toISOString()} [centralu] ${this.redact(text)}\n`)
  }

  stderr(chunk: Buffer): void {
    this.lines.push(chunk)
  }

  flush(): void {
    this.lines.flush()
  }

  tail(): string {
    return this.recent.text
  }

  /** Masks the app's secret values in a text that is about to leave: the same rule as the lines above (a check report quotes the app's own errors) */
  mask(text: string): string {
    return this.redact(text)
  }

  /** The last lines of stderr (after masking) — a copy. An error bundle (C-6) carries away the ones from that moment */
  tailLines(): string[] {
    return this.recent.snapshot()
  }

  close(): void {
    this.flush()
    this.file.close()
  }

  private appLine(line: string): void {
    const red = this.redact(line)
    this.recent.push(red)
    this.write(`${red}\n`)
  }

  private write(text: string): void {
    this.file.write(text)
  }
}

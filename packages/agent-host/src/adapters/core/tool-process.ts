import { rpcError } from '../../rpc-error.js'
import { waitForExit } from '../../timing.js'
import { lineSplitter } from '../../transport/json-lines.js'
import type { AgentProcess, AgentSpawnSpec, ProcessSource } from '../contract.js'
import { frameRecorder, type FrameRecorder } from '../frames/recorder.js'
import { spawnLocalAgent } from '../local-process.js'
import { GateRequests } from './gate.js'

/**
 * The frame tap (docs/plans/session-core.md §6.1, #1654): the one place a tool's lines are recorded, for every tool, at its
 * process instead of in each wire's client. It sees what any wire writes: every line to stdin and every line from stdout, in
 * order, and how the process ended. It reads and records only: no line is held, split differently, dropped or changed for
 * whoever reads or writes after it, and the process returned is the one given.
 *
 * Call it before the wire's own reader is attached, so a line is recorded before the wire has seen it (all the lines of
 * a chunk before the wire handles the first: the order on the pipe). A blank line is not a frame and is not recorded.
 */
export function tapProcess<P extends AgentProcess>(proc: P, recorder: FrameRecorder | undefined): P {
  if (!recorder) return proc
  const out = lineSplitter((line) => line.trim() && recorder.frame('out', line))
  const original: unknown = Reflect.get(proc.stdin, 'write')
  if (typeof original !== 'function') return proc
  // Recorded where it is written, so the order against the lines read is the order they happened in. Called on the stream
  // it came from with the arguments it was given, whatever overload the wire used
  Object.defineProperty(proc.stdin, 'write', {
    configurable: true,
    writable: true,
    value: (chunk: unknown, ...rest: unknown[]): unknown => {
      if (typeof chunk === 'string') out.push(chunk)
      else if (chunk instanceof Uint8Array) out.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      const written: unknown = Reflect.apply(original, proc.stdin, [chunk, ...rest])
      return written
    },
  })
  const incoming = lineSplitter((line) => line.trim() && recorder.frame('in', line))
  proc.stdout.on('data', (chunk: Buffer | string) => incoming.push(chunk))
  proc.once('exit', (code, signal) => recorder.exit(code, signal))
  return proc
}

/** The tap for a session's process, off unless `CC_RECORD_FRAMES` is set (`frames/recorder.ts`) */
export function tapSessionProcess<P extends AgentProcess>(proc: P, sessionId: string): P {
  return tapProcess(proc, frameRecorder(sessionId))
}

/** The answer for a tool whose launch is gone (not installed, or removed since): at the first open and at every relaunch */
export function toolNotInstalled(label: string, install?: string): Error {
  return rpcError(install ? `${label} is not installed. ${install}` : `${label} is not installed.`, 'tool_not_installed')
}

/** A start that failed because the program is not there (`ENOENT`) or cannot be run (`EACCES`): the tool is not installed */
export function isMissingProgram(err: unknown): boolean {
  const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined
  return code === 'ENOENT' || code === 'EACCES'
}

/** How long a stopped tool has after stdin's end to exit on its own before its tree is killed (Codex and ACP, measured as enough) */
export const STOP_GRACE_MS = 2_000

/** Where a tool's process comes from (docs/plans/session-core.md §5, §7.2 PR 3) */
export type ToolStart = {
  /** The session it serves: its frames are recorded under it (`CC_RECORD_FRAMES`). None for a lookup process, which records nothing */
  sessionId?: string
  /** Under the keeper: the keeper's child, which outlives this host by design and so starts without the host watch */
  source?: ProcessSource
  /** This host's own start, `spawnLocalAgent` unless a test or an adapter passes another */
  spawn?: (spec: AgentSpawnSpec) => AgentProcess
}

/**
 * Starts a tool's process: the one start for every tool (Codex, ACP; Claude through the SDK's `spawnClaudeCodeProcess`).
 * Started by this host, it ends with this host however the host ends (`endsWithHost`, #1654 Q3: every tool, not ACP alone);
 * started in the keeper, it is the keeper's. Tapped before anyone reads it, so the wire's reader comes after the tap.
 */
export function startToolProcess(spec: AgentSpawnSpec, how: ToolStart = {}): AgentProcess {
  const plain: AgentSpawnSpec = { command: spec.command, args: spec.args, env: spec.env, ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }) }
  const proc = how.source ? how.source.spawn(plain) : (how.spawn ?? spawnLocalAgent)({ ...plain, endsWithHost: true })
  return how.sessionId ? tapSessionProcess(proc, how.sessionId) : proc
}

/** A process a previous host left running, taken over as it is (the keeper's `adopt`): tapped from the adoption on */
export function adoptToolProcess(proc: AgentProcess, sessionId: string | undefined): AgentProcess {
  return sessionId ? tapSessionProcess(proc, sessionId) : proc
}

/** The host log's line for what a tool writes to stderr, cut at 500 characters (the tail for messages is `stderrTail`) */
export function logToolStderr(proc: AgentProcess, label: string): void {
  proc.stderr?.on('data', (d) => {
    const s = String(d).trim()
    if (s) console.error(`[${label}]`, s.slice(0, 500))
  })
}

/**
 * Stops a tool: stdin's end first, so it can end its own children and leave its files tidy (Codex removes its thread lock on
 * EOF and not on a signal, #57), then its whole tree once `graceMs` has passed without an exit. `exited`: the caller already
 * saw it end, so nothing is waited for.
 */
export async function stopToolProcess(proc: AgentProcess, opts: { graceMs?: number; exited?: boolean } = {}): Promise<void> {
  proc.stdin.end()
  const gone = opts.exited === true || (await waitForExit(proc, opts.graceMs ?? STOP_GRACE_MS))
  if (!gone) proc.kill('SIGKILL')
}

/** Ends a process outright with its tree and waits up to `boundMs` for it to go (an adopted process a tool cannot take over) */
export async function endToolProcess(proc: AgentProcess, boundMs: number): Promise<void> {
  proc.kill('SIGKILL')
  await waitForExit(proc, boundMs)
}

/**
 * How a tool is launched for a conversation: `null` to start a new one, the id to go on with one. A tool whose process
 * cannot outlive a Stop or a flag change (`agy`: SIGINT ends it; model and effort are flags) is launched again on the same
 * conversation (`--conversation <id>`), so the launch is asked each time, not once. `null` back: not installed.
 */
export type ToolLaunch = (resume: { externalId: string } | null) => Promise<AgentSpawnSpec | null>

/**
 * A session's process across its replacements (#1654 seam gaps 1, 2 and 4, measured on `agy` 1.4.7): the launch is asked
 * again for every new process, with the conversation's id once it is known, and that id may be learned after the process
 * started (`agy` says it only in `init`, after the first input: `noteExternalId`). A Stop answers every open gate request
 * `deny` before the process hears of it, since `agy` does not act on SIGINT while a gate hook waits.
 */
export class SessionProcess {
  private proc: AgentProcess | null = null
  private id: string | null
  private closed = false
  /** Starts and stops run one at a time, in the order asked: a Stop asked while a start awaits the launch stops what it starts */
  private chain: Promise<unknown> = Promise.resolve()
  readonly gates = new GateRequests()

  constructor(
    private readonly label: string,
    private readonly launch: ToolLaunch,
    private readonly how: ToolStart & {
      graceMs?: number
      /** How to install the tool, for the "not installed" answer (`toolNotInstalled`) */
      install?: string
      /** Told of each process as it starts, before anyone awaits it: the core watches its exit from here (`ledger.ts`) */
      onStart?: (proc: AgentProcess) => void
    },
    resumeExternalId: string | null,
  ) {
    this.id = resumeExternalId
  }

  /** The running process: null before the first start, after a stop, and once it has ended on its own */
  get current(): AgentProcess | null {
    return this.proc && !ended(this.proc) ? this.proc : null
  }

  /** The conversation's id: the one resumed, or the one the tool said last */
  get externalId(): string | null {
    return this.id
  }

  /**
   * The tool said its conversation's id, after its process started: every later launch goes on with it. `from`: the process
   * that said it, so a late line from a process already replaced does not change the id the current one goes on with
   */
  noteExternalId(id: string, from?: AgentProcess): void {
    if (from && from !== this.proc) return
    this.id = id
  }

  /** Starts a process for the conversation (a new one while its id is unknown), unless one runs */
  start(): Promise<AgentProcess> {
    return this.serial(() => this.startNow())
  }

  /** Ends the process (`stop`) and starts the next one on the same conversation: after a Stop, or a change of model or effort */
  relaunch(): Promise<AgentProcess> {
    return this.serial(async () => {
      await this.stopNow('The session is restarting.')
      return this.startNow()
    })
  }

  /**
   * A Stop by signal (`agy`: SIGINT, which ends its process). Every open gate request is answered `deny` first: a hook still
   * waiting holds the tool where it does not act on the signal. False when there is no process to signal.
   */
  interrupt(signal: NodeJS.Signals = 'SIGINT'): boolean {
    this.gates.denyAll('The turn was stopped.')
    return this.current?.kill(signal) ?? false
  }

  /** Denies every open gate request, then stops the process (stdin's end, the bound, the tree); a later start starts another */
  stop(reason = 'The turn was stopped.'): Promise<void> {
    // Held from now until the stop is done, also while it waits behind a start
    const release = this.gates.hold(reason)
    return this.serial(() => this.stopNow(reason)).finally(release)
  }

  /** The session's end: what is open and what asks later is denied, the process is stopped, and nothing starts again */
  close(): Promise<void> {
    this.closed = true
    this.gates.close('The session is closing.')
    return this.serial(() => this.stopNow('The session is closing.'))
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.chain.then(step, step)
    this.chain = next.catch(() => {})
    return next
  }

  private async startNow(): Promise<AgentProcess> {
    if (this.closed) throw new Error(`${this.label}'s session is closed`)
    if (this.current) throw new Error(`${this.label} is already running`)
    const spec = await this.launch(this.id === null ? null : { externalId: this.id })
    if (!spec) throw toolNotInstalled(this.label, this.how.install)
    // Closed while the launch was asked for: nothing is started that no one would stop
    if (this.closed) throw new Error(`${this.label}'s session is closed`)
    // What the process before left asking has no process to answer to
    this.gates.denyAll('The process was replaced.')
    const proc = startToolProcess(spec, this.how)
    this.proc = proc
    this.how.onStart?.(proc)
    return proc
  }

  private async stopNow(reason: string): Promise<void> {
    const release = this.gates.hold(reason)
    try {
      const proc = this.proc
      this.proc = null
      if (proc) await stopToolProcess(proc, { exited: ended(proc), ...(this.how.graceMs === undefined ? {} : { graceMs: this.how.graceMs }) })
    } finally {
      release()
    }
  }
}

const ended = (proc: AgentProcess): boolean => proc.exitCode !== null || proc.signalCode != null

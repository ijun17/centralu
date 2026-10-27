import type { ApprovalDecision, NormalizedEvent, PermissionPreset, TokenUsage } from '@cc/protocol'
import { lineSplitter } from '../../stream-text.js'
import type { AgentSpawnSpec, CreateSessionOpts, EventSink, SessionHandle } from '../contract.js'
import type { GateAnswer, GateChannel, GateHandler, GateInbound, GateRequest } from '../core/gate.js'
import { CoreSession } from '../core/ledger.js'
import type { CoreIo, RunningTurn, ToolWire, TurnEnding, TurnInput } from '../core/seam.js'
import type { ToolStart } from '../core/tool-process.js'
import { agyMcpDescriptors, agySettingsPath, readDenyRules, type DenyRule } from './deny-rules.js'
import { AgyGate, CLOSING, readHookCall } from './gate.js'
import { launchArgs } from './launch.js'
import { pluginRootFor, removePluginRoot, writePluginRoot, type GateSources, type PluginFiles } from './plugin-root.js'
import { AgyWire, type WireOutput } from './wire.js'

/**
 * One Centralu session on `agy` (docs/plans/antigravity-adapter.md): the `agy` wire (`wire.ts`, pure) and its gate
 * (`gate.ts`) on the session core (docs/plans/session-core.md §8). The core owns the queue, the receipts, the Stop, the exit
 * and the process; this file owns what is `agy`'s: the launch (flags, plugin root, the gate's key in the environment), the
 * lines in and out, and the approval cards.
 *
 * **One process per Stop.** `agy` ends its process on SIGINT (`interruptEndsProcess`), so the core asks `launch` again for
 * every new process, with the conversation's id (`--conversation`), which `agy` says only in `init` (`externalId`).
 * **One gate key per process.** `launch` opens the gate's channel (a new key revokes the last one) and writes the plugin
 * root afresh; the channel is closed when that process exits and when the session closes.
 */

/** What the host gives the `agy` adapter; the file operations are Node's (`fs/promises` is a `PluginFiles`) */
export type AgyHostDeps = {
  /** The host's gate route (`FrontDoorGates`); asked when a session starts, so the host may build it after the adapters */
  gates: () => GateInbound
  /** The host's data folder (`dataRoot()`): the plugin roots live under it, never in the person's config */
  dataDir: string
  /** The person's home: their `agy` settings (deny rules) and the MCP descriptor folder are read from it */
  home: string
  files: PluginFiles & { readFile(path: string, encoding: 'utf8'): Promise<string> }
  /** The node that runs the hook (`process.execPath`) */
  node: string
  /** The hook's two files (`agyGatePaths()`) */
  gateSources: () => GateSources
}

/** Where `agy` is and how to start it (part 1: detection): the command and the arguments before the session's own flags */
export type AgyFind = () => Promise<{ command: string; args: string[]; env?: Record<string, string> } | null>

export type AgySessionDeps = {
  label: string
  host: AgyHostDeps
  find: AgyFind
  start: Omit<ToolStart, 'sessionId'>
  stopConfirmMs?: number
}

export class AgySession extends CoreSession<AgyToolWire> implements SessionHandle {
  /** A process a previous host left is ended and the conversation opened again in a new one: no turn is taken over */
  readonly takesOverTurn = false

  constructor(opts: CreateSessionOpts, emit: EventSink, deps: AgySessionDeps, denyRules: readonly DenyRule[]) {
    super(
      { sessionId: opts.sessionId, resumeExternalId: opts.resumeExternalId ?? null, start: deps.start, ...(deps.stopConfirmMs === undefined ? {} : { stopConfirmMs: deps.stopConfirmMs }) },
      emit,
      new AgyToolWire(opts, emit, deps, denyRules),
    )
  }

  appAttachment(): 'attached' | 'restart' | 'failed' {
    return 'failed'
  }

  respondApproval(requestId: string, decision: ApprovalDecision, scope?: unknown, matcher?: string): boolean {
    return this.wire.gate.respondApproval(requestId, decision, scope, matcher)
  }

  applyRules(matchers: readonly string[]): void {
    this.wire.gate.applyRules(matchers)
  }

  setPermissionPreset(preset: PermissionPreset): void {
    this.wire.gate.setPermissionPreset(preset)
  }

  /** Model and effort are flags: the next input starts a new process with them (the conversation goes on, `--conversation`) */
  updateSettings(settings: { model?: string | null; effort?: string | null; verbosity?: string | null; permissionPreset?: PermissionPreset }): void {
    if (settings.permissionPreset) this.setPermissionPreset(settings.permissionPreset)
    if (this.wire.change(settings)) this.restartForNextInput()
  }

  override async dispose(): Promise<void> {
    try {
      await super.dispose()
    } finally {
      await this.wire.cleanup()
    }
  }
}

/** Reads the person's deny rules once, when the session starts (a missing or broken file gives none) */
export function readAgyDenyRules(host: Pick<AgyHostDeps, 'home' | 'files'>): Promise<DenyRule[]> {
  return readDenyRules((p) => host.files.readFile(p, 'utf8'), agySettingsPath(host.home))
}

class AgyToolWire implements ToolWire {
  readonly label: string
  readonly turns = { midTurnInput: false, interruptEndsProcess: true, confirmsStop: true } as const
  readonly launch: ToolWire['launch']
  readonly gate: AgyGate
  private model: string | undefined
  private effort: string | undefined
  private io: CoreIo | null = null
  /** The wire of the process that runs: a late line from one already replaced is not the session's */
  private agy: AgyWire | null = null
  private turn: RunningTurn | null = null
  /** The wire ended the turn itself: the calls it had open are closed already (`turnOver` has nothing to add) */
  private endingByWire = false
  private channel: GateChannel | null = null
  /** The conversation's last token reading, carried to the next process (its readings start from it) */
  private usage: TokenUsage | undefined

  constructor(
    private readonly opts: CreateSessionOpts,
    emit: EventSink,
    private readonly deps: AgySessionDeps,
    denyRules: readonly DenyRule[],
  ) {
    this.label = deps.label
    this.model = opts.model
    this.effort = opts.effort
    this.gate = new AgyGate({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      pluginRoot: pluginRootFor(deps.host.dataDir, opts.sessionId),
      preset: opts.permissionPreset,
      emit,
      denyRules,
      ...(opts.readableDirs ? { readableDirs: opts.readableDirs } : {}),
      ...(opts.mayRead ? { mayRead: opts.mayRead } : {}),
      mcpDescriptors: agyMcpDescriptors(deps.host.home),
    })
    this.launch = (resume) => this.launchProcess(resume)
  }

  private get sessionId(): string {
    return this.opts.sessionId
  }

  /** Whether the new model or effort differs from the one the process was launched with */
  change(settings: { model?: string | null; effort?: string | null }): boolean {
    let changed = false
    if (settings.model !== undefined && (settings.model ?? undefined) !== this.model) {
      this.model = settings.model ?? undefined
      changed = true
    }
    if (settings.effort !== undefined && (settings.effort ?? undefined) !== this.effort) {
      this.effort = settings.effort ?? undefined
      changed = true
    }
    return changed
  }

  /** The process for this conversation: a new gate key and the plugin root afresh, then the flags with the conversation's id */
  private async launchProcess(resume: { externalId: string } | null): Promise<AgentSpawnSpec | null> {
    const { host } = this.deps
    const found = await this.deps.find()
    if (!found) return null
    await this.channel?.close().catch(() => {})
    this.channel = null
    const channel = await host.gates().open(this.sessionId, this.handler())
    this.channel = channel
    try {
      const pluginRoot = await writePluginRoot({
        dataDir: host.dataDir,
        sessionId: this.sessionId,
        node: host.node,
        gateSources: host.gateSources(),
        files: host.files,
        ...(this.opts.systemPromptAppend ? { rulesText: this.opts.systemPromptAppend } : {}),
      })
      const args = [
        ...found.args,
        ...launchArgs({ ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}), pluginRoot, resume: resume?.externalId ?? null }),
      ]
      return { command: found.command, args, cwd: this.opts.cwd, env: { ...process.env, ...found.env, ...channel.env } }
    } catch (err) {
      await channel.close().catch(() => {})
      this.channel = null
      throw err
    }
  }

  /** The gate's route reads a hook's input into a request, and asks the session what to do with it */
  private handler(): GateHandler {
    let serial = 0
    return {
      read: (input): GateRequest | null => {
        const call = readHookCall(input)
        if (!call) return null
        const requestId = `${call.conversationId ?? ''}:${call.stepIdx ?? `n${++serial}`}`
        return { requestId, tool: call.name, input, ...(call.stepIdx === undefined ? {} : { stepIndex: call.stepIdx }) }
      },
      decide: (request, gone) => this.decide(request, gone),
    }
  }

  /** The gate's answer, or the core's `deny` when a Stop, an exit or the close comes first (`CoreIo.gates`) */
  private async decide(request: GateRequest, gone: AbortSignal): Promise<GateAnswer> {
    const gates = this.io?.gates
    if (!gates) return this.gate.answer(request.input, gone)
    const stop = new AbortController()
    const abort = () => stop.abort()
    gone.addEventListener('abort', abort, { once: true })
    const held = gates.wait(request.requestId)
    const decided = this.gate.answer(request.input, stop.signal)
    try {
      return await Promise.race([decided, held])
    } finally {
      gone.removeEventListener('abort', abort)
      // The card of a request the core denied is withdrawn; the wait of one the gate decided is let go
      stop.abort()
      gates.answer(request.requestId, { decision: 'deny', reason: 'The request was answered.' })
    }
  }

  async open(io: CoreIo, resume: { externalId: string } | null): Promise<{ externalId: string | null }> {
    this.io = io
    const agy = new AgyWire({ sessionId: this.sessionId, resume: resume?.externalId ?? null, label: this.label, ...(this.usage ? { usageBefore: this.usage } : {}) })
    this.agy = agy
    const channel = this.channel
    const release = () => {
      if (!channel) return
      void channel.close().catch(() => {})
      if (this.channel === channel) this.channel = null
    }
    io.process.once('exit', release)
    io.process.once('error', release)
    const out = lineSplitter((line) => this.take(io, agy, agy.stdout(line)))
    io.process.stdout.on('data', (c: Buffer | string) => out.push(c))
    io.process.stdout.once('end', () => out.flush())
    const err = io.process.stderr
    if (err) {
      const errs = lineSplitter((line) => this.take(io, agy, agy.stderr(line)))
      err.on('data', (c: Buffer | string) => errs.push(c))
      err.once('end', () => errs.flush())
    }
    // `agy` says its conversation's id in `init`, after the first input (`take`)
    return { externalId: null }
  }

  private take(io: CoreIo, agy: AgyWire, o: WireOutput): void {
    if (this.agy !== agy) return
    for (const e of o.events) if (e.type === 'usage_update') this.usage = e.tokens
    if (o.externalId) io.externalId(o.externalId)
    const ended = o.turnEnded
    if (o.sessionNotFound) {
      // The conversation is not `agy`'s: it would have run the turn in a new one. The turn fails, the process is stopped
      const message = `${this.label} does not have this conversation any more`
      this.endByWire({ how: 'failed', error: { code: 'session_not_found', message, retryable: false }, inputError: new Error(message) }, o.events)
    } else if (ended) {
      if (ended.how === 'failed') this.endByWire({ how: 'failed', error: ended.error, inputError: new Error(ended.error.message) }, o.events)
      else this.endByWire({ how: ended.how }, o.events)
    } else {
      for (const e of o.events) io.emit(e)
    }
    if (o.stop) io.process.kill('SIGINT')
  }

  private endByWire(ending: TurnEnding, events: readonly NormalizedEvent[]): void {
    const turn = this.turn
    if (!turn) {
      for (const e of events) this.io?.emit(e)
      return
    }
    this.endingByWire = true
    try {
      turn.end(ending, () => events)
    } finally {
      this.endingByWire = false
    }
  }

  startTurn(input: TurnInput, turn: RunningTurn): void {
    const { io, agy } = this
    if (!io || !agy) throw new Error(`${this.label} is not open`)
    this.turn = turn
    // The previous turn's Stop is over: this one may ask again
    this.gate.resume()
    io.process.stdin.write(`${agy.startTurn(input.text)}\n`)
    io.inputAccepted(input.id)
  }

  /** The core signals the process; the wire hears first that the `interrupted` result that follows is ours */
  interrupt(): void {
    this.agy?.stopRequested()
  }

  turnOver(why?: string): void {
    this.turn = null
    if (this.endingByWire) return
    // An exit or the close ended the turn: the calls it left open end failed
    for (const e of this.agy?.exit(why).events ?? []) this.io?.emit(e)
  }

  /** Every open card is denied before a Stop's signal: `agy` does not act on SIGINT while a hook waits (§1.5) */
  releaseCards(): void {
    this.gate.stop()
  }

  async close(): Promise<void> {
    this.gate.stop(CLOSING)
    await this.cleanup()
  }

  /** The gate's key is revoked and the plugin root removed; both are safe to repeat */
  async cleanup(): Promise<void> {
    const channel = this.channel
    this.channel = null
    await channel?.close().catch(() => {})
    await removePluginRoot(this.deps.host.files, this.deps.host.dataDir, this.sessionId).catch(() => {})
  }
}

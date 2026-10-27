import { realpath as realpathCallback } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { ApprovalDecision, ApprovalDetail, NormalizedEvent, PermissionPreset, QuestionAnswer } from '@cc/protocol'
import { ORCHESTRATOR_MCP_NAME } from '../../apps/contract.js'
import { rpcError } from '../../rpc-error.js'
import { asObj } from '../../json-value.js'
import { AlwaysAllowRules, alwaysAllowKey } from '../always-allow.js'
import { bridgePath } from '../bridge-path.js'
import type { AgentSpawnSpec, CreateSessionOpts, EventSink, SessionHandle } from '../contract.js'
import { CoreSession } from '../core/ledger.js'
import type { CoreIo, RunningTurn, ToolWire, TurnEnding, TurnInput } from '../core/seam.js'
import type { ToolStart } from '../core/tool-process.js'
import { insideFolder } from '../edit-grant.js'
import { fileEditDetail, type FileChange } from '../file-changes.js'
import { CardIds, PendingCards } from '../session-kit.js'
import { UnmappedTypes } from '../unmapped.js'
import { AcpConnection, AUTH_REQUIRED, METHOD_NOT_FOUND, NO_TIMEOUT_MS, RESOURCE_NOT_FOUND, RpcError, type RpcId } from './connection.js'
import { KNOWN_UPDATES } from './known-updates.js'
import type { AcpToolShape } from './profile.js'
import { addTokens, NO_TOKENS } from '../token-usage.js'
import { AcpNormalizer, requestInput, tokenUsage } from './normalize.js'
import {
  InitializeResult,
  OpenedSession,
  PromptResult,
  readUpdate,
  RequestPermission,
  type PermissionOption,
  type PermissionOutcome,
  type ToolCallFields,
} from './wire.js'

/**
 * One Centralu session on one ACP agent process (docs/plans/acp-adapter.md §3–§5): the ACP wire on the session core
 * (docs/plans/session-core.md §7.2 PR 5). The wire does the handshake, opening the conversation (new or load), the prompt,
 * cancel and approvals; the core (`core/ledger.ts`) queues input (one prompt at a time), keeps the receipts, the Stop's
 * timer, the exit (crash or asleep) and the process.
 */

export type AcpSessionDeps = {
  /** The tool's name in host.log lines and messages */
  label: string
  /** How to install the tool (`AcpProfile.descriptor.install`) */
  install?: string
  /** The agent's process: what to start (`AcpProfile.launch`), and from where (the keeper's source, or this host's spawn) */
  spec: AgentSpawnSpec
  start: Omit<ToolStart, 'sessionId'>
  /** The CLI version when the agent does not say it (`agentInfo.version`) */
  version: () => Promise<string | null>
  /** How long a Stop may wait for the agent's `cancelled` before the person hears it has not taken effect */
  stopConfirmMs: number
  /** Which of Centralu's own tools a call is, or null (`AcpProfile.centraluToolOf`) */
  centraluToolOf?: (call: ToolCallFields) => string | null
  /**
   * The tool's `/compact` compacts without the agent advertising it and leaves no protocol frame (OpenCode 1.19.4, measured), so
   * the one boundary known is Centralu's own compact turn: ended `end_turn` with a context reading smaller than the one before
   * it (§5.6, owner 2026-10-26). It is also what makes Centralu send that `/compact` at all (`AcpSession.compactCommand`)
   */
  infersCompaction?: boolean
  /** Where this tool's ACP differs from the common shape (`AcpProfile.shape`) */
  shape?: AcpToolShape
}

/** `edit`: the asked call is an edit whose run may come as a new call (`AcpToolShape.editRunsAsNewCall`), with its files */
type Card = { callId: string; options: PermissionOption[]; edit: string[] | null; answer(outcome: PermissionOutcome): void }

/** A question the agent asked through a permission request (`AcpToolShape.isQuestion`): one option per answer */
type QuestionCard = { callId: string; question: string; options: PermissionOption[]; answer(outcome: PermissionOutcome): void }

/**
 * One prompt and what was asked of it. Each turn has its own: a Stop belongs to the turn it was pressed in (`core.stopAsked`),
 * so a cancel the agent answers late can never end the next one.
 */
type Turn = {
  core: RunningTurn
  input: TurnInput
  cancelResent: boolean
  /** The context reading before this turn, and the last one in it (`usage_update.used`) */
  usedBefore: number | null
  used: number | null
  /** The agent said a compaction in this turn with protocol frames */
  compacted: boolean
  /** The session's running cost the agent last said in this turn (`usage_update.cost`, a total) */
  costTotal: number | null
}

/** While a command runs, how often its process tree is noted (`AgentProcess.noteTree`): a shell it starts may be late */
const TREE_NOTE_MS = 2_000

const CANCELLED: PermissionOutcome = { outcome: { outcome: 'cancelled' } }

export class AcpSession extends CoreSession<AcpWire> implements SessionHandle {
  /**
   * A process a previous host left is ended and the conversation opened again in a new one (`AcpAdapter`): a turn it was
   * running is not carried on, so the host ends it as one the restart stopped (`SessionManager.adoptKept`)
   */
  readonly takesOverTurn = false

  constructor(opts: CreateSessionOpts, emit: EventSink, deps: AcpSessionDeps) {
    super(
      { sessionId: opts.sessionId, resumeExternalId: opts.resumeExternalId ?? null, start: deps.start, stopConfirmMs: deps.stopConfirmMs },
      emit,
      new AcpWire(opts, deps),
    )
  }

  appAttachment(): 'attached' | 'restart' | 'failed' {
    return 'failed'
  }

  respondApproval(requestId: string, decision: ApprovalDecision, _scope?: unknown, matcher?: string): boolean {
    return this.wire.respondApproval(requestId, decision, matcher)
  }

  answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean {
    return this.wire.answerQuestion(requestId, answers)
  }

  applyRules(matchers: readonly string[]): void {
    this.wire.rules.addAll(matchers)
  }

  setPermissionPreset(preset: PermissionPreset): void {
    this.wire.preset = preset
  }

  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    return this.wire.commands
  }

  /**
   * `/compact` when this agent compacts on it, else null: Centralu then neither compacts the session at a break nor takes
   * `compact_self` (§5.6). A bare `/compact` sent to an agent without the command is an ordinary prompt to its model, which
   * compacts nothing (Antigravity 1.4.3 advertises only plan, logout and usage; Cursor's model answered it with a summary).
   * The focus line is not passed: no ACP agent measured takes one.
   */
  compactCommand(): string | null {
    return this.wire.compacts() ? '/compact' : null
  }
}

class AcpWire implements ToolWire {
  readonly label: string
  readonly install?: string
  /** ACP runs one prompt at a time (§5.4); a cancel ends the turn with `cancelled`, so the Stop's timer applies */
  readonly turns = { midTurnInput: false, interruptEndsProcess: false, confirmsStop: true } as const
  readonly launch: ToolWire['launch']
  readonly rules = new AlwaysAllowRules()
  preset: PermissionPreset
  commands: { name: string; description?: string; argumentHint?: string }[] = []
  private io!: CoreIo
  private conn!: AcpConnection
  /** The ACP session the conversation is on this process: the one every frame names */
  private conversation: string | null = null
  private readonly normalizer: AcpNormalizer
  private readonly unmapped: UnmappedTypes
  private readonly cards = new PendingCards<Card>()
  private readonly questions = new PendingCards<QuestionCard>()
  /** Edits allowed this turn whose run has not come yet, oldest first, and the new calls folded into them (`editRunsAsNewCall`) */
  private readonly allowedEdits: { callId: string; paths: string[] }[] = []
  private readonly folded = new Map<string, string>()
  private readonly cardIds = new CardIds()
  private turn: Turn | null = null
  /** While `session/load` is answered, every update is the replay of the conversation, not this turn (§4.3) */
  private replaying = false
  private canClose = false
  /** Commands running now, by call id, and the clock that notes the tree while any runs */
  private readonly commandsRunning = new Set<string>()
  private treeClock: ReturnType<typeof setInterval> | null = null
  /** The last context reading taken, for the compact turn's comparison */
  private lastUsed: number | null = null
  /** The session's running cost as last read at a turn's end: a turn's own cost is what it adds (OpenCode sends the total) */
  private costTotal: number | null = null
  /** What this process's turns have used, added up: `usage_update.tokens` is a running reading, and ACP reports each turn's alone */
  private tokensSoFar = NO_TOKENS
  /** The turns' costs added up (null until one is known): the cost of the running reading */
  private costSoFar: number | null = null

  /** The conversation `session/load` or `session/resume` is opening: its commands come during the replay (measured, Antigravity 1.4.3) */
  private opening: string | null = null

  constructor(
    private readonly opts: CreateSessionOpts,
    private readonly deps: AcpSessionDeps,
  ) {
    this.label = deps.label
    if (deps.install !== undefined) this.install = deps.install
    this.preset = opts.permissionPreset
    this.launch = async () => deps.spec
    this.normalizer = new AcpNormalizer(opts.sessionId, deps.label)
    this.unmapped = new UnmappedTypes(deps.label, opts.sessionId, KNOWN_UPDATES)
  }

  private get sessionId(): string {
    return this.opts.sessionId
  }

  private emit(e: NormalizedEvent): void {
    this.io.emit(e)
  }

  async open(io: CoreIo, resume: { externalId: string } | null): Promise<{ externalId: string | null }> {
    this.io = io
    // The process's exit is the core's (it watches the process); the connection only fails what it had asked
    this.conn = new AcpConnection(
      io.process,
      {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (id, method, params) => this.onRequest(id, method, params),
        onExit: () => {},
      },
      this.label,
      this.deps.shape?.stderrLine?.bind(this.deps.shape),
    )
    try {
      const init = InitializeResult.parse(
        await this.conn.request(
          'initialize',
          {
            protocolVersion: 1,
            clientInfo: { name: 'centralu', version: '1' },
            // No terminal and no writes: the agent uses its own tools, whose approvals come as `session/request_permission`.
            // Reads only for a tool whose own viewer is switched off (`clientReads`), held to the session's folder
            clientCapabilities: {
              fs: { readTextFile: this.deps.shape?.clientReads !== undefined, writeTextFile: false },
              terminal: false,
              session: { compaction: {} },
            },
          },
          60_000,
        ),
      )
      const version = init.agentInfo?.version ?? (await this.deps.version())
      if (version) this.emit({ type: 'agent_version', sessionId: this.sessionId, version })
      this.canClose = init.agentCapabilities?.sessionCapabilities?.close !== undefined
      const meta = this.deps.shape?.sessionMeta?.()
      const base = { cwd: this.opts.cwd, mcpServers: this.mcpServers(), ...(meta ? { _meta: meta } : {}) }
      if (resume) {
        const caps = init.agentCapabilities
        const method = caps?.loadSession ? 'session/load' : caps?.sessionCapabilities?.resume !== undefined ? 'session/resume' : null
        if (!method) throw rpcError(`${this.label} cannot reopen a conversation`, 'session_not_found')
        this.replaying = method === 'session/load'
        this.opening = resume.externalId
        try {
          OpenedSession.parse((await this.conn.request(method, { ...base, sessionId: resume.externalId }, 150_000)) ?? {})
        } finally {
          this.replaying = false
          this.opening = null
        }
        this.conversation = resume.externalId
        this.costTotal = this.opts.runningCost?.last ?? null
      } else {
        const opened = OpenedSession.parse(await this.conn.request('session/new', base, 120_000))
        if (!opened.sessionId) throw new Error(`${this.label} opened a session without an id`)
        this.conversation = opened.sessionId
        this.costTotal = 0
        this.opts.runningCost?.keep(0)
      }
      return { externalId: this.conversation }
    } catch (err) {
      throw this.openError(err)
    }
  }

  private openError(err: unknown): Error {
    if (err instanceof RpcError && err.code === AUTH_REQUIRED) {
      const signedOut = this.deps.shape?.signedOut?.(this.label)
      if (signedOut) return signedOut
      return rpcError(`${this.label} is not logged in. Log in from a terminal, then try again.`, 'not_logged_in')
    }
    if (err instanceof RpcError) return rpcError(`${this.label}: ${err.message}`, 'internal')
    return err instanceof Error ? err : new Error(String(err))
  }

  /** Centralu's own tools through the same stdio bridge Codex starts (§6). Apps are not attached to an ACP agent yet */
  private mcpServers(): unknown[] {
    const bridge = this.opts.orchestratorBridge
    if (!this.opts.orchestratorTools || !bridge) return []
    return [
      {
        name: ORCHESTRATOR_MCP_NAME,
        command: process.execPath,
        args: [bridgePath()],
        env: [
          { name: 'CC_HOST_URL', value: bridge.url },
          { name: 'CC_BRIDGE_TOKEN', value: bridge.token },
          { name: 'CC_SESSION_ID', value: this.opts.sessionId },
        ],
      },
    ]
  }

  startTurn(input: TurnInput, core: RunningTurn): void {
    const turn: Turn = { core, input, cancelResent: false, usedBefore: this.lastUsed, used: null, compacted: false, costTotal: null }
    this.turn = turn
    // `session/prompt` has no earlier answer: the write is the nearest the agent says it took the input (§2.3)
    this.io.inputAccepted(input.id)
    void this.prompt(turn)
  }

  private async prompt(turn: Turn): Promise<void> {
    let result: PromptResult
    try {
      result = PromptResult.parse(
        await this.conn.request('session/prompt', { sessionId: this.conversation, prompt: [{ type: 'text', text: turn.input.text }] }, NO_TIMEOUT_MS),
      )
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err))
      turn.core.end({ how: 'failed', error: { code: 'internal', message: `${this.label}: ${failure.message}`, retryable: true }, inputError: failure })
      return
    }
    turn.core.end(this.endingOf(result), () => this.endEvents(result, turn))
  }

  private endingOf(result: PromptResult): TurnEnding {
    switch (result.stopReason) {
      case 'cancelled':
        return { how: 'interrupted' }
      case 'refusal':
        return { how: 'failed', error: { code: 'internal', message: `${this.label} refused to go on with this turn.`, retryable: false }, inputError: null }
      default:
        return { how: 'complete' }
    }
  }

  /** The turn's usage, an inferred compaction and a limit's notice, before the core's own ending event */
  private endEvents(result: PromptResult, turn: Turn): NormalizedEvent[] {
    const sessionId = this.sessionId
    const events: NormalizedEvent[] = []
    const turnTokens = tokenUsage(result)
    // A turn with no usage reports no cost: its spend stays in the total and is said with the next turn that reports
    const cost = turnTokens ? this.turnCost(turn) : null
    if (turnTokens) {
      if (cost !== null) this.costSoFar = (this.costSoFar ?? 0) + cost
      this.tokensSoFar = addTokens(this.tokensSoFar, turnTokens)
      const request = requestInput(result)
      events.push({
        type: 'usage_update',
        sessionId,
        tokens: this.costSoFar === null ? this.tokensSoFar : { ...this.tokensSoFar, costUsd: this.costSoFar },
        ...(request ? { request } : {}),
      })
    }
    if (result.stopReason === 'end_turn' && this.inferredCompaction(turn)) {
      events.push({ type: 'compaction', sessionId, failed: false, trigger: 'manual' })
    }
    if (result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests') {
      events.push({
        type: 'notice',
        sessionId,
        level: 'warning',
        from: this.label,
        text: result.stopReason === 'max_tokens' ? `${this.label} stopped: the reply reached its length limit.` : `${this.label} stopped: the turn reached its limit of steps.`,
      })
    }
    return events
  }

  turnOver(why?: string): void {
    for (const e of why === undefined ? this.normalizer.endTurn() : this.normalizer.endTurn(why)) this.emit(e)
    this.stopTreeClock()
    this.allowedEdits.length = 0
    this.folded.clear()
    this.turn = null
  }

  /**
   * A command the tool runs may start helpers in a group of their own (Cursor's shell, measured on macOS), which outlive
   * the tool if it is killed: its tree is noted while a command runs, so they are ended with it (`noteTree`)
   */
  private watchCommands(e: NormalizedEvent): void {
    const proc = this.io.process
    if (!proc.noteTree) return
    if (e.type === 'tool_call' && e.summary.tool === 'Bash') {
      this.commandsRunning.add(e.callId)
      void proc.noteTree()
      if (!this.treeClock) {
        this.treeClock = setInterval(() => void proc.noteTree?.(), TREE_NOTE_MS)
        this.treeClock.unref?.()
      }
    } else if (e.type === 'tool_result') {
      this.commandsRunning.delete(e.callId)
      if (this.commandsRunning.size === 0) this.stopTreeClock()
    }
  }

  private stopTreeClock(): void {
    this.commandsRunning.clear()
    if (this.treeClock) clearInterval(this.treeClock)
    this.treeClock = null
  }

  /** What this turn added to the conversation's running cost, once a total from before it is known (`CreateSessionOpts.runningCost`); null otherwise */
  private turnCost(turn: Turn): number | null {
    if (turn.costTotal === null) return null
    const before = this.costTotal
    this.costTotal = turn.costTotal
    this.opts.runningCost?.keep(turn.costTotal)
    return before === null || turn.costTotal < before ? null : turn.costTotal - before
  }

  /** Whether the agent compacts on `/compact`: it advertises the command, or the profile measured that it does without saying so */
  compacts(): boolean {
    return this.deps.infersCompaction === true || this.commands.some((c) => c.name.replace(/^\//, '') === 'compact')
  }

  /** Centralu's own compact turn, with no protocol frame for it, whose reading went down (§5.6) */
  private inferredCompaction(turn: Turn): boolean {
    if (!this.deps.infersCompaction || !turn.input.compact || turn.compacted) return false
    return turn.usedBefore !== null && turn.used !== null && turn.used < turn.usedBefore
  }

  /** ACP's Stop: `session/cancel`; after it the core answers every open permission `cancelled` (measured: the agent withdraws none) */
  interrupt(): void {
    this.conn.notify('session/cancel', { sessionId: this.conversation })
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      this.unmapped.note(method)
      return
    }
    const read = readUpdate(params)
    if (!read) return
    // The commands are the process's, not the conversation's history: the ones said during a load's replay are kept
    if ('update' in read && read.update.sessionUpdate === 'available_commands_update' && (read.sessionId === this.conversation || read.sessionId === this.opening)) {
      this.commands = read.update.availableCommands.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.input?.hint ? { argumentHint: c.input.hint } : {}) }))
      return
    }
    if (read.sessionId !== this.conversation || this.replaying) return
    const turn = this.turn
    this.resendLostCancel()
    if ('other' in read) {
      this.unmapped.note(read.other)
      return
    }
    const u = read.update
    switch (u.sessionUpdate) {
      case 'usage_update':
        // Measured: a cancelled turn reads `used: 0` just before it ends, and the next turn reads the real size again
        if (u.used > 0 && u.size > 0) {
          this.emit({ type: 'context_update', sessionId: this.sessionId, used: u.used, window: u.size, exactness: 'exact' })
          this.lastUsed = u.used
          if (turn) turn.used = u.used
        }
        if (turn && u.cost?.currency === 'USD') turn.costTotal = u.cost.amount
        return
      case 'tool_call':
      case 'tool_call_update':
        this.emitAll(this.normalizer.update({ ...this.foldEdit(this.readCall(u), u.sessionUpdate), sessionUpdate: u.sessionUpdate }), turn)
        return
      default:
        this.emitAll(this.normalizer.update(u), turn)
    }
  }

  private emitAll(events: readonly NormalizedEvent[], turn: Turn | null): void {
    for (const e of events) {
      this.watchCommands(e)
      if (e.type !== 'compaction') {
        this.emit(e)
        continue
      }
      if (turn) turn.compacted = true
      this.emit({ ...e, trigger: turn?.input.compact ? 'manual' : 'auto' })
    }
  }

  /**
   * A cancel that reached the agent before its turn had begun is lost (ACP's cancel is a notification, answered by nothing
   * but the turn's end): the turn going on after it, by an update or by a question, gets the cancel once more
   */
  private resendLostCancel(): void {
    const turn = this.turn
    if (!turn?.core.stopAsked || turn.cancelResent) return
    turn.cancelResent = true
    this.conn.notify('session/cancel', { sessionId: this.conversation })
  }

  /** Answers a question cancelled, and remembers the call did not run as asked */
  private refused(callId: string): PermissionOutcome {
    this.normalizer.refuse(callId)
    return CANCELLED
  }

  /** Whether a question asked now belongs to a turn that still runs: none after Stop, after the turn's end or the close */
  private askable(turn: Turn | null): boolean {
    return turn !== null && this.turn === turn && !turn.core.stopAsked
  }

  private async onRequest(_id: RpcId, method: string, params: unknown): Promise<unknown> {
    const reads = this.deps.shape?.clientReads
    if (method === 'fs/read_text_file' && reads) return readTextFileFor(this.opts.cwd, reads.refused(), params)
    if (method !== 'session/request_permission') {
      this.unmapped.note(method)
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
    const asked = RequestPermission.parse(params)
    const req = { ...asked, toolCall: this.readCall(asked.toolCall) }
    const turn = this.turn
    this.resendLostCancel()
    if (!this.askable(turn)) return this.refused(req.toolCall.toolCallId)
    // A question is the person's to answer under every preset: never an approval, never answered without them
    if (this.deps.shape?.isQuestion?.(req)) return this.ask(req)
    if (this.deps.shape?.neverAllowed?.(req)) {
      // Declined as the person's "no" would be, so the agent carries on with the turn instead of taking it as stopped
      const no = pick(req.options, 'reject_once')
      this.normalizer.refuse(req.toolCall.toolCallId)
      return no ? selected(no) : CANCELLED
    }
    const call = this.normalizer.call(req.toolCall, true)
    const detail = detailOf(call, this.opts.cwd)
    const edit = this.deps.shape?.editRunsAsNewCall && call.kind === 'edit' ? editPaths(call) : null
    const once = pick(req.options, 'allow_once')
    const granted = once !== undefined && (await this.grantedWithoutCard(detail, call))
    // Stop, or the turn's end, may have come while the folder was being checked
    if (!this.askable(turn)) return this.refused(req.toolCall.toolCallId)
    if (granted && once) {
      this.allowedEdit(call.toolCallId, edit)
      return selected(once)
    }
    const requestId = this.cardIds.next('acp-req')
    return new Promise<PermissionOutcome>((resolve) => {
      this.cards.set(requestId, { callId: req.toolCall.toolCallId, options: req.options, edit, answer: resolve })
      this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId, detail })
    })
  }

  /** The tool's own field names read into the core's (`AcpToolShape.readCall`) */
  private readCall<T extends ToolCallFields>(call: T): T {
    const shape = this.deps.shape
    if (!shape?.readCall) return call
    return { ...call, ...shape.readCall(call), toolCallId: call.toolCallId }
  }

  /** An edit was allowed: its run, if it comes as a new call, is folded into this one (`editRunsAsNewCall`) */
  private allowedEdit(callId: string, paths: string[] | null): void {
    if (paths?.length) this.allowedEdits.push({ callId, paths })
  }

  /**
   * A new edit call whose file is one an allowed edit names is that edit's run (Antigravity 1.4.3: `<session>:<n>`,
   * "Running edit_file", after the asked call's `allow`): it is said under the asked call's id, so the card the person
   * answered ends as the edit did. The asked call's own late `failed` ("approved but never executed") then finds it ended
   */
  private foldEdit(u: ToolCallFields, kind: 'tool_call' | 'tool_call_update'): ToolCallFields {
    const into = this.folded.get(u.toolCallId)
    if (into) return { ...u, toolCallId: into }
    // An allowed edit that ended with no run of its own (the agent said it failed) waits for none: a later edit of the
    // same file is folded into its own asked call, not into this ended one
    if (u.status === 'completed' || u.status === 'failed') {
      const at = this.allowedEdits.findIndex((a) => a.callId === u.toolCallId)
      if (at >= 0) this.allowedEdits.splice(at, 1)
    }
    // A run is said running or ended; a `pending` call is another edit about to be asked, never a run
    if (kind !== 'tool_call' || u.kind !== 'edit' || u.status === 'pending' || this.allowedEdits.length === 0) return u
    const paths = editPaths(u)
    const at = this.allowedEdits.findIndex((a) => a.paths.some((p) => paths.includes(p)))
    const allowed = at < 0 ? undefined : this.allowedEdits.splice(at, 1)[0]
    if (!allowed) return u
    this.folded.set(u.toolCallId, allowed.callId)
    return { ...u, toolCallId: allowed.callId }
  }

  /**
   * A question the agent asked as a permission request (Antigravity's `interaction_*`, from its binary: one option per
   * answer, `reject_once` only for a "deny"): Centralu's question card, with the options' names as the answers. The answer
   * picks the option of that name; anything else is answered `cancelled`, which the agent takes as no answer
   */
  private ask(req: { toolCall: ToolCallFields; options: PermissionOption[] }): Promise<PermissionOutcome> {
    const requestId = this.cardIds.next('acp-question')
    const text = firstContentText(req.toolCall) || req.toolCall.title || `${this.label} asks`
    return new Promise<PermissionOutcome>((resolve) => {
      this.questions.set(requestId, { callId: req.toolCall.toolCallId, question: text, options: req.options, answer: resolve })
      this.emit({
        type: 'question_request',
        sessionId: this.sessionId,
        requestId,
        questions: [{ question: text, header: '', multiSelect: false, options: req.options.map((o) => ({ label: optionLabel(o), description: '' })) }],
      })
    })
  }

  answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean {
    const card = this.questions.take(requestId)
    if (!card) return false
    const chosen = answers.find((a) => a.question === card.question)?.answers[0] ?? answers[0]?.answers[0]
    const option = card.options.find((o) => optionLabel(o) === chosen)
    card.answer(option ? selected(option) : CANCELLED)
    this.emit({ type: 'question_resolved', sessionId: this.sessionId, requestId })
    return true
  }

  /** `auto`, Centralu's own tool, an `edits` grant inside the folder, or a rule the person saved: answered `allow_once` without a card */
  private async grantedWithoutCard(detail: ApprovalDetail, call: ToolCallFields): Promise<boolean> {
    if (this.preset === 'auto' || this.deps.centraluToolOf?.(call)) return true
    // An edit only: a delete or a move is not one (`edit-grant.ts`), and a move's destination is not in its paths
    if (this.preset === 'edits' && call.kind === 'edit' && detail.kind === 'file_edit') {
      const paths = editPaths(call).map((p) => (isAbsolute(p) ? p : join(this.opts.cwd, p)))
      if (await insideFolder(this.opts.cwd, paths)) return true
    }
    const key = alwaysAllowKey(detail)
    return key !== null && this.rules.allows(key)
  }

  respondApproval(requestId: string, decision: ApprovalDecision, matcher?: string): boolean {
    const card = this.cards.take(requestId)
    if (!card) return false
    // "Always" stays Centralu's rule: passing `allow_always` on would write it into the tool's own allowlist (§5.3)
    if (decision === 'always' && matcher) this.rules.add(matcher)
    const option = pick(card.options, decision === 'deny' ? 'reject_once' : 'allow_once')
    if (decision === 'deny' || !option) this.normalizer.refuse(card.callId)
    else this.allowedEdit(card.callId, card.edit)
    card.answer(option ? selected(option) : CANCELLED)
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    return true
  }

  releaseCards(): void {
    this.cards.release((requestId, card) => {
      this.normalizer.refuse(card.callId)
      card.answer(CANCELLED)
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision: 'deny' })
    })
    this.questions.release((requestId, card) => {
      card.answer(CANCELLED)
      this.emit({ type: 'question_resolved', sessionId: this.sessionId, requestId })
    })
  }

  async close(opts: { turnRunning: boolean }): Promise<void> {
    if (!this.conn) return
    if (opts.turnRunning && this.conversation) this.conn.notify('session/cancel', { sessionId: this.conversation })
    if (this.canClose && this.conversation && !this.conn.isClosed) {
      await this.conn.request('session/close', { sessionId: this.conversation }, 2000).catch(() => {})
    }
    // The core stops the process next: its exit is ours, so the connection fails what it asked as cancelled, not as a crash
    this.conn.close()
  }
}


const optionLabel = (o: PermissionOption): string => o.name || o.optionId

/** The text a call's first content block says (a question's wording, when the agent puts it there) */
function firstContentText(call: ToolCallFields): string {
  for (const c of call.content ?? []) if (c.type === 'content' && c.content?.type === 'text' && c.content.text) return c.content.text
  return ''
}

function pick(options: readonly PermissionOption[], kind: string): PermissionOption | undefined {
  return options.find((o) => o.kind === kind)
}

function selected(option: PermissionOption): PermissionOutcome {
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function editPaths(call: ToolCallFields): string[] {
  const input = asObj(call.rawInput)
  const fromDiffs = (call.content ?? []).flatMap((c) => (c.type === 'diff' && c.path ? [c.path] : []))
  const named = [str(input.filePath), str(input.path), str(input.file_path)].filter(Boolean)
  return [...new Set([...fromDiffs, ...(call.locations ?? []).map((l) => l.path), ...named])]
}

/** The approval card for an ACP tool call, by its kind (the request carries the call, measured on OpenCode 1.19.4) */
export function detailOf(call: ToolCallFields, cwd: string): ApprovalDetail {
  const input = asObj(call.rawInput)
  if (call.kind === 'execute') return { kind: 'command', command: str(input.command) || call.title || '', cwd: str(input.cwd) || cwd }
  if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') {
    const diffs: FileChange[] = (call.content ?? []).flatMap((c) => (c.type === 'diff' && c.path ? [{ path: c.path, diff: c.newText ?? '' }] : []))
    const changes = diffs.length ? diffs : editPaths(call).map((path) => ({ path, diff: str(input.content) || str(input.newString) || str(input.new_string) }))
    return fileEditDetail(call.kind === 'delete' ? changes.map((c) => ({ ...c, change: 'delete' as const })) : changes)
  }
  return { kind: 'other', raw: JSON.stringify({ title: call.title, kind: call.kind, input: call.rawInput }).slice(0, 2000) }
}

/**
 * `fs/read_text_file`, answered by the client (#59, docs/plans/antigravity-adapter.md §5.3): offered to a tool whose own file
 * viewer reads its home without asking (Antigravity 1.4.3 read its token file in the spike, §6 there). The viewer is switched
 * off and reads come here instead, where they are held to one rule: **inside the session's folder, never under a refused
 * folder** (the agent's home, which holds its token). Both sides are compared as real paths, so a link inside the folder that
 * points out of it, or into the agent's home, is refused like the path it points to.
 */

export const ReadTextFileParams = z.looseObject({
  sessionId: z.string(),
  path: z.string(),
  /** 1-based, as ACP's schema says */
  line: z.number().int().positive().nullish(),
  limit: z.number().int().positive().nullish(),
})
export type ReadTextFileParams = z.infer<typeof ReadTextFileParams>

/** The OS's own real path (Windows: long names and the disk's case), so a short name cannot slip past a refused folder */
const realPath = promisify(realpathCallback.native)

/** A file larger than this is not read whole into the agent's context (a log, a build output) */
export const MAX_READ_BYTES = 8 * 1024 * 1024

/** Who refuses a read, in the words the agent passes on to the model */
const REFUSED = 'Centralu reads files only inside the project folder for this agent'

export async function readTextFileFor(cwd: string, refused: readonly string[], params: unknown): Promise<{ content: string }> {
  const p = ReadTextFileParams.safeParse(params)
  if (!p.success) throw new RpcError(-32602, 'fs/read_text_file needs a path')
  const { path, line, limit } = p.data
  if (!isAbsolute(path)) throw new RpcError(-32602, 'fs/read_text_file needs an absolute path')
  const real = await realPath(path).catch(() => null)
  if (real === null) throw new RpcError(RESOURCE_NOT_FOUND, `No such file: ${path}`)
  const root = await realPath(cwd).catch(() => null)
  if (root === null || !inside(root, real)) throw new RpcError(RESOURCE_NOT_FOUND, `${REFUSED}: ${path} is outside it`)
  for (const folder of refused) {
    const no = await realPath(folder).catch(() => folder)
    if (inside(no, real) || real === no) throw new RpcError(RESOURCE_NOT_FOUND, `${REFUSED}: ${path} is the agent's own data`)
  }
  const info = await stat(real)
  if (!info.isFile()) throw new RpcError(RESOURCE_NOT_FOUND, `Not a file: ${path}`)
  if (info.size > MAX_READ_BYTES) throw new RpcError(-32603, `${path} is ${info.size} bytes; files over ${MAX_READ_BYTES} are not read whole`)
  const text = await readFile(real, 'utf8')
  if (!line && !limit) return { content: text }
  const lines = text.split('\n')
  const from = (line ?? 1) - 1
  return { content: lines.slice(from, limit ? from + limit : undefined).join('\n') }
}

/** Whether `target` is `folder` itself or under it (both real paths) */
function inside(folder: string, target: string): boolean {
  const rel = relative(folder, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

import { isAbsolute, join } from 'node:path'
import type { ApprovalDecision, ApprovalDetail, NormalizedEvent, PermissionPreset } from '@cc/protocol'
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
import { AcpConnection, AUTH_REQUIRED, METHOD_NOT_FOUND, NO_TIMEOUT_MS, RpcError, type RpcId } from './connection.js'
import { KNOWN_UPDATES } from './known-updates.js'
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
   * The tool's `/compact` leaves no protocol frame (OpenCode 1.19.4, measured), so the one boundary known is Centralu's own
   * compact turn: ended `end_turn` with a context reading smaller than the one before it (§5.6, owner 2026-10-26)
   */
  infersCompaction?: boolean
}

type Card = { callId: string; options: PermissionOption[]; answer(outcome: PermissionOutcome): void }

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

  applyRules(matchers: readonly string[]): void {
    this.wire.rules.addAll(matchers)
  }

  setPermissionPreset(preset: PermissionPreset): void {
    this.wire.preset = preset
  }

  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    return this.wire.commands
  }
}

class AcpWire implements ToolWire {
  readonly label: string
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

  constructor(
    private readonly opts: CreateSessionOpts,
    private readonly deps: AcpSessionDeps,
  ) {
    this.label = deps.label
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
    )
    try {
      const init = InitializeResult.parse(
        await this.conn.request(
          'initialize',
          {
            protocolVersion: 1,
            clientInfo: { name: 'centralu', version: '1' },
            // No fs and no terminal: the agent uses its own tools, whose approvals come as `session/request_permission`
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } },
          },
          60_000,
        ),
      )
      const version = init.agentInfo?.version ?? (await this.deps.version())
      if (version) this.emit({ type: 'agent_version', sessionId: this.sessionId, version })
      this.canClose = init.agentCapabilities?.sessionCapabilities?.close !== undefined
      const base = { cwd: this.opts.cwd, mcpServers: this.mcpServers() }
      if (resume) {
        const caps = init.agentCapabilities
        const method = caps?.loadSession ? 'session/load' : caps?.sessionCapabilities?.resume !== undefined ? 'session/resume' : null
        if (!method) throw rpcError(`${this.label} cannot reopen a conversation`, 'session_not_found')
        this.replaying = method === 'session/load'
        try {
          OpenedSession.parse((await this.conn.request(method, { ...base, sessionId: resume.externalId }, 150_000)) ?? {})
        } finally {
          this.replaying = false
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
    if (!read || read.sessionId !== this.conversation || this.replaying) return
    const turn = this.turn
    this.resendLostCancel()
    if ('other' in read) {
      this.unmapped.note(read.other)
      return
    }
    const u = read.update
    switch (u.sessionUpdate) {
      case 'available_commands_update':
        this.commands = u.availableCommands.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.input?.hint ? { argumentHint: c.input.hint } : {}) }))
        return
      case 'usage_update':
        // Measured: a cancelled turn reads `used: 0` just before it ends, and the next turn reads the real size again
        if (u.used > 0 && u.size > 0) {
          this.emit({ type: 'context_update', sessionId: this.sessionId, used: u.used, window: u.size, exactness: 'exact' })
          this.lastUsed = u.used
          if (turn) turn.used = u.used
        }
        if (turn && u.cost?.currency === 'USD') turn.costTotal = u.cost.amount
        return
      default:
        for (const e of this.normalizer.update(u)) {
          this.watchCommands(e)
          if (e.type !== 'compaction') {
            this.emit(e)
            continue
          }
          if (turn) turn.compacted = true
          this.emit({ ...e, trigger: turn?.input.compact ? 'manual' : 'auto' })
        }
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
    if (method !== 'session/request_permission') {
      this.unmapped.note(method)
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
    const req = RequestPermission.parse(params)
    const turn = this.turn
    this.resendLostCancel()
    if (!this.askable(turn)) return this.refused(req.toolCall.toolCallId)
    const call = this.normalizer.call(req.toolCall, true)
    const detail = detailOf(call, this.opts.cwd)
    const once = pick(req.options, 'allow_once')
    const granted = once !== undefined && (await this.grantedWithoutCard(detail, call))
    // Stop, or the turn's end, may have come while the folder was being checked
    if (!this.askable(turn)) return this.refused(req.toolCall.toolCallId)
    if (granted && once) return selected(once)
    const requestId = this.cardIds.next('acp-req')
    return new Promise<PermissionOutcome>((resolve) => {
      this.cards.set(requestId, { callId: req.toolCall.toolCallId, options: req.options, answer: resolve })
      this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId, detail })
    })
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


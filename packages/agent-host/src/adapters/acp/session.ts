import { isAbsolute, join } from 'node:path'
import type { ApprovalDecision, ApprovalDetail, NormalizedEvent, PermissionPreset } from '@cc/protocol'
import { ORCHESTRATOR_MCP_NAME } from '../../apps/contract.js'
import { rpcError } from '../../rpc-error.js'
import { asObj } from '../../json-value.js'
import { AlwaysAllowRules, alwaysAllowKey } from '../always-allow.js'
import { bridgePath } from '../bridge-path.js'
import { INTERRUPTED_BY_TOOL, type AgentProcess, type CreateSessionOpts, type EventSink, type InputObserver, type InputOrigin, type SessionHandle } from '../contract.js'
import { insideFolder } from '../edit-grant.js'
import { fileEditDetail, type FileChange } from '../file-changes.js'
import { CardIds, PendingCards, stopNotConfirmed, undeliveredError } from '../session-kit.js'
import { UnmappedTypes } from '../unmapped.js'
import { AcpConnection, AUTH_REQUIRED, METHOD_NOT_FOUND, NO_TIMEOUT_MS, RpcError, type FrameDirection, type RpcId } from './connection.js'
import { KNOWN_UPDATES } from './known-updates.js'
import { AcpNormalizer, tokenUsage } from './normalize.js'
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
 * One Centralu session on one ACP agent process (docs/plans/acp-adapter.md §3–§5): the handshake, opening the
 * conversation (new or load), one prompt at a time with input queued here, cancel, approvals and teardown.
 */

export type AcpSessionDeps = {
  /** The tool's name in host.log lines and messages */
  label: string
  /** The started agent process (`spawnLocalAgent` in production, a scripted peer in tests) */
  process: AgentProcess
  /** The CLI version when the agent does not say it (`agentInfo.version`) */
  version: () => Promise<string | null>
  /** How long a Stop may wait for the agent's `cancelled` before the person hears it has not taken effect */
  stopConfirmMs: number
  /** Which of Centralu's own tools a call is, or null (`AcpProfile.centraluToolOf`) */
  centraluToolOf?: (call: ToolCallFields) => string | null
  /** Every line both ways, for the recorder (§10.1) */
  onFrame?: (direction: FrameDirection, line: string) => void
}

type Input = { text: string; id?: string; observer?: InputObserver; done?: { resolve(): void; reject(e: Error): void } }

type Card = { callId: string; options: PermissionOption[]; answer(outcome: PermissionOutcome): void }

/**
 * One prompt and what was asked of it. Each turn has its own: a Stop belongs to the turn it was pressed in, so a cancel the
 * agent answers late can never end the next one.
 */
type Turn = { input: Input; stopAsked: boolean; cancelResent: boolean; stopTimer?: ReturnType<typeof setTimeout> }

/** While a command runs, how often its process tree is noted (`AgentProcess.noteTree`): a shell it starts may be late */
const TREE_NOTE_MS = 2_000

/** What a session is doing; the queue drains only in `ready` with no turn */
type Phase = 'opening' | 'ready' | 'closed'

const CANCELLED: PermissionOutcome = { outcome: { outcome: 'cancelled' } }

export class AcpSession implements SessionHandle {
  externalId: string | null = null
  /**
   * A process a previous host left is ended and the conversation opened again in a new one (`AcpAdapter`): a turn it was
   * running is not carried on, so the host ends it as one the restart stopped (`SessionManager.adoptKept`)
   */
  readonly takesOverTurn = false
  readonly ready: Promise<void>
  private phase: Phase = 'opening'
  private readonly conn: AcpConnection
  private readonly normalizer: AcpNormalizer
  private readonly unmapped: UnmappedTypes
  private readonly cards = new PendingCards<Card>()
  private readonly cardIds = new CardIds()
  private readonly rules = new AlwaysAllowRules()
  private readonly queue: Input[] = []
  private turn: Turn | null = null
  /** While `session/load` is answered, every update is the replay of the conversation, not this turn (§4.3) */
  private replaying = false
  private canClose = false
  private preset: PermissionPreset
  private commands: { name: string; description?: string; argumentHint?: string }[] = []
  private lastTurnInputs: string[] = []
  /** Commands running now, by call id, and the clock that notes the tree while any runs */
  private readonly commandsRunning = new Set<string>()
  private treeClock: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly opts: CreateSessionOpts,
    private readonly emit: EventSink,
    private readonly deps: AcpSessionDeps,
  ) {
    this.preset = opts.permissionPreset
    this.normalizer = new AcpNormalizer(opts.sessionId, deps.label)
    this.unmapped = new UnmappedTypes(deps.label, opts.sessionId, KNOWN_UPDATES)
    this.conn = new AcpConnection(
      deps.process,
      {
        onNotification: (method, params) => this.onNotification(method, params),
        onRequest: (id, method, params) => this.onRequest(id, method, params),
        onExit: (code, expected) => this.onExit(code, expected),
        ...(deps.onFrame ? { onFrame: deps.onFrame } : {}),
      },
      deps.label,
    )
    this.ready = this.open()
    this.ready.catch(() => {})
  }

  get sessionId(): string {
    return this.opts.sessionId
  }

  private async open(): Promise<void> {
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
      const resume = this.opts.resumeExternalId
      if (resume) {
        const caps = init.agentCapabilities
        const method = caps?.loadSession ? 'session/load' : caps?.sessionCapabilities?.resume !== undefined ? 'session/resume' : null
        if (!method) throw rpcError(`${this.deps.label} cannot reopen a conversation`, 'session_not_found')
        this.replaying = method === 'session/load'
        try {
          OpenedSession.parse((await this.conn.request(method, { ...base, sessionId: resume }, 150_000)) ?? {})
        } finally {
          this.replaying = false
        }
        this.externalId = resume
      } else {
        const opened = OpenedSession.parse(await this.conn.request('session/new', base, 120_000))
        if (!opened.sessionId) throw new Error(`${this.deps.label} opened a session without an id`)
        this.externalId = opened.sessionId
      }
      this.phase = 'ready'
      this.next()
    } catch (err) {
      throw this.openError(err)
    }
  }

  private openError(err: unknown): Error {
    if (err instanceof RpcError && err.code === AUTH_REQUIRED) {
      return rpcError(`${this.deps.label} is not logged in. Log in from a terminal, then try again.`, 'not_logged_in')
    }
    if (err instanceof RpcError) return rpcError(`${this.deps.label}: ${err.message}`, 'internal')
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

  appAttachment(): 'attached' | 'restart' | 'failed' {
    return 'failed'
  }

  send(text: string, opts?: { origin?: InputOrigin; id?: string }): void {
    this.enqueue({ text, ...(opts?.id ? { id: opts.id } : {}) })
  }

  sendTracked(text: string, observer?: InputObserver): Promise<void> {
    return new Promise<void>((resolve, reject) => this.enqueue({ text, ...(observer ? { observer } : {}), done: { resolve, reject } }))
  }

  private enqueue(input: Input): void {
    if (this.phase === 'closed') {
      const e = new Error(`${this.deps.label} session is closed`)
      input.observer?.fail(e)
      input.done?.reject(e)
      return
    }
    this.queue.push(input)
    this.next()
  }

  /** ACP runs one prompt at a time; a message sent during a turn waits for it (§5.4) */
  private next(): void {
    if (this.phase !== 'ready' || this.turn) return
    const input = this.queue.shift()
    if (input) void this.run(input)
  }

  turnInputs(): readonly string[] {
    return this.lastTurnInputs
  }

  private async run(input: Input): Promise<void> {
    const turn: Turn = { input, stopAsked: false, cancelResent: false }
    this.turn = turn
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
    input.observer?.accepted?.()
    let result: PromptResult | null = null
    let failure: Error | null = null
    try {
      result = PromptResult.parse(
        await this.conn.request('session/prompt', { sessionId: this.externalId, prompt: [{ type: 'text', text: input.text }] }, NO_TIMEOUT_MS),
      )
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err))
    }
    if (turn.stopTimer) clearTimeout(turn.stopTimer)
    if (this.phase === 'closed') return
    for (const e of this.normalizer.endTurn()) this.emit(e)
    this.stopTreeClock()
    this.closeCards()
    this.lastTurnInputs = input.id ? [input.id] : []
    this.turn = null
    if (failure) {
      this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'internal', message: `${this.deps.label}: ${failure.message}`, retryable: true } })
      input.observer?.fail(failure)
      input.done?.reject(failure)
    } else if (result) {
      this.endTurn(result, turn)
      input.observer?.complete()
      input.done?.resolve()
    }
    this.next()
  }

  private endTurn(result: PromptResult, turn: Turn): void {
    const sessionId = this.sessionId
    const tokens = tokenUsage(result)
    if (tokens) this.emit({ type: 'usage_update', sessionId, tokens })
    switch (result.stopReason) {
      case 'cancelled':
        this.emit({ type: 'state_change', sessionId, state: 'waiting_input', reason: turn.stopAsked ? 'interrupted' : INTERRUPTED_BY_TOOL })
        return
      case 'refusal':
        this.emit({ type: 'error', sessionId, error: { code: 'internal', message: `${this.deps.label} refused to go on with this turn.`, retryable: false } })
        return
      case 'max_tokens':
      case 'max_turn_requests':
        this.emit({
          type: 'notice',
          sessionId,
          level: 'warning',
          from: this.deps.label,
          text: result.stopReason === 'max_tokens' ? `${this.deps.label} stopped: the reply reached its length limit.` : `${this.deps.label} stopped: the turn reached its limit of steps.`,
        })
        this.emit({ type: 'turn_complete', sessionId })
        return
      default:
        this.emit({ type: 'turn_complete', sessionId })
    }
  }

  /**
   * A command the tool runs may start helpers in a group of their own (Cursor's shell, measured on macOS), which outlive
   * the tool if it is killed: its tree is noted while a command runs, so they are ended with it (`noteTree`)
   */
  private watchCommands(e: NormalizedEvent): void {
    const proc = this.deps.process
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

  interrupt(): void {
    const turn = this.turn
    if (!turn || this.phase !== 'ready') return
    turn.stopAsked = true
    this.conn.notify('session/cancel', { sessionId: this.externalId })
    // ACP: after a cancel the client answers every open permission `cancelled` (measured: the agent withdraws none)
    this.closeCards()
    if (!turn.stopTimer) {
      turn.stopTimer = setTimeout(() => {
        if (this.turn === turn) this.emit(stopNotConfirmed(this.sessionId, `${this.deps.label} has not confirmed the stop; the turn may still be running.`))
      }, this.deps.stopConfirmMs)
      turn.stopTimer.unref?.()
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      this.unmapped.note(method)
      return
    }
    const read = readUpdate(params)
    if (!read || read.sessionId !== this.externalId || this.replaying) return
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
        if (u.used > 0 && u.size > 0) this.emit({ type: 'context_update', sessionId: this.sessionId, used: u.used, window: u.size, exactness: 'exact' })
        return
      default:
        for (const e of this.normalizer.update(u)) {
          this.watchCommands(e)
          this.emit(e)
        }
    }
  }

  /**
   * A cancel that reached the agent before its turn had begun is lost (ACP's cancel is a notification, answered by nothing
   * but the turn's end): the turn going on after it, by an update or by a question, gets the cancel once more
   */
  private resendLostCancel(): void {
    const turn = this.turn
    if (!turn?.stopAsked || turn.cancelResent) return
    turn.cancelResent = true
    this.conn.notify('session/cancel', { sessionId: this.externalId })
  }

  /** Answers a question cancelled, and remembers the call did not run as asked */
  private refused(callId: string): PermissionOutcome {
    this.normalizer.refuse(callId)
    return CANCELLED
  }

  /** Whether a question asked now belongs to a turn that still runs: none after Stop or after the turn's end */
  private askable(turn: Turn | null): boolean {
    return this.phase !== 'closed' && turn !== null && this.turn === turn && !turn.stopAsked
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

  respondApproval(requestId: string, decision: ApprovalDecision, _scope?: unknown, matcher?: string): boolean {
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

  applyRules(matchers: readonly string[]): void {
    this.rules.addAll(matchers)
  }

  setPermissionPreset(preset: PermissionPreset): void {
    this.preset = preset
  }

  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    return this.commands
  }

  private closeCards(): void {
    this.cards.release((requestId, card) => {
      this.normalizer.refuse(card.callId)
      card.answer(CANCELLED)
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision: 'deny' })
    })
  }

  private onExit(code: number | null, expected: boolean): void {
    if (expected || this.phase === 'closed') return
    const wasOpen = this.phase === 'ready'
    this.phase = 'closed'
    this.closeCards()
    const turn = this.turn
    this.turn = null
    if (turn?.stopTimer) clearTimeout(turn.stopTimer)
    this.dropQueue('were still queued when the agent exited')
    const failure = new Error(`${this.deps.label} exited${code === null ? '' : ` (code ${code})`}`)
    if (turn) {
      for (const e of this.normalizer.endTurn()) this.emit(e)
      this.stopTreeClock()
      turn.input.observer?.fail(failure)
      turn.input.done?.reject(failure)
    }
    if (turn || !wasOpen) {
      const tail = this.conn.stderrTail().trim().split('\n').slice(-5).join('\n')
      this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'adapter_crashed', message: tail ? `${failure.message}: ${tail}` : failure.message, retryable: true } })
    } else {
      // Idle when it ended: the conversation is kept by the tool, and the next message opens it again
      this.emit({ type: 'session_live', sessionId: this.sessionId, live: false, reason: 'asleep' })
    }
  }

  private dropQueue(when: string): void {
    const left = this.queue.splice(0)
    if (left.length === 0) return
    const e = new Error(`${left.length} message(s) ${when}`)
    for (const i of left) {
      i.observer?.fail(e)
      i.done?.reject(e)
    }
    this.emit(undeliveredError(this.sessionId, left.length, when))
  }

  async dispose(): Promise<void> {
    if (this.phase === 'closed') return
    const turn = this.turn
    this.phase = 'closed'
    this.closeCards()
    this.dropQueue('were still queued when the session closed')
    if (turn) {
      // The calls it had open end with it (#1562 review: a host stopped mid-command left the card spinning after its restart)
      for (const e of this.normalizer.endTurn('Centralu stopped this session while the call ran')) this.emit(e)
      this.stopTreeClock()
    }
    if (turn && this.externalId) {
      if (turn.stopTimer) clearTimeout(turn.stopTimer)
      this.conn.notify('session/cancel', { sessionId: this.externalId })
      turn.input.observer?.fail(new Error('the session closed'))
      turn.input.done?.reject(new Error('the session closed'))
    }
    if (this.canClose && this.externalId && !this.conn.isClosed) {
      await this.conn.request('session/close', { sessionId: this.externalId }, 2000).catch(() => {})
    }
    await this.conn.dispose()
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


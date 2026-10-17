import { InputReceipts, type InputReceipt } from '../input-receipts.js'
import type { InputObserver } from '../contract.js'
import type { ApprovalDecision, ApprovalScope } from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import { INTERRUPTED_BY_TOOL, type CreateSessionOpts, type EventSink, type SessionHandle } from '../contract.js'
import { CodexClient } from './client.js'
import { imageEventFromDisk } from '../images.js'
import { launchedThreads } from './child-tracker.js'
import { CODEX_KNOWN_NOTIFICATIONS } from './known-notifications.js'
import { CompactionMarks, goalFromCodex, normalizeNotification } from './normalize.js'
import { threadSettingsChanged, threadSettingsOf, type CodexThreadSettings } from './thread-settings.js'
import { CodexRequestInputs } from './token-readings.js'
import { UnmappedTypes } from '../unmapped.js'
import { RetryActivity } from '../retry-activity.js'
import { couldNotStop, undeliveredError, undeliveredText } from '../session-kit.js'
import { sandboxConfig } from './sandbox.js'
import { withStderrTail } from '../../stream-text.js'
import { CodexRequests } from './server-requests.js'
import { CodexServers } from './thread-servers.js'
import { CodexChildThreads } from './child-threads.js'
import { CodexSlashCommands } from './slash-commands.js'
import { runningTurnOf, threadIdOf, turnIdOf } from './turn-reads.js'
import { spawnInKeeper } from './launch-config.js'
import { initializeAppServer, latestRunningTurn, networkAccessOf, resumeFailure, resumeThreadParams, startThreadParams } from './thread-open.js'
import { CodexTurns } from './turns.js'
import { WakingSends, watchBackgroundResume } from './background-resume.js'
import { keepAttachedAppMarks } from '../tool-titles.js'

/** How long we let a resume wait in front of the person — a lock error ("active writer") arrives within this window (measured ~0.3s) */
export const LAZY_RESUME_WAIT_MS = 3_000
export class CodexSession implements SessionHandle {
  readonly sessionId: string
  /**
   * The thread id, once there is a conversation to resume (#524). A thread Codex started has no rollout until its
   * first turn, and resuming it before then is refused (measured, codex-cli 0.160.0, 2026-10-12:
   * `thread/resume` -32600 "no rollout found for thread id …", and `thread/list` leaves it out). So a started thread
   * names itself at its first turn (`threadWritten`), as Claude's conversation names itself at its first message:
   * a session restarted before then (a model set before the first message) starts a thread again instead of
   * failing to resume one. A resumed thread has a rollout, and names itself at once.
   */
  externalId: string | null = null
  private closed = false

  private client: CodexClient
  private threadId: string | null = null
  /** Which turn is running, which ended, and which we interrupted: what Stop targets (see `CodexTurns`) */
  private readonly turns = new CodexTurns()
  /**
   * Messages that arrived while a compact/review turn was running (measured while dogfooding,
   * 2026-09-02, MGH session).
   *
   * In codex 0.147.0, turn/start **answers success while dropping the input** while a compact
   * turn is running — the rollout kept only the settings application (thread_settings_applied)
   * and not a single line of the user message, and since no error came back either, our screen
   * made it look sent. Upstream also pins these turns as unsteerable ("cannot steer a compact
   * turn" — turn_processor.rs). A normal turn is different: codex core merges input into a turn
   * that is running, so we just send it as usual. So we only queue here during compact/review
   * **that we ourselves started**, and flush the queue as a single turn once that turn ends.
   */
  private pendingInputs: { text: string; receipt?: InputReceipt }[] = []
  private inputReceipts = new InputReceipts()
  private inputGroups = new Map<string, InputReceipt[]>()
  /** An unsteerable turn (compact/review) is running — we know because we are the ones who started it */
  private blockingTurn = false
  /** Messages sent while the thread was still coming up, and those a Stop reclaimed (see `WakingSends`, #168) */
  private readonly sends = new WakingSends()
  /** Codex is reconnecting on its own (#168): the `retrying` activity and what it puts back (see `RetryActivity`) */
  private readonly retry: RetryActivity
  /**
   * The thread never came up. Only possible after a lazy resume handed the handle out:
   * watchBackgroundStart reports that once, counting the messages it swallowed (#168, item 5).
   */
  private startFailed = false
  /** The thread came up (`ready` resolved). Until then, every message sent is still waiting on it */
  private started = false
  /** Notification methods this session received that nothing maps or ignores on purpose, said once each in host.log (#58) */
  private readonly unmapped: UnmappedTypes
  /** /compact, /review and /goal (see `CodexSlashCommands`) */
  private readonly slashCommands: CodexSlashCommands
  /** The child threads and the steps they send (see `CodexChildThreads`) */
  private readonly childThreads: CodexChildThreads
  /** One compaction marker per compaction, from the item, the deprecated notification, or both (#303) */
  private readonly compactions = new CompactionMarks()
  /** Each model request's input, once (prompt cache accounting, see `CodexRequestInputs`) */
  private readonly requests = new CodexRequestInputs()
  /** What the thread said it runs with — a `thread/settings/updated` is measured against this (#304, `threadSettingsChanged`) */
  private threadSettings: CodexThreadSettings | null = null
  /** Centralu's bridge and the app bridges this thread loads (see `CodexServers`) */
  private readonly threadServers: CodexServers
  /** The server's requests behind our approval cards (see `CodexRequests`) */
  private readonly serverRequests: CodexRequests
  /** Thread ready — awaited at construction time to obtain externalId */
  readonly ready: Promise<void>

  constructor(
    private opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.sessionId = opts.sessionId
    // An app's mark only for an app attached here (#730 review): a repository's own server may be named `app-<x>`
    const sink = emit
    this.emit = (e) => sink(keepAttachedAppMarks(e, () => (opts.apps?.current() ?? []).map((a) => a.server)))
    this.unmapped = new UnmappedTypes('codex', opts.sessionId, CODEX_KNOWN_NOTIFICATIONS)
    this.retry = new RetryActivity(opts.sessionId)
    this.slashCommands = new CodexSlashCommands({
      sessionId: opts.sessionId,
      emit: (e) => this.emit(e),
      request: (method, params) => this.client.request(method, params),
      threadId: () => this.threadId,
      setBlockingTurn: (on) => {
        this.blockingTurn = on
      },
      flushPending: () => this.flushPending(),
    })
    this.childThreads = new CodexChildThreads({ sessionId: opts.sessionId, emit: (e) => this.emit(e) })
    this.threadServers = new CodexServers({
      sessionId: opts.sessionId,
      opts,
      request: (method, params) => this.client.request(method, params),
      threadId: () => this.threadId,
    })
    this.serverRequests = new CodexRequests({
      sessionId: opts.sessionId,
      emit: (e) => this.emit(e),
      respond: (id, result) => this.client.respond(id, result),
      threadId: () => this.threadId,
      appServers: () => this.threadServers.appServers,
      ownServer: () => this.threadServers.ownServer,
    })
    this.client = new CodexClient(
      {
        onNotification: (n) => this.onNotification(n),
        onServerRequest: (r) => this.serverRequests.onServerRequest(r),
        /*
         * **Do not report a process we closed ourselves as having crashed.**
         *
         * This is the spot that ate an entire day of investigation. When resuming a locked
         * thread failed, the manager cleaned the session up (dispose), and that ordinary
         * shutdown came back through here and raised `adapter_crashed`. The screen showed only
         * "codex app-server exited", and the real reason ("already has an active writer") was
         * buried underneath, out of sight. Calling a process that never crashed a crash left no
         * way to find the actual cause.
         */
        onExit: (code, expected) => {
          // The child threads lived in that process (#290) — closed by us or not, they are gone
          this.releaseChildren()
          if (expected) return
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: {
              code: 'adapter_crashed',
              // What it printed last is the reason a person can act on: a lock, a bad config line, a panic
              message: withStderrTail(`codex app-server exited (code ${code ?? 'null'})`, this.client),
              retryable: true,
            },
          })
        },
      },
      {
        cwd: opts.cwd,
        command: whichTool('codex') ?? 'codex',
        // Under the keeper (#280 step 2) the app-server is spawned there, or adopted from a previous host
        process: opts.processSource
          ? (opts.processSource.adopt?.process ?? spawnInKeeper(opts.processSource, opts.cwd))
          : undefined,
      },
    )
    this.ready = this.start()
    // Registered before any send's continuation, so the flag is set by the time a send's catch runs
    this.ready.then(
      () => {
        this.started = true
      },
      () => {
        this.startFailed = true
      },
    )
  }

  private async start(): Promise<void> {
    const adopted = !!this.opts.processSource?.adopt
    await initializeAppServer(this.client, this.sessionId, adopted, (e) => this.emit(e))

    const workspaceConfig = await sandboxConfig(this.opts.cwd, this.opts.permissionPreset, () => this.threadServers.personsConfig())
    if (this.opts.resumeExternalId) {
      // Resume (FR-10). If it fails, the session manager guides the person through the fallback
      let res: Record<string, unknown>
      try {
        res = await this.client.request<Record<string, unknown>>('thread/resume', resumeThreadParams(this.opts, await this.threadServers.mcpConfig(), workspaceConfig))
      } catch (err) {
        throw resumeFailure(err)
      }
      this.threadId = threadIdOf(res) ?? this.opts.resumeExternalId
      this.threadSettings = threadSettingsOf(res)
      this.threadServers.checkAppMode(res)
      this.networkAccess = networkAccessOf(res)
      // An adopted thread may be mid-turn: Stop needs that turn's id (#313)
      if (adopted) this.takeStartedTurn(runningTurnOf(res) ?? (await latestRunningTurn(this.client, this.sessionId, this.threadId, res)))
      /*
       * The goal is a live field (2026-09-07) — for the badge to stay accurate after a restart,
       * we ask again on resume. Older codex has no such method: a failure lies down quietly as
       * "no goal", same as having none.
       */
      void this.client
        .request<{ goal: Record<string, unknown> | null }>('thread/goal/get', { threadId: this.threadId })
        .then((r) => {
          // goalFromCodex folds complete into null — the default state is already null, so there is nothing to emit then
          const g = r.goal ? goalFromCodex(r.goal) : null
          if (g) this.emit({ type: 'goal', sessionId: this.sessionId, goal: g })
        })
        .catch(() => {})
    } else {
      const res = await this.client.request<Record<string, unknown>>('thread/start', startThreadParams(this.opts, await this.threadServers.mcpConfig(), workspaceConfig))
      this.threadId = threadIdOf(res)
      this.threadSettings = threadSettingsOf(res)
      this.threadServers.checkAppMode(res)
      this.networkAccess = networkAccessOf(res)
      // No rollout yet: the thread is named at its first turn (see externalId)
      return
    }
    this.externalId = this.threadId
  }

  private networkAccess: boolean | undefined

  delegationNotice(): string | undefined {
    return this.networkAccess === false
      ? `this child cannot reach the network under ${this.opts.permissionPreset}`
      : undefined
  }

  /** A turn started on this thread, so Codex has written its rollout and the thread can be resumed (see externalId) */
  private threadWritten(): void {
    if (this.externalId === null && this.threadId !== null) this.externalId = this.threadId
  }

  private onNotification(n: { method: string; params?: unknown }): void {
    /*
     * **A notification from another thread does not belong to this session** (the codex side of #98).
     *
     * A child agent spawned by the model via spawn_agent runs on a separate thread, and
     * app-server attaches that thread's listener to every initialized connection whenever a new
     * thread is created (codex source app-server/src/lib.rs -> try_attach_thread_listener; a
     * new-thread notification is only sent from notify_thread_created in spawn.rs). So a child's
     * notification arrives on this same connection, differing only in threadId. Without
     * filtering, the child's tool calls and text get stuck into the parent's conversation, the
     * child's turn/started hijacks the target of stop (turnId), and the child's turn/completed
     * flips the parent to "finished" — which is why this check runs before turnId is recorded.
     *
     * We do not filter server **requests** (approvals) (onServerRequest) — if nobody answers an
     * approval the child is asking for, the child gets stuck. While the thread is still unknown
     * (before the thread/start response), a child cannot exist yet, so we let it through.
     */
    // Before the thread filter: a child thread's approval requests do reach us (see above), and its card needs its changes too
    this.serverRequests.noteFileChange(n)
    // Also before the filter, for the same reason: a child's approval card closes with its request
    this.serverRequests.noteRequestEnded(n)
    // Also before the filter: a method nobody handles is news whichever thread it came from
    this.unmapped.note(n.method)
    const from = (n.params as { threadId?: unknown } | undefined)?.threadId
    /*
     * A child's notification is not the parent's conversation, but what the child did is kept (#222): its items become
     * steps under the `spawnAgent` card that launched it, which the host stores apart from the conversation.
     */
    if (typeof from === 'string' && this.threadId !== null && from !== this.threadId) {
      for (const e of this.childThreads.children.push(from, n)) this.emit(e)
      this.childThreads.onChildNotification(from, n)
      this.childThreads.noteSpawn(n)
      return
    }
    // Which turn is running (Turn.id — generated/v2/Turn.ts). Cleared once it ends: trying to
    // stop a turn that has already ended gets rejected by the server, and that rejection becomes a false "did not stop" signal
    if (n.method === 'turn/started') {
      this.turns.turnId = turnIdOf(n.params)
      // Before the event below goes out: the manager records a handle's external id as its events arrive
      this.threadWritten()
    }
    if (n.method === 'turn/completed' || n.method === 'turn/failed') this.turns.ended(turnIdOf(n.params))

    // Output flows again after a reconnect — the retrying activity gives way to what was showing before it
    const resumed = n.method.startsWith('item/') ? this.retry.resumed() : null
    if (resumed) this.emit(resumed)
    // A finished turn takes its activity with it (the state machine clears it on leaving working)
    if (n.method === 'turn/completed') this.retry.ended()

    this.threadServers.noteAppCall(n)
    if (n.method === 'item/started' || n.method === 'item/completed') {
      const p = (n.params ?? {}) as { turnId?: string; item?: { type?: string; clientId?: string } }
      if (p.item?.type === 'userMessage' && p.item.clientId && p.turnId) {
        const group = this.inputGroups.get(p.item.clientId)
        if (group) {
          this.inputGroups.delete(p.item.clientId)
          this.takeInputTurn({ turn: { id: p.turnId } }, group)
        }
      }
    }

    // Where compact/review ends — if messages piled up during it, they go out now
    if (n.method === 'turn/completed' && this.blockingTurn) {
      this.blockingTurn = false
      this.flushPending()
    }
    if (n.method === 'thread/settings/updated') {
      const { next, events } = threadSettingsChanged(this.sessionId, this.threadSettings, n.params, {
        model: this.opts.model ?? null,
        effort: this.opts.effort ?? null,
        verbosity: this.opts.verbosity ?? null,
        serviceTier: this.opts.serviceTier ?? null,
      })
      this.threadSettings = next
      for (const e of events) this.emit(e)
      return
    }
    if (n.method === 'mcpServer/startupStatus/updated' && !this.threadServers.firstMcpFailure(n.params)) return
    this.emitNotification(n)
    this.childThreads.noteSpawn(n)
    this.childThreads.noteTurnEnd(n)
  }

  /** A notification of this thread's own, as the events it maps to (`normalizeNotification`), each the way it goes out */
  private emitNotification(n: { method: string; params?: unknown }): void {
    for (const e of normalizeNotification(this.sessionId, n)) {
      if (e.type === 'error' && this.inputReceipts.size) this.interrupt(new Error(e.error.message))
      /*
       * An image that arrived carrying only a path gets its bytes filled in here (#40). normalize
       * is a pure function and cannot read files — IO is the adapter's job. The read is async,
       * but an image is not sensitive to conversation ordering (the tool line has already gone
       * out), so it is fine for it to arrive later.
       */
      if (e.type === 'message_image' && !e.data && e.path) {
        void imageEventFromDisk(this.sessionId, e.path).then((filled) => this.emit(filled))
        continue
      }
      if (e.type === 'compaction' && !this.compactions.admit(n)) continue
      // A spawnAgent card stays open while the children it started run, so their steps show on it live (#843)
      if (e.type === 'tool_result' && this.childThreads.children.hold(e, launchedThreads(n))) continue
      if (e.type === 'usage_update') {
        const request = this.requests.take(n.params)
        if (request) {
          this.emit({ ...e, request })
          continue
        }
      }
      // Each attempt sends its own notice; one indication is enough
      if (e.type === 'activity' && !this.retry.admit(e.activity)) continue
      /*
       * Who interrupted the turn is logged (#698): a real one ended a delegated turn as "finished" seven seconds before
       * the person quit, and nothing said whether the person's Stop, the host or Codex itself had sent it.
       */
      const interrupted = e.type === 'state_change' && e.reason === 'interrupted' && n.method === 'turn/completed'
      if (interrupted) {
        const turn = turnIdOf(n.params)
        const ours = !!turn && this.turns.interruptSent(turn)
        console.error(`[codex] ${this.sessionId.slice(0, 8)} turn ${turn ?? '?'} interrupted ${ours ? 'by a stop from Centralu' : 'by Codex, not by a stop from Centralu'}`)
        this.emit(ours ? e : { ...e, reason: INTERRUPTED_BY_TOOL })
      } else {
        this.emit(e)
      }
      if (e.type === 'turn_complete' || interrupted) {
        const ended = turnIdOf(n.params)
        if (ended) this.inputReceipts.endTurn(ended)
      }
    }
  }

  sendTracked(text: string, observer?: InputObserver): Promise<void> {
    const receipt = this.inputReceipts.create(observer)
    this.sendInput(text, receipt)
    return receipt.done
  }

  send(text: string): void { this.sendInput(text) }

  private sendInput(text: string, receipt?: InputReceipt): void {
    const nth = this.sends.issue()
    void this.ready
      .then(() => {
        // A Stop pressed before the thread was up already reclaimed this message (`sends`) — do not send it
        if (this.sends.reclaimed(nth) || receipt?.cancelled) return
        if (!this.threadId) throw new Error('Thread is not ready')
        /*
         * While compact/review is running, we do not send but queue instead — the measurement in
         * the pendingInputs comment is the reason (if sent, codex answers success while
         * **dropping** it). This leaves a limitation where a slash command hitting this path is
         * delivered as literal text, but /compact during a compact is meaningless anyway.
         */
        if (this.blockingTurn) {
          this.pendingInputs.push({ text, receipt })
          return
        }
        const command = this.slashCommands.run(text)
        if (command) return command
        if (receipt) this.inputGroups.set(receipt.id, [receipt])
        return (
          this.client
            .request('turn/start', {
              threadId: this.threadId,
              ...(receipt ? { clientUserMessageId: receipt.id } : {}),
              input: [{ type: 'text', text }],
              /*
               * Reasoning effort is passed per turn — this is the slot codex documents as applying
               * to "this turn and turns after it". It is cheaper this way, since it can be changed
               * without restarting the session.
               */
              ...(this.opts.effort ? { effort: this.opts.effort } : {}),
              ...this.outputSchemaParam(),
            })
            // The turn also rides along on the response — this covers the case where it arrives before the notification (the target of stop)
            .then((res) => this.takeInputTurn(res, receipt ? [receipt] : []))
        )
      })
      .catch((e: Error) => {
        if (receipt) this.inputGroups.delete(receipt.id)
        if (receipt?.cancelled || receipt?.completed) return
        if (receipt) this.interrupt(e)
        // The thread never came up — watchBackgroundStart says so once, counting this message (#168, item 5)
        if (this.startFailed) return
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: e.message, retryable: true },
        })
      })
  }

  /** Sends the messages that were queued out as one turn — each message as its own input item (does not blur the boundary) */
  private flushPending(): void {
    if (this.pendingInputs.length === 0 || !this.threadId) return
    const pending = this.pendingInputs
    const receipts = pending.flatMap((p) => p.receipt ? [p.receipt] : [])
    const clientId = receipts[0]?.id
    if (clientId) this.inputGroups.set(clientId, receipts)
    const input = pending.map(({ text }) => ({ type: 'text', text }))
    this.pendingInputs = []
    void this.client
      .request('turn/start', {
        threadId: this.threadId,
        ...(clientId ? { clientUserMessageId: clientId } : {}),
        input,
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        ...this.outputSchemaParam(),
      })
      .then((res) => this.takeInputTurn(res, receipts))
      .catch((e: Error) => {
        if (clientId) this.inputGroups.delete(clientId)
        if (receipts.length && receipts.every((r) => r.cancelled || r.completed)) return
        if (this.inputReceipts.size) this.interrupt(e)
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: e.message, retryable: true },
        })
      })
  }

  private takeInputTurn(res: unknown, receipts: InputReceipt[]): void {
    if (receipts.length && receipts.every((r) => r.completed)) return
    const id = turnIdOf(res)
    if (!receipts.length) { this.takeStartedTurn(id); return }
    if (!id) {
      this.interrupt(new Error('Codex did not identify the turn accepting the parent note'))
      return
    }
    // Stop can arrive while turn/start is in flight, before the next turn is named.
    if (receipts.some((r) => r.cancelled) && !this.turns.hasEnded(id)) {
      // Ours: the person's Stop, so its ending is not Codex's own interrupt (#698)
      this.turns.noteInterruptSent(id)
      void this.client.request('turn/interrupt', { threadId: this.threadId, turnId: id }).catch(() => {})
    }
    if (receipts.some((r) => r.cancelled)) return
    this.takeStartedTurn(id)
    for (const receipt of receipts) this.inputReceipts.bind(receipt, id)
  }

  /**
   * Takes a running turn's id from a response, unless the notifications already named one or already ended it. The
   * response and the notifications race: `turn/started` can come after the response (Stop pressed very quickly), and
   * `turn/completed` can come before it (a short turn), so a late response must not bring an ended turn back.
   */
  private takeStartedTurn(id: string | null): void {
    this.threadWritten()
    this.turns.take(id)
  }

  /**
   * A turn belonging to an agent that an app gave a schema and asked for (M4 D-1). Codex receives
   * the schema **per turn** — the installed 0.153.4's generated type is
   * `TurnStartParams.outputSchema` ("Optional JSON Schema used to constrain the final assistant
   * message for this turn"). So it is loaded onto every turn of this session: leaving it out even
   * once means that turn's last message is free text outside the schema. The answer is the last
   * message itself — the manager reads and validates that text as JSON. We could not re-verify by
   * running it while logged out (confirmed only from the generated type).
   */
  private outputSchemaParam(): Record<string, unknown> {
    return this.opts.outputSchema ? { outputSchema: this.opts.outputSchema } : {}
  }

  respondApproval(requestId: string, decision: ApprovalDecision, _scope?: ApprovalScope, matcher?: string): boolean {
    return this.serverRequests.respondApproval(requestId, decision, _scope, matcher)
  }

  applyRules(matchers: readonly string[]): void {
    this.serverRequests.applyRules(matchers)
  }

  appAttachment(server: string): 'attached' | 'restart' | 'failed' {
    return this.threadServers.appAttachment(server)
  }

  /** Slash commands (skills) — the app-server's official RPC (see `CodexSlashCommands.list`) */
  listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    return this.slashCommands.list()
  }

  interrupt(reason = new Error('The parent note was stopped before it finished')): void {
    const turns = this.inputReceipts.failAll(reason)
    this.pendingInputs = this.pendingInputs.filter((p) => !p.receipt)
    for (const turnId of turns) {
      if (!this.threadId || turnId === this.turns.turnId || this.turns.hasEnded(turnId)) continue
      this.turns.noteInterruptSent(turnId)
      void this.client.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {})
    }
    /*
     * Stops app calls made by this session (M4 A-5) — **even without a turn.** A call that had
     * already returned early past 240 seconds keeps running even after the turn ends. Work from a
     * session the person pressed stop on must not keep running in the background. The bridge does
     * not make this decision, so it is cut off here, at the host. The cancellation is carried by
     * the runtime down through the app and whatever it started.
     */
    this.opts.apps?.cancelAll()
    /*
     * The thread has not come up yet (a lazy resume is in progress) — reclaim the queued message
     * and go back to waiting for input (#168, `sends`). No turn/completed(interrupted) will
     * arrive either, since no turn was ever started — the state is flipped here instead.
     */
    if (!this.threadId && this.sends.unsent > 0) {
      this.sends.reclaim()
      this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
      return
    }
    /*
     * Answers this thread's open approvals with a refusal before the interrupt, the way the Claude adapter does. The
     * interrupt ends them on Codex's side too, but only if it lands: answering them here closes the cards either way,
     * and a refusal sent to a request the interrupt already ended is ignored. A child's request stays open, because
     * stopping this turn does not stop the child (see `stopBackgroundTask`).
     */
    for (const requestId of this.serverRequests.approvals.ids((a) => a.threadId === null || a.threadId === this.threadId)) {
      this.respondApproval(requestId, 'deny')
    }
    // Nothing to stop if no turn is running (this is the case of a stop pressed right after a turn just ended)
    if (!this.threadId || !this.turns.turnId) return
    this.turns.noteInterruptSent(this.turns.turnId)
    // Swallowing a failure here would leave us assuming it stopped and waiting — if it did not stop, say so
    void this.client
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.turns.turnId })
      .catch((err: Error) => this.emit(couldNotStop(this.sessionId, err)))
  }

  /**
   * Stops one child agent (#290) by interrupting its own turn — measured to stop it (`turn/completed {interrupted}`
   * on the child), where interrupting the parent's turn leaves it running. Its ending arrives through the child's
   * notifications like any other. A command the child was running is not killed by Codex's interrupt (measured: its
   * process outlived the interrupt), which is Codex's own behaviour for every interrupted turn.
   */
  async stopBackgroundTask(taskId: string): Promise<void> {
    const turnId = this.childThreads.children.turnOf(taskId)
    if (!turnId) throw new Error('That child agent has no running turn to stop')
    await this.client.request('turn/interrupt', { threadId: taskId, turnId })
  }

  /** The app-server is gone, and the child threads with it — each still listed ends as stopped. */
  private releaseChildren(): void {
    this.inputGroups.clear()
    this.inputReceipts.failAll(new Error('The session process ended before the parent note finished'))
    for (const e of this.childThreads.children.release('Ended with the session process')) this.emit(e)
  }

  /** The watchdog for a background resume (lazy resume only, see `watchBackgroundResume`) */
  watchBackgroundStart(): void {
    watchBackgroundResume({
      sessionId: this.sessionId,
      emit: (e) => this.emit(e),
      closed: () => this.closed,
      ready: this.ready,
      unsentNote: () => this.unsentNote(),
      dispose: () => this.dispose(),
    })
  }

  /**
   * The messages sent while the thread was opening, as a note for the error that ends the handle, and marked stopped
   * so dispose (which follows) does not say them again and a start that still lands does not send them. Inside that
   * one error rather than after it: once the manager retires the handle, a later event from it may not be heard.
   */
  private unsentNote(): string {
    const unsent = this.sends.reclaim()
    return unsent > 0 ? ` — ${undeliveredText(unsent, 'were sent while it was opening')}` : ''
  }

  /**
   * Closed or let go while a lazy resume was still waking (#428). The client's dispose or detach rejects the pending
   * resume, so `ready` fails after the handle is closed, and neither send's catch (it leaves a failed start to
   * watchBackgroundStart) nor watchBackgroundStart (it returns once closed) would speak for the messages sent
   * meanwhile. They are said here, and marked stopped so a start that still lands does not send them.
   */
  private reportUnsentWhileWaking(when: string): void {
    if (this.started) return
    const unsent = this.sends.reclaim()
    if (unsent > 0) this.emit(undeliveredError(this.sessionId, unsent, when))
  }

  /** Does not silently drop a pending approval (same reason as the claude adapter — the screen would be stuck holding the card) */
  async dispose(): Promise<void> {
    this.closed = true
    // App attachment closes together with the handle — a new handle gets its own
    this.opts.apps?.close()
    this.serverRequests.closeApprovals()
    // Said before the process goes, while this handle is still the session's (the manager drops a stale handle's events)
    this.releaseChildren()
    /*
     * The case of dying together with messages that were waiting for a compact to finish — the
     * screen already shows them as sent (the manager records them first), so dropping them
     * silently would just resurrect the original bug at shutdown time. We have to say delivery
     * failed, so the user can resend.
     */
    if (this.pendingInputs.length > 0) {
      const n = this.pendingInputs.length
      this.pendingInputs = []
      this.emit(undeliveredError(this.sessionId, n, 'were sent during compaction'))
    }
    this.reportUnsentWhileWaking('were sent while it was opening')
    await this.client.dispose()
  }

  /**
   * Lets go of the app-server without closing it (#280 step 2). No deny for a waiting approval —
   * the next host's `thread/resume` gets it re-sent under the same id — and no EOF, which would make
   * codex exit. The bridge processes codex started for this thread stay with codex.
   */
  async detach(): Promise<void> {
    // The next host resumes the thread, but not the messages this one held behind a resume still waking (#428)
    this.reportUnsentWhileWaking('were sent while it was opening, as Centralu restarted,')
    this.opts.apps?.close()
    await this.client.detach()
    this.closed = true
  }
}


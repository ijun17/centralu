import { hostAccessEnv } from '../contract.js'
import type { InputObserver, InputOrigin } from '../contract.js'
import { launchPreset } from '../edit-grant.js'
import { endsStreamRow, streamRowKind, type ApprovalDecision, type ApprovalScope, type PermissionPreset } from '@cc/protocol'
import { toolCommand } from '../../tool-launch.js'
import type { CreateSessionOpts, EventSink, SessionHandle } from '../contract.js'
import { CodexClient } from './client.js'
import { imageEventFromDisk } from '../images.js'
import { launchedThreads } from './child-tracker.js'
import { CODEX_KNOWN_NOTIFICATIONS } from './known-notifications.js'
import { CompactionMarks, goalFromCodex, normalizeNotification } from './normalize.js'
import { ReasoningParts } from './reasoning-parts.js'
import { turnError } from './model-rejected.js'
import { reconcileOpenedThread, threadSettingsChanged, threadSettingsOf, type CodexThreadSettings } from './thread-settings.js'
import { CodexRequestInputs } from './token-readings.js'
import { UnmappedTypes } from '../unmapped.js'
import { RetryActivity } from '../retry-activity.js'
import { undeliveredText } from '../session-kit.js'
import { sandboxConfig } from './sandbox.js'
import { withStderrTail } from '../../stream-text.js'
import { CodexRequests } from './server-requests.js'
import { CodexServers } from './thread-servers.js'
import { CodexChildThreads } from './child-threads.js'
import { CodexSlashCommands } from './slash-commands.js'
import { runningTurnOf, threadIdOf, turnIdOf } from './turn-reads.js'
import { codexCompactAt, initializeAppServer, latestRunningTurn, networkAccessOf, resumeFailure, resumeThreadParams, startThreadParams } from './thread-open.js'
import { watchBackgroundResume } from './background-resume.js'
import { keepAttachedAppMarks } from '../tool-titles.js'
import { MidTurnLedger } from '../core/mid-turn-ledger.js'
import type { MidTurnInput } from '../core/seam.js'

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

  private client: CodexClient
  private threadId: string | null = null
  /**
   * The inputs, their receipts, the turn a Stop targets, the queue behind a compact or review, and the exit (`MidTurnLedger`).
   * Codex merges an input into a turn that is running; a compact or review turn takes none (upstream: "cannot steer a compact
   * turn", turn_processor.rs), so what is sent during one waits for its end
   */
  private readonly ledger: MidTurnLedger
  /** The inputs a `turn/start` sent, by the client id it gave them: the turn's first item names it (#1604) */
  private inputGroups = new Map<string, MidTurnInput[]>()
  /**
   * The turn that started and has shown no item yet (#1604): the first item of a turn Codex starts for `turn/start` is the
   * message it was started with, which names the id it came under (`clientId`). A message that joined a turn already running
   * shows after the turn's other items, so only the first one says what a turn began from
   */
  private openingTurn: string | null = null
  /** The inputs the turn whose opening is being handled began from (`turnStartInputs`); null outside that event */
  private startInputs: readonly string[] | null = null
  /** A compaction we started (`/compact`) is running: a compaction event in it is manual */
  private compactTurn = false
  /** Codex is reconnecting on its own (#168): the `retrying` activity and what it puts back (see `RetryActivity`) */
  private readonly retry: RetryActivity
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
  /** The model and effort turns ask for: the session's own, or what the thread answered a resume with instead (#1369, `reconcileOpenedThread`) */
  private shown: { model: string | null; effort: string | null } | null = null
  /** What the thread said it runs with — a `thread/settings/updated` is measured against this (#304, `threadSettingsChanged`) */
  private threadSettings: CodexThreadSettings | null = null
  /** Centralu's bridge and the app bridges this thread loads (see `CodexServers`) */
  private readonly threadServers: CodexServers
  /** The server's requests behind our approval cards (see `CodexRequests`) */
  private readonly serverRequests: CodexRequests
  /** Thread ready — awaited at construction time to obtain externalId */
  readonly ready: Promise<void>

  /** The preset the session is set to now (#1525), which can differ from the one it launched under only between `normal` and `edits` */
  private livePreset: PermissionPreset

  /** Which reasoning item the open reasoning row last grew from, so a second item's summary does not run into the first's (#1464) */
  private readonly reasoningParts = new ReasoningParts()

  setPermissionPreset(preset: PermissionPreset): void {
    this.livePreset = preset
  }

  constructor(
    private opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.sessionId = opts.sessionId
    this.livePreset = opts.permissionPreset
    // An app's mark only for an app attached here (#730 review): a repository's own server may be named `app-<x>`
    const sink = emit
    this.emit = (e) => {
      // Whatever ends the open row, or a row of another kind (an answer), also ends the reasoning part before it (#1464)
      if (endsStreamRow(e) || streamRowKind(e) === 'text') this.reasoningParts.reset()
      sink(keepAttachedAppMarks(e, () => (opts.apps?.current() ?? []).map((a) => a.server)))
    }
    this.unmapped = new UnmappedTypes('codex', opts.sessionId, CODEX_KNOWN_NOTIFICATIONS)
    this.retry = new RetryActivity(opts.sessionId)
    this.slashCommands = new CodexSlashCommands({
      sessionId: opts.sessionId,
      emit: (e) => this.emit(e),
      request: (method, params) => this.client.request(method, params),
      threadId: () => this.threadId,
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
      editsFolder: () => (this.livePreset === 'edits' && launchPreset(opts.permissionPreset) === 'normal' ? opts.cwd : null),
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
        /*
         * The ledger says whether it went with work in flight (a crash) or idle (asleep: a Codex session keeps its app-server
         * while idle, #568, so a shutdown or a kill lands on sessions doing nothing, #1397). What it printed last is the reason
         * a person can act on: a lock, a bad config line, a panic
         */
        onExit: (code, expected) => this.ledger.exited(expected, withStderrTail(`codex app-server exited (code ${code ?? 'null'})`, this.client)),
      },
      {
        cwd: opts.cwd,
        command: toolCommand('codex'),
        sessionId: opts.sessionId,
        // Under the keeper (#280 step 2) the app-server is spawned there, or adopted from a previous host
        ...(opts.processSource ? { source: opts.processSource } : {}),
        ...(opts.processSource?.adopt ? { process: opts.processSource.adopt.process } : {}),
        // The host's address and this session's credential, for a script the agent writes (#1405)
        env: hostAccessEnv(opts.hostAccess),
      },
    )
    this.ledger = new MidTurnLedger(opts.sessionId, this.emit, {
      label: 'Codex',
      open: () => this.start(),
      hasConversation: () => this.threadId !== null,
      write: (inputs, queued) => this.write(inputs, queued),
      refusal: (err) => turnError(err.message),
      interrupt: (turnId) => this.client.request('turn/interrupt', { threadId: this.threadId, turnId }),
      releaseCards: () => this.releaseCards(),
      // The child threads lived in that process (#290): closed by us or not, they are gone
      connectionEnded: () => {
        this.inputGroups.clear()
        for (const e of this.childThreads.children.release('Ended with the session process')) this.emit(e)
      },
      close: () => this.close(),
      detach: async () => {
        this.opts.apps?.close()
        await this.client.detach()
      },
    })
    this.ready = this.ledger.ready
  }

  /**
   * The settings the thread turned out to run with (#1369) go to the host as it registers the handle (`takeOpenedSettings`):
   * until then it cannot record a `settings_changed`. A resume still running when the host took them (a slow background
   * resume) sends the event itself once it answers.
   */
  private opened: { model: string | null; effort: string | null } | null = null
  private openedTaken = false

  private adoptOpened(settings: { model: string | null; effort: string | null }): void {
    if (!this.openedTaken) {
      this.opened = settings
      return
    }
    this.emit({
      type: 'settings_changed',
      sessionId: this.sessionId,
      model: settings.model,
      effort: settings.effort,
      verbosity: this.opts.verbosity ?? null,
      serviceTier: this.opts.serviceTier ?? null,
      by: 'tool',
    })
  }

  takeOpenedSettings(): { model: string | null; effort: string | null } | null {
    this.openedTaken = true
    const settings = this.opened
    this.opened = null
    return settings
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
      // What the thread runs, against what Centralu shows (#1369): the screen follows the thread, never the other way round
      const opened = reconcileOpenedThread(this.sessionId, this.threadSettings, { model: this.opts.model ?? null, effort: this.opts.effort ?? null })
      if (opened.notice) this.emit(opened.notice)
      if (opened.settings) {
        // Another model than the one recorded answered: what every turn asks for from here on, or the next turn would undo it
        if (this.opts.model) this.shown = { model: opened.settings.model, effort: this.opts.effort ?? null }
        this.adoptOpened(opened.settings)
      }
      this.threadServers.checkAppMode(res)
      this.networkAccess = networkAccessOf(res)
      // An adopted thread may be mid-turn: Stop needs that turn's id (#313)
      if (adopted && this.ledger.taken([], runningTurnOf(res) ?? (await latestRunningTurn(this.client, this.sessionId, this.threadId, res)))) this.threadWritten()
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
      this.openingTurn = turnIdOf(n.params)
      this.ledger.turnStarted(this.openingTurn)
      // Before the event below goes out: the manager records a handle's external id as its events arrive
      this.threadWritten()
    }
    if (n.method === 'turn/failed') this.ledger.turnEnded(turnIdOf(n.params), null)
    if (n.method === 'turn/completed') this.compactTurn = false

    // Output flows again after a reconnect — the retrying activity gives way to what was showing before it
    const resumed = n.method.startsWith('item/') ? this.retry.resumed() : null
    if (resumed) this.emit(resumed)
    // A finished turn takes its activity with it (the state machine clears it on leaving working)
    if (n.method === 'turn/completed') this.retry.ended()

    this.threadServers.noteAppCall(n)
    if (n.method === 'item/started' || n.method === 'item/completed') {
      const p = (n.params ?? {}) as { turnId?: string; item?: { type?: string; clientId?: string } }
      // The turn's first item: what it began from is said now, and no later item is a start
      const opening = p.turnId !== undefined && p.turnId === this.openingTurn
      if (opening) this.openingTurn = null
      if (p.item?.type === 'userMessage' && p.item.clientId && p.turnId) {
        const group = this.inputGroups.get(p.item.clientId)
        if (group) {
          this.inputGroups.delete(p.item.clientId)
          if (this.ledger.taken(group, p.turnId)) this.threadWritten()
          if (opening) this.announceStart(group.flatMap((i) => (i.receipt ? [i.receipt.id] : [])))
        }
      }
    }
    if (n.method === 'thread/settings/updated') {
      const { next, events } = threadSettingsChanged(this.sessionId, this.threadSettings, n.params, {
        model: this.shown?.model ?? this.opts.model ?? null,
        effort: this.shown?.effort ?? this.opts.effort ?? null,
        verbosity: this.opts.verbosity ?? null,
        serviceTier: this.opts.serviceTier ?? null,
      })
      this.threadSettings = next
      // The thread changed under us and the record follows (settings_changed): turns ask for what runs now, not for the old one
      const switched = events.find((e) => e.type === 'settings_changed')
      if (switched?.type === 'settings_changed') this.shown = { model: switched.model, effort: switched.effort }
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
    for (const said of this.reasoningParts.join(n, normalizeNotification(this.sessionId, n))) {
      /*
       * Codex does not say why it compacted. A compaction inside the compact turn this session started (`/compact`, Centralu's
       * own compaction or the person's) is manual; any other is the tool's own, in the middle of a turn (#1500): the host does not
       * take it for a compaction it asked for
       */
      const sort = said.type === 'compaction' ? { ...said, trigger: this.compactTurn ? ('manual' as const) : ('auto' as const) } : said
      // The point a thread of this process was started to compact at, with its window readings (#1553); an adopted one was started with a limit this host did not keep
      const compactAt = codexCompactAt(this.opts)
      const e = sort.type === 'context_update' && compactAt !== undefined ? { ...sort, compactAt } : sort
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
          /*
           * Codex's token count does not say which model served it, and a session on the tool's default has none recorded: the
           * price ratios of the cache (`cache-cost.ts`) and the usage history need the one the thread runs (#1504 review).
           * What the turns ask for first, else what the thread answered when it opened
           */
          const model = this.shown?.model ?? this.opts.model ?? this.threadSettings?.model ?? null
          this.emit({ ...e, request: model ? { ...request, model } : request })
          continue
        }
      }
      // Each attempt sends its own notice; one indication is enough
      if (e.type === 'activity' && !this.retry.admit(e.activity)) continue
      if (n.method === 'turn/completed' && (e.type === 'turn_complete' || e.type === 'error' || (e.type === 'state_change' && e.reason === 'interrupted'))) {
        // The turn's end, which the ledger says, with the inputs it took
        const turn = turnIdOf(n.params)
        if (e.type === 'state_change') {
          /*
           * Who interrupted the turn is logged (#698): a real one ended a delegated turn as "finished" seven seconds before
           * the person quit, and nothing said whether the person's Stop, the host or Codex itself had sent it.
           */
          const ours = !!turn && this.ledger.stopSent(turn)
          console.error(`[codex] ${this.sessionId.slice(0, 8)} turn ${turn ?? '?'} interrupted ${ours ? 'by a stop from Centralu' : 'by Codex, not by a stop from Centralu'}`)
        }
        this.ledger.turnEnded(turn, e.type === 'error' ? { how: 'failed', error: e.error } : { how: e.type === 'turn_complete' ? 'complete' : 'interrupted' })
        continue
      }
      // An error of the thread's own: the tracked inputs still waiting fail with it
      if (e.type === 'error') this.ledger.failed(new Error(e.error.message))
      this.emit(e)
    }
  }

  // The origin is Claude's: Codex has no such stamp. `id` goes to `turn/start` as the message's client id, which the turn it starts names (#1604)
  sendTracked(text: string, observer?: InputObserver, opts?: { origin?: InputOrigin; id?: string }): Promise<void> {
    return this.ledger.sendTracked(text, observer, opts?.id)
  }

  /**
   * Says which inputs a turn Codex started began from (#1604): a second `working` for the turn, which the host reads with
   * `turnStartInputs` as it handles it. Codex starts a turn for a `turn/start` sent after the turn it was meant for ended, or
   * queued behind a compact or a review (`MidTurnLedger`), and the message it began from is what tells a hub whose that turn is
   */
  private announceStart(inputs: readonly string[]): void {
    this.startInputs = inputs
    try {
      this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
    } finally {
      this.startInputs = null
    }
  }

  turnStartInputs(): readonly string[] | null {
    return this.startInputs
  }

  send(text: string): void {
    this.ledger.send(text)
  }

  /**
   * A note steered into the regular turn that is running, starting nothing (#1492). `turn/start` would do it only while a turn is
   * running: with none, it starts a turn of its own (Codex sends a request's token count just before `turn/completed`, so a note for
   * the last request of a turn went out after the turn had ended and ran as a turn nobody asked for, #1504 review), and behind a
   * compact or review turn it queues the note and runs it as a turn. `turn/steer` names the turn it is for (`expectedTurnId`) and
   * is refused by Codex when that turn is not the one running, so a note for a turn that has ended starts nothing. The answer says
   * whether it was taken: a refused note is not told, and waits for a later request of a running turn (`ContextNudges`).
   */
  nudge(text: string): boolean | Promise<boolean> {
    const turnId = this.ledger.steerable()
    if (!this.threadId || turnId === null) return false
    return this.client.request('turn/steer', { threadId: this.threadId, input: [{ type: 'text', text }], expectedTurnId: turnId }).then(
      () => true,
      () => false,
    )
  }

  /**
   * Writes what the ledger sends: a slash command as its own request (`CodexSlashCommands`), anything else as one `turn/start`,
   * each message its own input item. Messages that waited behind a compact or review go as they are, so a slash command among
   * them is read as text (a `/compact` during a compact means nothing anyway)
   */
  private write(inputs: readonly MidTurnInput[], queued: boolean): { answer: Promise<unknown>; blocking?: boolean } {
    if (!this.threadId) return { answer: Promise.reject(new Error('Thread is not ready')) }
    const [first] = inputs
    const command = queued || !first ? null : this.slashCommands.run(first.text)
    if (command?.blocks) {
      this.compactTurn = command.blocks === 'compact'
      const answer = command.request.catch((err: unknown) => {
        this.compactTurn = false
        throw err
      })
      return { answer, blocking: true }
    }
    if (command) return { answer: command.request }
    const clientId = inputs.find((i) => i.receipt)?.receipt?.id
    if (clientId) this.inputGroups.set(clientId, [...inputs])
    const answer = this.client
      .request('turn/start', {
        threadId: this.threadId,
        ...(clientId ? { clientUserMessageId: clientId } : {}),
        input: inputs.map(({ text }) => ({ type: 'text', text })),
        ...this.turnSettings(),
        ...this.outputSchemaParam(),
      })
      // The turn also rides on the response, which can come before its notification (the target of a Stop)
      .then((res) => {
        if (this.ledger.taken(inputs, turnIdOf(res))) this.threadWritten()
      })
      .catch((err: unknown) => {
        if (clientId) this.inputGroups.delete(clientId)
        throw err
      })
    return { answer }
  }

  /**
   * The model and effort a turn is started with (#1369). Both are passed per turn: `TurnStartParams.model` and
   * `.effort` are documented as applying to "this turn and subsequent turns" (codex-cli 0.160.0), so what Centralu
   * shows is what the thread runs even when its stored model is another (a thread imported from elsewhere, one whose
   * model was retired) and changes without restarting the session. None recorded: the thread's own runs.
   */
  private turnSettings(): { model?: string; effort?: string } {
    const { model, effort } = this.shown ?? { model: this.opts.model ?? null, effort: this.opts.effort ?? null }
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }
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

  interrupt(): void {
    this.ledger.interrupt()
  }

  /** What a Stop releases besides the turns (`MidTurnLedger.interrupt`) */
  private releaseCards(): void {
    /*
     * Stops app calls made by this session (M4 A-5) — **even without a turn.** A call that had
     * already returned early past 240 seconds keeps running even after the turn ends. Work from a
     * session the person pressed stop on must not keep running in the background. The bridge does
     * not make this decision, so it is cut off here, at the host. The cancellation is carried by
     * the runtime down through the app and whatever it started.
     */
    this.opts.apps?.cancelAll()
    /*
     * Answers this thread's open approvals with a refusal before the interrupt, the way the Claude adapter does. The
     * interrupt ends them on Codex's side too, but only if it lands: answering them here closes the cards either way,
     * and a refusal sent to a request the interrupt already ended is ignored. A child's request stays open, because
     * stopping this turn does not stop the child (see `stopBackgroundTask`).
     */
    for (const requestId of this.serverRequests.approvals.ids((a) => a.threadId === null || a.threadId === this.threadId)) {
      this.respondApproval(requestId, 'deny')
    }
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

  /** The watchdog for a background resume (lazy resume only, see `watchBackgroundResume`) */
  watchBackgroundStart(): void {
    watchBackgroundResume({
      sessionId: this.sessionId,
      emit: (e) => this.emit(e),
      closed: () => this.ledger.closed,
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
    const unsent = this.ledger.takeQueued()
    return unsent > 0 ? ` — ${undeliveredText(unsent, 'were sent while it was opening')}` : ''
  }

  /** Does not silently drop a pending approval (same reason as the claude adapter — the screen would be stuck holding the card) */
  dispose(): Promise<void> {
    return this.ledger.dispose()
  }

  private async close(): Promise<void> {
    // App attachment closes together with the handle — a new handle gets its own
    this.opts.apps?.close()
    this.serverRequests.closeApprovals()
    await this.client.dispose()
  }

  /**
   * Lets go of the app-server without closing it (#280 step 2). No deny for a waiting approval —
   * the next host's `thread/resume` gets it re-sent under the same id — and no EOF, which would make
   * codex exit. The bridge processes codex started for this thread stay with codex.
   */
  detach(): Promise<void> {
    // The next host resumes the thread, but not the messages this one held behind a resume still waking (#428)
    return this.ledger.detach()
  }
}

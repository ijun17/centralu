import { InputReceipts, type InputReceipt } from '../input-receipts.js'
import type { InputObserver } from '../contract.js'
import { codexToolInstructionsFor } from '../../sessions/orchestrator-tools.js'
import { CLIENT_INFO, parseCliVersion } from '@cc/protocol'
import type { ApprovalDecision, ApprovalScope } from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import { INTERRUPTED_BY_TOOL, type CreateSessionOpts, type EventSink, type SessionHandle } from '../contract.js'
import { CodexClient } from './client.js'
import { imageEventFromDisk } from '../images.js'
import { CODEX_KNOWN_NOTIFICATIONS, CompactionMarks, CodexRequestInputs, goalFromCodex, launchedThreads, normalizeNotification, threadSettingsChanged, threadSettingsOf, type CodexThreadSettings } from './normalize.js'
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
import { permissionOptionsFor, repoFilesConfig, spawnInKeeper } from './launch-config.js'
import { rpcError } from '../../rpc-error.js'

/** How long we let a resume wait in front of the person — a lock error ("active writer") arrives within this window (measured ~0.3s) */
export const LAZY_RESUME_WAIT_MS = 3_000
/** The ceiling for a background resume — the same value as the manager's step limit (150s). Past this, it is considered stuck */
const BACKGROUND_RESUME_CAP_MS = 150_000

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
  /**
   * The id of the turn currently running — **needed in order to stop it** (dogfooding
   * 2026-09-07: stop did not work).
   *
   * `turn/interrupt` does not work with only a threadId. Measured behavior: the server rejects
   * it with `Invalid request: missing field \`turnId\``(-32600), and we were only piping that
   * rejection into an error event — the screen looked stopped but the turn ran to completion.
   * So we capture this **from both** the turn/started notification and the turn/start response:
   * if stop is pressed very quickly, the response can arrive before the notification.
   */
  private turnId: string | null = null
  /**
   * Turns already reported ended (`turn/completed`/`turn/failed`), the latest few. The `turn/start` response can
   * arrive after its own turn's `turn/completed`; taking the id from that late response would bring a finished
   * turn back as the target of Stop, and the next Stop would send `turn/interrupt` for a dead turn and say
   * "Could not stop". Bounded: only a response still in flight can name one of these.
   */
  private endedTurns: string[] = []
  /**
   * Turns we asked Codex to interrupt (#698), the latest few: a Stop, a delegation withdrawn, a parent's note cancelled.
   * A `turn/completed` with `interrupted` for any other turn was not asked for here, and says so (`INTERRUPTED_BY_TOOL`).
   */
  private interruptsSent: string[] = []
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
  /**
   * The count of messages sent, and the count reclaimed by a Stop pressed before the thread was
   * up (#168).
   *
   * Before resume finishes there is no turn to stop (there is no threadId or turnId yet). The old
   * Stop did nothing in that window, and a message queued up behind ready went out as turn/start
   * once resume finished — the turn started after the person had already stopped it. Now that
   * Stop reclaims whatever was sent up to that point. Anything sent after that still goes through.
   */
  private sendsIssued = 0
  private sendsStopped = 0
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
    try {
      const init = await this.client.request<{ userAgent?: unknown }>('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: null,
      })
      this.client.notify('initialized')
      /*
       * The app-server's version, for moving the session to a newer install (#297). Codex reports it only here, in
       * `userAgent`: `<our client name>/<server version> (<os>) …` (measured, codex-cli 0.160.0, 2026-10-05:
       * "centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)"). An adopted app-server is not
       * initialized again; its version comes from the keeper's tag instead (manager.adoptKept).
       */
      const ua = typeof init?.userAgent === 'string' ? init.userAgent : ''
      const version = parseCliVersion(ua.slice(ua.indexOf('/') + 1))
      if (version) this.emit({ type: 'agent_version', sessionId: this.sessionId, version })
    } catch (err) {
      /*
       * An app-server adopted from a previous host (#280 step 2) is the same stdio connection, already
       * initialized. Measured (codex-cli 0.160.0, gpt-5.6-luna, 2026-10-04): the second `initialize`
       * is rejected with -32600 "Already initialized" and nothing else changes; `thread/resume` then
       * answers with the running turn and re-sends a pending approval under the same request id.
       */
      if (!adopted || !/already initialized/i.test((err as Error).message)) throw err
    }

    const workspaceConfig = await sandboxConfig(this.opts.cwd, this.opts.permissionPreset, () => this.threadServers.personsConfig())
    if (this.opts.resumeExternalId) {
      // Resume (FR-10). If it fails, the session manager guides the person through the fallback
      let res: Record<string, unknown>
      try {
        res = await this.client.request<Record<string, unknown>>('thread/resume', {
          threadId: this.opts.resumeExternalId,
          ...permissionOptionsFor(this.opts.permissionPreset),
          /*
           * Metadata only, not the whole history (#342). Nothing here reads the history the resume used to return
           * except the running turn's id, and that has its own one-turn query below. Measured (codex-cli 0.160.0,
           * gpt-5.6-luna, a five-turn scratch thread, 2026-10-05): 1,206 KB / 761 ms and a `deprecationNotice`
           * ("Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`…") that #304 put
           * in the conversation, against 1.9 KB / 351 ms and no notice. One long thread's answer was 23 MB
           * (client.ts). A Codex that predates the flag ignores it and answers with the turns, as before.
           */
          excludeTurns: true,
          /*
           * Verbosity has to be carried through on resume too (#54). turn/start has no place for
           * it (unlike effort), so these two spots where the thread is started are the only
           * place — leaving it out here becomes the quiet kind of loss where settings reset every
           * time the session wakes back up.
           *
           * Reasoning summary is the same case (measured for #58): unless this switch is turned
           * on, the item/reasoning/* stream **never arrives, not once** — the kind of feature
           * where wiring it up without flipping the switch does nothing at all.
           */
          config: {
            model_reasoning_summary: 'auto',
            ...(this.opts.verbosity ? { model_verbosity: this.opts.verbosity } : {}),
            ...(this.opts.serviceTier ? { service_tier: this.opts.serviceTier } : {}),
            /*
             * MCP servers are loaded **on resume too** (M4 A-5, plan "to confirm separately" 1).
             *
             * The old resume sent no servers at all — if the initial settings do not survive on
             * the thread, a Codex orchestrator that wakes back up loses the centralu tools.
             * Whether they actually survive can only be known by running it (S-7), and we could
             * not re-check because Codex was logged out. So we load them again without waiting
             * for that confirmation: resume's `config` is a settings override (generated type
             * ThreadResumeParams — "Configuration overrides for the resumed thread"), so the same
             * name lands in the same slot, and overwriting it loses nothing if it had survived.
             * For apps, resume is effectively "starting the next thread" — an app attached while
             * the thread was running gets attached here.
             */
            ...(await this.threadServers.mcpConfig()),
            // Files in the repository only reach this thread in a trusted project — resume follows the same rule (#92)
            ...repoFilesConfig(this.opts),
            ...workspaceConfig,
          },
        })
      } catch (err) {
        /*
         * The raw message ("already has an active writer") explains nothing to the user.
         *
         * And **a sentence meant for a human is not enough on its own** — if the layer above has
         * to re-parse that sentence with a regular expression, that is not a contract. We surface
         * a machine-readable code alongside it: the UI needs this code to be able to offer
         * "split off and continue" (codex's thread/fork works fine even on a locked thread —
         * confirmed by measurement).
         */
        const msg = (err as Error).message
        if (/active writer/i.test(msg)) {
          /*
           * Measurement (#57) narrowed down what this error actually means: the lock is a flock,
           * not a file's mere existence, so a file left behind by a dead process **cannot**
           * produce this error. Landing here means a live process is holding the flock at this
           * exact moment — codex running in a terminal, another app, or an orphan that survived
           * without being cleaned up, having inherited only the fd.
           */
          throw rpcError('This conversation is already open elsewhere (codex in a terminal, another app, or a process left behind by an unclean shutdown)', 'conversation_locked')
        }
        throw err
      }
      this.threadId = threadIdOf(res) ?? this.opts.resumeExternalId
      this.threadSettings = threadSettingsOf(res)
      this.threadServers.checkAppMode(res)
      this.readNetworkAccess(res)
      // An adopted thread may be mid-turn: Stop needs that turn's id (#313)
      if (adopted) this.takeStartedTurn(runningTurnOf(res) ?? (await this.latestRunningTurn(res)))
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
      const res = await this.client.request<Record<string, unknown>>('thread/start', {
        cwd: this.opts.cwd,
        ...permissionOptionsFor(this.opts.permissionPreset),
        model: this.opts.model,
        /*
         * The following two are attached only for the orchestrator.
         *
         * The role is given directly through developerInstructions — the same slot as Claude's
         * systemPrompt append. The reason we avoid a file (AGENTS.md) is the same: if a
         * lower-privilege session could edit that file, it would become able to instruct every
         * session. The instructions of the Centralu tools ride there too (#525, developerInstructions()).
         *
         * Tools are attached through the stdio bridge. What we confirmed by measurement:
         *   per-thread config.mcp_servers  works (our command actually runs)
         *   the url (HTTP) approach        does not — not a single request ever arrives
         * So one extra process ends up running — a cost that does not exist on the Claude path.
         */
        ...this.developerInstructions(),
        /*
         * config is **assembled in this one place only.** There used to be a trap where the
         * verbosity spread and the orchestrator spread each built their own config keys, and one
         * would silently overwrite the other entirely — once there were three contributors
         * (summary, verbosity, orchestrator), it became cheaper to remove the trap than to keep
         * remembering it.
         */
        config: {
          // The reasoning-summary switch (measured for #58): without it, the item/reasoning/* stream never arrives
          model_reasoning_summary: 'auto',
          ...(this.opts.verbosity ? { model_verbosity: this.opts.verbosity } : {}),
          // Response speed (measured: priority = "Fast, 1.5x speed, increased usage")
          ...(this.opts.serviceTier ? { service_tier: this.opts.serviceTier } : {}),
          // MCP servers — the orchestrator's bridge and any attached external app's bridge (including approved MCP servers) (see mcpConfig)
          ...(await this.threadServers.mcpConfig()),
          // Files in the repository (.codex/ settings, hooks, rules, AGENTS.md) only in a trusted project (#92, repoFilesConfig)
          ...repoFilesConfig(this.opts),
          ...workspaceConfig,
        },
      })
      this.threadId = threadIdOf(res)
      this.threadSettings = threadSettingsOf(res)
      this.threadServers.checkAppMode(res)
      this.readNetworkAccess(res)
      // No rollout yet: the thread is named at its first turn (see externalId)
      return
    }
    this.externalId = this.threadId
  }

  private networkAccess: boolean | undefined

  private readNetworkAccess(res: Record<string, unknown>): void {
    const sandbox = res.sandbox as { type?: string; networkAccess?: boolean | string } | undefined
    this.networkAccess = sandbox?.type === 'dangerFullAccess' || sandbox?.networkAccess === 'enabled'
      ? true
      : typeof sandbox?.networkAccess === 'boolean' ? sandbox.networkAccess : undefined
  }

  delegationNotice(): string | undefined {
    return this.networkAccess === false
      ? `this child cannot reach the network under ${this.opts.permissionPreset}`
      : undefined
  }

  /**
   * The thread's developer instructions: the session's role, then the instructions of the Centralu tools it gets
   * (#525), which Claude receives from the in-process server and Codex would never show from the bridge's
   * `initialize` (measured: sessions/orchestrator-tools.ts, codexToolInstructionsFor). Sent at thread/start only.
   * `thread/resume` takes the same field and ignores it: resumed with other developer instructions, the model still
   * named the phrase from the first ones and the rollout gained no developer message (codex-cli 0.160.0,
   * `scripts/probe-codex-mcp-instructions.mts`, 2026-10-12). So a thread keeps what it was started with; a session
   * that changes profile while its thread lives on (a session the person turns the reader set off for, or back on)
   * keeps its tools' new rules from the tool descriptions alone until it starts a new thread.
   */
  private developerInstructions(): { developerInstructions?: string } {
    const tools = this.opts.orchestratorTools && this.opts.orchestratorBridge ? codexToolInstructionsFor(this.opts.toolProfile ?? 'orchestrator') : undefined
    const text = [this.opts.systemPromptAppend, tools].filter(Boolean).join('\n\n')
    return text ? { developerInstructions: text } : {}
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
      this.turnId = turnIdOf(n.params)
      // Before the event below goes out: the manager records a handle's external id as its events arrive
      this.threadWritten()
    }
    if (n.method === 'turn/completed' || n.method === 'turn/failed') {
      this.turnId = null
      const ended = turnIdOf(n.params)
      if (ended) this.endedTurns = [...this.endedTurns.slice(-(ENDED_TURNS_KEPT - 1)), ended]
    }

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
        const ours = !!turn && this.interruptsSent.includes(turn)
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
    this.childThreads.noteSpawn(n)
    this.childThreads.noteTurnEnd(n)
  }

  sendTracked(text: string, observer?: InputObserver): Promise<void> {
    const receipt = this.inputReceipts.create(observer)
    this.sendInput(text, receipt)
    return receipt.done
  }

  send(text: string): void { this.sendInput(text) }

  private sendInput(text: string, receipt?: InputReceipt): void {
    const nth = ++this.sendsIssued
    void this.ready
      .then(() => {
        // A Stop pressed before the thread was up already reclaimed this message (sendsStopped) — do not send it
        if (nth <= this.sendsStopped || receipt?.cancelled) return
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
    if (receipts.some((r) => r.cancelled) && !this.endedTurns.includes(id)) {
      // Ours: the person's Stop, so its ending is not Codex's own interrupt (#698)
      this.noteInterruptSent(id)
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
    if (id && !this.endedTurns.includes(id)) this.turnId ??= id
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

  /** Slash commands (skills) — the app-server's official RPC */
  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    const res = await this.client.request<{ data?: unknown }>('skills/list', {})
    const groups = Array.isArray(res?.data) ? res.data : []
    /*
     * compact is a built-in command, not a skill, so it does not appear in skills/list — but
     * autocomplete is drawn from this list, so leaving it out makes it a command that **exists but
     * is invisible** (hiding something that exists is also a lie the list tells). If codex ever
     * starts including it in the list, the dedupe below removes our own entry.
     */
    const out: { name: string; description?: string; argumentHint?: string }[] = [
      { name: 'compact', description: 'Summarizes the conversation to shrink context (built into codex)' },
      {
        name: 'review',
        description: 'Reviews the changed code (built into codex). If given an argument, reviews following that instruction instead',
        argumentHint: '[instruction]',
      },
    ]
    for (const g of groups) {
      const skills = (g as { skills?: unknown }).skills
      if (!Array.isArray(skills)) continue
      for (const s of skills) {
        const skill = (s ?? {}) as { name?: unknown; description?: unknown; enabled?: unknown }
        if (typeof skill.name !== 'string' || skill.enabled === false) continue
        if (out.some((c) => c.name === skill.name)) continue
        out.push({
          name: skill.name,
          description: typeof skill.description === 'string' ? skill.description : '',
        })
      }
    }
    return out
  }

  interrupt(reason = new Error('The parent note was stopped before it finished')): void {
    const turns = this.inputReceipts.failAll(reason)
    this.pendingInputs = this.pendingInputs.filter((p) => !p.receipt)
    for (const turnId of turns) {
      if (!this.threadId || turnId === this.turnId || this.endedTurns.includes(turnId)) continue
      this.noteInterruptSent(turnId)
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
     * and go back to waiting for input (#168, sendsStopped). No turn/completed(interrupted) will
     * arrive either, since no turn was ever started — the state is flipped here instead.
     */
    if (!this.threadId && this.sendsIssued > this.sendsStopped) {
      this.sendsStopped = this.sendsIssued
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
    if (!this.threadId || !this.turnId) return
    this.noteInterruptSent(this.turnId)
    // Swallowing a failure here would leave us assuming it stopped and waiting — if it did not stop, say so
    void this.client
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch((err: Error) => this.emit(couldNotStop(this.sessionId, err)))
  }

  private noteInterruptSent(turnId: string): void {
    if (!this.interruptsSent.includes(turnId)) this.interruptsSent = [...this.interruptsSent.slice(-(ENDED_TURNS_KEPT - 1)), turnId]
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

  /**
   * The watchdog for a background resume (lazy resume only). If resume fails or exceeds the
   * ceiling after the handle has already been handed out, we cannot just go quietly to sleep — we
   * raise adapter_crashed so the manager retires the handle and the "resend if missing" automatic
   * recovery path can kick in.
   */
  watchBackgroundStart(): void {
    const timer = setTimeout(() => {
      if (this.closed) return
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'adapter_crashed',
          message: `Resuming codex did not finish within ${BACKGROUND_RESUME_CAP_MS / 1000}s${this.unsentNote()}`,
          retryable: true,
        },
      })
      void this.dispose().catch(() => {})
    }, BACKGROUND_RESUME_CAP_MS)
    this.ready.then(
      () => clearTimeout(timer),
      (e: Error & { code?: string }) => {
        clearTimeout(timer)
        if (this.closed) return
        /*
         * A lock error keeps its code (#168, item 5). Arriving here instead of inside the 3-second
         * window used to turn it into adapter_crashed, so the screen could not offer "continue in
         * a fork". Measured on 0.153.4: a second app-server resuming a held thread is refused with
         * -32600 "thread <id> already has an active writer" in 35 ms to 1.3 s, so this is rare,
         * but a slow start can push it past the window.
         *
         * Messages sent meanwhile were never delivered (send stays quiet about them, so the
         * failure is said once): the person is told, since the screen shows them as sent.
         */
        const note = this.unsentNote()
        const locked = e.code === 'conversation_locked'
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: locked ? 'conversation_locked' : 'adapter_crashed', message: e.message + note, retryable: true },
        })
        void this.dispose().catch(() => {})
      },
    )
  }

  /**
   * The messages sent while the thread was opening, as a note for the error that ends the handle, and marked stopped
   * so dispose (which follows) does not say them again and a start that still lands does not send them. Inside that
   * one error rather than after it: once the manager retires the handle, a later event from it may not be heard.
   */
  private unsentNote(): string {
    const unsent = this.sendsIssued - this.sendsStopped
    this.sendsStopped = this.sendsIssued
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
    const unsent = this.sendsIssued - this.sendsStopped
    this.sendsStopped = this.sendsIssued
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
   * The turn an adopted thread is still running, asked for on its own (#342): a resume with `excludeTurns` answers
   * with no turns. Measured (codex-cli 0.160.0, 2026-10-05), a second `thread/resume` on the same connection while a
   * turn ran said `status: {type: 'active'}` and `turns: []`; `thread/turns/list` with `limit: 1`, newest first and
   * `itemsView: 'notLoaded'` named that turn as `inProgress` in 0.5 KB. Asked only for an active thread. A Codex
   * without the method answers with the turns in the resume itself, which `runningTurnOf` read first.
   */
  private async latestRunningTurn(res: Record<string, unknown>): Promise<string | null> {
    const status = (res.thread as { status?: { type?: unknown } } | undefined)?.status
    if (status?.type !== 'active' || !this.threadId) return null
    try {
      const page = await this.client.request<{ data?: unknown }>('thread/turns/list', {
        threadId: this.threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      })
      return runningTurnOf({ thread: { turns: page?.data } })
    } catch (err) {
      console.error(`[codex] ${this.sessionId.slice(0, 8)} could not ask for the running turn: ${(err as Error).message}`)
      return null
    }
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

/** How many ended turns `endedTurns` keeps: more than can have a `turn/start` response still in flight */
const ENDED_TURNS_KEPT = 8

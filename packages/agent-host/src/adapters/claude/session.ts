import { query, type SettingSource } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { InputReceipts, type InputReceipt } from '../input-receipts.js'
import type { InputObserver } from '../contract.js'
import type { ApprovalDecision, ApprovalScope, QuestionAnswer } from '@cc/protocol'
import { ClaudeLinks } from './exe-link.js'
import { StartGate } from './start-gate.js'
import type { UsageQuery } from './usage.js'
import type { AgentProcess, AgentSpawnSpec, CreateSessionOpts, EventSink, SessionHandle } from '../contract.js'
import { spawnLocalAgent } from '../local-process.js'
import { withStderrTail } from '../../stream-text.js'
import { ClaudeStreamNormalizer } from './normalize.js'
import { noCodeIntelligenceSettings } from './lsp-plugins.js'
import { adapterNotice, couldNotStop, undeliveredError } from '../session-kit.js'
import { ClaudeCards } from './session-cards.js'
import { ClaudeServers } from './session-servers.js'
import { appToolOf, isOrchestratorTool, permissionOptionsFor, settingSourcesFor } from './permissions.js'
import { liveQueries, probeIds, querySessions } from './live-queries.js'
import { claudeQueryOptions, type ClaudeInput, type QueryHandle } from './sdk-query.js'
import { ClaudeRaceRetry, type RaceMsg } from './refresh-race.js'
import { tracksInputs } from './tracked-input.js'
import { ClaudeScheduleLook } from './schedule-look.js'
import { keepAttachedAppMarks } from '../tool-titles.js'

/** `/goal`, alone or with an argument — not a message that merely starts with those letters ("/goal's syntax?"). */
function isGoalCommand(text: string): boolean {
  return /^\/goal(\s|$)/.test(text.trim())
}

/** A message as the stream loop reads it */
type StreamMsg = { type?: string; session_id?: string; subtype?: string; slash_commands?: unknown; claude_code_version?: unknown; capabilities?: unknown; user_message_uuid?: string; parent_tool_use_id?: string | null }

/**
 * How this adapter starts Claude processes, shared by every session it creates (#353): where the
 * program runs from, the spacing between starts, and the processes still closing.
 */
export type ClaudeLaunch = {
  /** Claude Code is started the Windows way (`windowsStart`) */
  windows: boolean
  /** The `claude` found on PATH, as the SDK takes it */
  executable: () => string | null
  links: ClaudeLinks
  gate: StartGate
  /** How long to wait before resending a turn that lost the sign-in refresh race */
  retryDelay: () => number
  /** Disposed sessions whose process has not ended yet: what `settle` waits for */
  closing: Set<Promise<void>>
  exitGraceMs: number
}

export class ClaudeSession implements SessionHandle {
  externalId: string | null = null
  private queue: ClaudeInput[] = []
  private inputReceipts = new InputReceipts()
  /** Person messages already handed to the SDK, so an interrupt receipt can report cancellations. */
  private personInputs = new Set<string>()
  private trackedInputKnown = false
  /** Installed only after the initial CLI metadata confirms the protocol we have verified. */
  sendTracked?: (text: string, observer?: InputObserver) => Promise<void>
  /** The CLI version this process last reported (#297) */
  private reportedVersion: string | null = null
  private notify: (() => void) | null = null
  private closed = false
  /** The turn for a message we sent has not been closed by a result yet — decides whether to flag it as interrupted (see interrupt). */
  private turnOpen = false
  /** The live query — the channel for asking about slash commands and context. */
  private query: QueryHandle | null = null
  private readonly stream: ClaudeStreamNormalizer
  /** The approval and question cards (see `ClaudeCards`) */
  private readonly cards: ClaudeCards
  /** The orchestrator's server and the attached apps' proxies (see `ClaudeServers`) */
  private readonly servers: ClaudeServers
  private stopAppWatch: (() => void) | null = null
  /**
   * Whether this session's CLI offers `/goal` — undefined until it has said (see `send`). Decided by
   * what the CLI advertises, never by a version number: `supportedCommands()` (answered at
   * initialization, before any message) and the init message's `slash_commands`.
   */
  private goalCommand: boolean | undefined
  /** Settles once `goalCommand` is as known as it will get — the command list answered, failed, or the stream ended. */
  private goalKnown: Promise<void> = Promise.resolve()
  private settleGoalKnown: () => void = () => {}
  /** Messages held behind a `/goal` that is waiting for `goalKnown` — so nothing sent after it overtakes it. */
  private sendGate: Promise<void> | null = null
  /** The CLI's process when it came from a `ProcessSource` (the keeper, #280 step 2) */
  private proc: AgentProcess | null = null
  private adopted = false
  /** Letting go of the process for the next host: its stream ending is not a crash */
  private detaching = false
  /** A turn that lost the sign-in refresh race goes again once (see `ClaudeRaceRetry`, #353) */
  private readonly raceRetry: ClaudeRaceRetry
  /** The CLI's timers, looked at again when due (see `ClaudeScheduleLook`, #568) */
  private readonly schedules: ClaudeScheduleLook
  /** The link folder this session's process runs from, released when the process is gone */
  private runKey: string | null = null
  /** Settles once the stream ended: the CLI process is gone, or this host let go of it */
  readonly ended: Promise<void>
  /** The query this session reads usage from (a usage probe asks its own, #726) */
  get usageQuery(): UsageQuery | null {
    return this.query
  }
  private markEnded: () => void = () => {}

  constructor(
    readonly sessionId: string,
    private opts: CreateSessionOpts,
    private emit: EventSink,
    private launch: ClaudeLaunch,
  ) {
    this.ended = new Promise<void>((resolve) => (this.markEnded = resolve))
    // An app's mark only for an app attached here (#730 review): a repository's own server may be named `app-<x>`
    const sink = emit
    this.emit = (e) => sink(keepAttachedAppMarks(e, () => (opts.apps?.current() ?? []).map((a) => a.server)))
    this.servers = new ClaudeServers({
      sessionId,
      opts,
      closed: () => this.closed,
      query: () => this.query,
      warn: (text) => this.emit({ type: 'notice', sessionId, level: 'warning', from: 'Centralu', label: 'apps', text }),
    })
    this.cards = new ClaudeCards({ sessionId, opts, emit: (e) => this.emit(e), ownServer: () => this.servers.orchestratorServer !== null })
    // The process runs with these until it is replaced; a model switch the CLI makes is reported against them (#304)
    this.stream = new ClaudeStreamNormalizer(sessionId, () => ({
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      verbosity: opts.verbosity ?? null,
      serviceTier: opts.serviceTier ?? null,
    }))
    this.stream.goal.seed(opts.knownGoal)
    this.raceRetry = new ClaudeRaceRetry({
      sessionId,
      emit: (e) => this.emit(e),
      closed: () => this.closed,
      retryDelay: () => this.launch.retryDelay(),
      resend: (sent) => {
        this.queue.push(...sent)
        this.turnOpen = true
        this.notify?.()
        this.notify = null
      },
    })
    this.schedules = new ClaudeScheduleLook({ sessionId, emit: (e) => this.emit(e), closed: () => this.closed, tasks: this.stream.tasks })
    // An adopted CLI announces its id only with its next turn's init; it is the conversation we resume
    if (opts.processSource?.adopt) this.externalId = opts.resumeExternalId ?? null
    if (opts.processSource?.adopt && opts.resumeExternalId) void this.schedules.recover(opts.resumeExternalId, opts.cwd)
    // The background work the previous host saw in this process (#648): the CLI will not list it again by itself
    if (opts.processSource?.adopt?.backgroundTasks?.length) this.stream.tasks.seed(opts.processSource.adopt.backgroundTasks)
  }

  async start(): Promise<void> {
    const preset = this.opts.permissionPreset

    /*
     * What to start (#353). On Windows a hard link of npm's claude.exe in the data folder, so a Claude
     * Code update can replace npm's file while this session runs; npm's placeholder is refused here
     * with the fix, instead of a spawn error Windows words as "16-bit program". Elsewhere the path
     * found on PATH, as before.
     */
    const exe = this.launch.executable()
    const run = exe ? this.launch.links.prepare(exe) : null

    this.servers.load()
    const servers = this.servers.mcpServers()
    const permissionOptions = await permissionOptionsFor(this.opts)
    // Code intelligence off for this session alone (#686): its language-server plugins disabled in the flag layer
    const codeIntelligence = this.opts.noCodeIntelligence
      ? { settings: await noCodeIntelligenceSettings(this.opts.cwd, settingSourcesFor(this.opts) as { settingSources?: SettingSource[] }) }
      : {}

    /*
     * Spaced out on Windows, so processes started together (the orchestrator waking its sessions, a
     * grid) do not all refresh an expired sign-in at once (#353). An adopted process is already running.
     */
    if (!this.opts.processSource?.adopt) await this.launch.gate.turn()
    this.runKey = run?.key ?? null
    this.launch.links.acquire(this.runKey)

    // Usage is a property of the account, but the SDK only exposes the method on a Query — this borrows a live query for it (liveQueries).
    const q: QueryHandle = (this.query = query({
      prompt: this.input(),
      options: claudeQueryOptions({
        sessionId: this.sessionId,
        opts: this.opts,
        executablePath: run?.path ?? undefined,
        servers,
        permissionOptions,
        codeIntelligence,
        spawn: (o) => (this.opts.processSource ? this.spawnProcess(o) : (this.proc = spawnLocalAgent(o))),
        canUseTool: (toolName, toolInput, options) => this.cards.canUseTool(preset, toolName, toolInput, options),
      }),
    }))
    // A usage probe (#726) is not a session anyone else may borrow: a model list asked meanwhile would use a query about to close
    if (!probeIds.has(this.sessionId)) liveQueries.add(q)
    querySessions.set(q, this.sessionId)
    this.releaseLostCalls(q)

    this.goalKnown = new Promise<void>((resolve) => (this.settleGoalKnown = resolve))
    q.supportedCommands()
      .then((list) => {
        if (this.goalCommand === undefined && Array.isArray(list)) this.goalCommand = list.some((c) => c?.name === 'goal')
      })
      .catch(() => {})
      .finally(() => this.settleGoalKnown())

    // Follows the server set when apps come and go, and that server's list when its tools change — never restarting the session.
    this.stopAppWatch = this.opts.apps?.onChange(() => this.servers.syncApps()) ?? null

    void this.read(q)
  }

  /** What the CLI reads: each message queued for it, in order, until the session closes */
  private async *input() {
    while (!this.closed) {
      const next = this.queue.shift()
      if (next !== undefined) {
        this.raceRetry.read(next)
        if (!next.parentNote) this.personInputs.add(next.uuid)
        yield {
          type: 'user' as const,
          parent_tool_use_id: null,
          session_id: this.externalId ?? '',
          uuid: next.uuid,
          message: { role: 'user' as const, content: [{ type: 'text' as const, text: next.text }] },
        }
        continue
      }
      await new Promise<void>((r) => (this.notify = r))
    }
  }

  /** Reads the CLI's stream until it ends, and says how it ended */
  private async read(q: QueryHandle): Promise<void> {
    try {
      /*
       * The normalizer remembers what a single message cannot decide on its own — whether the
       * body already went out as deltas, or a background agent that is still running. See
       * `ClaudeStreamNormalizer`. A local synthetic response like /usage produces zero deltas
       * (measured), and without that memory there would be no way to decide whether to emit the
       * whole-response body — emitting it always gets it appended twice on an ordinary turn,
       * and never emitting it means it never shows up at all.
       */
      for await (const msg of q) {
        /*
         * **Nothing arriving after close is accepted** (#157). Even after dispose terminates
         * the process, a few already-buffered messages can still come through — the tail text
         * and result of a turn that was wrapping up. A new process may already be sitting in
         * that session's slot, so the end of the old turn must never land in the new process's
         * own record.
         */
        if (this.closed) break
        this.onMessage(q, msg)
      }
      /*
       * **If the stream ended and we did not close it, the CLI died.**
       *
       * When the CLI process disappears silently, the stream can sometimes just end with no
       * exception at all. If nothing is emitted at that point, the UI stays "working" forever
       * and the next message goes nowhere — this raises the same signal the codex adapter raises
       * from `onExit(expected=false)`.
       */
      liveQueries.delete(q)
      this.settleGoalKnown()
      // A stream that ends because this host let go of the process is not a death (#280 step 2)
      if (!this.closed && !this.detaching) {
        this.releaseAgents('The session process ended before this agent reported back')
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'adapter_crashed', message: 'claude process ended unexpectedly', retryable: true },
        })
      }
    } catch (err) {
      liveQueries.delete(q)
      this.settleGoalKnown()
      /*
       * **An exception from a process we ourselves closed is not a crash** (#157). Same rule as
       * the clean-exit branch above. If settings change after a stopped turn (the last result
       * was `error_during_execution`), the old CLI ends still carrying an error result, and the
       * SDK turns that into a thrown exception, "Claude Code returned an error result: …". This
       * used to surface as adapter_crashed, and the manager would treat the brand-new process it
       * had just started as dead and close it.
       */
      if (this.closed || this.detaching) return
      this.releaseAgents('The session process ended before this agent reported back')
      /*
       * The SDK adds the end of the CLI's stderr to a failure only for a process it spawned itself. One
       * spawned here (`local-process.ts`) or in the keeper (`keeper/agent-process.ts`) keeps that tail, and it is
       * added the same way, so a CLI that fails to start still says why.
       */
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: { code: 'adapter_crashed', message: withStderrTail((err as Error).message, this.proc), retryable: true },
      })
    } finally {
      // The process is gone (or another host holds it now): its link may go once nothing else runs from it
      this.launch.links.release(this.runKey)
      this.runKey = null
      this.markEnded()
    }
  }

  /** One message of the stream, in the order the CLI sent it */
  private onMessage(q: QueryHandle, msg: unknown): void {
    const m = msg as StreamMsg
    if (!this.turnOpen && m.user_message_uuid && !m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'stream_event')) {
      this.turnOpen = true
      if (!this.cards.pending.size && !this.cards.questions.size) this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
    }
    if (m.type === 'system' && m.subtype === 'init') this.onInit(m)
    this.servers.noteAppCalls(msg)
    if (m.type === 'assistant') this.raceRetry.seen(msg as RaceMsg)
    if (m.type === 'result') this.turnOpen = false
    let events = this.stream.push(msg)
    const retrying = m.type === 'result' && this.raceRetry.afterResult(msg as RaceMsg)
    if (m.type === 'result' && !retrying) {
      const result = msg as { user_message_uuid?: string; user_message_uuids?: string[] }
      for (const id of result.user_message_uuids ?? (result.user_message_uuid ? [result.user_message_uuid] : [])) this.personInputs.delete(id)
    }
    let completedInputs: string[] | undefined
    if (m.type === 'result' && !retrying && this.inputReceipts.size && events.some((e) => e.type === 'turn_complete' || e.type === 'error')) {
      const result = msg as { user_message_uuid?: string; user_message_uuids?: string[] }
      const ids = result.user_message_uuids ?? []
      const failure = events.find((e) => e.type === 'error')
      if (ids.length && failure?.type === 'error') this.cancelParentNotes(new Error(failure.error.message))
      else if (ids.length) completedInputs = ids
      // ID-less results belong to synthetic/task-notification turns, not a parent note.
    }
    // The turn goes again instead of failing: its error marker would end the turn on screen
    if (retrying) events = events.filter((e) => e.type !== 'error')
    for (const e of events) {
      this.emit(e)
      // Capture this result before a later turn's frames can overwrite the host's answer.
      if (e.type === 'turn_complete' && completedInputs) this.inputReceipts.complete(completedInputs)
    }
    this.schedules.arm()
    // Once a turn ends, asks what is currently in the context window (FR-14).
    if (m.type === 'result' && !retrying) void this.reportContext(q)
  }

  /** The CLI's init message: its conversation id, what it can track, its version and its commands */
  private onInit(m: StreamMsg): void {
    if (m.session_id) this.externalId = m.session_id
    if (!this.trackedInputKnown) {
      this.trackedInputKnown = true
      if (tracksInputs(m)) {
        this.sendTracked = (text, observer) => {
          const receipt = this.inputReceipts.create(observer)
          this.sendInput(text, receipt.id, receipt)
          return receipt.done
        }
      }
    }
    // The CLI's own version, for moving the session to a newer install (#297). Once per process: init repeats per query
    if (typeof m.claude_code_version === 'string' && m.claude_code_version !== this.reportedVersion) {
      this.reportedVersion = m.claude_code_version
      this.emit({ type: 'agent_version', sessionId: this.sessionId, version: m.claude_code_version })
    }
    if (Array.isArray(m.slash_commands)) {
      this.goalCommand = m.slash_commands.includes('goal')
      this.settleGoalKnown()
    }
  }

  /**
   * The CLI's process, from the keeper (#280 step 2): the first call adopts the process a previous
   * host started, if there is one; any later call (none is expected) spawns a new one.
   */
  private spawnProcess(o: AgentSpawnSpec): AgentProcess {
    const src = this.opts.processSource!
    const adopt = src.adopt && !this.adopted ? src.adopt.process : null
    this.adopted = true
    this.proc = adopt ?? src.spawn({ command: o.command, args: o.args, cwd: o.cwd, env: o.env })
    return this.proc
  }

  /**
   * A call to one of our in-process servers (the orchestrator's tools, an app proxy) that was in
   * flight when the previous host went away: the CLI asked that host, nobody will ever answer, and
   * the turn would wait forever. Measured (CLI 2.1.282, SDK 0.3.263, haiku, 2026-10-04): the
   * adopted claude sat silent for 8 s with the call open; `interrupt()` from the new owner ended
   * the turn (`error_during_execution`), and the next turn — including a call to the same
   * in-process tool, now served by this host — ran normally. So the call is failed out loud and the
   * turn released, rather than left hanging; the person can send the message again.
   */
  private releaseLostCalls(q: QueryHandle): void {
    const open = this.opts.processSource?.adopt?.openCalls ?? []
    const lost = open.filter((c) => isOrchestratorTool(c.tool) || appToolOf(c.tool) !== null)
    if (lost.length === 0) return
    this.turnOpen = true
    this.stream.stopped()
    this.emit({
      type: 'error',
      sessionId: this.sessionId,
      error: {
        code: 'internal',
        message: `Centralu restarted while ${lost.map((c) => c.tool).join(', ')} was running; that call was lost, so the turn was stopped. Send the message again to retry.`,
        retryable: true,
      },
    })
    void q.interrupt().catch((err: Error) => console.error(`[claude] could not release a lost call in ${this.sessionId.slice(0, 8)}: ${err.message}`))
  }

  /**
   * Lets go of the CLI without stopping it (#280 step 2). Output keeps flowing through the normal
   * path until the keeper ends the stream, so a turn's result that was already on its way is still
   * recorded here; nothing is sent to the CLI, and an approval still waiting stays waiting for the
   * next host, which the CLI re-delivers it to.
   */
  async detach(): Promise<void> {
    this.detaching = true
    this.stopAppWatch?.()
    this.opts.apps?.close()
    if (this.query) liveQueries.delete(this.query)
    // An adopted process the SDK has not taken yet is let go of all the same
    const proc = this.proc ?? (this.adopted ? null : (this.opts.processSource?.adopt?.process ?? null))
    await proc?.detach?.()
    this.closed = true
    this.notify?.()
  }

  send(text: string): void { this.sendInput(text) }

  private sendInput(text: string, uuid = randomUUID(), note?: InputReceipt): void {
    /*
     * `/goal` goes to the CLI when the CLI offers it (2026-10-03). On 2026-09-07 (SDK 0.3.231 and
     * 0.3.263, the CLI of that day) the headless path had no goal at all: sent as text, the model
     * read the literal characters and role-played the hook ("Goal achieved!" with no hook behind
     * it), so every /goal was answered here with a refusal. The installed CLI 2.1.282 runs it
     * through the same `query()` path we use — measured: `goal` is in `supportedCommands()` and in
     * the init message's `slash_commands`, the CLI answers "Goal set: <condition>" itself (a
     * synthetic message, not the model), registers its Stop hook, and keeps the turn going until the
     * condition holds. What the stream says about it, and how the badge reads that, is in
     * `ClaudeGoalTracker` (normalize.ts).
     *
     * So the decision is made by capability: a CLI that advertises `goal` gets the command, one that
     * does not (older) still gets the honest one-liner. A `/goal` sent before the command list has
     * answered waits for it (`goalKnown`, milliseconds after start), and whatever is sent after it
     * waits behind it, so the order the person typed is the order the CLI reads.
     */
    const goal = isGoalCommand(text)
    if (!this.sendGate && !(goal && this.goalCommand === undefined)) {
      this.deliver(text, uuid, !!note)
      return
    }
    const gate = (this.sendGate = (this.sendGate ?? this.goalKnown).then(() => {
      if (note?.cancelled) return
      if (!this.closed) {
        this.deliver(text, uuid, !!note)
        return
      }
      // Closed while it waited: the same rule as dispose's queue — a message is never dropped silently
      this.emit(undeliveredError(this.sessionId, 1, 'were still queued when the session closed'))
    }))
    void gate.then(() => {
      if (this.sendGate === gate) this.sendGate = null
    })
  }

  private deliver(text: string, uuid: ReturnType<typeof randomUUID>, parentNote: boolean): void {
    if (isGoalCommand(text)) {
      if (this.goalCommand !== true) {
        /*
         * A CLI that does not offer /goal: sent as text, the model would only role-play the hook. A
         * refusal, then — but never a `turn_complete` while one of the CLI's own turns is still open
         * (a /goal typed mid-turn): that would mark the turn done while the CLI works. The open
         * turn's result closes it. The line carries its own message id, so it never runs into the
         * model's text as one row.
         */
        this.emit(adapterNotice(
          this.sessionId,
          "This Claude Code does not offer /goal to Centralu (it is not in the CLI's command list) — update Claude Code to use goals here. Sent as a message, the model would only pretend to keep one.",
        ))
        if (!this.turnOpen) this.emit({ type: 'turn_complete', sessionId: this.sessionId })
        return
      }
      this.stream.goal.commandSent()
    }
    const starting = !this.turnOpen
    this.queue.push({ text, uuid, parentNote })
    this.turnOpen = true
    this.notify?.()
    this.notify = null
    // A note queued while a tool awaits approval must leave that card and state intact.
    if (starting) this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }

  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): boolean {
    return this.cards.respondApproval(requestId, decision, scope, matcher)
  }

  answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean {
    return this.cards.answerQuestion(requestId, answers)
  }

  applyRules(matchers: readonly string[]): void {
    this.cards.applyRules(matchers)
  }

  /** The list of slash commands (an SDK public API). */
  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    if (!this.query) throw new Error('Session is not ready yet')
    return this.query.supportedCommands()
  }

  /**
   * Reports context usage (FR-14).
   *
   * **Asks the SDK directly.** This must not be computed from a result message's `modelUsage` —
   * that number accumulates over the session, so re-reading the cache adds to it every turn, and
   * it ends up exceeding the window size (measured: "context 533%"). `getContextUsage()` returns
   * how full the current window actually is.
   *
   * A failure here is swallowed quietly — the gauge briefly disappearing is better than blocking
   * the conversation.
   */
  private async reportContext(q: QueryHandle): Promise<void> {
    try {
      const usage = await q.getContextUsage()
      const used = Number(usage?.totalTokens ?? 0)
      const window = Number(usage?.maxTokens ?? 0)
      if (window > 0 && used >= 0) {
        this.emit({ type: 'context_update', sessionId: this.sessionId, used, window, exactness: 'exact' })
      }
    } catch {
      // The conversation continues even if context usage cannot be read.
    }
  }

  /**
   * Interrupt.
   *
   * **Both** of the following have to happen. This used to only deny the pending approval, which
   * only freed a turn that was waiting on a tool — if the model was simply thinking, nothing
   * happened at all. A button that does not stop anything when pressed is exactly the kind of
   * silent failure this project forbids.
   *
   *   1) Deny the pending approval: if `canUseTool` is holding a promise, it is stuck there with
   *      no point to clean up at even once the interrupt signal arrives. So it is released first.
   *   2) SDK interrupt: this actually cuts the turn. We can call this method because we pass the
   *      prompt as an async generator, in streaming input mode.
   */
  interrupt(cancelQueued = this.inputReceipts.size > 0, reason = new Error('The parent note was stopped before it finished')): void {
    // The SDK's plain interrupt leaves queued commands alive; cancelQueued maps to control-request cancel_queued.
    this.inputReceipts.failAll(reason)
    const held = (cancelQueued ? this.queue.filter((input) => !input.parentNote).length : 0) +
      this.raceRetry.held.filter((input) => !input.parentNote).length
    if (cancelQueued) this.queue.length = 0
    this.reportUndelivered(held)
    /*
     * This also stops any app calls this session made (M4 A-5). The SDK makes no promise about
     * whether the CLI sends a cancellation to a tool call when it interrupts a turn — we cut it
     * off directly. The cancellation propagates through the runtime, down to the app and whatever
     * it was doing.
     */
    this.opts.apps?.cancelAll()
    // A turn waiting to go again after the sign-in race (#353) is stopped as well: it is the same turn
    this.raceRetry.cancel()
    this.cards.releaseApprovals('Stopped by user')
    this.cards.releaseQuestions('Stopped by user')
    /*
     * The ending of an interrupted turn (`error_during_execution`) is an interruption, not a
     * failure (#168, the normalizer's `stopping`). This flags it **only while a turn is actually
     * running** — if pressing Stop on an idle session left the flag set, it would swallow a real
     * failure on the next turn.
     */
    if (this.turnOpen) this.stream.stopped()

    void this.query?.interrupt(cancelQueued ? { cancelQueued: true } : undefined).then((response) => {
      // cancel_queued sweeps SDK-held messages too, including the person's. The CLI's receipt
      // identifies exactly which did not run; do not silently discard their already-visible rows.
      const cancelled = (response as { cancelled?: unknown } | undefined)?.cancelled
      if (!Array.isArray(cancelled)) return
      let count = 0
      for (const id of cancelled) if (typeof id === 'string' && this.personInputs.delete(id)) count++
      this.reportUndelivered(count)
    }).catch((err: Error) => this.emit(couldNotStop(this.sessionId, err)))

    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
  }

  /** A failed turn is already over. Cancel its parent notes without interrupting the person's next turn. */
  private cancelParentNotes(reason: Error): void {
    const ids = this.inputReceipts.ids
    this.inputReceipts.failAll(reason)
    this.queue = this.queue.filter((input) => !input.parentNote)
    this.raceRetry.dropNotes()
    const query = this.query
    // The CLI can cancel an already-dequeued representative UUID's entire coalesced batch
    // (SDKControlInterruptResponse). A mixed batch could contain person input, so leave the SDK
    // queue intact when that race is possible; only local notes have been removed above.
    if (!query?.cancelAsyncMessage || this.personInputs.size || this.queue.length || this.raceRetry.held.length || this.sendGate) return
    for (const id of ids) void query.cancelAsyncMessage(id).catch((error: Error) => {
      this.emit({ type: 'error', sessionId: this.sessionId, error: {
        code: 'internal', message: `Could not cancel the parent note: ${error.message}`, retryable: false,
      } })
    })
  }

  private reportUndelivered(count: number): void {
    if (count) this.emit(undeliveredError(this.sessionId, count, 'were still queued when the turn stopped'))
  }

  /**
   * Stops one background task (#290). Measured on a backgrounded shell: `background_tasks_changed` without it,
   * `task_updated` killed and `task_notification` stopped follow at once, and the stream turns that into the
   * session's next `background_tasks` event. A rejection is thrown to the caller, so the person hears it.
   */
  async stopBackgroundTask(taskId: string): Promise<void> {
    if (!this.query || this.closed) throw new Error('The session process is not running')
    await this.query.stopTask(taskId)
  }

  /**
   * A pending approval is **never released silently.**
   *
   * Without a notification here, the approval card stays on the screen. Its `requestId` is not in
   * the new process's own map, so pressing it does nothing at all — the session is perfectly idle,
   * but the UI says "the agent is stuck", with no way out. `interrupt()` already handled this the
   * same way; only swapping the process was missing it.
   */
  async dispose(): Promise<void> {
    this.inputReceipts.failAll(new Error('The session closed before the parent note finished'))
    this.closed = true
    this.notify?.()
    // A message held behind an unanswered /goal is reported as undelivered, like the queue below
    this.settleGoalKnown()
    // App attachment closes along with the handle — a new handle gets its own.
    this.stopAppWatch?.()
    this.opts.apps?.close()
    /*
     * A message left in the queue follows the same rule (symmetric with the codex adapter's
     * compact queue — matched after the 2026-09-02 loss incident). Once the generator sees
     * `closed` and exits, nothing left here is ever read by anyone — and because the UI already
     * shows it as sent (the manager records it first), dropping it silently would quietly create
     * a "sent, but the agent never read it" state.
     */
    // A turn waiting out its delay after the sign-in race (#353) holds messages the same way
    const held = this.queue.length + this.raceRetry.cancel()
    if (held > 0) {
      this.queue.length = 0
      this.emit(undeliveredError(this.sessionId, held, 'were still queued when the session closed'))
    }
    this.cards.releaseApprovals('Session closed')
    this.cards.releaseQuestions('Session closed')
    this.releaseAgents('The session closed before this agent reported back')
    /*
     * **Terminates the process** (#157). This used to only end the input generator — the SDK just
     * closes the CLI's stdin, and the CLI keeps running the turn it was already on (including any
     * remaining tool calls in auto, where nothing ever asks). In a swapped-out session, the old
     * process and the new process ended up both writing into the same conversation. `close()`
     * closes stdin and sends SIGTERM if it has not ended (sdk.d.ts: "Close the query and
     * terminate the underlying process"). The usage window is also reclaimed here.
     *
     * On Windows there is no SIGTERM to send: the SDK (0.3.263, sdk.mjs `close`) ends stdin, waits
     * 2 s, then another 5 s, and only then kills a process that is still there. A CLI that is not mid-
     * turn leaves on the EOF by itself, so a sign-in refresh it may be writing (#353) gets to finish.
     * While the host keeps running that is all it takes; when the host is on its way out, `settle`
     * waits for these processes, because the host's own exit would take them along at once.
     */
    if (this.query) {
      liveQueries.delete(this.query)
      this.query.close()
      const ended = this.ended
      if (!this.launch.closing.has(ended)) {
        this.launch.closing.add(ended)
        void ended.then(() => this.launch.closing.delete(ended))
      }
    }
  }

  /**
   * Closes the card of a background agent that was still running — no notification arrives, since it disappeared with
   * the process (#98) — and ends every background task the session listed (#290), for the same reason.
   */
  private releaseAgents(why: string): void {
    this.inputReceipts.failAll(new Error(why))
    this.schedules.stop()
    for (const e of this.stream.release(why)) this.emit(e)
  }

}

import { randomUUID } from 'node:crypto'
import { handoffOpening, handoffPrompt, SESSION_HANDOFF, type NormalizedEvent, type SessionInfo, type ToolName } from '@cc/protocol'
import type { HandoffResult } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import { AgentRunWait } from './app-agents.js'
import type { HostAsk, HostAskAnswer } from './host-cards.js'
import { trustedJsonText } from './orchestrator-tools.js'
import { raceBound } from './with-timeout.js'

/**
 * What the handoff flow reaches of the session manager (#428), each member read when used: the manager builds it with
 * getters for its fields, never a copy of them.
 */
export type HandoffFlowHost = {
  readonly meta: ReadonlyMap<string, SessionInfo>
  readonly store: Store
  /** `log`: what the auto log line names instead of the card's kind (#694 review) */
  askHost(sessionId: string, detail: HostAsk['detail'], signal?: AbortSignal, card?: { log?: string }): Promise<HostAskAnswer>
  /** Why this tool cannot start a session here (unknown, not installed, signed out), or null */
  toolProblem(tool: string): Promise<string | null>
  /** The caller's own `auto` (#603): asked with no `boundary` it only answers; with one, it also logs the allowance */
  autoBoundaryOpen(sessionId: string, boundary?: string): boolean
  cwdFor(m: SessionInfo): string
  createSession(params: {
    projectId: string
    cwd: string
    tool: ToolName
    model?: string
    effort?: string
    verbosity?: string
    serviceTier?: string
    permissionPreset: SessionInfo['permissionPreset']
    initialPrompt: string
    /** Who sent the opening: the orchestrator, so it is stored and shown as its words, never the person's (FR-11) */
    initialFrom: { sessionId: string; name: string }
    handoff: { from: string; note: string; fromSessionId: string }
  }): Promise<SessionInfo>
  rename(sessionId: string, name: string): void
  send(sessionId: string, text: string, attachments: undefined, from: { sessionId: string; name: string }): Promise<void>
  exportHandoffRecord(sessionId: string, toTool?: string): Promise<{ text: string; path: string }>
  exportHandoffNote(sessionId: string, afterSeq: number): Promise<{ text: string; path: string } | null>
  onEvent(e: NormalizedEvent): void
  /** Waits that read a session's turn as it ends (`AgentRunWait`), as start_agent's observers do */
  readonly turnObservers: Map<string, Set<AgentRunWait>>
}

/** How the handoff waits (tests shorten them) */
export type HandoffTimings = {
  /** How long one call may wait for an agent's note before answering "still writing": under the Codex bridge's 280 s */
  callMs: number
  /** How long the note may take in all before the handoff gives up, as the window's own handoff does */
  noteMs: number
}

const TIMINGS: HandoffTimings = { callMs: 240_000, noteMs: 10 * 60_000 }

/**
 * One handoff the tool started. `done` is the whole of it (the record or the agent's note, then the successor), so a
 * second call that finds it waits on the same work and never starts another successor.
 */
type Run = {
  /** The handle a "still running" answer gives, for waiting on this run and no other */
  id: string
  callerId: string
  targetId: string
  done: Promise<HandoffResult>
  /** A call answered "still running": the result is kept for that handle until read, or until it expires */
  detached?: boolean
  result?: HandoffResult
}

/**
 * The orchestrator's handoff_session (#694): a session is handed to a fresh one, which starts from a note, as the
 * window's session menu does (`handoffSession` in the UI's store), with the same note, the same first message and the
 * same move of the original's live children (#693).
 *
 * **Who may hand off what.** Only the central orchestrator has the tool (`profileAllows`); a lead, an ordinary session
 * and an app's agent do not. Its target is a session of its own view on this computer (`orchestratorToolsFor`), and of
 * those only a project's ordinary session: never itself, an orchestrator or coordinator, an app's session (an app's
 * agent or its builder, whose tie to the app the successor would not carry), a worktree session (refused with the
 * window's reason), or a session mid-turn (refused, never cut short). The person's consent is a card in the
 * orchestrator's own session for each handoff, unless the orchestrator runs under `auto` (#603, logged) or the person
 * answered "always" on an earlier card, which lasts while this host serves that orchestrator. The checks run again
 * after the card, since the target may have started a turn while it stood.
 *
 * What moves is what the person's own handoff moves: the live children go to the successor, which is then owed their
 * reports; `moveChildren` checks no authority itself, which is why every check above precedes it. The original always
 * stays (the issue: never deleted automatically); the person removes it. The successor runs with the original's
 * preset, which the card names, so the handoff raises no session above what the person set for it.
 */
export class HandoffFlow {
  /** Handoffs running now, by the session being handed off: two at once would start two successors */
  private readonly running = new Map<string, Run>()
  /** Runs by handle: running ones, and finished ones a call was told to wait on, until read or expired */
  private readonly runs = new Map<string, Run>()
  /** Orchestrators the person told "always" on a handoff card, while this host serves them */
  private readonly always = new Set<string>()

  constructor(
    private readonly host: HandoffFlowHost,
    private readonly timings: HandoffTimings = TIMINGS,
  ) {}

  /** Why `target` cannot be handed off by `callerId` now, or null */
  private refusal(callerId: string, target: SessionInfo, mode: 'record' | 'agent'): string | null {
    const name = trustedJsonText(target.name)
    if (target.id === callerId) return 'An orchestrator does not hand itself off; the person does that.'
    if (this.running.has(target.id)) return `${name} is already being handed off.`
    if (target.kind !== 'worker' || !target.projectId) return `${name} is not a project's ordinary session, so it cannot be handed off.`
    if (target.appId) return `${name} belongs to an app (its builder or an agent it started); only the person hands those off.`
    if (target.worktree) return `${name} works in a worktree, and worktree sessions cannot hand off yet: merge or delete it first.`
    if (inTurn(target.state) || target.pendingApproval || target.pendingQuestions.length) {
      return `${name} is mid-turn (${target.pendingQuestions.length ? 'waiting on a question' : target.state}), so nothing was handed off. Wait for the turn to end (read_session shows it), or ask the person.`
    }
    if (mode === 'agent' && target.state === 'error') return `${name} is in an error state and cannot write a note. Hand it off from the record (mode "record").`
    return null
  }

  /** A refusal, logged with who asked and for which session (#694 review) */
  private refuse(callerId: string, targetId: string, error: string): HandoffResult {
    console.error(`[agent-host] handoff_session by ${callerId.slice(0, 8)} of ${targetId.slice(0, 8)} refused: ${error}`)
    return { ok: false, error }
  }

  /** Waits again on a run a "still running" answer named, which only its caller may do */
  async wait(callerId: string, handle: string, signal?: AbortSignal): Promise<HandoffResult> {
    const run = this.runs.get(handle)
    if (!run || run.callerId !== callerId) return { ok: false, error: `No handoff of yours has the handle ${trustedJsonText(handle)}: it finished and its result was read, or it expired.` }
    return this.waitOn(run, Date.now(), signal)
  }

  async handoff(
    callerId: string,
    target: SessionInfo,
    opts: { tool?: ToolName; mode?: 'record' | 'agent'; instructions?: string },
    signal?: AbortSignal,
  ): Promise<HandoffResult> {
    const started = Date.now()
    const mode = opts.mode ?? 'record'
    const tool = opts.tool ?? target.tool
    const instructions = opts.instructions?.trim() || undefined
    const refused = this.refusal(callerId, target, mode)
    if (refused) return this.refuse(callerId, target.id, refused)
    // The tool is checked before any card: a name that cannot start a session never reaches the person's eyes (#694 review)
    const problem = await this.host.toolProblem(tool)
    if (problem) return this.refuse(callerId, target.id, `Nothing was handed off: ${problem}`)

    let always = false
    /*
     * Under `auto` no card is raised, and the allowance is logged only once this call holds the session (#797): a
     * burst of calls logged "allowed" for each before all but one were refused. Asked here without logging.
     */
    const viaAuto = this.host.autoBoundaryOpen(callerId)
    if (!viaAuto && !this.always.has(callerId)) {
      const decision = await this.host.askHost(
        callerId,
        { kind: 'other', about: SESSION_HANDOFF, raw: this.question(target, tool, mode, instructions) },
        signal,
        { log: `${SESSION_HANDOFF} of ${target.id} (${mode}, to ${tool})` },
      )
      if (decision === 'deny') return this.refuse(callerId, target.id, `The person did not allow handing off ${trustedJsonText(target.name)}. Do not ask again unless they tell you to.`)
      if (decision === null) return this.refuse(callerId, target.id, 'The card was withdrawn before the person answered, so nothing was handed off.')
      always = decision === 'always' || decision === 'always_project'
    }
    // Read again: the target may have started a turn, gone, or been handed off while the card stood
    const now = this.host.meta.get(target.id)
    if (!now) return this.refuse(callerId, target.id, `${trustedJsonText(target.name)} is gone.`)
    const again = this.refusal(callerId, now, mode)
    if (again) return this.refuse(callerId, now.id, again)
    // "Always" counts only for a call that went through every check (#694 review): a refused one grants nothing
    if (always) this.always.add(callerId)

    // Claimed before anything is awaited, and held until the whole handoff ends
    const run: Run = { id: `ho-${randomUUID().slice(0, 8)}`, callerId, targetId: now.id, done: Promise.resolve({ ok: false, error: '' }) }
    this.running.set(now.id, run)
    this.runs.set(run.id, run)
    // Read again with the log: an orchestrator moved off `auto` meanwhile was never asked, so it gets nothing
    if (viaAuto && !this.host.autoBoundaryOpen(callerId, `${SESSION_HANDOFF} of ${now.id} (${mode}, to ${tool})`)) {
      this.running.delete(now.id)
      this.runs.delete(run.id)
      return this.refuse(callerId, now.id, 'This session left the auto preset while the handoff was being checked; call again to be asked.')
    }
    run.done = (mode === 'record' ? this.fromRecord(callerId, now, tool, instructions) : this.fromAgent(callerId, now, tool, instructions)).then((r) => {
      if (this.running.get(now.id) === run) this.running.delete(now.id)
      if (!run.detached) this.runs.delete(run.id)
      else {
        run.result = r
        // Kept for its handle, not forever: unread past the note's own bound, it goes
        setTimeout(() => this.runs.get(run.id) === run && this.runs.delete(run.id), this.timings.noteMs).unref?.()
      }
      return r
    })
    return this.waitOn(run, started, signal)
  }

  private async fromRecord(callerId: string, target: SessionInfo, tool: ToolName, instructions: string | undefined): Promise<HandoffResult> {
    try {
      const note = await this.host.exportHandoffRecord(target.id, tool)
      return await this.succeed(callerId, target, tool, note, 'record', instructions)
    } catch (e) {
      return { ok: false, error: `Nothing was handed off: ${(e as Error).message}` }
    }
  }

  /**
   * Agent mode: the session is asked, as the window asks it, with the orchestrator named as the sender. The note is
   * read from the store once the turn ends (`exportHandoffNote`), never from the screen.
   */
  private async fromAgent(callerId: string, target: SessionInfo, tool: ToolName, instructions: string | undefined): Promise<HandoffResult> {
    const before = this.host.store.loadMessages(target.id, 1).at(-1)?.seq ?? 0
    // Watched before the send, since an adapter can emit the turn's events while sending
    const turn = new AgentRunWait(() => {}, () => target.name)
    const readers = this.host.turnObservers.get(target.id) ?? new Set<AgentRunWait>()
    readers.add(turn)
    this.host.turnObservers.set(target.id, readers)
    try {
      try {
        await this.host.send(target.id, handoffPrompt(), undefined, { sessionId: callerId, name: this.host.meta.get(callerId)?.name ?? 'Orchestrator' })
      } catch (e) {
        return { ok: false, error: `Could not ask ${trustedJsonText(target.name)} for its note: ${(e as Error).message}` }
      }
      return await this.awaitNote(callerId, target, tool, before, instructions, turn)
    } finally {
      readers.delete(turn)
      if (readers.size === 0 && this.host.turnObservers.get(target.id) === readers) this.host.turnObservers.delete(target.id)
    }
  }

  /** Waits on a run for what is left of the call's bound: its result once (then forgotten), or "still running" with its handle */
  private async waitOn(run: Run, started: number, signal?: AbortSignal): Promise<HandoffResult> {
    if (run.result) {
      this.runs.delete(run.id)
      return run.result
    }
    const left = Math.max(0, this.timings.callMs - (Date.now() - started))
    const r = await raceBound(run.done, left, signal)
    if (r !== 'bound' && r !== 'aborted') {
      this.runs.delete(run.id)
      return r
    }
    run.detached = true
    const target = this.host.meta.get(run.targetId)
    return { ok: true, state: 'writing', sessionId: run.targetId, sessionName: target?.name ?? run.targetId, handle: run.id }
  }

  /**
   * Waits for the turn that writes the agent's note, then starts the successor. Never throws: a failure is the result.
   * The turn's end is read as start_agent reads a child's (`AgentRunWait`, #428): one that failed, hit a limit or was
   * stopped answers at once and says how, where polling the session's state waited out the whole bound and blamed it.
   */
  private async awaitNote(callerId: string, target: SessionInfo, tool: ToolName, before: number, instructions: string | undefined, turn: AgentRunWait): Promise<HandoffResult> {
    const name = trustedJsonText(target.name)
    try {
      const r = await raceBound(turn.done.then(() => null, (e: Error) => e), this.timings.noteMs)
      if (r === 'bound' || r === 'aborted') return { ok: false, error: `${name} wrote no note in ${Math.round(this.timings.noteMs / 60_000)} minutes; nothing was handed off.` }
      if (r) return { ok: false, error: `${name} did not write its note: ${r.message}; nothing was handed off. Hand it off from the record (mode "record").` }
      const cur = this.host.meta.get(target.id)
      if (!cur) return { ok: false, error: `${name} disappeared while writing its note; nothing was handed off.` }
      const got = await this.host.exportHandoffNote(target.id, before)
      if (!got) return { ok: false, error: `${name} ended its turn without a note; nothing was handed off. Hand it off from the record (mode "record").` }
      return await this.succeed(callerId, cur, tool, got, 'agent', instructions)
    } catch (e) {
      return { ok: false, error: `Nothing was handed off: ${(e as Error).message}` }
    }
  }

  /**
   * Starts the successor as the window does: every setting of the original when the tool stays, none of the
   * tool-specific ones when it changes, the original's preset and name, and the note as a marker (`createSession`'s
   * `handoff`, which moves the live children before the first message is sent). The original stays and is told.
   */
  private async succeed(
    callerId: string,
    target: SessionInfo,
    tool: ToolName,
    note: { text: string; path: string },
    mode: 'record' | 'agent',
    instructions: string | undefined,
  ): Promise<HandoffResult> {
    const same = tool === target.tool
    const callerName = this.host.meta.get(callerId)?.name ?? 'Orchestrator'
    const info = await this.host.createSession({
      projectId: target.projectId!,
      cwd: this.host.cwdFor(target),
      tool,
      ...(same && target.model ? { model: target.model } : {}),
      ...(same && target.effort ? { effort: target.effort } : {}),
      ...(same && target.verbosity ? { verbosity: target.verbosity } : {}),
      ...(same && target.serviceTier ? { serviceTier: target.serviceTier } : {}),
      permissionPreset: target.permissionPreset,
      initialPrompt: handoffOpening(target.name, note.text, note.path, instructions ? { from: `The orchestrator (${JSON.stringify(callerName)})`, text: instructions } : undefined),
      initialFrom: { sessionId: callerId, name: callerName },
      handoff: { from: target.name, note: note.text, fromSessionId: target.id },
    })
    this.host.rename(info.id, target.name)
    this.host.onEvent({
      type: 'notice', sessionId: target.id, level: 'info', from: 'Centralu', label: 'handoff',
      text: `The orchestrator “${callerName}” handed this session off to a fresh ${tool} session [${info.id}], which starts from a note ${mode === 'record' ? 'built from the record' : 'this session wrote'}. This session stays; remove it when you no longer need it.`,
    })
    console.error(`[agent-host] orchestrator ${callerId.slice(0, 8)} handed off ${target.id.slice(0, 8)} -> ${info.id.slice(0, 8)} (${mode}, ${tool})`)
    return { ok: true, state: 'done', sessionId: info.id, sessionName: target.name, tool, mode, from: target.id, path: note.path }
  }

  /**
   * The card's one question: what is handed off, to what, from which note, and what stays. Every name in it is someone
   * else's text (the target's name, the tool the model asked for, its words), so each is JSON-quoted on one line and
   * cannot read as the card's own sentence (#694 review); the words are cut at 400 characters and say so.
   */
  private question(target: SessionInfo, tool: ToolName, mode: 'record' | 'agent', instructions: string | undefined): string {
    const name = trustedJsonText(target.name)
    const words = instructions
      ? ` The orchestrator adds, as JSON: ${trustedJsonText(instructions.slice(0, 400))}` +
        (instructions.length > 400 ? ` (cut here; ${instructions.length} characters in all, given whole to the new session).` : '')
      : ''
    return (
      `Allow the orchestrator to hand off the session ${name} to a fresh session of the tool ${trustedJsonText(tool)}? ` +
      (mode === 'record' ? 'The note is built from its stored conversation; the session is not asked. ' : 'The session is asked to write the note first. ') +
      `${name} stays, the live work it started moves to the new session, and the new session runs under the ${target.permissionPreset} preset.` +
      words
    )
  }
}

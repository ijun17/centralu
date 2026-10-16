import { handoffOpening, handoffPrompt, SESSION_HANDOFF, type NormalizedEvent, type SessionInfo, type ToolName } from '@cc/protocol'
import type { HandoffResult } from '../adapters/contract.js'
import type { Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'
import type { HostAsk, HostAskAnswer } from './host-cards.js'
import { trustedJsonText } from './orchestrator-tools.js'

/**
 * What the handoff flow reaches of the session manager (#428), each member read when used: the manager builds it with
 * getters for its fields, never a copy of them.
 */
export type HandoffFlowHost = {
  readonly meta: ReadonlyMap<string, SessionInfo>
  readonly store: Store
  askHost(sessionId: string, detail: HostAsk['detail'], signal?: AbortSignal): Promise<HostAskAnswer>
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
    handoff: { from: string; note: string; fromSessionId: string }
  }): Promise<SessionInfo>
  rename(sessionId: string, name: string): void
  send(sessionId: string, text: string, attachments: undefined, from: { sessionId: string; name: string }): Promise<void>
  exportHandoffRecord(sessionId: string, toTool?: string): Promise<{ text: string; path: string }>
  exportHandoffNote(sessionId: string, afterSeq: number): Promise<{ text: string; path: string } | null>
  onEvent(e: NormalizedEvent): void
}

/** How the handoff waits (tests shorten them) */
export type HandoffTimings = {
  /** How often an agent-mode handoff looks for the note */
  pollMs: number
  /** How long one call may wait for an agent's note before answering "still writing": under the Codex bridge's 280 s */
  callMs: number
  /** How long the note may take in all before the handoff gives up, as the window's own handoff does */
  noteMs: number
}

const TIMINGS: HandoffTimings = { pollMs: 500, callMs: 240_000, noteMs: 10 * 60_000 }

type InFlight = { callerId: string; done: Promise<HandoffResult>; result?: HandoffResult }

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
  private readonly inFlight = new Map<string, InFlight>()
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
    if (target.kind !== 'worker' || !target.projectId) return `${name} is not a project's ordinary session, so it cannot be handed off.`
    if (target.appId) return `${name} belongs to an app (its builder or an agent it started); only the person hands those off.`
    if (target.worktree) return `${name} works in a worktree, and worktree sessions cannot hand off yet: merge or delete it first.`
    if (inTurn(target.state) || target.pendingApproval || target.pendingQuestions.length) {
      return `${name} is mid-turn (${target.pendingQuestions.length ? 'waiting on a question' : target.state}), so nothing was handed off. Wait for the turn to end (read_session shows it), or ask the person.`
    }
    if (mode === 'agent' && target.state === 'error') return `${name} is in an error state and cannot write a note. Hand it off from the record (mode "record").`
    return null
  }

  async handoff(
    callerId: string,
    target: SessionInfo,
    opts: { tool?: ToolName; mode?: 'record' | 'agent'; instructions?: string },
    signal?: AbortSignal,
  ): Promise<HandoffResult> {
    const started = Date.now()
    let running = this.inFlight.get(target.id)
    // A handoff that ended with nobody back for its result does not hold the session from another orchestrator
    if (running?.result && running.callerId !== callerId) {
      this.inFlight.delete(target.id)
      running = undefined
    }
    // The same orchestrator calling again waits on its handoff still running, or picks up how it ended
    if (running) return running.callerId === callerId ? this.waitOn(target.id, running, started, signal) : { ok: false, error: `${trustedJsonText(target.name)} is already being handed off.` }
    const mode = opts.mode ?? 'record'
    const tool = opts.tool ?? target.tool
    const instructions = opts.instructions?.trim() || undefined
    const refused = this.refusal(callerId, target, mode)
    if (refused) return { ok: false, error: refused }

    if (!this.always.has(callerId)) {
      const decision = await this.host.askHost(callerId, { kind: 'other', about: SESSION_HANDOFF, raw: this.question(target, tool, mode, instructions) }, signal)
      if (decision === 'deny') return { ok: false, error: `The person did not allow handing off ${trustedJsonText(target.name)}. Do not ask again unless they tell you to.` }
      if (decision === null) return { ok: false, error: 'The card was withdrawn before the person answered, so nothing was handed off.' }
      if (decision === 'always' || decision === 'always_project') this.always.add(callerId)
    }
    // Read again: the target may have started a turn, gone, or been handed off while the card stood
    const now = this.host.meta.get(target.id)
    if (!now) return { ok: false, error: `${trustedJsonText(target.name)} is gone.` }
    const again = this.inFlight.has(now.id) ? `${trustedJsonText(now.name)} is already being handed off.` : this.refusal(callerId, now, mode)
    if (again) return { ok: false, error: again }

    const entry: InFlight = { callerId, done: Promise.resolve({ ok: false, error: 'not started' }) }
    this.inFlight.set(now.id, entry)
    if (mode === 'record') {
      try {
        const note = await this.host.exportHandoffRecord(now.id, tool)
        return await this.succeed(callerId, now, tool, note, 'record', instructions)
      } catch (e) {
        return { ok: false, error: `Nothing was handed off: ${(e as Error).message}` }
      } finally {
        this.inFlight.delete(now.id)
      }
    }

    /*
     * Agent mode: the session is asked, as the window asks it, with the orchestrator named as the sender. The note is
     * read from the store once the turn ends (`exportHandoffNote`), never from the screen. The call waits under the
     * Codex bridge's bound; past it, the handoff goes on and the same call picks it up.
     */
    const before = this.host.store.loadMessages(now.id, 1).at(-1)?.seq ?? 0
    try {
      await this.host.send(now.id, handoffPrompt(), undefined, { sessionId: callerId, name: this.host.meta.get(callerId)?.name ?? 'Orchestrator' })
    } catch (e) {
      this.inFlight.delete(now.id)
      return { ok: false, error: `Could not ask ${trustedJsonText(now.name)} for its note: ${(e as Error).message}` }
    }
    entry.done = this.awaitNote(callerId, now, tool, before, instructions).then((r) => (entry.result = r))
    return this.waitOn(now.id, entry, started, signal)
  }

  /** Waits on a running handoff for what is left of the call's bound: its result once (then forgotten), or "still writing" */
  private async waitOn(targetId: string, entry: InFlight, started: number, signal?: AbortSignal): Promise<HandoffResult> {
    const left = Math.max(0, this.timings.callMs - (Date.now() - started))
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const later = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), left)
      onAbort = () => resolve(null)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const r = await Promise.race([entry.done, later])
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    if (r) {
      if (this.inFlight.get(targetId) === entry) this.inFlight.delete(targetId)
      return r
    }
    const target = this.host.meta.get(targetId)
    return { ok: true, state: 'writing', sessionId: targetId, sessionName: target?.name ?? targetId }
  }

  /** Waits for the agent's note, then starts the successor. Never throws: a failure is the result */
  private async awaitNote(callerId: string, target: SessionInfo, tool: ToolName, before: number, instructions: string | undefined): Promise<HandoffResult> {
    const deadline = Date.now() + this.timings.noteMs
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, this.timings.pollMs))
        const cur = this.host.meta.get(target.id)
        if (!cur) return { ok: false, error: `${trustedJsonText(target.name)} disappeared while writing its note; nothing was handed off.` }
        if (cur.state === 'error') return { ok: false, error: `${trustedJsonText(target.name)} hit an error while writing its note; nothing was handed off. Hand it off from the record (mode "record").` }
        if (Date.now() > deadline) return { ok: false, error: `${trustedJsonText(target.name)} wrote no note in ${Math.round(this.timings.noteMs / 60_000)} minutes; nothing was handed off.` }
        if (inTurn(cur.state)) continue
        const got = await this.host.exportHandoffNote(target.id, before).catch(() => null)
        if (got) return await this.succeed(callerId, cur, tool, got, 'agent', instructions)
      }
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

  /** The card's one question: what is handed off, to what, from which note, and what stays */
  private question(target: SessionInfo, tool: ToolName, mode: 'record' | 'agent', instructions: string | undefined): string {
    const name = JSON.stringify(target.name)
    return (
      `Allow the orchestrator to hand off ${name} to a fresh ${tool} session? ` +
      (mode === 'record' ? 'The note is built from its stored conversation; the session is not asked. ' : 'The session is asked to write the note first. ') +
      `${name} stays, the live work it started moves to the new session, and the new session runs under the ${target.permissionPreset} preset.` +
      (instructions ? ` The orchestrator adds, as JSON: ${trustedJsonText(instructions.slice(0, 400))}` : '')
    )
  }
}

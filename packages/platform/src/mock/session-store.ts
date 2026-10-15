import type { NormalizedEvent, SessionInfo, StoredMessage } from '@cc/protocol'
import type { MockClock } from './clock.js'

/**
 * The mock's sessions and their conversations: the session list, the stored rows, each session's open text row,
 * and the pieces of `MockPlatform.emit` that fold an event into them.
 */
export class SessionStore {
  sessions = new Map<string, SessionInfo>()
  /** Messages saved per session — left open so a test can build a "session with an already-long history" */
  messages = new Map<string, StoredMessage[]>()
  /** A subagent's steps per launch card (#222), keyed `<session id> <launch call id>` — left open like `messages` */
  subagentMessages = new Map<string, StoredMessage[]>()
  /** How many times a launch card's steps were read — a test checks they are read only when opened */
  subagentReads = 0
  /** The row of text currently streaming, per session — the very row inside `messages` (growing it also grows the record) */
  private streams = new Map<string, StoredMessage>()

  pushMessage(m: StoredMessage): void {
    this.streams.delete(m.sessionId) // A new row is the end of whatever was streaming — if it is the first row of a stream, emit reopens it
    const arr = this.messages.get(m.sessionId) ?? []
    arr.push(m)
    this.messages.set(m.sessionId, arr)
  }

  /**
   * A native subagent's step (#222) — see `MockPlatform.emit`. Returns the step number, to carry in the broadcast.
   */
  recordSubagentStep(event: Extract<NormalizedEvent, { type: 'subagent_event' }>): number {
    /*
     * A native subagent's step (#222) — like the host: kept under its launch card, apart from the conversation, numbered
     * within that launch (`stepSeq`), and sent on without a conversation seq. It never touches the session's state or
     * its open text row.
     */
    const key = `${event.sessionId} ${event.parentCallId}`
    const rows = this.subagentMessages.get(key) ?? []
    const step = event.step
    const kind = step.type === 'message_delta' ? 'text' : step.type === 'reasoning_delta' ? 'reasoning' : step.type
    const stepSeq = rows.length + 1
    rows.push({ sessionId: event.sessionId, seq: stepSeq, role: kind === 'text' || kind === 'reasoning' ? 'assistant' : 'system', kind, payload: step, ts: this.clock.now() })
    this.subagentMessages.set(key, rows)
    return stepSeq
  }

  /** Whether this notice repeats one already stored for the session */
  isRepeatedNotice(event: NormalizedEvent): boolean {
    // Text the tool repeats on every start (#304) — like the host, one stored line per session
    return !!(
      event.type === 'notice' &&
      event.oncePerSession &&
      (this.messages.get(event.sessionId) ?? []).some(
        (m) => m.kind === 'marker' && (m.payload as { type?: string; text?: string }).type === 'notice' && (m.payload as { text?: string }).text === event.text,
      )
    )
  }

  /** Folds an event into the session it belongs to, the way the host's live facts do */
  applyLiveFacts(s: SessionInfo, event: NormalizedEvent): void {
    if (event.type === 'approval_request') {
      s.state = 'waiting_approval'
      s.waitingSince ??= this.clock.now()
      s.pendingApproval = { requestId: event.requestId, detail: event.detail }
    } else if (event.type === 'approval_resolved') {
      if (s.pendingApproval?.requestId === event.requestId) s.pendingApproval = null
    } else if (event.type === 'question_request') {
      /*
       * The same rule as the real thing (manager.trackLiveFacts): a live question
       * **stays on the session**. Only emitting it as an event would make the card
       * disappear on every path that re-fetches the list (reconnect, refresh) — if it
       * stays in the real thing but disappears only in the mock, that difference shows up
       * on screen only.
       */
      s.state = 'waiting_input'
      s.waitingSince ??= this.clock.now()
      s.pendingQuestions = [...s.pendingQuestions, { requestId: event.requestId, questions: event.questions }]
    } else if (event.type === 'question_resolved') {
      s.pendingQuestions = s.pendingQuestions.filter((q) => q.requestId !== event.requestId)
    } else if (event.type === 'turn_complete') {
      s.state = 'waiting_input'
      s.waitingSince ??= this.clock.now()
    } else if (event.type === 'message_delta' || event.type === 'tool_call') {
      s.state = 'working'
      s.waitingSince = null
    } else if (event.type === 'worktree_merged') {
      // The same rule as the real thing (#69): must stay in the list after a reconnect too
      s.worktreeMerged = true
    } else if (event.type === 'worktree_pr') {
      // The same rule as the real thing (#76 stage 3): the PR state also stays in the list after a reconnect
      s.worktreePr = event.pr
    } else if (event.type === 'context_update') {
      /*
       * The same rule as the real thing (the host): context usage **stays on the session**
       * (issue #48).
       *
       * While the mock was only emitting this, the gauge reverted to `—` on every path
       * that re-fetches the list (app restart, reconnect) — the real thing holds onto the
       * value, so if this spot is left empty, e2e passes a state the real thing could
       * never produce as normal.
       */
      s.context = { used: event.used, window: event.window, exactness: event.exactness }
    }
    // The same rule as the real thing (#304): a fresh conversation empties the gauge until the tool reports again
    if (event.type === 'conversation_reset') s.context = null
    // The same rule as the real thing (#297): the CLI version the process reports stays on the session
    if (event.type === 'agent_version') s.agentVersion = event.version
    // The same rule as the real thing (#568): a session put to sleep lists as not live until it is woken
    if (event.type === 'session_live') s.live = event.live
    // The same rule as the real thing (#698): why the last turn stopped stays on the session until it works again
    if (event.type === 'interruption') s.interruption = event.interruption
    if ((event.type === 'state_change' && event.state === 'working') || event.type === 'message_delta' || event.type === 'tool_call') s.interruption = null
    /*
     * A switch the agent tool made (#304, #659) — like the host, recorded on the session so the list a reconnect reads
     * shows it too. (The host applies only what differs from what the process was launched with; the mock has no
     * process, so the snapshot is taken as it is.)
     */
    if (event.type === 'settings_changed') {
      s.model = event.model
      s.effort = event.effort
      s.verbosity = event.verbosity
      s.serviceTier = event.serviceTier ?? null
      if (event.permissionPreset) s.permissionPreset = event.permissionPreset
    }
  }

  /** Records the event as a stored row where the host would, and returns the event as it is broadcast (with its seq) */
  record(s: SessionInfo, event: NormalizedEvent, incoming: NormalizedEvent): NormalizedEvent {
    let out: NormalizedEvent = incoming
    /*
     * The same rule as the real thing (the host): an event that stays in the record gets a
     * seq within the session and carries it in the broadcast. The UI's unread tracking
     * (lastSeq) trusts only this seq — if the mock does not carry it, a bug that the real
     * thing would catch slips by quietly in tests only.
     */
    const kind =
      event.type === 'tool_call'
        ? ('tool_call' as const)
        : event.type === 'tool_result'
          ? ('tool_result' as const)
          : event.type === 'approval_request' || event.type === 'approval_resolved'
            ? ('approval' as const)
            : event.type === 'message_delta'
              ? ('text' as const)
              : // A reasoning summary (#58) — the same rule as the real thing: recorded only when text is carried
                event.type === 'reasoning_delta' && event.text
                ? ('reasoning' as const)
                : // A message that came in from outside (FR-11). The real payload is {text, from}, and the event
                  // holds both of them as-is, so restoring it (messagesToChat) brings back the same screen
                  event.type === 'user_message'
                  ? ('text' as const)
                  : event.type === 'compaction' || event.type === 'conversation_reset' || event.type === 'notice'
                    ? ('marker' as const)
                    : // Images persist too (#40, second pass). The real thing has a file plus a path, but the
                      // mock's disk is memory — leaving the bytes as-is in the payload lets loadMessages restore
                      // the same screen as the real thing
                      event.type === 'message_image'
                      ? ('image' as const)
                      : null
    /*
     * An in-conversation app screen (M4 B-1) — like the real thing, records only open and rejected, with no
     * body (manager.persistMessage). A reopened screen sets up its placeholder from this.
     */
    if (event.type === 'app_view' && (event.phase === 'open' || event.phase === 'rejected')) {
      const seq = (this.messages.get(s.id)?.length ?? 0) + 1
      const { type, sessionId, callId, appId, projectId, tool, phase, reason } = event
      this.pushMessage({
        sessionId: s.id,
        seq,
        role: 'system',
        kind: 'app_view',
        payload: { type, sessionId, callId, appId, projectId, tool, phase, ...(reason ? { reason } : {}) },
        ts: this.clock.now(),
      })
      s.lastSeq = seq
      out = { ...event, seq } as NormalizedEvent
    }
    /*
     * A streaming message is gathered into one row — the same rule as the real thing (host
     * persistMessage, #66). A chunk of the same kind grows the open row and carries that
     * row's number. A different row (a tool, a human message — pushMessage) or the end of
     * a turn closes it. Making a new row per chunk would give each chunk a different
     * number, and a screen that splits messages by number (#77) would draw one message as
     * broken up chunk by chunk.
     */
    const streamKind =
      event.type === 'message_delta' ? 'text' : event.type === 'reasoning_delta' && event.text ? 'reasoning' : null
    const piece = streamKind ? ((event as { text?: string }).text ?? '') : ''
    const run = this.streams.get(s.id)
    if (streamKind && run?.kind === streamKind) {
      run.payload = { ...(run.payload as object), text: String((run.payload as { text?: string }).text ?? '') + piece }
      s.lastSeq = run.seq
      out = { ...event, seq: run.seq } as NormalizedEvent
    } else {
      const closes =
        streamKind !== null ||
        event.type === 'turn_complete' ||
        event.type === 'error' ||
        (event.type === 'state_change' && event.state !== 'working')
      if (closes) this.streams.delete(s.id)
      // Does not start a row with an empty chunk — like the real thing, does not carry a number either
      if (kind && !(streamKind && !piece)) {
        const row: StoredMessage = {
          sessionId: s.id,
          seq: (this.messages.get(s.id)?.length ?? 0) + 1,
          role:
            event.type === 'message_delta' || event.type === 'reasoning_delta'
              ? 'assistant'
              : event.type === 'user_message'
                ? 'user'
                : 'system',
          kind,
          payload: event,
          ts: this.clock.now(),
        }
        this.pushMessage(row)
        if (streamKind) this.streams.set(s.id, row)
        s.lastSeq = row.seq
        out = { ...event, seq: row.seq } as NormalizedEvent
      }
    }
    return out
  }

  constructor(
    private readonly clock: MockClock,
  ) {}
}

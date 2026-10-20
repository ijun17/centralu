import {
  appViewRecord,
  applySessionState,
  continuesStreamRow,
  endsStreamRow,
  isRecord,
  keepsSubagentStep,
  nextContext,
  recordedRowKind,
  streamRowKind,
  subagentStepRow,
  type NormalizedEvent,
  type SessionInfo,
  type StoredMessage,
} from '@cc/protocol'
import type { MockClock } from './clock.js'

/** The event as the host broadcasts it, carrying the number its row was stored under */
const withSeq = (e: NormalizedEvent, seq: number): NormalizedEvent => Object.assign({}, e, { seq })

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
  /**
   * When a subagent step was archived without its session (#418), keyed `<session id> <launch call id> <seq>`. The
   * step stays in `subagentMessages`, as the host keeps its row with `trashed_at` set, so later steps number after it
   */
  subagentTrashedAt = new Map<string, number>()
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
   * A native subagent's step (#222) — see `MockPlatform.emit`. Returns the step number, to carry in the broadcast, or
   * null for a step the host neither keeps nor sends on (a chunk with no text).
   */
  recordSubagentStep(event: Extract<NormalizedEvent, { type: 'subagent_event' }>): number | null {
    /*
     * A native subagent's step (#222) — like the host: kept under its launch card, apart from the conversation, numbered
     * within that launch (`stepSeq`), and sent on without a conversation seq. It never touches the session's state or
     * its open text row.
     */
    const step = event.step
    if (!keepsSubagentStep(step)) return null
    const key = `${event.sessionId} ${event.parentCallId}`
    const rows = this.subagentMessages.get(key) ?? []
    // After the last one kept, as the host numbers them (`MAX(seq) + 1`): a step deleted from the session archive frees no number before it
    const stepSeq = (rows.at(-1)?.seq ?? 0) + 1
    rows.push({ sessionId: event.sessionId, seq: stepSeq, ...subagentStepRow(step), payload: step, ts: this.clock.now() })
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
        (m) => m.kind === 'marker' && isRecord(m.payload) && m.payload.type === 'notice' && m.payload.text === event.text,
      )
    )
  }

  /** Folds an event into the session it belongs to, the way the host's live facts do */
  applyLiveFacts(s: SessionInfo, event: NormalizedEvent): void {
    /*
     * The same rules as the real thing (`applySessionState`, protocol session-state.ts): the state, when the wait
     * began, and the live cards **stay on the session**. Only emitting them as events would make a card disappear on
     * every path that re-fetches the list (reconnect, refresh) — if it stays in the real thing but disappears only in
     * the mock, that difference shows up on screen only. A copy kept here left a question in waiting_input (#428).
     */
    applySessionState(s, event, this.clock.now())
    if (event.type === 'worktree_merged') {
      // The same rule as the real thing (#69): must stay in the list after a reconnect too
      s.worktreeMerged = true
    } else if (event.type === 'worktree_pr') {
      // The same rule as the real thing (#76 stage 3): the PR state also stays in the list after a reconnect
      s.worktreePr = event.pr
    }
    /*
     * The same rule as the real thing (the host, `nextContext`): context usage **stays on the session** (issue #48), a
     * fresh conversation empties the gauge until the tool reports again (#304), and a compaction that says its size
     * moves it there (#1282).
     *
     * While the mock only emitted the reading, the gauge reverted to `—` on every path that re-fetches the list (app
     * restart, reconnect) — the real thing holds onto the value, so if this spot is left empty, e2e passes a state the
     * real thing could never produce as normal.
     */
    s.context = nextContext(s.context, event)
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

  /**
   * Records the event as a stored row where the host would, and returns the event as it is broadcast (with its seq).
   *
   * The same rules as the real thing (host `SessionRecord.persistMessage`), read from one place (protocol
   * transcript-rows.ts): which events are recorded, that a streaming message is gathered into one row (#66) and one row
   * is one message (#77, a chunk naming another `messageId` starts a new row, #212), and where a message ends. An event
   * that stays in the record gets a seq within the session and carries it in the broadcast: the UI's unread tracking
   * (lastSeq) trusts only this seq, and a screen that splits messages by number draws whatever rows this keeps.
   */
  record(s: SessionInfo, event: NormalizedEvent, incoming: NormalizedEvent): NormalizedEvent {
    const streamKind = streamRowKind(event)
    if (streamKind) {
      const piece = 'text' in event && typeof event.text === 'string' ? event.text : ''
      const run = this.streams.get(s.id)
      if (run && continuesStreamRow(run, event)) {
        const before = isRecord(run.payload) ? run.payload : {}
        run.payload = { ...before, text: (typeof before.text === 'string' ? before.text : '') + piece }
        s.lastSeq = run.seq
        return withSeq(incoming, run.seq)
      }
      this.streams.delete(s.id)
      // Does not start a row with an empty chunk — like the real thing, does not carry a number either
      if (!piece) return incoming
      const row = this.append(s, 'assistant', streamKind, event)
      this.streams.set(s.id, row)
      return withSeq(incoming, row.seq)
    }
    if (endsStreamRow(event)) this.streams.delete(s.id)
    const recorded = recordedRowKind(event)
    if (recorded) {
      const row = this.append(s, 'system', recorded, event.type === 'app_view' ? appViewRecord(event) : event)
      return withSeq(incoming, row.seq)
    }
    /*
     * Two rows the host writes on their own paths (`sendMessage`, `persistImage`). A message that came in from outside
     * (FR-11): the real payload is {text, from}, and the event holds both of them as-is, so restoring it
     * (messagesToChat) brings back the same screen. Images persist too (#40, second pass): the real thing has a file
     * plus a path, but the mock's disk is memory, so the bytes stay in the payload and loadMessages restores the same
     * screen.
     */
    if (event.type === 'user_message' || event.type === 'message_image') {
      const row = event.type === 'user_message' ? this.append(s, 'user', 'text', event) : this.append(s, 'system', 'image', event)
      return withSeq(incoming, row.seq)
    }
    return incoming
  }

  /** Appends a row with the session's next seq (which closes whatever was streaming) and moves the session's lastSeq */
  private append(s: SessionInfo, role: StoredMessage['role'], kind: StoredMessage['kind'], payload: unknown): StoredMessage {
    const row: StoredMessage = { sessionId: s.id, seq: (this.messages.get(s.id)?.length ?? 0) + 1, role, kind, payload, ts: this.clock.now() }
    this.pushMessage(row)
    s.lastSeq = row.seq
    return row
  }

  constructor(
    private readonly clock: MockClock,
  ) {}
}

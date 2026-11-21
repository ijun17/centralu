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
} from '@cc/protocol/client'
import type { MockClock } from './clock.js'

/** The event as the host broadcasts it, carrying the number its row was stored under */
const withSeq = (e: NormalizedEvent, seq: number): NormalizedEvent => Object.assign({}, e, { seq })

/**
 * The mock's sessions and their conversations: the session list, the stored rows, each session's open text row,
 * and the pieces of `MockPlatform.emit` that fold an event into them.
 */
export class SessionStore {
  sessions = new Map<string, SessionInfo>()
  /** Open so a test can seed a long history */
  messages = new Map<string, StoredMessage[]>()
  /** A subagent's steps per launch card (#222), keyed `<session id> <launch call id>` */
  subagentMessages = new Map<string, StoredMessage[]>()
  /**
   * A step archived without its session (#418), keyed `<session id> <launch call id> <seq>`. It stays in
   * `subagentMessages`, as the host keeps the row with `trashed_at`, so later steps number after it
   */
  subagentTrashedAt = new Map<string, number>()
  subagentReads = 0
  /** The streaming text row per session: the very row inside `messages` */
  private streams = new Map<string, StoredMessage>()

  pushMessage(m: StoredMessage): void {
    this.streams.delete(m.sessionId) // A new row ends the stream; emit reopens it for a stream's first row
    const arr = this.messages.get(m.sessionId) ?? []
    arr.push(m)
    this.messages.set(m.sessionId, arr)
  }

  /**
   * A native subagent's step (#222), as the host: kept under its launch card, numbered within it, sent on without a
   * conversation seq, and never touching the session. Null for a step the host neither keeps nor sends (no text).
   */
  recordSubagentStep(event: Extract<NormalizedEvent, { type: 'subagent_event' }>): number | null {
    const step = event.step
    if (!keepsSubagentStep(step)) return null
    const key = `${event.sessionId} ${event.parentCallId}`
    const rows = this.subagentMessages.get(key) ?? []
    // As the host numbers them (`MAX(seq) + 1`): an archived step frees no number before it
    const stepSeq = (rows.at(-1)?.seq ?? 0) + 1
    rows.push({ sessionId: event.sessionId, seq: stepSeq, ...subagentStepRow(step), payload: step, ts: this.clock.now() })
    this.subagentMessages.set(key, rows)
    return stepSeq
  }

  isRepeatedNotice(event: NormalizedEvent): boolean {
    // Text the tool repeats on every start (#304): one stored line per session, as on the host
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
     * The host's `applySessionState`: the state, the wait start and the live cards stay on the session, so a path that
     * re-fetches the list (reconnect, refresh) still shows them (#428).
     */
    applySessionState(s, event, this.clock.now())
    if (event.type === 'worktree_merged') {
      // As the host (#69): stays in the list after a reconnect
      s.worktreeMerged = true
    } else if (event.type === 'worktree_pr') {
      // As the host (#76): stays in the list after a reconnect
      s.worktreePr = event.pr
    }
    /*
     * The host's `nextContext`: usage stays on the session for a re-fetch (#48), a fresh conversation empties it
     * (#304), and a compaction that says its size sets it (#1282).
     */
    s.context = nextContext(s.context, event)
    // As the host (#297): the CLI version the process reports stays on the session
    if (event.type === 'agent_version') s.agentVersion = event.version
    // As the host (#568): a session put to sleep lists as not live until it is woken
    if (event.type === 'session_live') s.live = event.live
    // As the host (#698): why the last turn stopped stays on the session until it works again
    if (event.type === 'interruption') s.interruption = event.interruption
    if (event.type === 'state_change' && event.state === 'working') s.interruption = null
    /*
     * A switch the tool made (#304, #659) stays on the session for a reconnect. The host applies only what differs
     * from the launch; the mock has no process, so it takes the snapshot as it is.
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
   * Records a row where the host's `SessionRecord.persistMessage` would, by protocol transcript-rows.ts (#66, #77,
   * #212), and returns the event with its seq: the UI's unread tracking (lastSeq) trusts only this seq.
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
      // As the host: an empty chunk starts no row and carries no number
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
     * Rows the host writes on their own paths (`sendMessage`, `persistImage`): an outside message keeps {text, from}
     * (FR-11); an image keeps its bytes in the payload where the host keeps a file (#40), so a reload draws the same.
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

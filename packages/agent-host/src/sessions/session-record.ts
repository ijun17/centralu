import { CacheLedger } from './cache-ledger.js'
import type {
  NormalizedEvent,
  PermissionPreset,
  SessionInfo,
  StoredMessage,
} from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { saveAttachment, sweepAttachments } from '../dev-services/attachments.js'

/**
 * Interval for flushing to disk during streaming (#66).
 *
 * Now that one message is one row, the per-delta safety net is replaced by a periodic flush —
 * the most that can be lost on a crash is the last 2 seconds (or 2,000 characters). Why not
 * flush on every delta: it would rewrite the whole growing body every time, so the amount
 * written grows quadratically for a long answer.
 */
const STREAM_FLUSH_CHARS = 2000

export const STREAM_FLUSH_MS = 2000

/**
 * What the session record reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type SessionRecordHost = {
  readonly cacheLedger: CacheLedger
  readonly emit: (e: NormalizedEvent) => void
  readonly meta: Map<string, SessionInfo>
  observeCommit: (e: Extract<NormalizedEvent, { type: "tool_call" | "tool_result"; }>, m: SessionInfo) => void
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  readonly store: Store
}

/**
 * What a session's events leave in the store (#66, #304): the message being streamed and its flushes, the rows each
 * event writes, the images and attachments it names, the settings a tool reported, a subagent's steps, and the events
 * a session sent before it existed. Moved out of the session manager as it was (#428); what it reaches of the manager
 * is `SessionRecordHost`.
 */
export class SessionRecord {
  constructor(private readonly host: SessionRecordHost) {}

  /**
   * The message currently streaming — one per session (#66).
   *
   * Now that the unit of storage changed from delta to message, this is where we hold "which row
   * is this session's open message". As deltas arrive the body grows (periodic flush), and when a
   * boundary is hit (tool call, turn end, the person's message, process exit) it closes and gets
   * indexed exactly once at that point.
   */
  readonly streams = new Map<
    string,
    { seq: number; kind: 'text' | 'reasoning'; payload: Record<string, unknown>; text: string; written: number; lastWrite: number }
  >()

  /**
   * **The configuration the currently running process actually holds.**
   *
   * This can differ from meta (the value shown on screen). Permissions and model are fixed when the
   * tool is launched, so a mismatch can arise where the screen changes to "auto" but the process
   * keeps running with the old configuration. In that state, picking "auto" again does nothing,
   * because compared against meta nothing changed (dogfooding: "it shows auto selected but keeps
   * asking anyway"). So the comparison baseline is always this map, not meta.
   */
  /**
   * Events a session's tool sent while `createSession` was still waiting for it to come up (#304). The session is
   * registered only once the adapter answers (a failed start must leave no ghost), so anything emitted before then
   * had no session to be recorded under: it went out unnumbered and was never stored. Measured with codex-cli 0.160.0:
   * `configWarning` arrives while `thread/start` is being answered, and its notice was lost from the record while the
   * thread's own `warning` with the same text was stored. Held here and replayed once the session exists; dropped
   * with it if the start fails.
   */
  readonly unborn = new Map<string, NormalizedEvent[]>()

  /**
   * Only saves events meant to become part of the conversation record. If it was saved, returns the
   * in-session seq assigned to it — carried in the broadcast, it is the basis for the UI's unread
   * tracking.
   *
   * **A streaming delta never creates a row — it grows the row already open** (#66).
   * A single delta used to be a single row — one sentence became nine rows, 84% of the DB was
   * fragments, pagination lost all meaning while it was busy counting rows, and the trigram index
   * could not index a 1-2 character body, which killed search. Now a single row is created when a
   * message starts (the first chunk is written there and then, so at least the start survives a
   * crash), and every chunk after that is appended to the body and flushed only periodically. It is
   * indexed exactly once, when the stream closes.
   */
  persistMessage(e: NormalizedEvent, m: SessionInfo): number | null {
    // A reasoning summary (#58) only counts as recorded once text is actually attached. A chunk with
    // nothing but estTokens (claude) lives only as a progress indicator and then disappears: stacking
    // up content-free rows would turn the record into noise.
    if (e.type === 'message_delta' || (e.type === 'reasoning_delta' && e.text)) {
      const streamKind = e.type === 'message_delta' ? ('text' as const) : ('reasoning' as const)
      const text = e.text ?? ''
      const run = this.streams.get(m.id)
      /*
       * A chunk that names a different message than the open row is a new message (#212). Codex can say two
       * things in a row with nothing recorded between them (a poll of a running command is not an item), and
       * with no boundary here the two became one row: "…polling it now.It is still running…". A chunk that
       * names no message continues the open row, as before.
       */
      const messageId = e.type === 'message_delta' ? e.messageId : undefined
      const openId = run?.payload.messageId
      const newMessage = !!messageId && typeof openId === 'string' && openId !== messageId
      if (run && run.kind === streamKind && !newMessage) {
        run.text += text
        if (run.text.length - run.written >= STREAM_FLUSH_CHARS || Date.now() - run.lastWrite >= STREAM_FLUSH_MS) {
          this.flushStream(m.id, run)
        }
        m.lastSeq = run.seq
        return run.seq
      }
      // If the kind changes (answer <-> reasoning) or the message does, that point is a boundary
      if (run) this.closeStream(m.id)
      // A row is never started with an empty chunk — the "" delta codex sends at the end once created 1,853
      // empty rows
      if (!text) return null
      const seq = this.host.store.nextSeq(m.id)
      const fresh = { seq, kind: streamKind, payload: { ...e } as Record<string, unknown>, text, written: 0, lastWrite: 0 }
      this.streams.set(m.id, fresh)
      this.flushStream(m.id, fresh)
      m.lastSeq = seq
      return seq
    }

    /*
     * Any **recorded** event that is not a stream is a message boundary — if a tool call arrives in
     * the middle of an answer, everything before it is one chunk. Meanwhile, an event that is never
     * recorded, like activity or usage_update, blends naturally with streaming and is not a boundary.
     * The end of a turn (turn_complete, error, or a state_change that is not working) is a boundary
     * too — nothing gets recorded for it, but the message has ended.
     */
    const kind =
      e.type === 'tool_call' ? 'tool_call'
      : e.type === 'tool_result' ? 'tool_result'
      : e.type === 'approval_request' || e.type === 'approval_resolved' ? 'approval'
      // Records the compaction point. In the model's own context, old conversation is folded away, but
      // it still exists as-is in our record — showing where it was folded is what makes reading back through
      // it possible.
      : e.type === 'compaction' ? 'marker'
      // The same reason for a fresh conversation inside the session (#304): the model forgot, our record did not
      : e.type === 'conversation_reset' ? 'marker'
      // What the tool wanted the person to read (#304) — a line in the transcript, like an error
      : e.type === 'notice' ? 'marker'
      /*
       * A failure is part of the record too (#107). An error used to just change state and move on —
       * all that remained on screen was a single `lastError` line, and even that was cleared the
       * moment the next turn began. So the spot where a turn died with a 400 was left with **an empty
       * answer**, and nowhere recorded why it was empty. Stamping it as a marker keeps that moment in
       * the transcript (and in a handoff record).
       */
      : e.type === 'error' ? 'marker'
      /*
       * Inline app view (M4 B-1): all that is recorded is which app's view was raised under this card
       * (or that it was rejected). A result, cancellation or closing are events that happen while that
       * view is alive, so none of them are recorded.
       */
      : e.type === 'app_view' && (e.phase === 'open' || e.phase === 'rejected') ? 'app_view'
      : null
    const boundary =
      kind !== null ||
      e.type === 'turn_complete' ||
      e.type === 'error' ||
      (e.type === 'state_change' && e.state !== 'working')
    if (boundary) this.closeStream(m.id)
    if (!kind) return null
    const seq = this.host.store.nextSeq(m.id)
    /*
     * The record of an app view **never carries the body** — the tool's input is passed through to
     * the app exactly as given, so it is unknown what it contains. Same reason an app run record
     * (A-6) only ever keeps a summary of its arguments. The instance id also has no meaning once this
     * host process ends.
     */
    const payload =
      e.type === 'app_view'
        ? { type: e.type, sessionId: e.sessionId, callId: e.callId, appId: e.appId, projectId: e.projectId, tool: e.tool, phase: e.phase, ...(e.reason ? { reason: e.reason } : {}) }
        : e
    const msg: StoredMessage = { sessionId: m.id, seq, role: 'system', kind, payload, ts: Date.now() }
    this.host.store.appendMessages([msg])
    m.lastSeq = seq
    return seq
  }

  /**
   * The agent tool switched a setting by itself (#304): Claude Code's refusal fallback, another Codex client changing
   * the thread. The process already runs with the new value, so this is recorded, not applied: no restart, and the
   * process's launch record (`running`) moves along with it so `settingsDrifted` does not read it as a change the person
   * still wants made. Only the fields that differ from that launch record are taken — the adapter's snapshot is its own
   * view. A field the person changed mid-turn (saved, waiting for the turn to end) keeps the person's value: the launch
   * record still moves, so the restart at the turn's end applies their choice over the tool's. The project's remembered
   * default is left alone: the person did not choose this. The broadcast is the host's full snapshot.
   */
  recordToolSettings(e: Extract<NormalizedEvent, { type: 'settings_changed' }>): void {
    const m = this.host.meta.get(e.sessionId)
    if (!m) return
    const live = this.host.running.get(e.sessionId)
    // The tool switched models by itself (a refusal's fallback, #304): the next request reads none of the cache
    if (e.model !== undefined && e.model !== (live ?? m).model) this.host.cacheLedger.note(e.sessionId, 'model_change')
    let changed = false
    for (const k of ['model', 'effort', 'verbosity', 'serviceTier'] as const) {
      const v = e[k]
      if (v === undefined || v === (live ?? m)[k]) continue
      const pending = !!live && m[k] !== live[k]
      if (live) live[k] = v
      if (pending) continue
      m[k] = v
      changed = true
    }
    if (!changed) return
    this.host.store.upsertSession(m)
    this.host.emit({
      type: 'settings_changed',
      sessionId: m.id,
      model: m.model,
      effort: m.effort,
      verbosity: m.verbosity,
      serviceTier: m.serviceTier,
      by: 'tool',
    })
  }

  /**
   * A native subagent's step (#222): kept under the card that launched it, then sent on as its card.
   *
   * It is **not the conversation**, so it skips everything `onEvent` does with the parent's events: it moves no state
   * (a background agent's steps arrive while the parent waits for the person), it does not close the parent's open
   * text row (that split the parent's paragraph mid-word, #98), it takes no conversation seq (so it is never unread),
   * and it is not indexed. A step's text arrives whole (see `SubagentStep`), so it is one row as it comes.
   *
   * Two things a subagent does are still the session's: a file it edited (the adapter reports `files_touched` as the
   * parent's) and a commit it made, which is attributed to this session like the parent's own (#50).
   */
  recordSubagentStep(e: Extract<NormalizedEvent, { type: 'subagent_event' }>): void {
    const m = this.host.meta.get(e.sessionId)
    if (!m) return
    const step = e.step
    if (step.type === 'reasoning_delta' && !step.text) return
    if (step.type === 'message_delta' && !step.text) return
    const kind =
      step.type === 'message_delta' ? ('text' as const)
      : step.type === 'reasoning_delta' ? ('reasoning' as const)
      : step.type
    const role = kind === 'text' || kind === 'reasoning' ? ('assistant' as const) : ('system' as const)
    const stepSeq = this.host.store.appendSubagentMessage(m.id, e.parentCallId, { role, kind, payload: step, ts: Date.now() })
    if (step.type === 'tool_call' || step.type === 'tool_result') this.host.observeCommit(step, m)
    this.host.emit({ ...e, stepSeq })
  }

  /** Writes an open stream row to disk exactly as it stands right now — indexed only once, when it closes
   * (#66) */
  flushStream(sessionId: string, run: { seq: number; kind: 'text' | 'reasoning'; payload: Record<string, unknown>; text: string; written: number; lastWrite: number }): void {
    this.host.store.upsertMessageNoIndex({
      sessionId, seq: run.seq, role: 'assistant', kind: run.kind,
      payload: { ...run.payload, text: run.text }, ts: Date.now(),
    })
    run.written = run.text.length
    run.lastWrite = Date.now()
  }

  /** The message has ended — its final form is written and it is only now put into the search index (#66) */
  closeStream(sessionId: string): void {
    const run = this.streams.get(sessionId)
    if (!run) return
    this.streams.delete(sessionId)
    this.host.store.appendMessages([
      {
        sessionId, seq: run.seq, role: 'assistant', kind: run.kind,
        payload: { ...run.payload, text: run.text }, ts: Date.now(),
      },
    ])
  }

  saveAttachment(sessionId: string, name: string, mime: string, dataBase64: string) {
    return saveAttachment(sessionId, name, mime, dataBase64)
  }

  /**
   * Persistence for an image the agent produces (#40, second decision on 2026-08-26: display-only
   * -> persisted, with a 500MB total cap). Bytes go to an attachments file, and only the path goes
   * into the DB row — the same structure as a user-to-agent attachment, so the DB always stays
   * text-only.
   */
  async persistImage(e: Extract<NormalizedEvent, { type: 'message_image' }>, m: SessionInfo): Promise<void> {
    let stored: string | undefined
    let note = e.note
    if (e.data) {
      try {
        stored = (await saveAttachment(m.id, 'agent-image', e.mime, e.data)).path
        // Keeping under the cap is the writer's responsibility — once it overflows, the oldest files are
        // swept first
        void sweepAttachments().catch(() => {})
      } catch (err) {
        note = `Could not save the image: ${(err as Error).message}`
      }
    }
    const payload: NormalizedEvent = {
      type: 'message_image', sessionId: m.id, mime: e.mime, data: '', path: stored ?? e.path, note,
    }
    const seq = this.host.store.nextSeq(m.id)
    this.host.store.appendMessages([{ sessionId: m.id, seq, role: 'system', kind: 'image', payload, ts: Date.now() }])
    m.lastSeq = seq
    this.host.store.upsertSession(m)
  }
}

import type { ModelWindows } from './auto-compact.js'
import type { CacheLedger } from './cache-ledger.js'
import {
  appViewRecord,
  continuesStreamRow,
  endsStreamRow,
  keepsSubagentStep,
  recordedRowKind,
  streamRowKind,
  subagentStepRow,
  type Attachment,
  type MessageImage,
  type NormalizedEvent,
  type PermissionPreset,
  type SessionInfo,
  type StoredMessage,
} from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { mentions, readMessageImage, resolveWrittenPath, writtenForms } from '../dev-services/message-image.js'
import { saveAttachment, sweepAttachments } from '../dev-services/attachments.js'

/**
 * Interval for flushing to disk during streaming (#66).
 *
 * Now that one message is one row, the per-delta safety net is replaced by a periodic flush —
 * the most that can be lost on a crash is the last 2 seconds (or 2,000 characters). Why not
 * flush on every delta: it would rewrite the whole growing body every time, so the amount
 * written grows quadratically for a long answer.
 */
export const STREAM_FLUSH_CHARS = 2000

export const STREAM_FLUSH_MS = 2000

/**
 * What the session record reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type SessionRecordHost = {
  readonly cacheLedger: CacheLedger
  /** Each model's context window as the tools reported it (`ModelWindows`, auto-compact.ts) */
  readonly modelWindows: ModelWindows
  readonly emit: (e: NormalizedEvent) => void
  readonly meta: Map<string, SessionInfo>
  observeCommit: (e: Extract<NormalizedEvent, { type: "tool_call" | "tool_result"; }>, m: SessionInfo) => void
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  readonly store: Store
  /** Where the session actually runs: the stored path, derived once for an old row (#28) */
  cwdFor: (m: SessionInfo) => string
  /** A session's row, or `session_not_found` */
  sessionOf: (sessionId: string) => SessionInfo
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
    // Which chunks grow a row and where a message ends are shared with the mock (protocol transcript-rows.ts)
    const streamKind = streamRowKind(e)
    if (streamKind) {
      const text = (e as { text?: string }).text ?? ''
      const run = this.streams.get(m.id)
      if (run && continuesStreamRow(run, e)) {
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
      const seq = this.host.store.messages.nextSeq(m.id)
      const fresh = { seq, kind: streamKind, payload: { ...e } as Record<string, unknown>, text, written: 0, lastWrite: 0 }
      this.streams.set(m.id, fresh)
      this.flushStream(m.id, fresh)
      m.lastSeq = seq
      return seq
    }

    // Any recorded event that is not a stream, and the end of a turn, is a message boundary (`endsStreamRow`)
    const kind = recordedRowKind(e)
    if (endsStreamRow(e)) this.closeStream(m.id)
    if (e.type === 'message_image') return this.persistImage(e, m)
    if (!kind) return null
    const seq = this.host.store.messages.nextSeq(m.id)
    // The record of an app view never carries the body (`appViewRecord`)
    const payload = e.type === 'app_view' ? appViewRecord(e) : e
    const msg: StoredMessage = { sessionId: m.id, seq, role: 'system', kind, payload, ts: Date.now() }
    this.host.store.messages.appendMessages([msg])
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
    this.host.store.sessions.upsertSession(m)
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
    if (!keepsSubagentStep(step)) return
    const stepSeq = this.host.store.messages.appendSubagentMessage(m.id, e.parentCallId, { ...subagentStepRow(step), payload: step, ts: Date.now() })
    if (step.type === 'tool_call' || step.type === 'tool_result') this.host.observeCommit(step, m)
    this.host.emit({ ...e, stepSeq })
  }

  /** Writes an open stream row to disk exactly as it stands right now — indexed only once, when it closes
   * (#66) */
  flushStream(sessionId: string, run: { seq: number; kind: 'text' | 'reasoning'; payload: Record<string, unknown>; text: string; written: number; lastWrite: number }): void {
    this.host.store.messages.upsertMessageNoIndex({
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
    this.host.store.messages.appendMessages([
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
  /**
   * **Its row is taken at once, in the order the image came** (#868), and the file is written after. The row used to be
   * taken only once the file was saved, so the text that followed the image could take its number first and be stored
   * above it. The row first holds what the event says (a path the tool gave, a note); once the bytes are in a file it is
   * rewritten with that file's path, or with why it could not be saved. Returns the row's number.
   */
  persistImage(e: Extract<NormalizedEvent, { type: 'message_image' }>, m: SessionInfo): number {
    const ts = Date.now()
    const seq = this.host.store.messages.nextSeq(m.id)
    const row = (path: string | undefined, note: string | undefined): StoredMessage => ({
      sessionId: m.id, seq, role: 'system', kind: 'image', ts,
      payload: { type: 'message_image', sessionId: m.id, mime: e.mime, data: '', path, note } satisfies NormalizedEvent,
    })
    this.host.store.messages.appendMessages([row(e.path, e.note)])
    m.lastSeq = seq
    if (e.data) void this.saveImage(e, m, row)
    return seq
  }

  /** Writes an image's bytes to an attachment file and points its row at it */
  private async saveImage(
    e: Extract<NormalizedEvent, { type: 'message_image' }>,
    m: SessionInfo,
    row: (path: string | undefined, note: string | undefined) => StoredMessage,
  ): Promise<void> {
    let stored: string | undefined
    let note = e.note
    try {
      stored = (await saveAttachment(m.id, 'agent-image', e.mime, e.data)).path
      // Keeping under the cap is the writer's responsibility — once it overflows, the oldest files are
      // swept first
      void sweepAttachments().catch(() => {})
    } catch (err) {
      note = `Could not save the image: ${(err as Error).message}`
    }
    try {
      this.host.store.messages.upsertMessageNoIndex(row(stored ?? e.path, note))
    } catch {
      // The store is closed (the host is leaving): the row keeps what it was written with
    }
  }

  /**
   * A local image one of this session's replies names (`messages.image`; dev-services/message-image.ts).
   *
   * The reply is asked first, before the path is resolved or anything on disk is touched: a path no reply of this
   * session wrote is refused without saying whether it exists. A reply still streaming is asked too, from memory: its
   * row is written every two seconds (`STREAM_FLUSH_MS`), and the window draws the image as soon as the `)` arrives.
   * A relative path is read against the folder the session runs in, as the agent that wrote it meant it.
   */
  async messageImage(sessionId: string, written: string): Promise<MessageImage> {
    const m = this.host.sessionOf(sessionId)
    if (!this.repliesName(sessionId, written)) {
      return { ok: false, reason: 'not_mentioned', message: 'No reply in this session names this path, so it is not read' }
    }
    const abs = resolveWrittenPath(written, this.host.cwdFor(m))
    if (abs === null) return { ok: false, reason: 'not_found', message: `${written} is not a path on this machine` }
    return readMessageImage(abs)
  }

  repliesName(sessionId: string, written: string): boolean {
    const open = this.streams.get(sessionId)
    if (open?.kind === 'text' && mentions(open.text, written)) return true
    return writtenForms(written).some((form) => this.host.store.messages.replyTextsContaining(sessionId, form).some((text) => mentions(text, written)))
  }

  /**
   * The steps of the subagent one card launched (#222) — the only read of them, asked when the person opens that
   * card's steps. As cards: a tool's `input` and `output` stay in the store, as for a history page (#221).
   * A archived session's cards can be opened in its read-only view, so this does not refuse the session archive.
   */
  loadSubagentMessages(sessionId: string, parentCallId: string, afterSeq: number | undefined, limit: number): StoredMessage[] {
    return this.host.store.messages.loadSubagentMessages(sessionId, parentCallId, { afterSeq, limit })
  }

  async loadMessages(sessionId: string, limit: number, beforeSeq?: number): Promise<StoredMessage[]> {
    const rows = this.host.store.messages.loadMessages(sessionId, limit, beforeSeq)
    /*
     * An image row stores only a path (#40) — the bytes are loaded back in when handing it to the
     * screen. If the file is gone (cleaned up by the 500MB cap, or deleted outside), the reason is
     * loaded instead of a silent blank.
     */
    const { readFile } = await import('node:fs/promises')
    return Promise.all(
      rows.map(async (r) => {
        if (r.kind === 'image') {
          const p = r.payload as Extract<NormalizedEvent, { type: 'message_image' }>
          if (!p.path || p.note) return r
          try {
            const data = (await readFile(p.path)).toString('base64')
            return { ...r, payload: { ...p, data } }
          } catch {
            return { ...r, payload: { ...p, note: 'The image was cleared and no longer exists (total-size cap)' } }
          }
        }
        // A user attachment's own image follows the same rule — bytes are loaded if the file is still
        // there, and if it was cleaned up the path alone is left quietly (the screen falls back to a name
        // chip)
        if (r.kind === 'text' && r.role === 'user') {
          const p = r.payload as { attachments?: Attachment[] }
          if (!p?.attachments?.some((a) => a.kind === 'image')) return r
          const attachments = await Promise.all(
            p.attachments.map(async (a) => {
              if (a.kind !== 'image') return a
              try {
                return { ...a, data: (await readFile(a.path)).toString('base64') }
              } catch {
                return a
              }
            }),
          )
          return { ...r, payload: { ...p, attachments } }
        }
        return r
      }),
    )
  }
}

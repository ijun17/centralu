import { isObj } from '../../json-value.js'
import { oneRow } from './rows.js'
import type Database from 'better-sqlite3'
import type { StoredMessage } from '@cc/protocol'
import { parseJson } from './json.js'
import { INDEXED_KINDS, indexedText } from './search-index.js'

/**
 * The condition that keeps the trash out of a search (#204). Its index rows are dropped when it goes to the trash;
 * this also covers the ones a trash step cut short left behind.
 */
const OUT_OF_TRASH = `session_id NOT IN (SELECT id FROM sessions WHERE deleted_at IS NOT NULL)`

/**
 * How a stored message is read back (`loadMessages`, `loadMessagesFrom`, and a subagent's steps, `loadSubagentMessages`).
 *
 *   full   include a tool call's `input` and a tool result's `output` — the whole record (#221)
 *
 * Without `full` a tool message reads as its card: `summary` and nothing more. That is the default because every
 * reader today hands what it reads to someone else: the UI (a history page), another session's prompt
 * (`read_session`, `recall`, the Assistant's memory), a successor (the handoff record). Full tool output reaching
 * another session's prompt is the privilege path #73 closed, and an agent `cat`-ing a large file must not ride every
 * page load. A reader that needs the record asks for it by name here, where the question gets asked.
 */
export type ReadOpts = { full?: boolean }

/**
 * The payload column as `ReadOpts` asks for it. The fields are dropped by SQLite (`json_remove`) rather than after
 * `JSON.parse`, so a page never pulls a megabyte of tool output into the host only to throw it away. A payload that is
 * not JSON is passed through as it is: `json_remove` refuses it, and that refusal would fail the whole page (#850).
 */
function payloadColumn(opts: ReadOpts): string {
  return opts.full
    ? 'payload'
    : `CASE WHEN kind IN ('tool_call', 'tool_result') AND json_valid(payload) THEN json_remove(payload, '$.input', '$.output') ELSE payload END as payload`
}

/**
 * Stored rows as messages. **A payload that is not JSON reads as `{}` and the row keeps its place** (#850): one bad row
 * must not fail its page, and dropping it would shorten the page, which the window reads as the start of the
 * conversation (`more: msgs.length >= HISTORY_PAGE`). An empty payload is what every reader already tolerates: no
 * text, no summary.
 */
export function readRows(raw: (StoredMessage & { payload: string })[]): StoredMessage[] {
  return raw.map((r) => {
    const payload = parseJson(r.payload)
    return { ...r, payload: payload === undefined ? {} : payload }
  })
}

/** The conversation: messages and their search index, a subagent's steps, and the full-text search over them */
export class MessageRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * Writes messages — **writing the same spot twice overwrites it, index included.**
   *
   * The index row is pinned to its message row (the messages rowid is its rowid), so INSERT OR REPLACE overwrites it. A
   * plain index INSERT adds a row per rewrite: a real database reached 28,892 messages against 249,809 index rows (8.6x,
   * up to 13 duplicates), recall returned the same line 5 times in a limit of 8, and the index grew to tens of times the
   * text. Deleting by session_id and seq is no alternative: they are UNINDEXED, so it scans all ~250,000 rows per write.
   *
   * messages is UPDATE, not REPLACE: REPLACE deletes and reinserts, which **changes the rowid** the index points at.
   */
  appendMessages(msgs: StoredMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, kind = excluded.kind,
         payload = excluded.payload, ts = excluded.ts`,
    )
    const rowidOf = this.db.prepare<unknown[], { rowid: number }>(`SELECT rowid FROM messages WHERE session_id = ? AND seq = ?`)
    const fts = this.db.prepare(
      `INSERT OR REPLACE INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`,
    )
    /*
     * Deletes by rowid. FTS5's `'delete'` command only works on contentless or external-content
     * tables, and messages_fts is an ordinary table that holds its own text, so that command
     * fails with `SQL logic error` and rolls back other messages in the same batch (#179).
     */
    const dropFts = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    const tx = this.db.transaction((rows: StoredMessage[]) => {
      for (const m of rows) {
        const payload = JSON.stringify(m.payload)
        stmt.run(m.sessionId, m.seq, m.role, m.kind, payload, m.ts)
        const body = indexedText(m.kind, payload)
        const rid = rowidOf.get(m.sessionId, m.seq)?.rowid
        if (rid === undefined) continue
        if (body) {
          fts.run(rid, body, m.sessionId, m.seq)
        } else {
          // A spot whose text disappeared is removed from the index too (otherwise the old text stays searchable)
          dropFts.run(rid)
        }
      }
    })
    tx(msgs)
  }

  /**
   * Full-text search over conversations (E-1). **Returns the whole body**: how much context is needed only the caller
   * knows. Not `snippet(..., 12)`: its 12 counts trigram tokens, about 15 real characters, too little to tell whether
   * a passage is the one looked for.
   */
  searchMessages(query: string, limit = 50): { sessionId: string; seq: number; body: string }[] {
    const q = query.trim()
    if (!q) return []

    // The trigram tokenizer **cannot find anything shorter than 3 characters** (measured).
    // Two-character searches like '승인' or '배포' are common in Korean, so this falls back to LIKE.
    if (q.length < 3) {
      return this.db
        .prepare<unknown[], { sessionId: string; seq: number; body: string }>(
          `SELECT session_id as sessionId, seq, body FROM messages_fts
           WHERE body LIKE ? AND ${OUT_OF_TRASH} ORDER BY seq DESC LIMIT ?`,
        )
        .all(`%${q}%`, limit)
    }

    try {
      return this.db
        .prepare<unknown[], { sessionId: string; seq: number; body: string }>(
          `SELECT session_id as sessionId, seq, body
           FROM messages_fts WHERE messages_fts MATCH ? AND ${OUT_OF_TRASH} ORDER BY rank LIMIT ?`,
        )
        .all(`"${q.replace(/"/g, '""')}"`, limit)
    } catch {
      // An FTS syntax error (special characters, etc.) quietly returns an empty result — the search box must not break
      return []
    }
  }

  /**
   * A search over these sessions only, archived ones included (#1487): their search index rows are dropped on archive, so
   * this reads their messages. What the index holds (`INDEXED_KINDS`), matched by case-insensitive substring: the first
   * session named first, each session's newest first.
   */
  searchSessions(sessionIds: readonly string[], query: string, limit = 50): { sessionId: string; seq: number; body: string }[] {
    const q = query.trim()
    if (!q || sessionIds.length === 0) return []
    const kinds = [...INDEXED_KINDS]
    return this.db
      .prepare<unknown[], { sessionId: string; seq: number; body: string }>(
        `SELECT session_id as sessionId, seq, json_extract(payload, '$.text') as body FROM messages
          WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')})
            AND json_valid(payload) AND json_extract(payload, '$.text') LIKE ? ESCAPE '\\'
          ORDER BY CASE session_id ${sessionIds.map((_, i) => `WHEN ? THEN ${i}`).join(' ')} END, seq DESC LIMIT ?`,
      )
      .all(...sessionIds, ...kinds, `%${q.replace(/[\\%_]/g, '\\$&')}%`, ...sessionIds, limit)
  }

  /**
   * Reads a conversation — **one row is one message** (#77), and `limit` counts rows.
   *
   * Neighboring assistant rows are different messages (a reply after a background task finished or a question card was
   * answered, rows a transcript import writes per reply), so they are not joined: joining runs two replies into one
   * paragraph with no space, like "…still running.All six reviews are in."
   */
  loadMessages(sessionId: string, limit = 200, beforeSeq?: number, opts: ReadOpts = {}): StoredMessage[] {
    const raw = this.db
      .prepare<unknown[], (StoredMessage & { payload: string })>(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM messages
         WHERE session_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, beforeSeq ?? null, beforeSeq ?? null, limit)
    return readRows(raw.reverse())
  }

  /**
   * The text of this session's replies that contain `needle`: the agent's own words (`assistant` `text` rows), and
   * those of the subagents it launched, which the window shows under their cards. The person's messages, reasoning and
   * tool output are not replies. Asked by `messages.image`, which reads only an image a reply names.
   *
   * `instr` over the stored JSON narrows the rows in SQLite; the needle is JSON-escaped the way the payload was
   * written, so a path with a quote or a backslash is still found. The caller decides on the parsed text.
   */
  replyTextsContaining(sessionId: string, needle: string): string[] {
    const escaped = JSON.stringify(needle).slice(1, -1)
    const rows = this.db
      .prepare<unknown[], { payload: string }>(
        `SELECT payload FROM messages
           WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND instr(payload, ?) > 0
         UNION ALL
         SELECT payload FROM subagent_messages
           WHERE session_id = ? AND trashed_at IS NULL AND role = 'assistant' AND kind = 'text' AND instr(payload, ?) > 0`,
      )
      .all(sessionId, escaped, sessionId, escaped)
    const texts: string[] = []
    for (const r of rows) {
      // A row that is not JSON names nothing
      const payload = parseJson(r.payload)
      const text = isObj(payload) ? payload.text : undefined
      if (typeof text === 'string') texts.push(text)
    }
    return texts
  }

  /**
   * The conversation **after** afterSeq — loadMessages's forward-going counterpart (#66).
   * Reads "what was said next" from a spot recall handed back. Same rule: one row is one message (#77).
   */
  loadMessagesFrom(sessionId: string, afterSeq: number, limit = 20, opts: ReadOpts = {}): StoredMessage[] {
    const raw = this.db
      .prepare<unknown[], (StoredMessage & { payload: string })>(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM messages
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit)
    return readRows(raw)
  }

  /** Every user row of the session after `afterSeq`, oldest first, however many (#1639: the messages its tool may still hold) */
  loadUserRowsFrom(sessionId: string, afterSeq: number): StoredMessage[] {
    const raw = this.db
      .prepare<unknown[], (StoredMessage & { payload: string })>(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn({})}, ts FROM messages
         WHERE session_id = ? AND seq > ? AND role = 'user' ORDER BY seq ASC`,
      )
      .all(sessionId, afterSeq)
    return readRows(raw)
  }

  /**
   * The seq of this session's last point where the model lost what came before (#974): a compaction that folded
   * something (a failed one did not), or a fresh conversation (`conversation_reset`, Claude Code's `/clear`). Null when
   * there is none. Both adapters store a compaction as the same marker row, live or read back from the tool
   * (`recordedRowKind`, `historyRow`), so one query covers Claude's `compact_boundary` and Codex's `contextCompaction`.
   * Every message earlier than this seq is in our record but no longer in the model's context.
   */
  lastContextCut(sessionId: string): number | null {
    const row = oneRow(
      this.db
      .prepare<unknown[], { seq: number | null }>(
        `SELECT MAX(seq) as seq FROM messages
         WHERE session_id = ? AND kind = 'marker' AND json_valid(payload) AND (
           json_extract(payload, '$.type') = 'conversation_reset' OR
           (json_extract(payload, '$.type') = 'compaction' AND COALESCE(json_extract(payload, '$.failed'), 0) = 0))`,
      )
      .get(sessionId),
    )
    return row.seq
  }

  /**
   * Updates a row while it is still streaming — **the index is left untouched** (#66).
   *
   * Re-indexing a growing body with trigram on every delta would make the cost grow with the
   * square of the message's length. appendMessages indexes it once when the stream closes (the
   * turn_complete boundary).
   */
  upsertMessageNoIndex(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, kind = excluded.kind,
           payload = excluded.payload, ts = excluded.ts`,
      )
      .run(m.sessionId, m.seq, m.role, m.kind, JSON.stringify(m.payload), m.ts)
  }

  /**
   * Keeps one step of a native subagent under the call that launched it (#222) and returns its number within that
   * launch. Never indexed, and never in `messages`: see v41 for why the steps have a table of their own.
   */
  appendSubagentMessage(
    sessionId: string,
    parentCallId: string,
    m: Pick<StoredMessage, 'role' | 'kind' | 'payload' | 'ts'>,
  ): number {
    const next = this.db.prepare<unknown[], { seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM subagent_messages WHERE session_id = ? AND parent_call_id = ?`,
    )
    const put = this.db.prepare(
      `INSERT INTO subagent_messages (session_id, parent_call_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    return this.db.transaction((): number => {
      const { seq } = oneRow(next.get(sessionId, parentCallId))
      put.run(sessionId, parentCallId, seq, m.role, m.kind, JSON.stringify(m.payload), m.ts)
      return seq
    })()
  }

  /**
   * The steps of the subagent one call launched (#222), oldest first, from after `afterSeq`. `seq` in what comes back
   * is the step's number within that launch.
   *
   * The only reader of `subagent_messages`, and it names one launch card: nothing reads a session's subagent steps by
   * the way. A tool step reads as its card unless `full` is asked for, the same as `loadMessages`. Steps moved to the
   * trash without their session (#418, `SubagentStepRecords`) are not read.
   */
  loadSubagentMessages(
    sessionId: string,
    parentCallId: string,
    opts: ReadOpts & { afterSeq?: number; limit?: number } = {},
  ): StoredMessage[] {
    const raw = this.db
      .prepare<unknown[], (StoredMessage & { payload: string })>(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM subagent_messages
         WHERE session_id = ? AND parent_call_id = ? AND seq > ? AND trashed_at IS NULL ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, parentCallId, opts.afterSeq ?? 0, opts.limit ?? -1)
    return readRows(raw)
  }

  /**
   * The input of the tool call a session recorded under `callId` (the `parentCallId` of a background task), whole: the command a
   * shell was started with. Undefined when the call is not in the conversation or has no input (#1902)
   */
  toolCallInput(sessionId: string, callId: string): unknown {
    const row = this.db
      .prepare<unknown[], { payload: string }>(`SELECT payload FROM messages WHERE session_id = ? AND kind = 'tool_call' AND json_valid(payload) AND json_extract(payload, '$.callId') = ? ORDER BY seq DESC LIMIT 1`)
      .get(sessionId, callId)
    const payload = row ? parseJson(row.payload) : undefined
    return isObj(payload) && payload.callId === callId ? payload.input : undefined
  }

  /**
   * The newest message of this session the person sent from Centralu's window (`byPerson`: the composer, or the fixed text a click of theirs sends,
   * docs/plans/cited-requests.md §3), or null. A row with no
   * source mark is not enough: a caught-up CLI transcript, an app's text and a first prompt have none either
   */
  newestPersonMessage(sessionId: string): { seq: number; ts: number; text: string } | null {
    const row = this.db
      .prepare<unknown[], { seq: number; ts: number; payload: string }>(
        `SELECT seq, ts, payload FROM messages
         WHERE session_id = ? AND role = 'user' AND kind = 'text' AND json_valid(payload) AND json_extract(payload, '$.byPerson') = 1
           AND json_type(payload, '$.from') IS NULL AND json_type(payload, '$.fromApp') IS NULL AND json_type(payload, '$.fromScript') IS NULL
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId)
    const payload = row ? parseJson(row.payload) : undefined
    return row && isObj(payload) ? { seq: row.seq, ts: row.ts, text: typeof payload.text === 'string' ? payload.text : '' } : null
  }

  nextSeq(sessionId: string): number {
    const row = oneRow(this.db.prepare<unknown[], { m: number }>(`SELECT COALESCE(MAX(seq), 0) as m FROM messages WHERE session_id = ?`).get(sessionId))
    return row.m + 1
  }
}

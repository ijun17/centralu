import type Database from 'better-sqlite3'
import type { StoredMessage } from '@cc/protocol'
import { indexedText } from './search-index.js'

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
 * (`read_session`, `recall`, the orchestrator's memory), a successor (the handoff record). Full tool output reaching
 * another session's prompt is the privilege path #73 closed, and an agent `cat`-ing a large file must not ride every
 * page load. A reader that needs the record asks for it by name here, where the question gets asked.
 */
export type ReadOpts = { full?: boolean }

/**
 * The payload column as `ReadOpts` asks for it. The fields are dropped by SQLite (`json_remove`) rather than after
 * `JSON.parse`, so a page never pulls a megabyte of tool output into the host only to throw it away.
 */
function payloadColumn(opts: ReadOpts): string {
  return opts.full
    ? 'payload'
    : `CASE WHEN kind IN ('tool_call', 'tool_result') THEN json_remove(payload, '$.input', '$.output') ELSE payload END as payload`
}

/** The conversation: messages and their search index, a subagent's steps, and the full-text search over them */
export class MessageRecords {
  constructor(private readonly db: Database.Database) {}

  /**
   * Writes messages — **writing the same spot twice overwrites it, index included.**
   *
   * messages used to be the only INSERT OR REPLACE; the index was a plain INSERT. So rewriting
   * the same (session, seq) added **another row to the index** every time. In the real database
   * that came to 28,892 messages against 249,809 index rows — 8.6x — and some had piled up as
   * many as 13 duplicates.
   *
   * The cost showed up in two places: recall results were papered over with the same line
   * repeated (dogfooding: "limit was 8 and the same thing came back 5 times"), and the index had
   * bloated to tens of times the size of the actual text.
   *
   * The fix is to **pin the index row to its message row.** Using the messages rowid as the
   * index's own rowid lets INSERT OR REPLACE overwrite it automatically. (session_id and seq
   * are UNINDEXED, so deleting by a WHERE clause on them would scan all 250,000 rows — that
   * cannot happen on every write.)
   *
   * messages also has to be UPDATE, not REPLACE. REPLACE deletes and reinserts, which **changes
   * the rowid**, and once that happens the spot the index was pointing at is gone.
   */
  appendMessages(msgs: StoredMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET role = excluded.role, kind = excluded.kind,
         payload = excluded.payload, ts = excluded.ts`,
    )
    const rowidOf = this.db.prepare(`SELECT rowid FROM messages WHERE session_id = ? AND seq = ?`)
    const fts = this.db.prepare(
      `INSERT OR REPLACE INTO messages_fts (rowid, body, session_id, seq) VALUES (?, ?, ?, ?)`,
    )
    /*
     * Deletes by rowid. FTS5's `'delete'` command only works on contentless or external-content
     * tables, and messages_fts is an ordinary table that holds its own text, so that command
     * always failed with `SQL logic error` and rolled back other messages in the same batch
     * along with it (#179).
     */
    const dropFts = this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`)
    const tx = this.db.transaction((rows: StoredMessage[]) => {
      for (const m of rows) {
        const payload = JSON.stringify(m.payload)
        stmt.run(m.sessionId, m.seq, m.role, m.kind, payload, m.ts)
        const body = indexedText(m.kind, payload)
        const rid = (rowidOf.get(m.sessionId, m.seq) as { rowid: number } | undefined)?.rowid
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
   * Full-text search over conversations (E-1). Archived sessions are included too — what is
   * being looked for may be sitting in one of them.
   */
  /**
   * Full-text search over conversations. **Returns the whole body** — trimming it is left to
   * the caller.
   *
   * This used to trim with `snippet(..., 12)` here, but that 12 counted not characters but
   * **tokens**, and with the trigram tokenizer that cut off after roughly 15 real characters.
   * The orchestrator would receive something like `"the policy list already said the…"` and
   * **could not tell whether this was even the passage it was looking for.** How much
   * surrounding context is needed is something only the caller knows, so that judgment is
   * left to it.
   */
  searchMessages(query: string, limit = 50): { sessionId: string; seq: number; body: string }[] {
    const q = query.trim()
    if (!q) return []

    // The trigram tokenizer **cannot find anything shorter than 3 characters** (measured).
    // Two-character searches like '승인' or '배포' are common in Korean, so this falls back to LIKE.
    if (q.length < 3) {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, body FROM messages_fts
           WHERE body LIKE ? AND ${OUT_OF_TRASH} ORDER BY seq DESC LIMIT ?`,
        )
        .all(`%${q}%`, limit) as { sessionId: string; seq: number; body: string }[]
    }

    try {
      return this.db
        .prepare(
          `SELECT session_id as sessionId, seq, body
           FROM messages_fts WHERE messages_fts MATCH ? AND ${OUT_OF_TRASH} ORDER BY rank LIMIT ?`,
        )
        .all(`"${q.replace(/"/g, '""')}"`, limit) as { sessionId: string; seq: number; body: string }[]
    } catch {
      // An FTS syntax error (special characters, etc.) quietly returns an empty result — the search box must not break
      return []
    }
  }

  /**
   * Reads a conversation — **one row is one message** (#77).
   *
   * In the delta era (before #66), one token was one row, so this used to join consecutive
   * assistant rows back into a single message when reading. Those rows were merged once by v21,
   * and writes now write one row per message. Since then, neighboring assistant rows are
   * **genuinely different messages** — a new reply with no human turn in between (a background
   * task finished, a question card was answered), and rows written per reply by transcript
   * import. Joining them the old way would run two replies together into one paragraph with no
   * space, like "…still running.All six reviews are in." So rows are handed back as-is — limit
   * also counts rows (= messages).
   */
  loadMessages(sessionId: string, limit = 200, beforeSeq?: number, opts: ReadOpts = {}): StoredMessage[] {
    const raw = this.db
      .prepare(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM messages
         WHERE session_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, beforeSeq ?? null, beforeSeq ?? null, limit) as (StoredMessage & { payload: string })[]
    return raw.reverse().map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
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
      .prepare(
        `SELECT payload FROM messages
           WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND instr(payload, ?) > 0
         UNION ALL
         SELECT payload FROM subagent_messages
           WHERE session_id = ? AND role = 'assistant' AND kind = 'text' AND instr(payload, ?) > 0`,
      )
      .all(sessionId, escaped, sessionId, escaped) as { payload: string }[]
    const texts: string[] = []
    for (const r of rows) {
      try {
        const text = (JSON.parse(r.payload) as { text?: unknown }).text
        if (typeof text === 'string') texts.push(text)
      } catch {
        // A row that is not JSON names nothing
      }
    }
    return texts
  }

  /**
   * The conversation **after** afterSeq — loadMessages's forward-going counterpart (#66).
   * Used to read "what was said next" from a spot recall handed back. Same rule: one row is one message (#77).
   */
  loadMessagesFrom(sessionId: string, afterSeq: number, limit = 20, opts: ReadOpts = {}): StoredMessage[] {
    const raw = this.db
      .prepare(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM messages
         WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as (StoredMessage & { payload: string })[]
    return raw.map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
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
    const next = this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM subagent_messages WHERE session_id = ? AND parent_call_id = ?`,
    )
    const put = this.db.prepare(
      `INSERT INTO subagent_messages (session_id, parent_call_id, seq, role, kind, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    return this.db.transaction((): number => {
      const { seq } = next.get(sessionId, parentCallId) as { seq: number }
      put.run(sessionId, parentCallId, seq, m.role, m.kind, JSON.stringify(m.payload), m.ts)
      return seq
    })()
  }

  /**
   * The steps of the subagent one call launched (#222), oldest first, from after `afterSeq`. `seq` in what comes back
   * is the step's number within that launch.
   *
   * The only reader of `subagent_messages`, and it names one launch card: nothing reads a session's subagent steps by
   * the way. A tool step reads as its card unless `full` is asked for, the same as `loadMessages`.
   */
  loadSubagentMessages(
    sessionId: string,
    parentCallId: string,
    opts: ReadOpts & { afterSeq?: number; limit?: number } = {},
  ): StoredMessage[] {
    const raw = this.db
      .prepare(
        `SELECT session_id as sessionId, seq, role, kind, ${payloadColumn(opts)}, ts FROM subagent_messages
         WHERE session_id = ? AND parent_call_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, parentCallId, opts.afterSeq ?? 0, opts.limit ?? -1) as (StoredMessage & { payload: string })[]
    return raw.map((r) => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) as m FROM messages WHERE session_id = ?`)
      .get(sessionId) as { m: number }
    return row.m + 1
  }
}

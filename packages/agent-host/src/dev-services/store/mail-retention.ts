import type Database from 'better-sqlite3'

/**
 * How long the mailbox keeps what it holds (docs/plans/mailbox.md §4.4). A thread that is not `done` is kept always,
 * apart from the one kind below that was only ever news.
 */
export type MailSweepLimits = {
  /** A done thread's messages go this long after `done_at`, its `event` messages (the header) excepted */
  doneMessagesMs: number
  /** A done thread goes whole, header included, this long after `done_at` */
  doneHeaderMs: number
  /** A thread that is only read news (notices, no assignee, no blocker) goes this long after its last message */
  noticeThreadMs: number
  /** At most this many messages in a thread; past it the oldest `notice` messages go first, never any other kind */
  maxMessages: number
  /** Rows per delete, so a sweep never holds the store for long */
  batch: number
}

const DAY = 24 * 60 * 60 * 1000

export const MAIL_RETENTION: MailSweepLimits = {
  doneMessagesMs: 30 * DAY,
  doneHeaderMs: 180 * DAY,
  noticeThreadMs: 14 * DAY,
  maxMessages: 2000,
  batch: 500,
}

export type MailSweepResult = { messages: number; threads: number }

/** A thread whose `done_at` is past `@cut` and that nobody pinned */
const EXPIRED_DONE = `t.state = 'done' AND t.pinned_at IS NULL AND t.done_at IS NOT NULL AND t.done_at <= @cut`

/**
 * A notice thread (§3.3, "a thread opened only to tell something"): nothing but notices and events in it, no assignee,
 * no task field ever changed (`rev` 0: a task that lost its assignee, or was blocked and unblocked, is not news), no blocker standing, every message read or handled by everyone it went to, and quiet for @cut. A question nobody has
 * answered is not news, so a thread that holds one is never taken by this rule
 */
const READ_NEWS = `
  t.state != 'done' AND t.pinned_at IS NULL AND t.assignee IS NULL AND t.rev = 0
  AND NOT EXISTS (SELECT 1 FROM mail_blockers b WHERE b.thread_id = t.id AND b.resolved_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id AND m.kind NOT IN ('notice', 'event'))
  AND NOT EXISTS (SELECT 1 FROM mail_messages m JOIN mail_receipts r ON r.message_id = m.id
                   WHERE m.thread_id = t.id AND r.read_at IS NULL AND r.handled_at IS NULL)
  AND COALESCE((SELECT MAX(m.created_at) FROM mail_messages m WHERE m.thread_id = t.id), t.created_at) <= @cut`

/**
 * One run of retention: plain `DELETE`s in batches, one transaction each, at run time and not in a migration. It leaves
 * `parent_id` and `follows` naming a thread it removed: a reader finds none and shows the link as gone. The `thread`
 * blockers that named a removed thread count as resolved, which the service does after this (it moves state)
 */
export function sweepMail(db: Database.Database, now: number, limits: Partial<MailSweepLimits> = {}): MailSweepResult {
  const l = { ...MAIL_RETENTION, ...limits }
  const result: MailSweepResult = { messages: 0, threads: 0 }

  const dropMessages = (ids: string[]): void => {
    const json = JSON.stringify(ids)
    db.prepare(`DELETE FROM mail_receipts WHERE message_id IN (SELECT value FROM json_each(?))`).run(json)
    result.messages += db.prepare(`DELETE FROM mail_messages WHERE id IN (SELECT value FROM json_each(?))`).run(json).changes
  }

  const dropThreads = (where: string, cut: number): void => {
    const pick = db.prepare<{ cut: number; batch: number }, { id: string }>(`SELECT t.id FROM mail_threads t WHERE ${where} ORDER BY t.created_at LIMIT @batch`)
    for (;;) {
      // `immediate`: the write lock is taken before the read, so a host that commits in between does not fail this one at once
      const done = db.transaction((): boolean => {
        const ids = pick.all({ cut, batch: l.batch }).map((r) => r.id)
        if (ids.length === 0) return true
        const json = JSON.stringify(ids)
        db.prepare(`DELETE FROM mail_receipts WHERE message_id IN (SELECT id FROM mail_messages WHERE thread_id IN (SELECT value FROM json_each(?)))`).run(json)
        result.messages += db.prepare(`DELETE FROM mail_messages WHERE thread_id IN (SELECT value FROM json_each(?))`).run(json).changes
        db.prepare(`DELETE FROM mail_blockers WHERE thread_id IN (SELECT value FROM json_each(?))`).run(json)
        db.prepare(`DELETE FROM mail_participants WHERE thread_id IN (SELECT value FROM json_each(?))`).run(json)
        db.prepare(`UPDATE mail_turns SET thread_id = NULL WHERE thread_id IN (SELECT value FROM json_each(?))`).run(json)
        result.threads += db.prepare(`DELETE FROM mail_threads WHERE id IN (SELECT value FROM json_each(?))`).run(json).changes
        return false
      }).immediate()
      if (done) return
    }
  }

  // A done thread, header and all
  dropThreads(EXPIRED_DONE, now - l.doneHeaderMs)
  // Read news
  dropThreads(READ_NEWS, now - l.noticeThreadMs)

  // A done thread's messages, once they are old: its events, the header, stay until the whole thread goes
  const oldMessages = db.prepare<{ cut: number; batch: number }, { id: string }>(
    `SELECT m.id FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
      WHERE ${EXPIRED_DONE} AND m.kind != 'event' LIMIT @batch`,
  )
  for (;;) {
    const done = db.transaction((): boolean => {
      const ids = oldMessages.all({ cut: now - l.doneMessagesMs, batch: l.batch }).map((r) => r.id)
      if (ids.length === 0) return true
      dropMessages(ids)
      return false
    }).immediate()
    if (done) break
  }

  // A thread over its size: the oldest notices first, and nothing else
  const over = db
    .prepare<[number], { id: string; n: number }>(`SELECT thread_id AS id, COUNT(*) AS n FROM mail_messages GROUP BY thread_id HAVING COUNT(*) > ?`)
    .all(l.maxMessages)
  const oldestNotices = db.prepare<[string, number], { id: string }>(`SELECT id FROM mail_messages WHERE thread_id = ? AND kind = 'notice' ORDER BY seq LIMIT ?`)
  for (const thread of over) {
    let excess = thread.n - l.maxMessages
    while (excess > 0) {
      const ids = oldestNotices.all(thread.id, Math.min(excess, l.batch)).map((r) => r.id)
      if (ids.length === 0) break
      db.transaction(() => dropMessages(ids)).immediate()
      excess -= ids.length
    }
  }

  // A turn that belongs to no thread (the person's, the CLI's own) is kept only while it runs, and the session's latest ended one stays (§4.1)
  const dropTurns = db.prepare<[number], { changes: number }>(
    `DELETE FROM mail_turns WHERE rowid IN (
       SELECT t.rowid FROM mail_turns t
        WHERE t.thread_id IS NULL AND t.ended_at IS NOT NULL
          AND t.turn_seq < COALESCE((SELECT MAX(l.turn_seq) FROM mail_turns l WHERE l.session_id = t.session_id AND l.ended_at IS NOT NULL), 0)
        LIMIT ?)`,
  )
  while (db.transaction(() => dropTurns.run(l.batch).changes).immediate() > 0);
  return result
}

import type Database from 'better-sqlite3'
import { ROLE_VIA_WORDS } from './mailbox.js'

/**
 * The holds an earlier build wrote that nothing writes now, ended (#2243). The mail token guard (`budget`) went with D32 (#2014) and the `auto`
 * receiver's first-contact hold (`holdsInbound`, `policy`) with D10, yet the v65 move (`mailbox-adopt.ts`) carries a v61 receipt's hold as it was,
 * settled `legacy`, so the Inbox's Waiting listed "Paused: this session has used its share of turns started by mail" and "Held: this session
 * runs without asking" with nothing behind them. One predicate, used by the move (as it ends) and by store step 72 (for the rows moved before):
 * an earlier build's hold that is not a request is `dismissed`, the hold word the person's Dismiss sets (not held for the person, never
 * delivered). The honest word is the hold's own: `gone` says a sender or recipient is gone and `withdrawn` that the sender said it no longer waits,
 * and neither is so. `settled` stays `legacy`.
 *
 * What stays: a `policy` row of today's rule (`reach.holdFor`) is never `legacy` (the move is the one writer of that word), and a moved request keeps
 * its hold. v61's other `policy` hold was the untrusted asker's request (D10 replaced both with the one trust gate), a person's decision that may still
 * be pending. The v61 mail has no `request` kind and the thread's origin was `mail`: what says it is where the move put the row. It sets `via` to the
 * Assistant's role only for the thread's assignee when that is the Assistant and the owner is someone else, and a request is that.
 *
 * Idempotent; a store without the table is left alone. Returns the rows ended.
 */
export function endEarlierBuildHolds(db: Database.Database): number {
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_recipients'`).get() === undefined) return 0
  const roles = `(${ROLE_VIA_WORDS.map((w) => `'${w}'`).join(', ')})`
  return db
    .prepare(
      `UPDATE mail_recipients SET held = 'dismissed', attempt_at = NULL, last_error = NULL, attempts = 0
        WHERE held = 'budget' OR (held = 'policy' AND settled = 'legacy' AND COALESCE(via, '') NOT IN ${roles})`,
    )
    .run().changes
}

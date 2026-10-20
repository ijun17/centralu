// Which of the merge queue's messages their owner has acknowledged (#1351): a stopgap until the mailbox (#1347),
// where the queue's events become mail in a thread per queue item. Everything about acknowledging lives here, so the
// mail can replace this one module: the rest of the app asks it what is still unread and tells it what was read.
//
// A message is an event with `notify` (it needs its owner: needs attention, landed, closed, a batch's end, main red).
// It stays unacknowledged for its owner until the owner acknowledges it (the `ack` tool: event seqs, or every one up
// to a seq), so a session that missed it (a `watch` restarted with a later `--after`, a crash, a notice lost in a
// compacted or busy session) finds it again: `merge_queue` lists them first, `watch` with no `--after` starts at the
// oldest. One that needs attention and stays unacknowledged for 30 minutes is posted into its owner's session again,
// once. The state is kept on the event itself (`ackedAt`, `repostedAt`), in the queue file. A message with no owner
// (main red with no queue item to blame) has nobody to acknowledge it and is not kept. A queue file from before this
// starts with what it already said acknowledged (`acksFrom`, queue.mjs normalize), so an upgrade replays nothing.
// The queue keeps its last 200 events (MAX_EVENTS, queue.mjs): on a very busy queue an old message can still go.

/** After this long an unacknowledged message that needs attention is posted again (PROJECT_BOARD_QUEUE_REPOST_MS: tests only) */
export const REPOST_MS = Number(process.env.PROJECT_BOARD_QUEUE_REPOST_MS) || 30 * 60_000

const forOwner = (owner) => (e) => Boolean(e.owner) && (!owner || e.owner === owner)

/** The messages `owner` has not acknowledged (every owner's when null), oldest first */
export function unacked(q, owner = null) {
  const from = q.acksFrom ?? 0
  return (q.events ?? []).filter((e) => e.seq > from && e.notify && !e.ackedAt && forOwner(owner)(e)).sort((a, b) => a.seq - b.seq)
}

/** The seq to start a `watch` after: just before `owner`'s oldest unacknowledged message, else the queue's last */
export function watchStart(q, owner = null) {
  const first = unacked(q, owner)[0]
  return first ? first.seq - 1 : q.seq
}

/**
 * Acknowledges `owner`'s messages: those `seqs`, or every one up to `upTo`, or both. Another owner's are never
 * touched. Answers how many it acknowledged.
 */
export function acknowledge(q, owner, { seqs = [], upTo = null, at }) {
  let n = 0
  for (const e of unacked(q, owner)) {
    if (seqs.includes(e.seq) || (upTo !== null && e.seq <= upTo)) {
      e.ackedAt = at
      n += 1
    }
  }
  return n
}

/**
 * The messages that need attention, posted into their session (`told`, at `toldAt`) and still unacknowledged
 * `REPOST_MS` after, not posted again yet. One not posted yet waits for its first post.
 */
export function dueReposts(q, now) {
  return unacked(q).filter((e) => e.kind === 'attention' && e.told === true && e.toldAt && !e.repostedAt && Date.parse(e.toldAt) + REPOST_MS <= now)
}

/** Marks a message posted again (it is, once) */
export function markReposted(q, seq, at) {
  const e = (q.events ?? []).find((x) => x.seq === seq)
  if (e) e.repostedAt = at
}

/** What the posted notice and `watch` add: how to acknowledge it */
export const ackHint = (e) =>
  `Ack it with the board app's ack tool once handled: ack({ owner: ${JSON.stringify(e.owner ?? '')}, seqs: [${e.seq}] }) (merge_queue lists what is unacknowledged).`

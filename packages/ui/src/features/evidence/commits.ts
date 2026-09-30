import type { GitCommit } from '@cc/protocol'

/**
 * The number of commits the History tab fetches (#21).
 *
 * There has to be a cap — a real repository's `git log` runs to tens of thousands of lines, and
 * this list is not virtualized. 100 is roughly two weeks of an active repository, which is about
 * the range "what has happened lately" actually asks for.
 *
 * **The fact that the cap was hit is stated on screen** (`evidence-history-cap`). A list that cuts
 * off silently is a list lying that there are no older commits.
 */
export const COMMIT_LIMIT = 100

/**
 * just now · 32m ago · 3h ago · 5d ago.
 *
 * "How long ago" comes before the exact time — the reason to skim history is to establish order,
 * not to check a specific time. `now` is taken as a parameter so the clock is an argument, which
 * lets a test avoid waiting on real time.
 */
export function commitAgo(when: number, now: number): string {
  const min = Math.floor((now - when) / 60000)
  // A commit timestamped in the future (clock skew, a rebase) also falls here — 'just now' is better than printing a negative number of minutes
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  const day = Math.floor(hour / 24)
  return day < 30 ? `${day}d ago` : `${Math.floor(day / 30)}mo ago`
}

/**
 * Whether the author's name is worth the space it takes.
 *
 * In a solo repository, the same name repeats on every row — at 340px wide that is noise, not
 * information. It is only written when there is actually someone to tell apart.
 */
export function hasMultipleAuthors(commits: GitCommit[]): boolean {
  const first = commits[0]?.author
  return commits.some((c) => c.author !== first)
}

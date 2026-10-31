import type { GitCommit } from '@cc/protocol/client'

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

export { formatAgo as commitAgo } from '@cc/core'

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

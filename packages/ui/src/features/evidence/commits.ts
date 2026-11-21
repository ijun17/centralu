import type { GitCommit } from '@cc/protocol/client'

/** The History tab's cap (#21): the list is not virtualized. 100 is about two weeks of an active repository */
export const COMMIT_LIMIT = 100

export { formatAgo as commitAgo } from '@cc/core'

/** In a solo repository the same name on every row is noise, so names show only when there is someone to tell apart */
export function hasMultipleAuthors(commits: GitCommit[]): boolean {
  const first = commits[0]?.author
  return commits.some((c) => c.author !== first)
}

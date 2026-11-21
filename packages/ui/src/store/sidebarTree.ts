import type { SessionSummary } from '@cc/core'

/**
 * The one parent rule for the tree (`orderAsTree`) and the fold reveal (`foldGroupsHiding`), so revealing a fork whose
 * source is gone opens the group it hangs under, its asker's.
 */
export function treeParentOf(s: SessionSummary, inList: (id: string) => boolean): string | null {
  const candidates = [s.forkedFrom, s.parentSessionId, s.askedBy]
  return candidates.find((id): id is string => !!id && id !== s.id && inList(id)) ?? null
}

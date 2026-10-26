import type { SessionSummary } from '@cc/core'

/**
 * The session a row hangs under, among the rows the list has (`inList`): the session it was forked from, else the one
 * that held its worktree, else the one that asked for it, each only if the list has it. The tree draws a row under this
 * one (`orderAsTree`) and the fold reveal opens its group (`foldGroupsHiding`), so both ask here: a fork whose source
 * is gone hangs under its asker, and revealing it has to open the asker's children, not the missing source's.
 */
export function treeParentOf(s: SessionSummary, inList: (id: string) => boolean): string | null {
  const candidates = [s.forkedFrom, s.parentSessionId, s.askedBy]
  return candidates.find((id): id is string => !!id && id !== s.id && inList(id)) ?? null
}

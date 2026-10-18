import type { SessionSummary } from '@cc/core'

/**
 * The project a session's row stands under in the sidebar (#1038). Its own, except for a child started on another
 * machine than the session that started it (start_agent with a machine): that child is a session of the machine's
 * checkout, but it hangs under its parent, as a local child does, so it goes to its parent's project. What it started
 * in its own project goes with it. An ask_project session (`askedBy` of another project on the same machine) stays in
 * its own project, as before; a loop in the links (which the host never makes) stops where it closes.
 */
export function sidebarProjectOf(s: SessionSummary, sessions: Readonly<Record<string, SessionSummary>>): string | null {
  const seen = new Set<string>()
  let cur = s
  for (;;) {
    seen.add(cur.id)
    const parent = cur.askedBy ? sessions[cur.askedBy] : undefined
    if (!parent || seen.has(parent.id)) return cur.projectId
    const otherMachine = (parent.machine ?? null) !== (cur.machine ?? null)
    if (!otherMachine && parent.projectId !== cur.projectId) return cur.projectId
    cur = parent
  }
}

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

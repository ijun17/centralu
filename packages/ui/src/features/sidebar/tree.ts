import { needsAnswer, type SessionSummary } from '@cc/core'
import { treeParentOf } from '../../store/sidebarTree.js'

export type ProjectAppSessions = {
  /** Sessions that still belong in the project's ordinary tree. */
  project: SessionSummary[]
  /** Listed app id → the sessions that row owns, in the host's order. */
  byApp: Map<string, SessionSummary[]>
}

/**
 * Separates the sessions owned by apps that are still listed in a project from its ordinary
 * sessions. A removed app deliberately does not claim its old sessions: they return to the
 * project list instead of disappearing with the app row.
 *
 * This happens before `orderAsTree`, so a regular session and the agents or worktrees it started
 * retain the tree layout they had before app rows were introduced.
 */
export function groupProjectAppSessions(
  sessions: SessionSummary[],
  appIds: readonly string[],
): ProjectAppSessions {
  const byApp = new Map(appIds.map((id) => [id, [] as SessionSummary[]]))
  const project: SessionSummary[] = []
  for (const session of sessions) {
    const owned = session.appId ? byApp.get(session.appId) : undefined
    if (owned) owned.push(session)
    else project.push(session)
  }
  return { project, byApp }
}

/** A completed turn is not an app waiting on the person; approvals and pending questions are. */
export function appSessionsNeedAttention(sessions: SessionSummary[]): boolean {
  return sessions.some(needsAnswer)
}

/**
 * Lays out the session list in tree order: a session immediately followed by the sessions it started (owner decision
 * 2026-10-12 on #561), and each of those by theirs. A child is grouped by who started it, `askedBy` for a start_agent
 * child, whether it runs in its parent's folder or in a new worktree; `parentSessionId` still places a worktree session
 * under the session that held it (#69, a former worktree manager's children). A fork (#677, `forkedFrom`) hangs under
 * the session it was copied from, ahead of the session that asked for it. `askedBy` of an ask_project session names a
 * session of another project, which is not in this list, so that session stays at the top level with its "Asked by"
 * mark.
 *
 * Hierarchy lives only in the sidebar — the grid, the inbox and the palette all stay flat lists
 * (design decision: "The hierarchy lives in the sidebar; the grid stays a flat set of panels").
 *
 * If the parent is not in this list (archived, etc.), the child is drawn at the top level —
 * indentation is only a sign of a relationship, and drawing it indented while the parent is
 * invisible would make it look like it is hanging under nothing. A child of a child hangs one step further in (#862):
 * start_agent is depth one, but an `auto` session may cross that boundary, and drawing its children at the top level
 * made them read as their grandparent's siblings. A loop in the links (which the host never makes) is cut where it
 * closes, so every session is drawn exactly once.
 */
export function orderAsTree(sessions: SessionSummary[]): { s: SessionSummary; nested: boolean; depth: number }[] {
  const here = new Set(sessions.map((x) => x.id))
  const parentOf = (s: SessionSummary): string | null => treeParentOf(s, (id) => here.has(id))
  const kids = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const parent = parentOf(s)
    if (parent) kids.set(parent, [...(kids.get(parent) ?? []), s])
  }
  const out: { s: SessionSummary; nested: boolean; depth: number }[] = []
  const placed = new Set<string>()
  const place = (s: SessionSummary, depth: number) => {
    if (placed.has(s.id)) return
    placed.add(s.id)
    out.push({ s, nested: depth > 0, depth })
    for (const c of kids.get(s.id) ?? []) place(c, depth + 1)
  }
  for (const s of sessions) if (!parentOf(s)) place(s, 0)
  // Only a loop leaves a session unplaced: draw it at the top level, with what hangs under it
  for (const s of sessions) place(s, 0)
  return out
}

export type TreeRow = {
  s: SessionSummary
  nested: boolean
  /** How many steps in it hangs under the list's top level: 0 for a top-level session, 1 for its child, and so on */
  depth: number
  /** The sessions this row started and has in the list: what its chevron folds (#666) */
  children: SessionSummary[]
  /** Its children are folded away: they are in `children` but not among the rows, nor is anything under them */
  folded: boolean
}

/**
 * `orderAsTree` as the rows to draw, with each row's children and whether they are folded (#666). A folded row keeps
 * its place and its `children`, so the row can say how many it hides and whether one of them is waiting; everything
 * under it is left out of the rows, its children's own children too.
 */
export function treeRows(sessions: SessionSummary[], isFolded: (parentId: string) => boolean): TreeRow[] {
  const ordered = orderAsTree(sessions)
  const rows: TreeRow[] = ordered.map(({ s, nested, depth }) => ({ s, nested, depth, children: [], folded: false }))
  // The row each one hangs under is the nearest earlier row one step out
  const open: TreeRow[] = []
  for (const row of rows) {
    open.length = row.depth
    if (row.depth > 0) open[row.depth - 1]?.children.push(row.s)
    open[row.depth] = row
  }
  const out: TreeRow[] = []
  let hideBelow: number | null = null
  for (const row of rows) {
    if (hideBelow !== null && row.depth > hideBelow) continue
    hideBelow = null
    const folded = row.children.length > 0 && isFolded(row.s.id)
    out.push({ ...row, folded })
    if (folded) hideBelow = row.depth
  }
  return out
}

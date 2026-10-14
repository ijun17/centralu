import type { SessionSummary } from '@cc/core'

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
  return sessions.some((session) => session.state === 'waiting_approval' || session.pendingQuestions.length > 0)
}

/**
 * Lays out the session list in tree order: a session immediately followed by the sessions it started (owner decision
 * 2026-10-12 on #561). A child is grouped by who started it, `askedBy` for a start_agent child, whether it runs in its
 * parent's folder or in a new worktree; `parentSessionId` still places a worktree session under the session that held
 * it (#69, a former worktree manager's children). `askedBy` of an ask_project session names a session of another
 * project, which is not in this list, so that session stays at the top level with its "Asked by" mark.
 *
 * Hierarchy lives only in the sidebar — the grid, the inbox and the palette all stay flat lists
 * (design decision: "The hierarchy lives in the sidebar; the grid stays a flat set of panels").
 *
 * If the parent is not in this list (archived, etc.), the child is drawn at the top level —
 * indentation is only a sign of a relationship, and drawing it indented while the parent is
 * invisible would make it look like it is hanging under nothing. The tree is one level deep (start_agent is depth
 * one): a session whose parent is itself nested is drawn at the top level rather than lost.
 */
export function orderAsTree(sessions: SessionSummary[]): { s: SessionSummary; nested: boolean }[] {
  const here = new Set(sessions.map((x) => x.id))
  const parentOf = (s: SessionSummary): string | null =>
    s.parentSessionId && here.has(s.parentSessionId) ? s.parentSessionId
    : s.askedBy && s.askedBy !== s.id && here.has(s.askedBy) ? s.askedBy
    : null
  const byId = new Map(sessions.map((x) => [x.id, x]))
  const kids = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const s of sessions) {
    const parent = parentOf(s)
    if (parent && !parentOf(byId.get(parent)!)) {
      kids.set(parent, [...(kids.get(parent) ?? []), s])
    } else {
      roots.push(s)
    }
  }
  return roots.flatMap((root) => {
    const children = kids.get(root.id) ?? []
    return [
      { s: root, nested: false },
      ...children.map((c) => ({ s: c, nested: true })),
    ]
  })
}

export type TreeRow = {
  s: SessionSummary
  nested: boolean
  /** The sessions this row started and has in the list: what its chevron folds (#666). Empty for a child. */
  children: SessionSummary[]
  /** Its children are folded away: they are in `children` but not among the rows */
  folded: boolean
}

/**
 * `orderAsTree` as the rows to draw, with each parent's children and whether they are folded (#666). A folded parent
 * keeps its place and its `children`, so the row can say how many it hides and whether one of them is waiting; the
 * children themselves are left out of the rows.
 */
export function treeRows(sessions: SessionSummary[], isFolded: (parentId: string) => boolean): TreeRow[] {
  const ordered = orderAsTree(sessions)
  const rows: TreeRow[] = []
  for (const { s, nested } of ordered) {
    const last = rows[rows.length - 1]
    if (nested && last) {
      last.children.push(s)
      continue
    }
    rows.push({ s, nested: false, children: [], folded: false })
  }
  return rows.flatMap((row) => {
    const folded = row.children.length > 0 && isFolded(row.s.id)
    const parent = { ...row, folded }
    return folded ? [parent] : [parent, ...row.children.map((c) => ({ s: c, nested: true, children: [], folded: false }))]
  })
}

import { needsAnswer, type SessionSummary } from '@cc/core'
import { treeParentOf } from '../../store/sidebarTree.js'

export type ProjectAppSessions = {
  project: SessionSummary[]
  /** Listed app id → the sessions that row owns, in the host's order. */
  byApp: Map<string, SessionSummary[]>
}

/**
 * Splits off the sessions of a project's listed apps. A removed app's sessions return to the project list instead of
 * vanishing with its row. Runs before `orderAsTree`, so the tree layout does not depend on the app rows.
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
 * The session list in tree order (#561): each session followed by those it started (`treeParentOf`: a fork under its
 * source, #677; a worktree session under the one that held it, #69), and theirs one step further in (#862). Only the
 * sidebar nests; the grid, inbox and palette stay flat. A child whose parent is not listed (archived, or another
 * project's asker) stands at the top level. A loop, which the host never makes, is cut where it closes.
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
  depth: number
  /** The sessions this row started and has in the list: what its chevron folds (#666) */
  children: SessionSummary[]
  /** Its children stay in `children` but neither they nor anything under them are rows */
  folded: boolean
}

/** `orderAsTree` as the rows to draw (#666); a folded row keeps its `children` so it can say what it hides */

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

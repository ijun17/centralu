import type { SessionSummary } from '@cc/core'

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

/**
 * Walking a process table by parent links, in one place (#428): the tree a stop reaches (`kill-tree.ts`) and the
 * host's own descendants a leftover is told apart from (`strays.ts`).
 */

/** One row of a process table, as far as parent links go */
export type ParentRow = { pid: number; ppid: number }

/** The roots, plus every descendant reached by following ppid down. Each pid once, however the links loop */
export function descendants(rows: readonly ParentRow[], roots: readonly number[]): Set<number> {
  const byParent = new Map<number, number[]>()
  for (const r of rows) {
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r.pid)
    else byParent.set(r.ppid, [r.pid])
  }
  const seen = new Set<number>(roots)
  const queue = [...roots]
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      queue.push(kid)
    }
  }
  return seen
}

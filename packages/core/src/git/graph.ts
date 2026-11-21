import type { GitCommit } from '@cc/protocol/client'

/**
 * Commit graph lanes, following parent shas: joining rows in `git log` order would draw relationships that do not
 * exist. The first parent inherits the lane (the trunk runs straight); other parents join an existing lane or open one.
 * A parent past the rows read keeps its lane: the line runs off the bottom.
 */
export type GraphRow = {
  sha: string
  lane: number
  above: number[]
  below: number[]
  /** Lanes the lines to this commit's parents reach */
  edges: number[]
}

export function layoutCommits(commits: GitCommit[]): GraphRow[] {
  /** The sha each lane waits for; null is an empty lane */
  const lanes: (string | null)[] = []
  const active = (): number[] => lanes.flatMap((v, i) => (v === null ? [] : [i]))
  const alloc = (sha: string): number => {
    const free = lanes.indexOf(null)
    const at = free === -1 ? lanes.length : free
    lanes[at] = sha
    return at
  }

  const rows: GraphRow[] = []
  /** After a rebase or cherry-pick, log does not guarantee topological order */
  const drawn = new Set<string>()
  for (const c of commits) {
    const above = active()

    // Nobody waits for it: HEAD, or a branch first seen inside the window
    let lane = lanes.indexOf(c.sha)
    if (lane === -1) lane = alloc(c.sha)

    // Several children can wait for the same parent: clearing only one would leave a ghost lane
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) lanes[i] = null
    drawn.add(c.sha)

    const edges: number[] = []
    for (const [n, parent] of c.parents.entries()) {
      // A parent drawn above (out-of-order dates) would get a lane nothing ends; lines only point down
      if (drawn.has(parent)) continue
      const held = lanes.indexOf(parent)
      if (held !== -1) {
        edges.push(held)
      } else if (n === 0) {
        lanes[lane] = parent
        edges.push(lane)
      } else {
        edges.push(alloc(parent))
      }
    }

    rows.push({ sha: c.sha, lane, above, below: active(), edges: [...new Set(edges)] })
  }
  return rows
}

export function laneCount(rows: GraphRow[]): number {
  let max = 0
  for (const r of rows) {
    for (const l of [r.lane, ...r.above, ...r.below]) if (l > max) max = l
  }
  return max + 1
}

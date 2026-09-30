import type { GitCommit } from '@cc/protocol'

/**
 * Lays out the vertical lines of the commit graph.
 *
 * With dots alone you can tell "what came in when", but not **where things split off and where they merged
 * back**. To draw lines, though, they have to follow the real parent relationships. Simply joining each row
 * to the next in the order `git log` emits them makes the rows after a merge look connected even though they
 * are not parent and child — drawing a relationship that does not exist is worse than drawing dots alone.
 *
 * So lanes are assigned by following parent shas. There are only two rules:
 *   - The first parent **inherits the same lane**. That is what keeps the main trunk running straight down.
 *   - The other parents branch off into a lane beside it. If that lane already exists, they join it rather
 *     than making a new one.
 *
 * A parent off screen (past the first 50) keeps holding its lane too. A line running off the bottom of the
 * list is the plain truth — history does not end there; that is just as far as we read.
 */
export type GraphRow = {
  sha: string
  /** The vertical line this commit's dot sits on */
  lane: number
  /** The vertical lines coming down into this row from above */
  above: number[]
  /** The vertical lines going on down below this row */
  below: number[]
  /** The vertical lines reached by the lines running from this commit to its parents */
  edges: number[]
}

export function layoutCommits(commits: GitCommit[]): GraphRow[] {
  /** The sha each lane is waiting for as 'what comes next'. Null is an empty lane */
  const lanes: (string | null)[] = []
  const active = (): number[] => lanes.flatMap((v, i) => (v === null ? [] : [i]))
  const alloc = (sha: string): number => {
    const free = lanes.indexOf(null)
    const at = free === -1 ? lanes.length : free
    lanes[at] = sha
    return at
  }

  const rows: GraphRow[] = []
  /** Commits already drawn — after a rebase or cherry-pick, log does not guarantee topological order */
  const drawn = new Set<string>()
  for (const c of commits) {
    const above = active()

    // A commit nobody is waiting for starts a new trunk (HEAD, or a branch first seen inside the window)
    let lane = lanes.indexOf(c.sha)
    if (lane === -1) lane = alloc(c.sha)

    // Every lane that was waiting for this commit ends here.
    // Several children can point at the same parent, so clearing only one would leave a ghost lane.
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) lanes[i] = null
    drawn.add(c.sha)

    const edges: number[] = []
    for (const [n, parent] of c.parents.entries()) {
      /*
       * A parent already drawn above gets no lane.
       *
       * When dates are out of order (rebase/cherry-pick) and a parent comes before its child, nothing ever
       * ends the lane waiting for that parent, and a ghost line runs all the way to the bottom. Lines in this
       * model only point downwards, so simply leaving out a line that would go up is right —
       * drawing a relationship that does not exist is worse than a line that is not there being cut off.
       */
      if (drawn.has(parent)) continue
      const held = lanes.indexOf(parent)
      if (held !== -1) {
        edges.push(held) // A lane is already waiting for it → join that lane (without adding a lane)
      } else if (n === 0) {
        lanes[lane] = parent // The first parent inherits the trunk
        edges.push(lane)
      } else {
        edges.push(alloc(parent))
      }
    }

    rows.push({ sha: c.sha, lane, above, below: active(), edges: [...new Set(edges)] })
  }
  return rows
}

/** How many lanes the graph uses: the rightmost lane number plus one. What the width of the graph column is based on */
export function laneCount(rows: GraphRow[]): number {
  let max = 0
  for (const r of rows) {
    for (const l of [r.lane, ...r.above, ...r.below]) if (l > max) max = l
  }
  return max + 1
}

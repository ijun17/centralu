import type { GitCommit } from '@cc/protocol'
import type { GraphRow } from '@cc/core'

/**
 * One row of the commit graph.
 *
 * Why lines are drawn at all: with only dots, it is possible to know what came in, but not where
 * it branched off or merged back. The lines are exactly that information.
 *
 * The panel is narrow, so the lane width is kept very tight at 9px. A real repository usually has
 * two or three branches alive at once, so this width barely eats into the space for the subject
 * line.
 *
 * The row height has to be fixed. A line has to meet exactly at the row boundary to read as one
 * continuous stroke; if rows had different heights, the line would look broken at the mismatch.
 */
export const ROW_H = 38
const LANE_W = 9
const DOT_Y = ROW_H / 2
/*
 * The left pad is the panel's text padding (px-3, 12px), not a lane measure.
 *
 * The commit row carries no padding of its own — this SVG is its first child, so this
 * number is the distance between the panel wall and lane 0. It was 7, and the HEAD ring
 * (r 5 + 1 stroke) reaches 5.5 from center, which left the ring 1.5px off the wall —
 * visibly touching it. 12 lines the dots up with every other left edge in the panel.
 * The right side stays narrow: it faces the row's own gap, not the wall.
 */
const PAD_L = 12
const PAD_R = 7

const x = (lane: number) => PAD_L + lane * LANE_W

export function graphWidth(lanes: number): number {
  return PAD_L + PAD_R + Math.max(0, lanes - 1) * LANE_W
}

/** A line that changes lanes is drawn as a curve. A sharp straight bend reads like an arrow and misleads about direction */
const curve = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1} ${y1} C${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`

export function CommitGraph({
  row,
  commit,
  lanes,
  head,
}: {
  row: GraphRow
  commit: GitCommit
  lanes: number
  /** The top of the list — this is where we currently stand */
  head: boolean
}) {
  const merge = commit.parents.length > 1
  const w = graphWidth(lanes)

  return (
    <svg
      width={w}
      height={ROW_H}
      viewBox={`0 0 ${w} ${ROW_H}`}
      className="shrink-0"
      aria-hidden
      data-testid={`commit-graph-${commit.shortSha}`}
    >
      {row.above.map((l) =>
        l === row.lane ? (
          // My own trunk comes down from above and reaches the dot
          <line key={`a${l}`} x1={x(l)} y1={0} x2={x(l)} y2={DOT_Y} stroke="var(--color-graphite)" strokeWidth="1.5" />
        ) : row.below.includes(l) ? (
          // A branch passing through, unrelated to this commit
          <line key={`a${l}`} x1={x(l)} y1={0} x2={x(l)} y2={ROW_H} stroke="var(--color-graphite)" strokeWidth="1.5" />
        ) : (
          // A branch that ends here — it was waiting for this commit as its parent
          <path
            key={`a${l}`}
            d={curve(x(l), 0, x(row.lane), DOT_Y)}
            fill="none"
            stroke="var(--color-graphite)"
            strokeWidth="1.5"
          />
        ),
      )}

      {row.edges.map((e) =>
        e === row.lane ? (
          <line key={`e${e}`} x1={x(e)} y1={DOT_Y} x2={x(e)} y2={ROW_H} stroke="var(--color-graphite)" strokeWidth="1.5" />
        ) : (
          <path
            key={`e${e}`}
            d={curve(x(row.lane), DOT_Y, x(e), ROW_H)}
            fill="none"
            stroke="var(--color-graphite)"
            strokeWidth="1.5"
          />
        ),
      )}

      {/*
        The dot's shape tells the kind (the achromatic rule — told apart by shape, not color):
          large filled dot = HEAD, here now   ·   empty dot = merge   ·   small dot = ordinary commit
      */}
      {head && <circle cx={x(row.lane)} cy={DOT_Y} r={5} fill="none" stroke="var(--color-ash)" strokeWidth="1" />}
      <circle
        cx={x(row.lane)}
        cy={DOT_Y}
        r={merge ? 3.5 : 2.5}
        fill={merge ? 'var(--color-pit)' : head ? 'var(--color-chalk)' : 'var(--color-slate)'}
        stroke={merge ? 'var(--color-ash)' : 'none'}
        strokeWidth="1.5"
      />
    </svg>
  )
}

import type { GitCommit } from '@cc/protocol/client'
import type { GraphRow } from '@cc/core'

/**
 * One row of the commit graph; the lines say where a commit branched off or merged back. Lanes are 9px: the panel is
 * narrow and a repository rarely has more than three live branches. The row height is fixed pixels, so a line meets
 * the next row's exactly and reads as one stroke.
 */
export const ROW_H = 38
const LANE_W = 9
const DOT_Y = ROW_H / 2
/*
 * The left pad is the panel's text padding (px-3), lining the dots up with the panel's other left edges: the SVG is
 * the row's first child, and at 7 the HEAD ring (reaching 5.5) sat 1.5px off the wall. The right faces the row's gap.
 */
const PAD_L = 12
const PAD_R = 7

const x = (lane: number) => PAD_L + lane * LANE_W

export function graphWidth(lanes: number): number {
  return PAD_L + PAD_R + Math.max(0, lanes - 1) * LANE_W
}

/** A lane change is a curve: a sharp bend reads like an arrow and misleads about direction */
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
  /** The top of the list: where we stand now */
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
          <line key={`a${l}`} x1={x(l)} y1={0} x2={x(l)} y2={DOT_Y} stroke="var(--color-line-strong)" strokeWidth="1.5" />
        ) : row.below.includes(l) ? (
          <line key={`a${l}`} x1={x(l)} y1={0} x2={x(l)} y2={ROW_H} stroke="var(--color-line-strong)" strokeWidth="1.5" />
        ) : (
          // A branch that ends here: this commit is its parent
          <path
            key={`a${l}`}
            d={curve(x(l), 0, x(row.lane), DOT_Y)}
            fill="none"
            stroke="var(--color-line-strong)"
            strokeWidth="1.5"
          />
        ),
      )}

      {row.edges.map((e) =>
        e === row.lane ? (
          <line key={`e${e}`} x1={x(e)} y1={DOT_Y} x2={x(e)} y2={ROW_H} stroke="var(--color-line-strong)" strokeWidth="1.5" />
        ) : (
          <path
            key={`e${e}`}
            d={curve(x(row.lane), DOT_Y, x(e), ROW_H)}
            fill="none"
            stroke="var(--color-line-strong)"
            strokeWidth="1.5"
          />
        ),
      )}

      {/*
        Shape, not colour, tells the kind: ringed = HEAD, hollow = merge, small = an ordinary commit
      */}
      {head && <circle cx={x(row.lane)} cy={DOT_Y} r={5} fill="none" stroke="var(--color-ink-muted)" strokeWidth="1" />}
      <circle
        cx={x(row.lane)}
        cy={DOT_Y}
        r={merge ? 3.5 : 2.5}
        fill={merge ? 'var(--color-surface-side)' : head ? 'var(--color-ink)' : 'var(--color-ink-faint)'}
        stroke={merge ? 'var(--color-ink-muted)' : 'none'}
        strokeWidth="1.5"
      />
    </svg>
  )
}

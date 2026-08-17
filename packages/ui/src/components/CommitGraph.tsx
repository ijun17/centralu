import type { GitCommit } from '@cc/protocol'
import type { GraphRow } from '@cc/core'

/**
 * 커밋 그래프의 한 행.
 *
 * 선을 그리는 이유: 점만 있으면 "무엇이 들어왔나"는 알아도 **어디서 갈라지고 합쳐졌나**를
 * 알 수 없다. 선이 곧 그 정보다.
 *
 * 좁은 패널이라 레인 폭을 9px로 아주 좁게 잡는다. 실제 저장소에서 동시에 살아 있는
 * 가지는 보통 두세 개라 이 폭이면 제목 자리를 거의 뺏지 않는다.
 *
 * **행 높이가 고정이어야 한다.** 줄이 행 경계에서 딱 맞물려야 하나의 이어진 선으로 보이는데,
 * 행마다 높이가 다르면 어긋난 자리에서 선이 끊긴 것처럼 보인다.
 */
export const ROW_H = 38
const LANE_W = 9
const DOT_Y = ROW_H / 2
const PAD = 7

const x = (lane: number) => PAD + lane * LANE_W

export function graphWidth(lanes: number): number {
  return PAD * 2 + Math.max(0, lanes - 1) * LANE_W
}

/** 레인이 바뀌는 선은 곡선으로. 꺾인 직선은 화살표처럼 보여서 방향을 오해하게 만든다 */
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
  /** 목록 맨 위 — 지금 여기 서 있다 */
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
          // 내 줄기가 위에서 내려와 점에 닿는다
          <line key={`a${l}`} x1={x(l)} y1={0} x2={x(l)} y2={DOT_Y} stroke="var(--color-graphite)" strokeWidth="1.5" />
        ) : row.below.includes(l) ? (
          // 이 커밋과 상관없이 지나가는 가지
          <line key={`a${l}`} x1={x(l)} y1={0} x2={x(l)} y2={ROW_H} stroke="var(--color-graphite)" strokeWidth="1.5" />
        ) : (
          // 여기서 끝나는 가지 — 이 커밋을 부모로 기다리고 있었다
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
        점의 모양이 종류를 말한다 (무채색 규칙 — 색이 아니라 형태로 구분한다):
          가운데가 찬 큰 점 = HEAD, 지금 여기   ·   빈 점 = 병합   ·   작은 점 = 보통 커밋
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

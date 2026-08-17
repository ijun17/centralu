import type { GitCommit } from '@cc/protocol'

/**
 * 커밋 그래프의 세로줄 배치.
 *
 * 점만 찍어 두면 "무엇이 언제 들어왔나"는 알아도 **어디서 갈라져 어디로 합쳐졌나**를 알 수 없다.
 * 그런데 선을 그리려면 진짜 부모 관계를 따라 그려야 한다. `git log`가 뱉는 순서대로
 * 위아래를 그냥 이어버리면, 병합 뒤에 오는 줄들은 서로 부모-자식이 아닌데도 이어진 것처럼
 * 보인다 — 없는 관계를 그려 보이는 건 점만 찍는 것보다 나쁘다.
 *
 * 그래서 부모 sha를 따라 레인을 잡는다. 규칙은 둘뿐이다:
 *   - 첫 부모는 **같은 레인을 이어받는다**. 그래야 주 줄기가 곧게 내려간다.
 *   - 나머지 부모는 옆 레인으로 갈라진다. 그 레인이 이미 있으면 새로 만들지 않고 합류한다.
 *
 * 화면 밖(50개 너머)의 부모도 레인을 붙잡은 채로 둔다. 목록 바닥에서 선이 잘려 나가는 건
 * 사실 그대로다 — 역사는 거기서 끝난 게 아니라 우리가 거기까지만 읽은 것이다.
 */
export type GraphRow = {
  sha: string
  /** 이 커밋의 점이 놓이는 세로줄 */
  lane: number
  /** 이 행 위에서 내려오는 세로줄들 */
  above: number[]
  /** 이 행 아래로 내려가는 세로줄들 */
  below: number[]
  /** 이 커밋에서 부모로 뻗는 선이 닿는 세로줄들 */
  edges: number[]
}

export function layoutCommits(commits: GitCommit[]): GraphRow[] {
  /** 각 레인이 '다음에 올 것'으로 기다리는 sha. null이면 빈 레인 */
  const lanes: (string | null)[] = []
  const active = (): number[] => lanes.flatMap((v, i) => (v === null ? [] : [i]))
  const alloc = (sha: string): number => {
    const free = lanes.indexOf(null)
    const at = free === -1 ? lanes.length : free
    lanes[at] = sha
    return at
  }

  const rows: GraphRow[] = []
  for (const c of commits) {
    const above = active()

    // 아무도 기다리지 않는 커밋이면 새 줄기다 (HEAD, 혹은 창 안에서 처음 보이는 가지)
    let lane = lanes.indexOf(c.sha)
    if (lane === -1) lane = alloc(c.sha)

    // 이 커밋을 기다리던 레인은 전부 여기서 끝난다.
    // 여러 자식이 같은 부모를 가리킬 수 있어서 하나만 지우면 유령 레인이 남는다.
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) lanes[i] = null

    const edges: number[] = []
    for (const [n, parent] of c.parents.entries()) {
      const held = lanes.indexOf(parent)
      if (held !== -1) {
        edges.push(held) // 이미 기다리는 레인이 있다 → 그리로 합류 (레인을 늘리지 않는다)
      } else if (n === 0) {
        lanes[lane] = parent // 첫 부모가 줄기를 이어받는다
        edges.push(lane)
      } else {
        edges.push(alloc(parent))
      }
    }

    rows.push({ sha: c.sha, lane, above, below: active(), edges: [...new Set(edges)] })
  }
  return rows
}

/** 가장 오른쪽 레인 번호. 그래프 열의 폭을 정하는 근거 */
export function laneCount(rows: GraphRow[]): number {
  let max = 0
  for (const r of rows) {
    for (const l of [r.lane, ...r.above, ...r.below]) if (l > max) max = l
  }
  return max + 1
}

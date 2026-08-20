import type { GitCommit } from '@cc/protocol'

/**
 * 기록 탭이 읽어 오는 커밋 수 (#21).
 *
 * 상한은 있어야 한다 — 실제 저장소의 `git log`는 수만 줄이고 이 목록은 가상 스크롤이
 * 아니다. 100은 활발한 저장소의 2주쯤인데, "요즘 무슨 일이 있었나"가 실제로 묻는 범위다.
 *
 * **상한에 닿았다는 사실을 화면에 적는다** (`evidence-history-cap`). 조용히 끊긴 목록은
 * "더 오래된 커밋이 없다"고 거짓말하는 목록이다.
 */
export const COMMIT_LIMIT = 100

/**
 * just now · 32m ago · 3h ago · 5d ago.
 *
 * 정확한 시각보다 '얼마나 됐나'가 먼저다 — 기록을 훑는 이유는 순서를 잡기 위해서지
 * 특정 시각을 확인하기 위해서가 아니다. `now`를 받는 이유는 시계를 인자로 두어야
 * 테스트가 시간을 기다리지 않아도 되기 때문이다.
 */
export function commitAgo(when: number, now: number): string {
  const min = Math.floor((now - when) / 60000)
  // 미래로 찍힌 커밋(시계 어긋남·rebase)도 여기로 떨어진다 — 음수 분을 적느니 '방금'이 낫다
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  const day = Math.floor(hour / 24)
  return day < 30 ? `${day}d ago` : `${Math.floor(day / 30)}mo ago`
}

/**
 * 작성자 이름이 자리값을 하나.
 *
 * 혼자 쓰는 저장소면 모든 줄에 같은 이름이 반복된다 — 340px에서 그건 정보가 아니라 소음이다.
 * 구별할 사람이 있을 때만 적는다.
 */
export function hasMultipleAuthors(commits: GitCommit[]): boolean {
  const first = commits[0]?.author
  return commits.some((c) => c.author !== first)
}

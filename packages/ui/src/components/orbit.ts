import { useEffect } from 'react'

/** styles/index.css의 회전 궤도. 이름을 문자열로 아는 곳은 여기 하나다 */
const ORBIT = 'cc-orbit-spin'

/**
 * 도는 것들은 **한 시계**를 본다.
 *
 * 사이드바 표식과 그리드 칸 테두리는 같은 궤도를 같은 1.4초로 돈다. 그런데도 화면에서
 * 서로 다른 속도로 보였다 — 주기가 아니라 **위상**이 달랐다. CSS 애니메이션은 요소가
 * 생긴 순간부터 세므로, 세션이 도는 중에 그리드로 넘어가면 칸의 궤도는 거기서 0부터
 * 시작한다. 실측으로 758ms, 거의 정반대였다(1.4초 주기의 195°). 눈은 두 개가 어긋난
 * 것까지는 읽어도 "위상이 다르다"고는 읽지 않는다. 그냥 따로 논다고 본다.
 *
 * 그래서 각자의 시작점을 버리고 문서 시계의 원점에 못 박는다. 언제 생겼든 각도는
 * `(지금 % 1.4초)`로 같아지고, 이후로도 같이 간다.
 *
 * **CSS만으로 하는 방법을 먼저 재봤고, 버렸다.** `--cc-orbit`을 상속되게 바꿔 뿌리에서
 * 한 번만 돌리면 코드는 세 줄로 끝나지만, 상속되는 커스텀 속성이 매 프레임 바뀌면
 * 트리 전체가 다시 계산된다. 노드 12만 개(긴 대화 하나가 그 근처다)에서 프레임이
 * 16.7ms → 34.1ms로 두 배가 됐다. 도는 표식 하나 맞추자고 대화창을 절반 속도로
 * 만들 수는 없다. 이 방식은 상태가 바뀌는 순간에만 일하고, 프레임마다는 아무것도 안 한다.
 */
export function syncOrbits(): void {
  // jsdom에는 이 API가 없다 — 단위 테스트에서 화면 없이 그려질 때가 있다
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return
  for (const anim of document.getAnimations()) {
    if ((anim as CSSAnimation).animationName !== ORBIT) continue
    // 이미 맞은 것은 건드리지 않는다 — 다시 넣으면 그 프레임에 한 번 튄다
    if (anim.startTime !== 0) anim.startTime = 0
  }
}

/**
 * 새로 도는 것이 생겼으면 전부 같은 각도로 맞춘다.
 *
 * `key`는 "지금 도는 것들"을 나타내는 값이면 된다 — 그게 바뀔 때가 궤도가 새로 생기는
 * 순간이다. 마운트도 그 순간에 포함된다(처음 렌더에서 이미 돌고 있는 경우).
 */
export function useOrbitSync(key: string | boolean): void {
  useEffect(() => {
    if (!key) return
    syncOrbits()
  }, [key])
}

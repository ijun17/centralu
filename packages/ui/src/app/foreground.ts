/**
 * 앱이 지금 **눈앞에 있는가**.
 *
 * 알림 정책이 여기에 달려 있다: 눈앞에 있으면 알리지 않는다(소음이므로).
 * 그래서 이 판정이 틀리면 **알림이 조용히 사라진다** — 아무 흔적도 남지 않는 종류의 고장이다.
 *
 * 두 신호가 필요하다:
 *   - `hasFocus`   다른 앱에 가려졌는가 (맥에서 앱 전환하면 false)
 *   - `visibility` 최소화·다른 탭으로 가려졌는가
 *
 * 예전엔 visibilitychange 핸들러만 `visibility`를 봤다. 그래서 다른 앱으로 간 뒤
 * (blur로 false가 된 뒤) 가림 이벤트가 한 번 더 뜨면 다시 true가 됐다 —
 * 창은 여전히 'visible'이기 때문이다. 그 순간부터 알림이 막힌다.
 */
export function isForeground(hasFocus: boolean, visibility: DocumentVisibilityState): boolean {
  return hasFocus && visibility === 'visible'
}

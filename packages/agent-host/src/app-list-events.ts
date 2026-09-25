import type { ExternalApps } from './apps/external/runtime.js'

/**
 * 외부 앱 목록이 달라졌다는 방송 (M4 A-8) — 런타임의 알림(`onAppsChanged`)을 목록 비교로 거른다.
 *
 * 런타임의 알림은 "달라졌을 수 있다"이다. 상태를 바꾸는 자리마다 부르고, 판정은 받는 쪽이 한다.
 * 세션은 붙은 앱과 도구를 비교하고, 여기서는 UI가 보는 것(`list()`) 전부를 비교한다. 같으면
 * 방송하지 않는다. 그래서 목록이 그대로인 알림(에이전트 도구만 바뀌었다)은 화면에 왕복을
 * 만들지 않고, 목록이 바뀐 알림은 하나도 빠지지 않는다.
 *
 * main.ts와 시험이 이 함수를 같이 쓴다(`app-view-source.ts`와 같은 자리). 시험이 도는 이음새가
 * 곧 host의 이음새다.
 *
 * @returns 구독을 푼다
 */
export function onExternalAppListChanged(apps: ExternalApps, emit: () => void): () => void {
  let seen = JSON.stringify(apps.list())
  return apps.onAppsChanged(() => {
    const now = JSON.stringify(apps.list())
    if (now === seen) return
    seen = now
    emit()
  })
}

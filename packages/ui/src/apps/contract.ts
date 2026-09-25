import type { ComponentType } from 'react'
import type { AppId } from '@cc/protocol'

/**
 * 앱의 UI 쪽 계약 (#81) — 컴파일타임 레지스트리에 얹히는 모듈의 모양.
 *
 * 동적 로딩은 없다: 앱은 저장소 안 React 컴포넌트고, 격리는 로딩 방식이 아니라
 * **단방향 의존**(앱은 api.ts로만 코어를 만지고, 코어는 registry 한 줄만 안다)과
 * **소유권**(상태·도구·슬롯이 앱 소유라 토글 오프 = 잔재 없음)으로 지킨다.
 * 강제는 dependency-cruiser 규칙이 한다 — 관례가 아니라 CI다.
 *
 * id는 열린 문자열이다 (M4 P-1). 전에는 여기서 `'control'` 하나짜리 합집합으로 닫혀
 * 있었다 — 명부가 컴파일된 배열 하나일 때는 참이었지만, 실행 중에 발견되는 외부 앱은
 * 그 합집합에 들어갈 방법이 없다. 정의는 전선과 같은 곳(`@cc/protocol`)에 두고 여기서는
 * 다시 내보내기만 한다: 앱 저자가 읽는 이름은 계속 이 파일에서 나온다.
 */
export type { AppId }

export type AppModule = {
  id: AppId
  /** Settings > Apps 줄에 서는 이름 */
  title: string
  /** 오케스트레이터 화면 우측 레일 */
  railPanel?: ComponentType
  /** 전용 화면 (보드 앱에서 쓸 자리 — 지금은 비어 있다) */
  view?: ComponentType
  /** Settings > Apps > 이 앱의 설정 */
  settingsPanel?: ComponentType
}

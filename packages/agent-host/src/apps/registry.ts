import type { HostAppModule } from './contract.js'
import { controlHostApp } from './control.js'

/**
 * 앱 명부 (#81) — **코어가 앱에 대해 아는 유일한 줄.**
 *
 * 컴파일타임 배열이다. 동적 로딩·버저닝·서드파티 스토리는 일부러 없다 —
 * 앱은 저장소 안 모듈이고, 계약은 두 소비자(관제, 다음 앱)가 요구를 증명한
 * 것만 담는다. 여기서 빼면 앱은 존재하지 않는다: 도구도, 상태도, UI도.
 */
export const HOST_APPS: readonly HostAppModule[] = [controlHostApp]

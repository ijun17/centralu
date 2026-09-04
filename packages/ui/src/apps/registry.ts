import type { AppModule } from './contract.js'
import { controlApp } from './control/index.js'

/**
 * 앱 명부 (#81) — **코어가 앱에 대해 아는 유일한 줄** (host 쪽 registry와 대칭).
 * 여기서 빼면 앱은 화면에서 존재하지 않는다. 토글은 지우지 않고 안 그릴 뿐이다.
 */
export const APPS: readonly AppModule[] = [controlApp]

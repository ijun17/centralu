import type { ExternalApps } from './apps/external/runtime.js'
import type { ViewSource } from './views/view-host.js'

/**
 * 앱 화면(views/)과 외부 앱 런타임(apps/external/)을 잇는 한 줄 (M4 B-3 ↔ A).
 *
 * 두 층은 서로를 모른다. 화면 쪽은 "문서를 읽어 주고, 출처 방식을 알려 주고, 열린 동안 앱을
 * 붙들어 주는 쪽"을 `ViewSource`로 선언하고, 런타임은 그 일을 하는 함수를 가진다. 여기서
 * 둘을 맞댄다. main.ts와 시험이 이 함수를 같이 쓴다. 그래서 시험이 도는 이음새가 곧 host의
 * 이음새다(`app-run-ledger.ts`와 같은 자리).
 *
 * 앱은 (프로젝트, id)로 하나다. 두 층의 `AppRef` 모양이 같아서 그대로 넘긴다.
 */
export function runtimeViewSource(apps: ExternalApps): ViewSource {
  return {
    readResource: (app, uri) => apps.readResource(app, uri),
    originMode: (app) => apps.viewOrigin(app),
    retain: (app) => apps.retainView(app),
  }
}

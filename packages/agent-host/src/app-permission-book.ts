import type { AppRef, CapabilityBook } from './apps/external/runtime.js'
import type { Store } from './dev-services/store.js'

/**
 * 외부 앱 런타임의 능력 승인 기억(`CapabilityBook`)을 저장소로 채운다 (M4 D-4).
 *
 * 실행 기록(`app-run-ledger.ts`)과 같은 뒤집기다: 런타임은 Store를 임포트하지 않는다. host의 main과 시험이 같은 이음새를
 * 쓴다 — 시험만의 이음새가 따로 있으면, 시험이 초록이어도 진짜 host의 선은 끊겨 있을 수 있다.
 */
export function storePermissionBook(store: Store): CapabilityBook {
  const key = (app: AppRef) => `${app.projectId ?? '_user'}/${app.appId}`
  return {
    get: (app, capability) => store.getAppPermission(key(app), capability),
    put: (app, d) => store.putAppPermission(key(app), app.projectId, d),
    forget: (app, capability) => store.forgetAppPermission(key(app), capability),
    list: (app) => store.listAppPermissions(key(app)),
  }
}

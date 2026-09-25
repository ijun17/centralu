import type { RunLedger } from './apps/external/runtime.js'
import type { Store } from './dev-services/store.js'

/**
 * 외부 앱 런타임의 실행 기록 자리(`RunLedger`)를 저장소로 채운다 (M4 A-6).
 *
 * 런타임은 Store를 임포트하지 않는다(`host-app-runtime-physics-only`) — 필요한 모양을 선언하고,
 * 코어가 이 한 장으로 잇는다. host의 main과 테스트가 같은 이음새를 쓴다: 테스트만의 이음새가
 * 따로 있으면, 테스트가 초록이어도 진짜 host의 선은 끊겨 있을 수 있다.
 */
export function storeRunLedger(store: Store): RunLedger {
  return {
    begin: (r) => store.beginAppRun(r),
    end: (id, e) => store.endAppRun(id, e),
    link: (id, sessionId) => store.linkAppRunSession(id, sessionId),
    keepFailure: (f, keep) => store.keepAppRunFailure(f, keep),
    list: (projectId, appId, limit) => store.listAppRuns(projectId, appId, limit),
    prune: (before) => store.pruneAppRuns(before),
    settleUnfinished: (error) => store.settleUnfinishedAppRuns(error),
  }
}

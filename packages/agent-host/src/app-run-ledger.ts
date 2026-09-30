import type { RunLedger } from './apps/external/runtime.js'
import type { Store } from './dev-services/store.js'

/**
 * Backs the external app runtime's run record slot (`RunLedger`) with the store (M4 A-6).
 *
 * The runtime does not import Store (`host-app-runtime-physics-only`) — it declares the shape it
 * needs, and the core wires it up in this one file. The host's main and the tests use the same
 * seam: if the tests had their own separate seam, they could stay green while the real host's
 * wiring was actually broken.
 */
export function storeRunLedger(store: Store): RunLedger {
  return {
    begin: (r) => store.beginAppRun(r),
    end: (id, e) => store.endAppRun(id, e),
    link: (id, sessionId) => store.linkAppRunSession(id, sessionId),
    keepFailure: (f, keep) => store.keepAppRunFailure(f, keep),
    list: (projectId, appId, limit) => store.listAppRuns(projectId, appId, limit),
    agentUse: (projectId, appId, since) => store.appAgentUse(projectId, appId, since),
    prune: (before) => store.pruneAppRuns(before),
    settleUnfinished: (error) => store.settleUnfinishedAppRuns(error),
  }
}

import type { AppRef, CapabilityBook } from './apps/external/runtime.js'
import type { Store } from './dev-services/store.js'
import { appKeyOf } from '@cc/protocol'

/**
 * Backs the external app runtime's capability approval memory (`CapabilityBook`) with the store
 * (M4 D-4).
 *
 * The same flip check as the run ledger (`app-run-ledger.ts`): the runtime does not import
 * Store. The host's main and the tests use the same seam. If the tests had their own separate
 * seam, they could stay green while the real host's wiring was actually broken.
 */
export function storePermissionBook(store: Store): CapabilityBook {
  const key = (app: AppRef) => appKeyOf(app.projectId, app.appId)
  return {
    get: (app, capability) => store.permissions.getAppPermission(key(app), capability),
    put: (app, d) => store.permissions.putAppPermission(key(app), app.projectId, d),
    forget: (app, capability) => store.permissions.forgetAppPermission(key(app), capability),
    list: (app) => store.permissions.listAppPermissions(key(app)),
  }
}

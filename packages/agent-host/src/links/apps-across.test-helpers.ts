import { storePermissionBook } from '../app-permission-book.js'
import { storeRunLedger } from '../app-run-ledger.js'
import { ExternalApps } from '../apps/external/runtime.js'
import type { Store } from '../dev-services/store.js'
import { readShared, writeShared } from '../sessions/app-access.js'
import type { SessionManager } from '../sessions/manager.js'
import { plantAttachApp, type PlantKit } from '../sessions/session-apps.test-helpers.js'
import { LinkedApps } from './linked-apps.js'
import { cleanups, folder } from './links-world.test-helpers.js'

/**
 * A host's app runtime for the tests of a project's app used from another machine (#1938), wired into its session
 * manager as main.ts wires it: the runtime over the store's projects, and the linked apps a session reaches beside them.
 * Its hosts (`appsPeers`) and the answers to the other side are wired by `machineHost` / `hubHost`.
 */
export function hostApps(store: Store, mgr: SessionManager) {
  const dataRoot = folder()
  const logs = folder()
  const rt = new ExternalApps({
    projects: () => store.projects.projectRoots(),
    dataRoot,
    reservedIds: ['control'],
    runs: storeRunLedger(store),
    permissions: storePermissionBook(store),
    shared: (ref) => readShared(store.settings, ref),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  const linked = new LinkedApps({ lookupMs: 2_000, chunkMs: 1_000 })
  mgr.apps.useExternalApps(rt, { linked })
  cleanups.push(() => rt.dispose())
  const projectName = (id: string) => store.projects.listProjects().find((p) => p.id === id)?.name ?? id
  const gates = new Map<string, { open(): void }>()
  return {
    rt,
    linked,
    projectName,
    /**
     * The fixture app (`--mode attach`: peek, poke, hold) in a project here; `shared`: the person shares it. `kit` comes from
     * the test file, as for `attachWorld`: the host core takes nothing from the app runtime but its door
     */
    plant(kit: PlantKit, projectId: string, id: string, o: { shared?: boolean } = {}) {
      const path = store.projects.listProjects().find((p) => p.id === projectId)!.path
      gates.set(id, plantAttachApp(kit, path, id, logs))
      if (o.shared) writeShared(store.settings, { projectId, appId: id }, true)
      rt.refresh()
    },
    /** Lets the app's `hold` calls end */
    open: (id: string) => gates.get(id)?.open(),
  }
}

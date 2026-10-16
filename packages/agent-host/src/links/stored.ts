import type { Store } from '../dev-services/store.js'
import type { HeadersMirror, MachineRecord, MachineRegistry } from './links.js'
import type { ProjectOrder } from './router.js'
import { z } from 'zod'
import { readJsonList } from '../dev-services/store/json.js'

/**
 * The registry and the headers mirror in the hub's own store (v46, store/linked-machines.ts). One writer per store
 * (docs/plans/remote-hub.md §1): the hub writes what it heard about other machines into its own
 * store and nothing else; each machine stays authoritative for its own data.
 */

export function storeRegistry(store: Store): MachineRegistry {
  return {
    list: () => store.listLinkedMachines(),
    add: (record: Omit<MachineRecord, 'slot'>) => store.addLinkedMachine(record),
    remove: (id) => store.removeLinkedMachine(id),
    setAcceptedVersions: (id, key) => store.setLinkedMachineAcceptedVersions(id, key),
  }
}

const kindOf = (k: 'sessions' | 'projects') => (k === 'sessions' ? 'session' : 'project')

/** Rows without an id are not headers the hub can answer for; they are left out */
const withIds = (list: unknown[]) =>
  list.filter((x): x is { id: string } => typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string')

export function storeMirror(store: Store): HeadersMirror {
  return {
    read: (machine, kind) => store.machineHeaders(machine, kindOf(kind)),
    replace: (machine, kind, list) => store.replaceMachineHeaders(machine, kindOf(kind), withIds(list)),
    upsertSession: (machine, session) => {
      if (typeof session.id === 'string') store.upsertMachineSession(machine, session as { id: string })
    },
    patchSession: (machine, sessionId, patch) => store.patchMachineSession(machine, sessionId, patch),
    removeSession: (machine, sessionId) => store.removeMachineSession(machine, sessionId),
    // The registry's removal takes the headers with the machine (store.removeLinkedMachine)
    forget: () => {},
  }
}

/**
 * The project order across machines (#734) in the hub's own store, as one setting: a key the previous build never
 * reads, so a host swap needs no migration. A value that cannot be read is no order at all, and the next drag writes
 * a new one.
 */
const PROJECT_ORDER_KEY = 'hub.projectOrder'

export function storeProjectOrder(store: Store): ProjectOrder {
  return {
    read: () => readJsonList(store.appSetting(PROJECT_ORDER_KEY), z.string()),
    write: (orderedIds) => store.setAppSetting(PROJECT_ORDER_KEY, JSON.stringify(orderedIds)),
  }
}

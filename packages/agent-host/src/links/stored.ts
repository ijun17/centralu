import type { Store } from '../dev-services/store.js'
import { isObj } from '../json-value.js'
import type { HeadersMirror, MachineRecord, MachineRegistry } from './links.js'
import type { ProjectOrder } from './router.js'
import type { LinkDeps } from './link-deps.js'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { readJsonList } from '../dev-services/store/json.js'
import { HUB_SELF_KEY } from '../dev-services/store/store-keys.js'
import { hubKeyOf, SshTunnel } from './tunnel.js'

/**
 * The registry and the headers mirror in the hub's own store (v46, store/linked-machines.ts). One writer per store
 * (docs/plans/remote-hub.md §1): the hub writes what it heard about other machines into its own
 * store and nothing else; each machine stays authoritative for its own data.
 */

export function storeRegistry(store: Store): MachineRegistry {
  return {
    list: () => store.machines.listLinkedMachines(),
    add: (record: Omit<MachineRecord, 'slot'>) => store.machines.addLinkedMachine(record),
    remove: (id) => store.machines.removeLinkedMachine(id),
    setAcceptedVersions: (id, key) => store.machines.setLinkedMachineAcceptedVersions(id, key),
    setAsks: (id, on) => store.machines.setLinkedMachineAsks(id, on),
    setAutoReconnect: (id, on) => store.machines.setLinkedMachineAutoReconnect(id, on),
    setLastConnected: (id, at) => store.machines.setLinkedMachineSeen(id, at),
    setRevoked: (id, revoked) => store.machines.setLinkedMachineRevoked(id, revoked),
  }
}

/**
 * This computer's id as a hub (#550): made once and kept in its store, so a machine it links to knows it again after
 * a restart or a reconnect. A setting the previous build never reads, so it needs no migration. Shaped as a machine id,
 * since the machine qualifies this hub's project ids with it. It is also the host id in every mail id and address.
 */
const HUB_SELF_ID = /^hub-[0-9a-f]{8}$/

export function hubSelfId(store: Store): string {
  const kept = store.settings.appSetting(HUB_SELF_KEY)
  if (kept && HUB_SELF_ID.test(kept)) return kept
  const made = `hub-${randomBytes(4).toString('hex')}`
  /*
   * Written under the write lock, keeping an id another host wrote since the read above: during a swap two hosts on one
   * store can both find none, and both would otherwise keep their own (every mail address made under the losing id would
   * then name a host that is not this one). Read back, so both answer with the one that was kept
   */
  store.settings.updateAppSetting(HUB_SELF_KEY, (current) => (current !== null && HUB_SELF_ID.test(current) ? current : made))
  return store.settings.appSetting(HUB_SELF_KEY) ?? made
}

/**
 * The tunnel each linked machine's link opens (main.ts's `tunnelFor`): ssh, pairing there under this hub's own key,
 * drawn from its id in the store (`hubSelfId`, #1405 review). Here rather than inline in main.ts so a test holds the
 * key to the id: a key from the data folder's path gave two hubs of one computer name and one path a single label
 */
export function tunnelsFor(store: Store, log: (line: string) => void): (record: MachineRecord) => SshTunnel {
  return (record) => new SshTunnel({ target: record.sshTarget, remote: record.remote, hubKey: hubKeyOf(hubSelfId(store)), log })
}

/**
 * What `new Links(...)` is given (main.ts), with everything the hub's own store decides made here: the registry, the
 * headers mirror and the tunnel (`tunnelsFor`). main.ts cannot hand any of the three in (the type leaves them out), so
 * the key a tunnel pairs under cannot be drawn from anything but the store's id again, and a test drives this very
 * function (#1405 review)
 */
export function linkDepsFor(store: Store, rest: Omit<LinkDeps, 'mirror' | 'registry' | 'tunnelFor'>): LinkDeps {
  return { ...rest, mirror: storeMirror(store), registry: storeRegistry(store), tunnelFor: tunnelsFor(store, (line) => rest.log?.(line)) }
}

const kindOf = (k: 'sessions' | 'projects') => (k === 'sessions' ? 'session' : 'project')

/** Rows without an id are not headers the hub can answer for; they are left out */
const withIds = (list: unknown[]) =>
  list.filter((x): x is { id: string } => isObj(x) && typeof x.id === 'string')

export function storeMirror(store: Store): HeadersMirror {
  return {
    read: (machine, kind) => store.machines.machineHeaders(machine, kindOf(kind)),
    replace: (machine, kind, list) => store.machines.replaceMachineHeaders(machine, kindOf(kind), withIds(list)),
    upsertSession: (machine, session) => {
      if (typeof session.id === 'string') store.machines.upsertMachineSession(machine, session as { id: string })
    },
    patchSession: (machine, sessionId, patch) => store.machines.patchMachineSession(machine, sessionId, patch),
    removeSession: (machine, sessionId) => store.machines.removeMachineSession(machine, sessionId),
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
    read: () => readJsonList(store.settings.appSetting(PROJECT_ORDER_KEY), z.string()),
    write: (orderedIds) => store.settings.setAppSetting(PROJECT_ORDER_KEY, JSON.stringify(orderedIds)),
  }
}

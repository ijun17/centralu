import { unheard, type NormalizedEvent } from '@cc/protocol/client'
import { machineAway } from '@cc/core'
import type { StoreGet, StoreSet } from '../state.js'
import { reloadCommandRuns, resyncOwed } from '../machines.js'
import { trackWorkingSince } from '../sessionList.js'

export function machineEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  /*
   * docs/state-management.md §7: the row is replaced whole; an owed read runs at a status that finds the machine still
   * connected, not one that turns it connected (its `machine_resync` follows).
   */
  if (e.type === 'machine_status') {
    const was = get().machines[e.machine.id]?.status
    set((s) => ({ machines: { ...s.machines, [e.machine.id]: e.machine } }))
    // An away session is not working (#1822, docs/state-management.md §7)
    const held = machineAway(e.machine) ? Object.values(get().sessions).filter((x) => x.machine === e.machine.id && unheard(x) !== x) : []
    if (held.length) {
      const sessions = { ...get().sessions, ...Object.fromEntries(held.map((x) => [x.id, unheard(x)])) }
      set((s) => ({ sessions, workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()) }))
    }
    if (was === 'connected' && e.machine.status === 'connected' && resyncOwed(get().platform, e.machine.id)) void get().recoverMachine(e.machine.id)
    return true
  }
  if (e.type === 'machine_resync') {
    // Its terminals' and runs' views read them again: an updated machine starts them over (#1902)
    set((s) => ({ machineResyncs: { ...s.machineResyncs, [e.machineId]: (s.machineResyncs[e.machineId] ?? 0) + 1 } }))
    reloadCommandRuns(get, e.machineId)
    void get().recoverMachine(e.machineId)
    return true
  }
  return false
}

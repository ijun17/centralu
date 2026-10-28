import type { NormalizedEvent } from '@cc/protocol/client'
import type { StoreGet, StoreSet } from '../state.js'
import { resyncOwed } from '../machines.js'

/**
 * Linked machines (#82): a link's state and a machine's resync. App-wide, handled before the session
 * guard (`dispatchEvent`). True when the event was one of these.
 */
export function machineEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  /*
   * A linked machine's link changed state (#82). The event carries the whole row, so it replaces that machine's row
   * rather than patching it. The machine's sessions are not touched: whether one is away is derived from this row
   * (`isAway`), and what they are is read again when the machine says so (`machine_resync`), or at a status that finds
   * it connected after a resync that could not read everything (#1611). A status that turns a machine connected is not
   * that: the hub sends its `machine_resync` right after.
   */
  if (e.type === 'machine_status') {
    const was = get().machines[e.machine.id]?.status
    set((s) => ({ machines: { ...s.machines, [e.machine.id]: e.machine } }))
    if (was === 'connected' && e.machine.status === 'connected' && resyncOwed(get().platform, e.machine.id)) void get().recoverMachine(e.machine.id)
    return true
  }
  // What the UI holds about one machine has to be read again (#82): its own recovery, not the whole app's
  if (e.type === 'machine_resync') {
    void get().recoverMachine(e.machineId)
    return true
  }
  return false
}

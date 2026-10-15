import type { NormalizedEvent } from '@cc/protocol'
import type { StoreGet, StoreSet } from '../state.js'

/**
 * Linked machines (#82): a link's state and a machine's resync. App-wide, handled before the session
 * guard (`dispatchEvent`). True when the event was one of these.
 */
export function machineEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  /*
   * A linked machine's link changed state (#82). The event carries the whole row, so it replaces that machine's row
   * rather than patching it. The machine's sessions are not touched: whether one is away is derived from this row
   * (`isAway`), and what they are is read again only when the machine says so (`machine_resync`).
   */
  if (e.type === 'machine_status') {
    set((s) => ({ machines: { ...s.machines, [e.machine.id]: e.machine } }))
    return true
  }
  // What the UI holds about one machine has to be read again (#82): its own recovery, not the whole app's
  if (e.type === 'machine_resync') {
    void get().recoverMachine(e.machineId)
    return true
  }
  return false
}

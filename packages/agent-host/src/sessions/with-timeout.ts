/** Moved to the host's one place for bounded waits (`timing.ts`, #428); kept so its importers need not change */
export { raceBound, withTimeout } from '../timing.js'

/**
 * The hub's links to other machines (docs/plans/remote-hub.md §2, §5): one `LinkedMachine` per machine, with its transport
 * (`Tunnel`), connection (`RemoteClient`), cursor and epoch, and the headers mirror for while it is away. The host imports
 * links through this door; the parts are link-deps.ts, linked-machine-connection.ts, linked-machine-ops.ts, links-registry.ts.
 */

export type { HeadersMirror, LinkDeps, MachineRecord, MachineRegistry } from './link-deps.js'
export { Links } from './links-registry.js'

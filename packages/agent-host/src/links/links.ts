/**
 * The hub's links to other machines (docs/plans/remote-hub.md §2, §5): one `LinkedMachine` per
 * machine the person linked, each with its transport (`Tunnel`), its connection (`RemoteClient`),
 * its own cursor and epoch, and the headers mirror that answers for it while it is away.
 *
 * This is the door the host imports links through. The parts: what a link is given (link-deps.ts),
 * one machine's connection, backoff, version gate and relayed events (linked-machine-connection.ts),
 * what the person asks of that machine: install, update, autostart, activity (linked-machine-ops.ts,
 * `LinkedMachine`), and every link of this hub with the ssh hosts and the probe (links-registry.ts, `Links`).
 */

export type { HeadersMirror, LinkDeps, MachineRecord, MachineRegistry } from './link-deps.js'
export { Links } from './links-registry.js'

/**
 * The sender a hub's orchestrator's instruction is recorded under (`sendFromHub`). Not a session of this host: no id
 * this host makes starts with `_`. The window shows only the sender's name; the id is what the injection gate reads
 */
export const HUB_SENDER = '_hub-orchestrator'

/**
 * The sender a linked machine's session's ask_project task is recorded under on the hub (#550, `MachineAsks`): another
 * machine's session, never the person and never an orchestrator. Not a session of this host, as `HUB_SENDER`; the
 * window shows the name it carries (`<session> on <machine>`)
 */
export const MACHINE_ASKER = '_linked-machine-session'

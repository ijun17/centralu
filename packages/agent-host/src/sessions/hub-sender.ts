/**
 * The sender a hub's Assistant's instruction is recorded under (`sendFromHub`). Not a session of this host: no id
 * this host makes starts with `_`. The window shows only the sender's name; the id is what the injection gate reads
 */
export const HUB_SENDER = '_hub-orchestrator'

/**
 * The same sender under the Assistant's new name (#2133, docs/plans/assistant-rename.md). This build records and sends
 * only `HUB_SENDER`; a later one sends this. A message row keeps the one it was recorded with, and a linked machine
 * of another release records its own, so every reader takes both
 */
const HUB_SENDER_RENAMED = '_hub-assistant'

/** Whether a sender id is the hub's Assistant's, under either name */
export function isHubSender(id: unknown): boolean {
  return id === HUB_SENDER || id === HUB_SENDER_RENAMED
}

/** Whether a sender id is a hub's Assistant's as it reaches the hub from a linked machine: qualified with that machine's id (`machineId` when given) */
export function isQualifiedHubSender(id: unknown, machineId?: string): boolean {
  if (typeof id !== 'string') return false
  const dot = id.lastIndexOf('.')
  if (dot < 0 || !isHubSender(id.slice(dot + 1))) return false
  return machineId === undefined || id.slice(0, dot) === machineId
}

/**
 * The sender a linked machine's session's ask_project task is recorded under on the hub (#550, `MachineAsks`): another
 * machine's session, never the person and never an Assistant. Not a session of this host, as `HUB_SENDER`; the
 * window shows the name it carries (`<session> on <machine>`)
 */
export const MACHINE_ASKER = '_linked-machine-session'

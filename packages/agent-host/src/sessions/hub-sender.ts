/**
 * The sender a hub's Assistant's instruction is recorded under (`sendFromHub`). Not a session of this host: no id
 * this host makes starts with `_`. The window shows only the sender's name; the id is what the injection gate reads
 */
export const HUB_SENDER = '_hub-assistant'

/**
 * The same sender under the Assistant's old name (#2133, docs/plans/assistant-rename.md §3.4): a row recorded before
 * #2532 keeps it, and a linked machine of beta.57 to beta.84 still records it and relays it to the hub, so every
 * reader takes both
 */
const HUB_SENDER_OLD = '_hub-orchestrator'

/** Whether a sender id is the hub's Assistant's, under either name */
export function isHubSender(id: unknown): boolean {
  return id === HUB_SENDER || id === HUB_SENDER_OLD
}

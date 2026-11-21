import type { NormalizedEvent } from '@cc/protocol/client'
import type { ConnectionState, Platform } from '@cc/platform/ports'

/** The connection to the host and the recovery after it comes back. */
export type ConnectionSlice = {
  platform: Platform | null
  connection: ConnectionState
  /**
   * Reconnects to a host that could not replay (`resync_required`): another host lifetime (#280). An open app view asks
   * for its address again on each, since the new host may serve it elsewhere or not at all.
   */
  hostResyncs: number
  /** The same per linked machine (`machine_resync`, #1902) */
  machineResyncs: Record<string, number>
  /**
   * The first lists arrived and the last screen is restored (docs/state-management.md §5); until then no screen shows,
   * so no intro flashes. Stays true across reconnects.
   */
  workspaceReady: boolean
  attach(platform: Platform): Promise<void>
  /** `id`: what every window of the host calls the event (`agents.subscribe`), which a notification is claimed by */
  dispatchEvent(e: NormalizedEvent, id?: string): void
  /** docs/state-management.md §5, §7. `resync`: no replay, so the open conversation is read again too. */
  recoverAfterReconnect(resync?: boolean): Promise<void>
}

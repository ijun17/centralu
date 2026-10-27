import type { NormalizedEvent } from '@cc/protocol/client'
import type { ConnectionState, Platform } from '@cc/platform/ports'

/** The connection to the host and the recovery after it comes back. */
export type ConnectionSlice = {
  platform: Platform | null
  connection: ConnectionState
  /**
   * How many times the connection came back to a host that could not replay what was missed
   * (`resync_required`) — in practice another host lifetime: a restart, or a build switch behind
   * the keeper's front door (#280). An open app view asks for its address again on every change
   * (AppFrame): the new host may serve it at another address, or not at all.
   */
  hostResyncs: number
  /**
   * The first lists have arrived and the last screen has been restored (owner, 2026-10-18). Until then the window
   * does not know which screen to show, so it shows none: the orchestrator's intro and "No projects yet" used to flash
   * before the restored screen replaced them. Stays true across later reconnects.
   */
  workspaceReady: boolean
  attach(platform: Platform): Promise<void>
  dispatchEvent(e: NormalizedEvent): void
  /**
   * Recovery after reconnecting. Merges the host's session list into the store (sessions created,
   * changed or deleted while disconnected), and revives sessions that were running (when the host
   * dies, its processes die with it). If `resync` is true, event replay was not possible — the
   * conversation being viewed is also re-read from the store.
   */
  recoverAfterReconnect(resync?: boolean): Promise<void>
}

import type {
  NormalizedEvent,
} from '@cc/protocol'
import type {
  ConnectionState,
  Platform,
} from '@cc/platform/ports'

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

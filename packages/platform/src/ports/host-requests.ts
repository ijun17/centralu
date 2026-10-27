import type { HostRequest } from '@cc/protocol/client'

/**
 * The calls of the limited credential waiting for the person (#1405): a program on this computer that is not the
 * window (an agent's script, a tool) asked for something that cannot be undone, and the host holds the call until the
 * person allows or denies it here. The host raises one only while a window that shows them is attached; this window
 * says it does in its hello.
 */
export interface HostRequestsPort {
  /** The requests waiting, oldest first: read after connecting, since a `host_request` event missed is not sent again */
  list(): Promise<HostRequest[]>
  /** The person's answer; `ok` is false when the request no longer waits (answered elsewhere, withdrawn, expired) */
  answer(requestId: string, decision: 'allow' | 'deny'): Promise<{ ok: boolean }>
}

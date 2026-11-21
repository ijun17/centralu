import type { HostRequest } from '@cc/protocol/client'

/**
 * Calls of the limited credential the host holds for the person to allow or deny (#1405, docs/protocol.md §1); raised
 * only while a window that says in its hello it shows them is attached.
 */
export interface HostRequestsPort {
  list(): Promise<HostRequest[]>
  answer(requestId: string, decision: 'allow' | 'deny'): Promise<{ ok: boolean }>
}

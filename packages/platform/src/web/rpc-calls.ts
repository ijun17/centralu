/** Owns admission, deadlines and delivery uncertainty for one client's calls. */
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  frame: string | null
  bytes: number
}

export function rpcError(message: string, code: string, retryable = false): Error {
  return Object.assign(new Error(message), { code, retryable })
}

export class RpcCalls {
  private pending = new Map<string, Pending>()
  private queuedBytes = 0

  constructor(private maxPending: number, private maxBytes: number) {}

  add(id: string, frame: string, timeout: number, method: string, resolve: Pending['resolve'], reject: Pending['reject']): boolean {
    const bytes = new TextEncoder().encode(frame).byteLength
    if (this.pending.size >= this.maxPending || this.queuedBytes + bytes > this.maxBytes) {
      reject(rpcError('Pending RPC limit reached', 'overloaded', true))
      return false
    }
    const timer = setTimeout(() => this.take(id)?.reject(rpcError(`RPC timed out: ${method}`, 'timeout', true)), timeout)
    this.pending.set(id, { resolve, reject, timer, frame, bytes })
    this.queuedBytes += bytes
    return true
  }

  send(send: (frame: string, bytes: number) => void): void {
    for (const [id, call] of this.pending) {
      if (call.frame === null) continue
      const frame = call.frame
      // Mark uncertain before invoking the socket, including a synchronous send failure.
      call.frame = null
      this.queuedBytes -= call.bytes
      try { send(frame, call.bytes) } catch (error) {
        this.take(id)?.reject(error instanceof Error ? error : rpcError('Connection lost', 'connection_lost', true))
      }
    }
  }

  take(id: string): Pending | undefined {
    const call = this.pending.get(id)
    if (!call) return undefined
    this.pending.delete(id)
    clearTimeout(call.timer)
    if (call.frame !== null) this.queuedBytes -= call.bytes
    return call
  }

  disconnect(reason: string): void {
    for (const [id, call] of this.pending) {
      if (call.frame === null) this.take(id)?.reject(rpcError(`${reason}; request outcome is unknown. Check host state before retrying.`, 'connection_lost', true))
    }
  }

  close(): void {
    for (const id of this.pending.keys()) this.take(id)?.reject(rpcError('Connection closed', 'connection_closed'))
  }
}

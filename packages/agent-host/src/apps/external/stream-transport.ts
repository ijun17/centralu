import type { Readable, Writable } from 'node:stream'
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client'

/**
 * An MCP transport over a pair of streams — newline-delimited JSON, the same as the stdio binding
 * (M4 A-3, spikes S-4 and S-5).
 *
 * Two reasons we do not use the SDK's `StdioClientTransport` (measured in the spikes):
 *   1. That transport **spawns its own child.** We have to give the child an extra pipe besides
 *      stdio (fd 3, for the broker), so spawning has to be our job.
 *   2. Figuring out the spec generation **starts the app twice** (a sibling process for the probe,
 *      then the real one). In S-4, a 2025-generation server started two processes for a single
 *      connection. This transport probes over the same connection instead — the SDK treats a
 *      stdio-shaped transport with no `_dispose` as "probing in place".
 *
 * `pid` and `stderr` **must exist even though nothing reads them.** The v2 client tells whether a
 * transport is stdio-shaped by whether these two properties exist (`detectProbeTransportKind`).
 * Without them it is treated as HTTP, and a 2025-generation server that does not answer the probe
 * gets disconnected as a "failure" instead of falling back to initialize because it is treated as
 * an old server (S-5 probe-classify: reusing the SDK transport produces `REQUEST_TIMEOUT`, this
 * transport connects as legacy instead).
 */
export class StreamTransport implements Transport {
  readonly pid: number | null
  readonly stderr = null
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private buf = new ReadBuffer()
  private closed = false

  constructor(
    private readable: Readable,
    private writable: Writable,
    opts: { pid?: number | null } = {},
  ) {
    this.pid = opts.pid ?? null
  }

  async start(): Promise<void> {
    this.readable.on('data', (chunk: Buffer) => {
      this.buf.append(chunk)
      for (;;) {
        let msg: JSONRPCMessage | null
        try {
          msg = this.buf.readMessage()
        } catch (e) {
          // Do not drop the connection over one malformed line — this happens when an app mixes
          // logging into stdout
          this.onerror?.(e as Error)
          continue
        }
        if (msg === null) break
        this.onmessage?.(msg)
      }
    })
    this.readable.on('error', (e) => this.onerror?.(e))
    this.readable.on('end', () => void this.close())
    this.readable.on('close', () => void this.close())
    // If the app dies first, the write side throws EPIPE — leaving it unhandled turns into an
    // unhandled exception in the host
    this.writable.on('error', (e) => this.onerror?.(e))
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('app connection closed'))
    return new Promise((resolve, reject) => {
      this.writable.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()))
    })
  }

  /** Closes only our own state. Closing the pipes is the shutdown rule's job (AppProcess.stop). */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

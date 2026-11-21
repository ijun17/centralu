import type { Readable } from 'node:stream'
import { bridgeToken } from './transport/bridge-token.js'
import { sessionToken } from './transport/session-token.js'
import { lineSplitter } from './transport/json-lines.js'
import { isObj, tryParseJson } from './json-value.js'

/**
 * The control lines on the host's stdin (one JSON object per line, from a keeper or the window that started it) and the addresses that
 * outlive one host under a keeper. `{"op":"stop"}` stops (from the keeper, noting the person quit, #1143); with `forUpdate` the next host continues
 * what it ends; `{"op":"system-ending","cancelled"?:true}` notes the system is ending or no longer is (#1397). Nothing else is parsed; a host
 * started with `--standby` exits at once (main.ts)
 */

/**
 * The address and credential the Codex bridge of `sessionId` is started with. Under a keeper the address is the front door, never this host's
 * port: a running codex keeps its bridge for as long as the thread lives and the bridge reads its address once, so an address that dies with
 * this host would cut every bridge on a restart. The credential is the session's bridge token (`transport/bridge-token.ts`, #382), derived
 * from the host's token, which under a keeper is the front door's, so the next host accepts it too
 */
export function bridgeAddress(
  frontDoor: string | undefined,
  port: number | undefined,
  hostToken: string,
  sessionId: string,
): { url: string; token: string; credential: string } | null {
  if (!port) return null
  // The bridge's credential, and the session's for its processes (#1405, session-token.ts): both derived, never stored
  return { url: frontDoor || `ws://127.0.0.1:${port}`, token: bridgeToken(hostToken, sessionId), credential: sessionToken(hostToken, sessionId) }
}

/**
 * The port an app view's address points at (#280 step 4, views/view-host.ts). Under a keeper it is the front door's, as for the bridge: the
 * address is loaded into an iframe that outlives this host and the door relays HTTP to whichever host is current. Without a keeper, or with a
 * door address that is not a loopback port, it is the host's own port
 */
export function viewPort(frontDoor: string | undefined, port: number | undefined): number | null {
  if (!port) return null
  if (!frontDoor) return port
  try {
    const door = new URL(frontDoor)
    const n = Number(door.port)
    return door.hostname === '127.0.0.1' && Number.isInteger(n) && n > 0 && n < 65536 ? n : port
  } catch {
    return port
  }
}

const MAX_LINE = 64 * 1024

export type ControlMessage = { op: string; forUpdate?: boolean; cancelled?: boolean }

/**
 * Control lines on the host's stdin, one handler per op. A line before its handler is registered is kept (the last per op) and
 * given to it then. The stream ending means nothing here: `--watch-parent` reads that
 */
export class ControlChannel {
  private handlers = new Map<string, (m: ControlMessage) => void>()
  /** The last line of an op that came before anything took it: the host is still starting while the window may already speak */
  private early = new Map<string, ControlMessage>()

  constructor(input: Readable) {
    const lines = lineSplitter((line) => {
      const l = line.trim()
      if (l) this.dispatch(l)
    }, { maxLine: MAX_LINE })
    input.on('data', (chunk: string | Buffer) => lines.push(chunk))
    input.resume()
  }

  on(op: string, handler: (m: ControlMessage) => void): void {
    this.handlers.set(op, handler)
    const early = this.early.get(op)
    this.early.delete(op)
    if (early) handler(early)
  }

  private dispatch(line: string): void {
    const msg = tryParseJson(line)
    if (!isObj(msg) || typeof msg.op !== 'string') return
    const m: ControlMessage = {
      op: msg.op,
      ...(typeof msg.forUpdate === 'boolean' ? { forUpdate: msg.forUpdate } : {}),
      ...(typeof msg.cancelled === 'boolean' ? { cancelled: msg.cancelled } : {}),
    }
    const handler = this.handlers.get(m.op)
    if (handler) handler(m)
    else this.early.set(m.op, m)
  }
}

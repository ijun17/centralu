import type { Readable } from 'node:stream'
import { bridgeToken } from './transport/bridge-token.js'
import { sessionToken } from './transport/session-token.js'
import { lineSplitter } from './transport/json-lines.js'
import { isObj, tryParseJson } from './json-value.js'

/**
 * The control lines on the host's stdin, and the addresses that outlive one host under a keeper.
 *
 * The parent holds the host's stdin (it is the pipe whose end tells the host its parent is gone, `--watch-parent`). Under
 * a keeper, or the desktop window that started the host, that pipe also carries a few control lines, one JSON object per
 * line:
 *
 * | parent -> host (stdin)                       | what the host does                                          |
 * |----------------------------------------------|-------------------------------------------------------------|
 * | `{"op":"stop"}`                              | stops; from the keeper, it notes the person quit (#1143)     |
 * | `{"op":"stop","forUpdate":true}`             | stops for an update: the next host continues what it ends    |
 * | `{"op":"system-ending","cancelled"?:true}`   | notes the system is ending, or that it no longer is (#1397) |
 *
 * The host parses nothing else the parent sends. Until #1895 a keeper also swapped hosts over this pipe (`--standby`,
 * `activate`, `drain`); no host of this build answers those, and one started with `--standby` exits at once (main.ts).
 */

/**
 * The address and credential the Codex bridge of `sessionId` is started with. Under a keeper the
 * address is the front door, never this host's own port: a running codex keeps the bridge it
 * started for as long as its thread lives, and the bridge reads its address once, from its
 * environment, so an address that dies with this host would cut every bridge when the keeper restarts its host.
 *
 * The credential is the session's bridge token, never the host's own (`transport/bridge-token.ts`,
 * #382): the bridge's environment can be read by any process of the same user. It is derived from
 * the host's token, which under a keeper is the front door's, so the next host accepts it too.
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
 * The port an app view's address points at (#280 step 4, views/view-host.ts). Under a keeper it is
 * the front door's, for the same reason as the bridge above: the address is handed to the UI once
 * and loaded into an iframe that outlives this host, and the door relays the HTTP bytes to
 * whichever host is current, so after the keeper restarts its host the same address still serves the view. Without a
 * keeper, or with a door address that is not a loopback port (never what the keeper hands over),
 * it is the host's own port. Nothing before the host listens.
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

/** The longest control line accepted. The real ones are tens of bytes */
const MAX_LINE = 64 * 1024

/** `cancelled`: on `system-ending`, the end the line before announced was called off (#1397) */
export type ControlMessage = { op: string; forUpdate?: boolean; cancelled?: boolean }

/**
 * Control lines on the host's stdin. One handler per op. A line that arrives before its handler is registered is kept
 * (the last one per op) and given to it then. The stream ending means nothing here: `--watch-parent` reads that.
 */
export class ControlChannel {
  private handlers = new Map<string, (m: ControlMessage) => void>()
  /** The last line of an op that came before anything took it: the host is still starting while the window may already speak */
  private early = new Map<string, ControlMessage>()

  constructor(input: Readable) {
    // A peer that never sends a newline does not get to grow this without bound: past MAX_LINE, its line is not JSON
    const lines = lineSplitter((line) => {
      const l = line.trim()
      if (l) this.dispatch(l)
    }, { maxLine: MAX_LINE })
    input.on('data', (chunk: string | Buffer) => lines.push(chunk))
    // Paused when the token line was read first (`readHandedToken`, #538); a listener alone does not restart it
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

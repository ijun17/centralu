import { createServer, type RequestListener, type Server } from 'node:http'
import { randomInt } from 'node:crypto'

/**
 * Per-app origin ports (M4 B-3, spike S-1).
 *
 * An app that breaks under an opaque origin (5 of 86 public apps, S-8) is given its own origin:
 * `http://127.0.0.1:<that app's port>`. WebKit keeps browser storage **separated by origin**, so
 * the port has to preserve two properties.
 *
 *   Fixed     The same app gets the same port across runs. Otherwise the app's storage disappears
 *             on every run.
 *   Immutable A port once given to an app is **never given to a different app again**, even after
 *             that app is deleted. That origin's storage remains in WebKit, so reissuing the port
 *             would let a new app read someone else's storage.
 *
 * So the assignment table (key → port) and the retired list are stored on the host side, and the
 * table never shrinks.
 *
 * The port range is 20000–32767. This avoids macOS's ephemeral port range (49152–65535) and
 * Linux's (32768–60999) — picking from there would risk the OS briefly lending the same number to
 * an outgoing connection.
 *
 * If another program is holding an assigned port, that app is moved to a new port and the old one
 * is retired. The app loses that origin's storage. In exchange, the view comes up. Keeping state on
 * the server is a principle of this design, so losing storage is a smaller cost than the view never
 * coming up at all. The fact of the move is recorded in the host log.
 *
 * Cookies sit outside this isolation. In dev and web modes, where the top level is
 * `http://127.0.0.1`, all ports share cookies (measured for S-1: Chromium, WebKit, WKWebView).
 * localStorage and IndexedDB are separated.
 */

export type PortBook = {
  /** key → port. The key is `<project id or _user>/<app id>` (views/view-host.ts) */
  assigned: Record<string, number>
  /** Ports that left because they were held by someone else. Never given to anyone again */
  retired: number[]
}

export interface PortBookStore {
  load(): PortBook | null
  save(book: PortBook): void
}

export type OriginPortsOptions = {
  range?: readonly [number, number]
  /** Lets tests control the order. Defaults to a uniform random number within the range */
  pick?: (lo: number, hi: number) => number
  attempts?: number
  log?: (line: string) => void
}

export const ORIGIN_PORT_RANGE = [20000, 32767] as const

/** The stored value is a file — malformed parts are dropped on read (a failure to start is a bigger risk than a dropped port being reassigned) */
function readBook(raw: PortBook | null): PortBook {
  const book: PortBook = { assigned: {}, retired: [] }
  if (!raw || typeof raw !== 'object') return book
  const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536
  if (raw.assigned && typeof raw.assigned === 'object') {
    for (const [k, v] of Object.entries(raw.assigned)) if (validPort(v)) book.assigned[k] = v
  }
  if (Array.isArray(raw.retired)) book.retired = raw.retired.filter(validPort)
  return book
}

function listenOn(port: number, handler: RequestListener): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.once('error', reject)
    // Binds only to loopback — another machine on the same network has no reason to reach this view
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

export class OriginPorts {
  private readonly range: readonly [number, number]
  private readonly pick: (lo: number, hi: number) => number
  private readonly attempts: number
  private readonly log: (line: string) => void

  constructor(
    private readonly store: PortBookStore,
    opts: OriginPortsOptions = {},
  ) {
    this.range = opts.range ?? ORIGIN_PORT_RANGE
    this.pick = opts.pick ?? ((lo, hi) => randomInt(lo, hi + 1))
    this.attempts = opts.attempts ?? 200
    this.log = opts.log ?? ((line) => console.error(line))
  }

  /** The current assignment table (for tests and diagnostics). Reads the store's value as is */
  book(): PortBook {
    return readBook(this.store.load())
  }

  /**
   * Starts a server with the handler attached at this key's port. For a key seen for the first
   * time, a new port is chosen and returned only **after it is recorded**. If it cannot be
   * recorded, the server is closed and this throws. Using an unrecorded port risks that port going
   * to a different app on the next run.
   */
  async serve(key: string, handler: RequestListener): Promise<{ port: number; server: Server }> {
    const book = this.book()
    const own = book.assigned[key]
    if (own !== undefined) {
      try {
        return { port: own, server: await listenOn(own, handler) }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        this.log(
          `[agent-host] view origin port ${own} for ${key} is taken by another program — ` +
            `moving it to a new port; storage the view kept under the old origin is no longer visible`,
        )
        book.retired.push(own)
        delete book.assigned[key]
      }
    }
    const taken = new Set<number>([...Object.values(book.assigned), ...book.retired])
    const [lo, hi] = this.range
    for (let i = 0; i < this.attempts; i++) {
      const port = this.pick(lo, hi)
      if (port < lo || port > hi || taken.has(port)) continue
      let server: Server
      try {
        server = await listenOn(port, handler)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        // A port currently held belongs to no one — it is only skipped for this attempt
        taken.add(port)
        continue
      }
      book.assigned[key] = port
      try {
        this.store.save(book)
      } catch (e) {
        await new Promise<void>((r) => server.close(() => r()))
        throw e
      }
      return { port, server }
    }
    throw new Error(`No free view origin port for ${key} in ${lo}-${hi}`)
  }
}

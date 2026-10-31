import { createServer, type RequestListener, type Server } from 'node:http'
import { randomInt } from 'node:crypto'
import { tryParseJson } from '../json-value.js'

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
  /** Fields a newer build added (#384), kept as they are when the book is written back */
  [field: string]: unknown
}

export interface PortBookStore {
  load(): PortBook | null
  save(book: PortBook): void
  /**
   * Reads the stored book, applies `fn` and writes the result back as one step, so a writer in
   * another process (the old and new host of a swap share the store) cannot slip in between the
   * read and the write. Without it, the same steps run as a plain load and save, which is
   * already one step inside a single process because none of them waits.
   */
  update?(fn: (current: PortBook | null) => PortBook): void
}

export type OriginPortsOptions = {
  range?: readonly [number, number]
  /** Lets tests control the order. Defaults to a uniform random number within the range */
  pick?: (lo: number, hi: number) => number
  attempts?: number
  log?: (line: string) => void
}

export const ORIGIN_PORT_RANGE = [20000, 32767] as const

const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536

/** Every port a value names, at any depth: what a value this build cannot read may hold */
function portsIn(v: unknown, out: number[] = []): number[] {
  if (validPort(v)) out.push(v)
  else if (Array.isArray(v)) for (const x of v) portsIn(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) portsIn(x, out)
  return out
}

/**
 * The stored value is a file another build writes too (#384). A part this build cannot read is not used, but its
 * ports are retired, so an assignment a newer build wrote in another shape never has its port given to another app:
 * a failure to start is a bigger risk than a dropped entry, and a port handed out twice leaks one app's storage to
 * another. Fields this build does not know are kept, so writing the book back does not drop them.
 */
function readBook(raw: PortBook | null): PortBook {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { assigned: {}, retired: [] }
  const { assigned, retired, ...rest } = raw
  const book: PortBook = { ...rest, assigned: {}, retired: [] }
  const unread: number[] = []
  if (assigned && typeof assigned === 'object') {
    for (const [k, v] of Object.entries(assigned)) {
      if (validPort(v)) book.assigned[k] = v
      else portsIn(v, unread)
    }
  }
  if (Array.isArray(retired)) for (const p of retired) (validPort(p) ? book.retired : unread).push(...portsIn(p))
  const used = new Set([...Object.values(book.assigned), ...book.retired])
  for (const p of unread) {
    if (used.has(p)) continue
    used.add(p)
    book.retired.push(p)
  }
  return book
}

/**
 * The stored row read as a book (`apps.viewPorts`, main.ts), or null for none. Text that is not a JSON object (a write
 * cut short, a hand edit) cannot say which app had which port, so every number in it that could be a port is retired,
 * and its apps get new ports: they lose what they kept under the old origin, and no app gets another's. `say` is told
 * once per reading of such a row; the next port written replaces it.
 */
export function parsePortBook(raw: string | null, say: (line: string) => void): PortBook | null {
  if (raw === null) return null
  const v = tryParseJson(raw)
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as PortBook
  const retired = [...new Set((raw.match(/\d+/g) ?? []).map(Number).filter(validPort))]
  say(
    `is not a JSON object (${JSON.stringify(raw.slice(0, 80))}): its ${retired.length} port number(s) are retired so none goes to another app, and its apps get new ports`,
  )
  return { assigned: {}, retired }
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
   * Reads the current book, lets `change` edit it and stores the result with no wait in between.
   * Every change to the table goes through here, so what another serve() recorded while this one
   * was binding a port is kept instead of being overwritten with an older copy.
   */
  private commit(change: (book: PortBook) => void): void {
    if (this.store.update) {
      this.store.update((current) => {
        const book = readBook(current)
        change(book)
        return book
      })
      return
    }
    const book = this.book()
    change(book)
    this.store.save(book)
  }

  /**
   * Starts a server with the handler attached at this key's port. For a key seen for the first
   * time, a new port is chosen and returned only **after it is recorded**. If it cannot be
   * recorded, the server is closed and this throws. Using an unrecorded port risks that port going
   * to a different app on the next run.
   *
   * Several keys can be served at once. The table is read again once a port is bound, and a port
   * that another key or the retired list holds by then is given up and another one is tried.
   */
  async serve(key: string, handler: RequestListener): Promise<{ port: number; server: Server }> {
    const own = this.book().assigned[key]
    if (own !== undefined) {
      try {
        return { port: own, server: await listenOn(own, handler) }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        this.log(
          `[agent-host] view origin port ${own} for ${key} is taken by another program — ` +
            `moving it to a new port; storage the view kept under the old origin is no longer visible`,
        )
        this.commit((book) => {
          if (book.assigned[key] === own) delete book.assigned[key]
          if (!book.retired.includes(own)) book.retired.push(own)
        })
      }
    }
    const busy = new Set<number>()
    const [lo, hi] = this.range
    for (let i = 0; i < this.attempts; i++) {
      const port = this.pick(lo, hi)
      if (port < lo || port > hi || busy.has(port)) continue
      const known = this.book()
      if (Object.values(known.assigned).includes(port) || known.retired.includes(port)) continue
      let server: Server
      try {
        server = await listenOn(port, handler)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        // A port currently held belongs to no one — it is only skipped for this attempt
        busy.add(port)
        continue
      }
      let claimed = false
      let displaced: number | undefined
      try {
        this.commit((book) => {
          claimed = !Object.values(book.assigned).includes(port) && !book.retired.includes(port)
          if (!claimed) return
          /*
           * Another host recorded a different port for this very key while this one was binding. This
           * port is the one in use here, so it takes the entry, and the other is retired: it may have
           * been served under that origin, and it must not be given to a different app later.
           */
          const prev = book.assigned[key]
          if (prev !== undefined && prev !== port) {
            displaced = prev
            if (!book.retired.includes(prev)) book.retired.push(prev)
          }
          book.assigned[key] = port
        })
      } catch (e) {
        await new Promise<void>((r) => server.close(() => r()))
        throw e
      }
      if (!claimed) {
        // Someone recorded this port while it was being bound — it is theirs
        await new Promise<void>((r) => server.close(() => r()))
        continue
      }
      if (displaced !== undefined) {
        this.log(`[agent-host] view origin port ${displaced} for ${key} was recorded elsewhere meanwhile — retired it, ${key} uses ${port}`)
      }
      return { port, server }
    }
    throw new Error(`No free view origin port for ${key} in ${lo}-${hi}`)
  }
}


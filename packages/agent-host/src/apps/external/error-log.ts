import type { AppProcess } from './app-process.js'
import { ERRORS_KEPT, errorBundle, type HeldErrorBundle, type SentErrorBundle } from './errors.js'

/**
 * Where an app's error bundles are kept (M4 C-6) — per app name (the runtime's `holdKey`), most
 * recent first, with which ones were sent to the building session. The runtime records into it and
 * answers from it (`ExternalApps.errors`, `markErrorSent`); what a bundle holds is `errors.ts`.
 */

/**
 * How long it waits to capture stderr once more after a tool failure (C-6). The stack a thrown app
 * error carries goes to stderr, while the failure answer goes to stdout, and the order they arrive in
 * is not guaranteed. Since it is a pipe on the same machine, both arrive within a few milliseconds.
 */
const STDERR_SETTLE_MS = 150

/** The key for a sent bundle — within one app, a bundle is uniquely (kind, time). Stays the same key even after stderr is re-captured and the bundle is replaced */
const sentKey = (holdKey: string, b: Pick<HeldErrorBundle, 'kind' | 'at'>): string => `${holdKey}\n${b.kind}\n${b.at}`

export class ErrorLog {
  /** Recent error bundles per app name (holdKey), most recent first (C-6) — carried over even when the manifest changes and a new entry is created */
  private bundles = new Map<string, HeldErrorBundle[]>()
  /**
   * A bundle sent to the building session → the time it was sent (C-6). Kept separately instead of
   * marked on the bundle because a tool-failure bundle **gets replaced with a new object** shortly
   * after, when it re-captures stderr (recordError) — a mark written onto the bundle would disappear
   * at that point.
   */
  private sent = new Map<string, number>()

  constructor(
    /** The list's "time of the last error" changed — the runtime announces it (see `record`) */
    private changed: () => void,
  ) {}

  errors(key: string): { latest: SentErrorBundle | null; recent: SentErrorBundle[] } {
    const recent = (this.bundles.get(key) ?? []).map((b) => ({ ...b, sentAt: this.sent.get(sentKey(key, b)) ?? null }))
    return { latest: recent[0] ?? null, recent }
  }

  /** The time of the most recent bundle, if any (the list's `lastErrorAt`) */
  lastAt(key: string): number | undefined {
    return this.bundles.get(key)?.[0]?.at
  }

  markSent(key: string, at: number): HeldErrorBundle | 'sent' | null {
    const list = this.bundles.get(key) ?? []
    const b = list.find((x) => x.at === at)
    if (!b) return null
    const k = sentKey(key, b)
    if (this.sent.has(k)) return 'sent'
    // Clears the mark for a bundle that has aged out of the list — a mark has no reason to outlive the bundle it belongs to
    for (const old of [...this.sent.keys()]) {
      if (old.startsWith(`${key}\n`) && !list.some((x) => sentKey(key, x) === old)) this.sent.delete(old)
    }
    this.sent.set(k, Date.now())
    return b
  }

  unmarkSent(key: string, at: number): void {
    const b = (this.bundles.get(key) ?? []).find((x) => x.at === at)
    if (b) this.sent.delete(sentKey(key, b))
  }

  /**
   * Records one error bundle. Since a tool failure's answer can arrive before stderr does (two
   * separate pipes — a thrown stack goes over stderr, the failure answer over stdout), that process's
   * stderr is captured once more a little afterward.
   */
  record(key: string, app: string, b: Omit<HeldErrorBundle, 'text' | 'denied'> & { denied?: HeldErrorBundle['denied'] }, proc: AppProcess | null): void {
    const list = this.bundles.get(key) ?? []
    let bundle = errorBundle(app, proc ? { ...b, stderr: proc.log.tailLines() } : b)
    list.unshift(bundle)
    if (list.length > ERRORS_KEPT) list.length = ERRORS_KEPT
    this.bundles.set(key, list)
    /*
     * The "time of the last error" the list states has changed — the screen (the error row) sees this
     * and re-reads the bundle. Why this does not rely on "changed" (emitChanged): a read-only tool's
     * call never emits it (doing so would turn a screen re-reading on failure into a loop). Failing to
     * start or dying already announced through the status change, but for a tool failure, this is the
     * only signal.
     */
    this.changed()
    if (!proc) return
    setTimeout(() => {
      const i = list.indexOf(bundle)
      if (i < 0) return
      bundle = errorBundle(app, { ...b, stderr: proc.log.tailLines() })
      list[i] = bundle
    }, STDERR_SETTLE_MS).unref()
  }

  /**
   * An app that is gone (its folder or its project removed) takes its error bundles with it (#392). They are kept
   * across a manifest change, not across removal: each removed app that had failed left up to ten bundles of stderr
   * behind for the host's life. A folder put back starts with none, as a new app does.
   */
  forget(key: string): void {
    this.bundles.delete(key)
    for (const k of [...this.sent.keys()]) if (k.startsWith(`${key}\n`)) this.sent.delete(k)
  }
}

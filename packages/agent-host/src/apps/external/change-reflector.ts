import type { AppLifecycle } from './app-lifecycle.js'
import { resetLife, type AppEntry, type Blocker } from './app-entry.js'
import { folderFingerprint } from './fingerprint.js'
import type { AppRef } from './ref.js'
import type { RuntimeTiming } from './runtime-types.js'

/** What reflecting changes asks of the runtime (`ExternalApps`) */
export type ReflectHost = {
  readonly timing: RuntimeTiming
  disposed(): boolean
  readonly lifecycle: AppLifecycle
  find(ref: AppRef): AppEntry | undefined
  holdKey(ref: AppRef): string
  label(ref: AppRef): string
  blocker(e: AppEntry, opts?: { fresh?: boolean }): Blocker | null
  appsChanged(): void
  /** "Changed" for an open screen: the app restarted on new code (`ExternalAppsDeps.emitChanged`) */
  emitChanged(ref: AppRef): void
  /** Whether the app's building session is mid-turn (`ExternalAppsDeps.builderBusy`) */
  builderBusy(ref: AppRef): boolean
  /** Rescans the app's scope now, reading a deferred manifest change for this app (`rescan`'s `now`) */
  rescanNow(ref: AppRef): void
}

/**
 * Reflecting a changed app folder (M4 C-4) — restarting an app on its new code once a building
 * session's turn ends, or once an edit from an editor goes quiet, without ever cutting off a call in
 * progress. Moved out of the runtime (`runtime.ts`) with its timers; the runtime tells it when a
 * scan saw a folder change (`folderChanged`) and when a person restored a version
 * (`reloadIfChanged`).
 */
export class ChangeReflector {
  /** Timers for reflecting changes (C-4) — per app name (holdKey). Carried over even when the manifest changes and a new entry is created */
  private turnEndTimers = new Map<string, NodeJS.Timeout>()
  private quietTimers = new Map<string, NodeJS.Timeout>()
  /** Apps whose started entry a scan replaced (new manifest) while their turn-end timer was pending — the timer finds only a never-started entry and must still start it */
  private replacedBeforeTurnEnd = new Set<string>()
  /** A reflect in progress — an overlapping call waits on the same one */
  private reloading = new Map<string, Promise<boolean>>()

  constructor(private host: ReflectHost) {}

  dispose(): void {
    for (const t of [...this.turnEndTimers.values(), ...this.quietTimers.values()]) clearTimeout(t)
    this.turnEndTimers.clear()
    this.quietTimers.clear()
    this.replacedBeforeTurnEnd.clear()
  }

  /**
   * A scan replaced `prev`, an entry that had started, with a new entry for a changed manifest. Usually that
   * scan is turn end's own (`rescanNow`). But a watcher's scan arriving after the builder went idle and before the
   * turn-end timer runs does it first, and the timer then finds a new entry that has never started: without this
   * note it would take it for an app nobody ever used and leave it stopped.
   */
  manifestReplaced(ref: AppRef, prev: AppEntry): void {
    const key = this.host.holdKey(ref)
    if (prev.life.stamp !== null && this.turnEndTimers.has(key)) this.replacedBeforeTurnEnd.add(key)
  }

  /**
   * This app's building session's turn ended (M4 C-4) — announced by the host from session state.
   *
   * This does not restart on every single change to the app folder: a building agent edits several
   * files, several times, within one turn, and the app in between is half-edited code. Only once the
   * turn ends is a whole batch of edits complete, and only the host watching session state knows that.
   * Notifications are briefly collected (a turn ending and a state change arrive back to back) — this
   * restarts once per turn.
   *
   * At turn end, the current folder is **measured directly** (its fingerprint). The answer is correct
   * no matter how many watch events were missed. This starts the app even if it is idle and stopped,
   * if it changed — the building session's tool list needs to move to the new code.
   */
  builderTurnEnded(ref: AppRef): void {
    if (this.host.disposed()) return
    const key = this.host.holdKey(ref)
    clearTimeout(this.turnEndTimers.get(key))
    const t = setTimeout(() => {
      this.turnEndTimers.delete(key)
      const replacedEarlier = this.replacedBeforeTurnEnd.delete(key)
      /*
       * A manifest change deferred while mid-turn is read right now (`rescan`'s `now`). Even if
       * watching missed that change, it is read here. If a new entry was created, the old process
       * stops after finishing its call (`haltWhenDrained`), and the new entry is started **once** with
       * the new manifest — just like when only the folder changed, this starts an app even if it was
       * idle and stopped, as long as it has ever started before (this moves the building session's
       * tool list forward).
       */
      const before = this.host.find(ref)
      this.host.rescanNow(ref)
      const after = this.host.find(ref)
      if (before && after && after !== before) {
        if (before.life.stamp !== null || replacedEarlier) void this.startNewManifest(after, "the builder's turn ended and the manifest changed")
        return
      }
      if (replacedEarlier && after && after.life.stamp === null) {
        void this.startNewManifest(after, "the builder's turn ended and the manifest had changed")
        return
      }
      void this.reloadIfChanged(ref, { startIfStopped: true, why: "the builder's turn ended and the app folder changed" })
    }, this.host.timing.turnEndDebounceMs)
    t.unref()
    this.turnEndTimers.set(key, t)
  }

  /**
   * A scan saw that the app folder changed (C-4). If a building session is mid-turn, this does
   * nothing — turn end reflects it instead. If there is none, or it is idle (edited from an editor),
   * this waits for things to go quiet after the last change, and reflects it if the building session
   * is still not mid-turn at that point. This path only ever restarts a running app — an app no one is
   * using is never woken up by an edit (the performance budget).
   */
  folderChanged(e: AppEntry): void {
    if (this.host.builderBusy(e.ref)) return
    const key = this.host.holdKey(e.ref)
    clearTimeout(this.quietTimers.get(key))
    const ref = e.ref
    const t = setTimeout(() => {
      this.quietTimers.delete(key)
      if (this.host.builderBusy(ref)) return
      void this.reloadIfChanged(ref, { startIfStopped: false, why: 'the app folder changed and stayed quiet' })
    }, this.host.timing.reloadQuietMs)
    t.unref()
    this.quietTimers.set(key, t)
  }

  /**
   * If the folder differs from the last time it started, restarts with the current files — returns
   * true if it restarted.
   *
   * **A call in progress is never cut off.** This waits for it to finish (no cap — cutting it off is
   * worse). Stopped in the very same tick it finishes (see the comment on `drain`). Since a changed
   * folder means the author fixed something, an app stopped after failing repeatedly also gets another
   * chance (its count is cleared). Restarting re-reads the tool list, and a session is notified if the
   * agent-facing tools changed (immediately for Claude, from the next thread for Codex — same as A-5).
   * An open screen also receives "changed".
   */
  reloadIfChanged(ref: AppRef, opts: { startIfStopped: boolean; why: string }): Promise<boolean> {
    const key = this.host.holdKey(ref)
    const running = this.reloading.get(key)
    if (running) return running
    const p = (async () => {
      const e = this.host.find(ref)
      // A changed folder gives a stopped app another chance (below), so only what that cannot clear stops it here
      if (!e || this.host.blocker(e, { fresh: true }) || this.host.disposed()) return false
      const L = e.life
      if (L.stamp === null || folderFingerprint(e.dir) === L.stamp) return false
      if (!opts.startIfStopped && !L.proc?.alive) return false
      while (L.inflight > 0) await this.host.lifecycle.drain(e, 60_000)
      // The manifest changed and a new entry replaced this one, or it was removed, while waiting — a new entry starts through its own path
      if (this.host.find(ref) !== e || this.host.disposed()) return false
      const pid = L.proc?.child.pid
      L.proc?.log.note(`reloading: ${opts.why}`)
      void this.host.lifecycle.halt(e, opts.why)
      resetLife(L)
      this.host.appsChanged()
      try {
        await this.host.lifecycle.use(e, async () => {})
        console.error(`[apps] ${this.host.label(ref)} reloaded (${opts.why})${pid ? `, was pid ${pid}` : ''}`)
        this.host.emitChanged(ref)
      } catch (err) {
        // Failed to start — the reason is recorded both in the list (crashed) and in an error bundle. The building session's check reads that reason
        console.error(`[apps] ${this.host.label(ref)} reload failed: ${(err as Error).message.split('\n')[0]}`)
      }
      return true
    })().finally(() => this.reloading.delete(key))
    this.reloading.set(key, p)
    return p
  }

  /**
   * Starts a newly created entry with a new manifest (C-4) — for when reading a manifest deferred
   * until the building session's turn end replaces the entry. The old process is stopped by `rescan`
   * after finishing its call. If it starts, "changed" is sent to an open screen (the same as
   * `reloadIfChanged`).
   */
  private async startNewManifest(e: AppEntry, why: string): Promise<void> {
    if (this.host.blocker(e) || this.host.disposed()) return
    try {
      await this.host.lifecycle.use(e, async () => {})
      console.error(`[apps] ${this.host.label(e.ref)} started on its new manifest (${why})`)
      this.host.emitChanged(e.ref)
    } catch (err) {
      // Failed to start — the reason is recorded both in the list (crashed) and in an error bundle. The building session's check reads that reason
      console.error(`[apps] ${this.host.label(e.ref)} did not start on its new manifest: ${(err as Error).message.split('\n')[0]}`)
    }
  }
}

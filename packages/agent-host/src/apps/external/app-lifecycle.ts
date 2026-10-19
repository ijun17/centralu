import { AppProcess, AppStartError, type SpawnSpec } from './app-process.js'
import { folderFingerprint } from './fingerprint.js'
import type { AppEntry, AppTool, Blocker } from './app-entry.js'
import type { HeldErrorBundle } from './errors.js'
import { toolNameError } from './manifest.js'
import type { AppRef } from './ref.js'
import type { RuntimeTiming } from './runtime-types.js'
import { AppUnavailableError } from './unavailable.js'
import { visibilityOf } from './visibility.js'

/**
 * What the lifecycle asks of the runtime (`ExternalApps`) — the rule for whether an app may run, how
 * it is started, where its failures and changes are told, and the entry that is current for a name.
 */
export type LifecycleHost = {
  readonly timing: RuntimeTiming
  disposed(): boolean
  appsChanged(): void
  recordError(e: AppEntry, b: Omit<HeldErrorBundle, 'text' | 'denied'> & { denied?: HeldErrorBundle['denied'] }, proc?: AppProcess | null): void
  blocker(e: AppEntry): Blocker | null
  spawnSpec(e: AppEntry, pipeId: number): SpawnSpec
  /** Captures the code about to run as a version (E-1) — an app outside git's (`keepsVersions`) */
  snapshot(e: AppEntry, stamp: string): void
  find(ref: AppRef): AppEntry | undefined
  holdKey(ref: AppRef): string
  label(ref: AppRef): string
}

/**
 * An app process's lifecycle (M4 A-3) — starting only when first needed and only one at a time,
 * backing off and stopping after repeated failures, stopping when idle, and the screens that hold
 * an app open. Moved out of the runtime (`runtime.ts`) as one piece: everything here works on an
 * entry's `Life`, and the runtime reaches it only through these methods.
 */
export class AppLifecycle {
  constructor(private host: LifecycleHost) {}

  /**
   * (scope, app id) → open screen count. Tied to the name rather than the app entry (AppEntry): when
   * the manifest changes, a new entry is created, but the screen in front of the person stays open the
   * whole time. Tying this to the entry instead would leave the new entry thinking it has zero
   * screens, and demote an app with an open screen to idle.
   */
  private viewHolds = new Map<string, number>()
  private pipeSeq = 0
  /**
   * Every process this runtime has ever started that has not yet ended. Not just the ones an entry
   * (`Life.proc`) is holding onto: an old process waiting for its call to finish after a new entry was
   * created because the manifest changed (`haltWhenDrained`), or a process being shut down by a check
   * or a reflect, belongs to no entry at all. `dispose` ends this list, not the entries — ending only
   * the entries would leave such a process orphaned under launchd after the host exits (this happened
   * with three fixture apps left behind after running the check and reflect tests with the fix
   * disabled).
   */
  private spawned = new Set<AppProcess>()

  /** An app is never idle while in use — the idle timer is set again once it is done */
  async use<T>(e: AppEntry, fn: (proc: AppProcess) => Promise<T>): Promise<T> {
    e.life.inflight += 1
    this.clearIdle(e)
    try {
      return await fn(await this.ensureRunning(e))
    } finally {
      e.life.inflight -= 1
      if (e.life.inflight === 0) for (const w of e.life.idleWaiters.splice(0)) w()
      this.armIdle(e)
    }
  }

  /**
   * Waits for every call in progress to finish — resolves true if that happens within `ms`. The
   * caller has to stop it **in the same tick** it gets this back: yielding even once lets a call that
   * arrives in the meantime raise inflight again (the caller re-checks this with a while loop).
   */
  drain(e: AppEntry, ms: number): Promise<boolean> {
    if (e.life.inflight === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(t)
        resolve(true)
      }
      const t = setTimeout(() => {
        e.life.idleWaiters = e.life.idleWaiters.filter((w) => w !== waiter)
        resolve(false)
      }, ms)
      t.unref()
      e.life.idleWaiters.push(waiter)
    })
  }

  /**
   * If it is running, returns it; if starting, returns that promise; otherwise starts a new one.
   *
   * **Only one starts at a time.** If five simultaneous needs each saw "none exists" and each started
   * one, five processes would grab hold of the same data folder — the same shape of problem
   * encountered restoring sessions (see the `resuming` comment in `manager.ts`). Everyone waits on the
   * same in-progress startup promise instead.
   */
  private ensureRunning(e: AppEntry): Promise<AppProcess> {
    const L = e.life
    const blocked = this.host.blocker(e)
    if (blocked) throw new AppUnavailableError(blocked.reason)
    if (L.proc?.alive) return Promise.resolve(L.proc)
    if (L.starting) return L.starting

    const epoch = L.epoch
    const p = (async () => {
      const wait = L.retryAt - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (L.epoch !== epoch || this.host.disposed()) throw new AppUnavailableError('The app changed or was stopped, so this start was abandoned')
      const usedPrior = L.verdict !== undefined
      const pipeId = ++this.pipeSeq
      /*
       * The fingerprint is measured **before** starting (C-4) — even an app that fails to start has to
       * be left with "this code was tried once", or turn end would never restart it after a fix.
       * Measured once more if it starts: so an app that writes something into its own folder while
       * starting up is never read as "changed" and restarted without end.
       */
      L.stamp = folderFingerprint(e.dir)
      // An app outside git now has the code about to run captured as a version (E-1) — does nothing if it is the same code. The app still starts even if capturing the version fails
      this.host.snapshot(e, L.stamp)
      let proc: AppProcess
      try {
        proc = await AppProcess.start({
          ...this.host.spawnSpec(e, pipeId),
          // Known from its spawn (#839): a quit stops one still starting, a halt stops the start it abandons, and one
          // spawned once the quit began is stopped at once
          onSpawn: (spawned) => {
            this.remember(spawned)
            L.spawning = spawned
            if (this.host.disposed()) void spawned.stop(0, { awaitKill: false })
          },
        })
      } catch (err) {
        L.spawning = null
        if (L.epoch === epoch) {
          // If connecting failed with the remembered generation, that memory could be wrong — the next attempt probes again
          if (usedPrior) L.verdict = undefined
          this.fail(e, (err as Error).message)
          const started = err instanceof AppStartError ? err : null
          this.host.recordError(e, {
            kind: 'start',
            at: Date.now(),
            message: started?.head ?? (err as Error).message.split('\n')[0]!,
            stderr: started?.stderr ?? [],
            tool: null,
            args: null,
            runId: null,
          })
        }
        // A halt stopped it while it started: said as the abandoned start it is, not as the app failing
        throw new AppUnavailableError(L.epoch === epoch ? (err as Error).message : 'The app changed or was stopped, so this start was abandoned')
      }
      if (L.spawning === proc) L.spawning = null
      if (L.epoch !== epoch || this.host.disposed()) {
        this.remember(proc)
        void proc.stop(this.host.timing.graceMs)
        throw new AppUnavailableError('The app changed or was stopped, so this start was abandoned')
      }
      this.remember(proc)
      L.verdict = proc.verdict() ?? L.verdict
      L.stamp = folderFingerprint(e.dir)
      L.loaded = L.stamp
      L.proc = proc
      L.pipeId = pipeId
      L.lastError = null
      this.readTools(e, proc)
      proc.onUnexpectedExit = (reason) => this.crashed(e, proc, reason)
      return proc
    })()
    L.starting = p
    // Starting, running, and crashed or failed (after failing to start) are all states the list states (A-8)
    this.host.appsChanged()
    const settled = () => {
      if (L.starting === p) L.starting = null
      this.host.appsChanged()
    }
    p.then(settled, settled)
    return p
  }

  readTools(e: AppEntry, proc: AppProcess): void {
    const kept: AppTool[] = []
    const warnings: string[] = []
    const drop = (why: string) => {
      warnings.push(`a tool was dropped — ${why}`)
      proc.log.note(`tool dropped: ${why}`)
    }
    for (const t of proc.tools) {
      const err = toolNameError(t.name)
      if (err) {
        drop(err)
        continue
      }
      const vis = visibilityOf(t)
      if (!vis.ok) {
        drop(vis.error)
        continue
      }
      kept.push({ tool: t, visibility: vis.visibility })
    }
    if (e.manifest?.home && !kept.some((t) => t.tool.name === e.manifest?.home)) {
      warnings.push(`the home tool (${e.manifest.home}) is not in the tool list`)
    }
    // Only announces when what a session sees (agent-facing tools) has changed — a change to a screen-only tool has nothing to do with a session
    const forModel = (list: AppTool[] | null) =>
      list === null ? null : JSON.stringify(list.filter((t) => t.visibility.includes('model')).map((t) => t.tool))
    const before = forModel(e.life.known)
    e.life.tools = kept
    e.life.known = kept
    e.life.toolWarnings = warnings
    if (forModel(kept) !== before) this.host.appsChanged()
  }

  /**
   * Counts one failure. Stops it on the third, otherwise defers the next start.
   *
   * **Reviving it is the next need's job.** A dead app is never automatically restarted after the
   * backoff — the same principle as stopping an idle app (A-3): an app process with no one calling it
   * has no reason to stay running. Backoff is set as "the next startup happens no earlier than this".
   * A call that arrives in that window waits out the remaining time and then starts it.
   */
  private fail(e: AppEntry, reason: string): void {
    const L = e.life
    L.failures += 1
    L.lastError = reason
    const where = this.host.label(e.ref)
    if (L.failures >= this.host.timing.maxFailures) {
      L.gaveUp = true
      // A stopped app never attaches to a session (decision 4) — announce so an already-attached session detaches it
      this.host.appsChanged()
      console.error(`[apps] ${where} stopped after ${L.failures} consecutive failures: ${reason.split('\n')[0]}`)
    } else {
      L.retryAt = Date.now() + this.host.timing.backoffBaseMs * 2 ** (L.failures - 1)
      console.error(`[apps] ${where} failed (${L.failures}/${this.host.timing.maxFailures}): ${reason.split('\n')[0]}`)
    }
  }

  private crashed(e: AppEntry, proc: AppProcess, reason: string): void {
    const L = e.life
    if (L.proc !== proc) return
    L.proc = null
    L.tools = null
    L.busy = null
    this.clearIdle(e)
    // If it died after running well for a long time, this is not a consecutive failure — counted from zero
    if (Date.now() - proc.startedAt >= this.host.timing.stableMs) L.failures = 0
    this.fail(e, reason)
    this.host.recordError(e, { kind: 'crash', at: Date.now(), message: reason.split('\n')[0]!, stderr: proc.log.tailLines(), tool: null, args: null, runId: null })
    // Cleans up the pipe and the log, and collects any descendant left in its group
    void proc.stop(0)
    // A running app died without warning — the person in front of the screen has to see the reason (A-8, B-6)
    this.host.appsChanged()
  }

  /** Records a started process — every time one is recorded, anything already ended is cleared out (so the list never grows over the host's lifetime) */
  private remember(proc: AppProcess): void {
    for (const p of this.spawned) if (!p.alive) this.spawned.delete(p)
    this.spawned.add(proc)
  }

  /** Stops it — because it went idle, changed, lost trust, or the host is exiting */
  async halt(e: AppEntry, why: string, opts: { graceMs?: number; awaitKill?: boolean; awaitTree?: boolean } = {}): Promise<void> {
    const L = e.life
    L.epoch += 1
    // A start under way is abandoned by the new epoch (#839): the next need starts afresh instead of joining it
    L.starting = null
    this.clearIdle(e)
    const proc = L.proc
    L.proc = null
    L.tools = null
    // A busy hold belongs to the process it came from (#1236): it ends with it
    L.busy = null
    // The abandoned start's process goes with it (#839): left to finish starting, it ran beside the next start's copy
    const spawning = L.spawning
    L.spawning = null
    const graceMs = opts.graceMs ?? this.host.timing.graceMs
    const stopping = spawning ? (spawning.log.note(`stopping while starting: ${why}`), spawning.stop(graceMs, { awaitKill: opts.awaitKill, awaitTree: opts.awaitTree })) : undefined
    if (!proc) return stopping
    // A running app is stopping — it is not running in the list from this moment (A-8)
    this.host.appsChanged()
    proc.log.note(`stopping: ${why}`)
    await Promise.all([proc.stop(graceMs, { awaitKill: opts.awaitKill, awaitTree: opts.awaitTree }), stopping])
  }

  armIdle(e: AppEntry): void {
    this.clearIdle(e)
    const L = e.life
    if (L.inflight > 0 || this.viewsOf(e) > 0 || !L.proc || this.busyReason(e) !== null) return
    L.idle = setTimeout(() => {
      L.idle = null
      if (L.inflight === 0 && this.viewsOf(e) === 0 && this.busyReason(e) === null) void this.halt(e, `idle for ${this.host.timing.idleMs}ms`)
    }, this.host.timing.idleMs)
    L.idle.unref()
  }

  /**
   * What the app is busy with now (#1236), or null: a hold the **current** process made, under a manifest that
   * declares `uses.background`. Read by the idle rule, which leaves a busy app running as it does one with an open
   * view, and by the list, which shows the reason on the app's row.
   */
  busyReason(e: AppEntry): string | null {
    const L = e.life
    const b = L.busy
    if (!b || !e.manifest?.uses.background || !L.proc?.alive || b.pipeId !== L.pipeId) return null
    return b.reason
  }

  /**
   * The app on pipe `pipeId` says it is busy with background work (`reason`), or no longer (`null`) (#1236). Answers
   * why it is refused, or null once taken: only an app whose manifest declares `uses.background` may hold, and a
   * report from a process that is not this entry's newest (one stopping, or replaced) changes nothing. A hold made
   * while its process is still starting counts once the start completes. Releasing arms the idle rule again, which
   * stops the app after the idle time if nothing else holds it.
   */
  setBusy(e: AppEntry, pipeId: number, reason: string | null): string | null {
    if (!e.manifest?.uses.background) {
      return 'refused: this app does not declare "uses": { "background": "<what it does>" } in centralu.app.json, so it cannot keep running with nothing open'
    }
    const L = e.life
    // A process older than the current one (stopping after a restart) holds nothing for the new one
    if (pipeId < L.pipeId) return "refused: this process is no longer the app's current one"
    const was = this.busyReason(e)
    L.busy = reason === null ? null : { pipeId, reason }
    const now = this.busyReason(e)
    if (now !== null) this.clearIdle(e)
    else this.armIdle(e)
    if (now !== was) this.host.appsChanged()
    return null
  }

  private viewsOf(e: AppEntry): number {
    return this.viewHolds.get(this.host.holdKey(e.ref)) ?? 0
  }

  /** Stops it only after finishing a call in progress — the way an old entry's process is collected when a manifest change replaces the entry */
  async haltWhenDrained(e: AppEntry, why: string): Promise<void> {
    while (e.life.inflight > 0) await this.drain(e, 60_000)
    await this.halt(e, why)
  }

  clearIdle(e: AppEntry): void {
    if (e.life.idle) clearTimeout(e.life.idle)
    e.life.idle = null
  }

  /**
   * One screen is holding this app open (called by ViewHost's open). While a screen is open, this is
   * never treated as an idle app — call the returned function to release the hold (close).
   */
  retainView(e: AppEntry, ref: AppRef): () => void {
    const key = this.host.holdKey(e.ref)
    this.viewHolds.set(key, (this.viewHolds.get(key) ?? 0) + 1)
    this.clearIdle(e)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.viewHolds.get(key) ?? 1) - 1
      if (left > 0) this.viewHolds.set(key, left)
      else this.viewHolds.delete(key)
      // Not the entry from when this was held, but the **current** entry — if the manifest changed in the meantime, the new entry starts going idle
      const now = this.host.find(ref)
      if (now) this.armIdle(now)
    }
  }

  /** Stops every entry given and every process this runtime started — the host is exiting (`ExternalApps.dispose`) */
  async stopAll(all: AppEntry[]): Promise<void> {
    // Within the shutdown budget (Tauri's 3 seconds) — the grace period is shortened, and it does not wait all the way through SIGKILL
    await Promise.allSettled([
      ...all.map((e) => this.halt(e, 'host shutting down', { graceMs: 1_000, awaitKill: false })),
      // Also processes belonging to no entry at all (see the `spawned` comment) — if one is already stopping, this waits for that same stop (stop only ever runs once)
      ...[...this.spawned].map((p) => p.stop(1_000, { awaitKill: false })),
    ])
    this.spawned.clear()
  }
}

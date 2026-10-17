import { join } from 'node:path'
import type { ListResourcesResult, ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import { USER_APP_SCOPE, appKeyOf, appLabel, type AppReview, type ExternalAppInfo } from '@cc/protocol'
import { DirWatchers } from '../../dev-services/watch.js'
import type { AppProcess } from './app-process.js'
import { BrokerDesk, type BrokerHost, type CapabilityDecisionListed } from './desk.js'
import { memoryCapabilityBook } from './capabilities.js'
import type { AppCheckReport } from './check.js'
import { AppCalls, type AppCallOptions } from './app-calls.js'
import { checkApp } from './app-check.js'
import { createApp, installUserApp, removeUserApp, type FoldersHost, type NewAppSpec, type UserAppSpec } from './app-folders.js'
import { AppLifecycle } from './app-lifecycle.js'
import { ChangeReflector } from './change-reflector.js'
import { ErrorLog } from './error-log.js'
import { AppUnavailableError } from './unavailable.js'
import type { HeldErrorBundle, SentErrorBundle } from './errors.js'
import { folderFingerprint } from './fingerprint.js'
import { PROJECT_APPS_REL, USER_APPS_REL, scanApps } from './discovery.js'
import { RUN_RETENTION_MS, announcingLedger, type AgentUse, type AppRunListed } from './runs.js'
import { SecretStore, secretValueProblem } from './secrets.js'
import { AppStartEnv } from './app-start-env.js'
import { AppResources } from './app-resources.js'
import type { AppRef } from './ref.js'
import { AppHandover } from './handover.js'
import type { Snapshot } from './versions.js'
import type { Audience } from './visibility.js'

/**
 * The external app runtime (M4 A) — **the one file that is the door the core knows external apps
 * through.**
 *
 * An external app is a folder discovered at runtime and the process that folder starts. (Compiled
 * built-in apps lived beside them until the last one, the control app, was removed in #97.) The
 * rule from #81 still holds: the core's path to knowing about an app has to stay narrow — so this
 * runtime never imports the core, and instead **receives**
 * what it needs (the project list and their trust, the data folder) through `ExternalAppsDeps`. This
 * is the same inversion #97 did for the UI runtime: the runtime declares what it needs, and the host
 * fills it in.
 *
 * It never imports the store either. Projects and trust are asked for through a function — asked
 * every time because the store is the single source of truth. Holding a copy here would mean the
 * copy still answers "yes" after trust has been turned off.
 */

/**
 * The scope name for a user-folder app — a key in memory, and also one segment of the data and log
 * folders (`USER_APP_SCOPE`, the same name every app key carries).
 * A project id is a UUID, so it never collides with this name.
 */
const USER_SCOPE = USER_APP_SCOPE

export type { AppRef } from './ref.js'

/** The shape of a check report also leaves through this door (C-3) */
export type { AppCheckReport, CheckFinding } from './check.js'
/** The shape of an error bundle (C-6) */
export type { HeldErrorBundle, SentErrorBundle } from './errors.js'
/** The part of the broker's body the host's core fills in (D) — the manager supplies it via `attachBrokerHost` */
export type { AgentRunRequest, AgentRunResult, BrokerHost, CapabilityOrigin, CapabilityQuestion, CapabilityDecisionListed } from './desk.js'
/** Where a capability approval's answer is stored (D-4) — the host fills it in with the store (`app-permission-book.ts`) */
export type { CapabilityBook, CapabilityDecision } from './capabilities.js'
/** The closed list of host data (D-3) — the manager fills in what each name gives */
export { HOST_CAPABILITIES, type HostCapability } from './capabilities.js'

/** The shape of the ledger also leaves through this door — a place for the core to fill in (main.ts, `app-run-ledger.ts`) */
export type { RunLedger, AppRunRow, AppRunListed, AgentTokens, AgentUse } from './runs.js'
/** The rule for reading a tool's declared screen also leaves through this door — an in-conversation screen (B-1) uses the same validation as a fixed screen */
export { resourceUriOf } from './visibility.js'

/** What the runtime is given and the shape of what a call returns (`runtime-types.ts`) — they leave through this door too */
export { DEFAULT_TIMING, type AppCaller, type AppCallOutcome, type AppRunStatus, type ExternalAppsDeps, type RuntimeTiming } from './runtime-types.js'
import { invalidReason, newEntry, resetLife, type AppEntry, type Blocker, type Scope } from './app-entry.js'
import { DEFAULT_TIMING, type AppCaller, type AppCallOutcome, type ExternalAppsDeps, type RuntimeTiming } from './runtime-types.js'

/** Joins together the text parts of a result (`app-calls.ts`) — leaves through this door */
export { resultText } from './app-calls.js'
/** An app that cannot be called (`unavailable.ts`) — leaves through this door */
export { AppUnavailableError } from './unavailable.js'

export class ExternalApps {
  /** Scope key → (app id → entry) */
  private scopes = new Map<string, { scope: Scope; apps: Map<string, AppEntry> }>()
  private watchers: DirWatchers
  private disposed = false
  private timing: RuntimeTiming
  private secrets: SecretStore
  /** What an app process is started with: its folders, environment and secrets (`app-start-env.ts`) */
  private startEnv: AppStartEnv
  /** An app's resources and its fixed screen (`app-resources.ts`) */
  private resources: AppResources
  /** `onAppsChanged` subscribers, and whether a notification is already scheduled for this tick */
  private appsListeners = new Set<() => void>()
  private appsNotePending = false
  /** Recent error bundles per app name (holdKey) and which were sent (C-6) — `error-log.ts` */
  private errorLog = new ErrorLog(() => this.appsChanged())
  /** Apps being removed (`removeUserApp`, by `holdKey`) — none of them starts again while its folder moves */
  private removing = new Set<string>()
  /**
   * The broker desk (D) — the one place that resolves what an app requests over fd 3. A call between
   * apps (D-2) goes through this runtime's single path (`call`). Constructed in the constructor —
   * where the answer's storage (`deps.permissions`) and the wait cap (`timing`) are decided.
   */
  private desk: BrokerDesk
  /** Handover (E) — the staging area for an imported app and the person's confirmation (`handover.ts`) */
  private handover: AppHandover

  /** An app process's lifecycle (A-3) — `app-lifecycle.ts` */
  private lifecycle: AppLifecycle
  /** Reflecting a changed app folder (C-4) — `change-reflector.ts` */
  private reflector: ChangeReflector
  /** The single path an app's tool is called through, and the runs it holds open (A-4) — `app-calls.ts` */
  private calls: AppCalls

  constructor(private deps: ExternalAppsDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.lifecycle = new AppLifecycle({
      timing: this.timing,
      disposed: () => this.disposed,
      appsChanged: () => this.appsChanged(),
      recordError: (e, b, proc) => this.recordError(e, b, proc),
      blocker: (e, opts) => this.blocker(e, opts),
      spawnSpec: (e, pipeId) => this.startEnv.spawnSpec(e, pipeId),
      snapshot: (appId, dir, stamp) => this.handover.snapshot(appId, dir, 'started', stamp),
      find: (ref) => this.find(ref),
      holdKey: (ref) => this.holdKey(ref),
      label: (ref) => this.label(ref),
    })
    this.reflector = new ChangeReflector({
      timing: this.timing,
      disposed: () => this.disposed,
      lifecycle: this.lifecycle,
      find: (ref) => this.find(ref),
      holdKey: (ref) => this.holdKey(ref),
      label: (ref) => this.label(ref),
      blocker: (e, opts) => this.blocker(e, opts),
      appsChanged: () => this.appsChanged(),
      emitChanged: (ref) => this.deps.emitChanged?.(ref),
      builderBusy: (ref) => this.deps.builderBusy?.(ref) ?? false,
      rescanNow: (ref) => {
        const scopeKey = ref.projectId ?? USER_SCOPE
        if (this.scopes.has(scopeKey) && !this.disposed) this.rescan(scopeKey, { now: ref.appId })
      },
    })
    // Every ledger row passes through this one place — a tool-call row (`call`) and a broker-request row (the desk) alike. So the runs panel's own signal is also produced here, once
    const notify = deps.emitRunsChanged
    if (deps.runs && notify) this.deps = { ...deps, runs: announcingLedger(deps.runs, notify) }
    this.calls = new AppCalls({
      timing: this.timing,
      lifecycle: this.lifecycle,
      runs: this.deps.runs ?? null,
      blocker: (e, opts) => this.blocker(e, opts),
      boundaryOpen: (sessionId) => this.sessionBoundaryOpen(sessionId),
      masker: (ref) => this.startEnv.masker(ref),
      recordError: (e, b, proc) => this.recordError(e, b, proc),
      emitChanged: (ref, caller) => this.deps.emitChanged?.(ref, caller),
    })
    this.desk = new BrokerDesk(
      {
        has: (ref) => this.find(ref) !== undefined,
        name: (ref) => this.find(ref)?.manifest?.name ?? ref.appId,
        redactor: (ref) => this.startEnv.masker(ref),
        origin: (runId) => this.calls.chainOrigin(runId),
        chain: (runId) => this.calls.chainOf(runId),
        denied: (runId, d) => this.calls.denied(runId, d),
        call: (ref, tool, args, caller, opts) => this.call(ref, tool, args, caller, opts),
      },
      deps.permissions ?? memoryCapabilityBook(),
      () => ({ questionMs: this.timing.capabilityQuestionMs, agentRateWindowMs: this.timing.agentRateWindowMs }),
      this.deps.runs ?? null,
    )
    this.secrets = new SecretStore(deps.dataRoot)
    this.startEnv = new AppStartEnv(this.deps, this.timing, this.secrets, this.calls, this.desk)
    this.resources = new AppResources(this.timing, this.lifecycle, (ref) => this.require(ref))
    this.watchers = new DirWatchers((key) => this.rescan(key), deps.watchFlushMs)
    /*
     * Once at startup: closes a run that never saw its own ending, and prunes anything past
     * retention. This is the safe moment for it — this host has not opened a single run yet.
     */
    const settled = deps.runs?.settleUnfinished('the host stopped before this call finished') ?? 0
    const pruned = deps.runs?.prune(Date.now() - RUN_RETENTION_MS) ?? 0
    if (settled || pruned) console.error(`[apps] run records: ${settled} unfinished closed, ${pruned} past retention removed`)
    // Handover (E) — an imported app's staging area and confirmation. The runtime never starts an app still waiting on confirmation (`held`)
    this.handover = new AppHandover(
      {
        dataRoot: deps.dataRoot,
        reservedIds: deps.reservedIds,
        rescanUser: () => this.rescanUser(),
        userApp: (appId) => {
          const e = this.find({ projectId: null, appId })
          return e ? { dir: e.dir, manifest: e.manifest } : null
        },
        changed: () => this.appsChanged(),
      },
      deps.handover,
    )
  }

  /**
   * An app's recent error bundles (M4 C-6) — failing to start, an unannounced exit, a tool failure.
   * `latest` is what "send to the building session" would send. **Never sent automatically** — the
   * UI reads and sends this when a person presses the button (see the comment in errors.ts).
   */
  errors(ref: AppRef): { latest: SentErrorBundle | null; recent: SentErrorBundle[] } {
    return this.errorLog.errors(this.holdKey(ref))
  }

  /**
   * Records that one bundle was sent to the building session (C-6) — **only once.** Returns the
   * bundle to send, `'sent'` if it was already sent, or null if it is no longer held (it aged out of
   * the list, or the host restarted). Recording happens before sending: even if the person clicks
   * twice, or from two windows, it goes out only once. If sending fails, the caller reverts this with
   * `unmarkErrorSent` — a bundle that never actually went out is never left marked "sent".
   *
   * The sending itself does not happen here. The runtime only collects bundles and answers when asked
   * (errors.ts); what actually sends it is the RPC a person triggers by clicking.
   */
  markErrorSent(ref: AppRef, at: number): HeldErrorBundle | 'sent' | null {
    return this.errorLog.markSent(this.holdKey(ref), at)
  }

  unmarkErrorSent(ref: AppRef, at: number): void {
    this.errorLog.unmarkSent(this.holdKey(ref), at)
  }

  /** Records one error bundle for this app (`ErrorLog.record`) */
  private recordError(e: AppEntry, b: Omit<HeldErrorBundle, 'text' | 'denied'> & { denied?: HeldErrorBundle['denied'] }, proc: AppProcess | null = null): void {
    this.errorLog.record(this.holdKey(e.ref), `${e.manifest?.name ?? e.ref.appId} (${this.label(e.ref)})`, b, proc)
  }

  /**
   * Receives the part of the broker's body only the host's core can do (an agent session) (D). Called
   * by the manager when it receives the runtime (`SessionManager.useExternalApps`) — the host's main
   * and the tests use the same seam. Empties it if null: a request afterward is refused with "no
   * agent to lend".
   */
  attachBrokerHost(host: BrokerHost | null): void {
    this.desk.attach(host)
  }

  /**
   * The remembered capability answers for one app (D-4), most recent first. `current` means it was
   * given against the manifest's current `uses`; otherwise it is no longer used. Everything is
   * non-current if the manifest is invalid or the app is gone.
   */
  permissions(ref: AppRef): CapabilityDecisionListed[] {
    const m = this.find(ref)?.manifest
    return this.desk.permissions(ref, m ? m.uses : null)
  }

  /** Forgets one remembered answer (D-4) — the next time that capability is needed, it is asked again */
  forgetPermission(ref: AppRef, capability: string): void {
    this.desk.forgetPermission(ref, capability)
  }

  /**
   * The agent usage one app has requested (D-5) — over the last day, and over the 30 days records are
   * kept. Read by the runs panel (`apps.usage`).
   */
  agentUse(ref: AppRef): { day: AgentUse; month: AgentUse } {
    const now = Date.now()
    const none = { runs: 0, durationMs: 0, tokens: null }
    const ledger = this.deps.runs
    return {
      day: ledger?.agentUse(ref.projectId, ref.appId, now - 24 * 60 * 60 * 1000) ?? none,
      month: ledger?.agentUse(ref.projectId, ref.appId, now - RUN_RETENTION_MS) ?? none,
    }
  }

  /** One app's run records, most recent first (B-7) — records are still readable even for an app whose folder is gone */
  runs(ref: AppRef, limit = 100): AppRunListed[] {
    return this.deps.runs?.list(ref.projectId, ref.appId, limit) ?? []
  }

  /**
   * Re-reads the project list and trust, and rescans everything.
   *
   * Called once at startup, and whenever a project is added or removed or trust changes (an RPC door
   * calls this). Changes inside a folder are tracked separately by watching — this function decides
   * "which folders to watch". **It never starts anything** — an app starts only the first time it is
   * needed.
   */
  refresh(): void {
    if (this.disposed) return
    const want = new Map<string, Scope>()
    want.set(USER_SCOPE, { key: USER_SCOPE, projectId: null, root: this.deps.dataRoot, trusted: true })
    for (const p of this.deps.projects()) {
      want.set(p.id, { key: p.id, projectId: p.id, root: p.path, trusted: p.trusted })
    }
    for (const key of [...this.scopes.keys()]) {
      if (!want.has(key)) this.dropScope(key)
    }
    for (const scope of want.values()) {
      const cur = this.scopes.get(scope.key)
      if (cur) cur.scope = scope
      else this.scopes.set(scope.key, { scope, apps: new Map() })
      this.rescan(scope.key)
    }
  }

  /** Every discovered external app — an untrusted project's app and one with a broken manifest appear too, with their reason */
  list(): ExternalAppInfo[] {
    const out: ExternalAppInfo[] = []
    for (const { apps } of this.scopes.values()) {
      for (const e of apps.values()) out.push(this.info(e))
    }
    return out
  }

  private sessionBoundaryOpen: (sessionId: string) => boolean = () => false

  /** Host-owned policy; a request cannot claim an auto preset in its arguments. */
  setSessionBoundaryPolicy(policy: (sessionId: string) => boolean): void {
    this.sessionBoundaryOpen = policy
  }

  /**
   * An app's tool list — if the app is down, **this is where it starts** (the first time it is
   * needed).
   *
   * A tool with `__` in its name is dropped right here (A-1's `toolNameError`). The place a list is
   * read is the place it is enforced: this list becomes the source of truth both for what attaches to
   * a session (A-5) and for the tools a screen can call.
   */
  async tools(ref: AppRef, audience?: Audience, sessionId?: string): Promise<Tool[]> {
    const e = this.require(ref)
    const all = await this.lifecycle.use(e, async () => e.life.tools ?? [], !!sessionId && this.sessionBoundaryOpen(sessionId))
    return all.filter((t) => !audience || t.visibility.includes(audience)).map((t) => t.tool)
  }

  /**
   * The last tool list read — **never starts the app.** Null if it has never been read.
   *
   * The side that attaches an app to a session (A-5) checks this first, and starts the app with
   * `tools()` only if there is none. The list survives even while the app is down, so an app process
   * does not start every time a session starts.
   */
  knownTools(ref: AppRef, audience?: Audience): Tool[] | null {
    const known = this.require(ref).life.known
    if (!known) return null
    return known.filter((t) => !audience || t.visibility.includes(audience)).map((t) => t.tool)
  }

  /**
   * The app list, or an app's agent-facing tools, may have changed (A-5) — the moment to recount which
   * apps are attached to a session.
   *
   * When this fires: an app folder appears, disappears, or its manifest changes; a project is added
   * or removed; trust changes; an app stops (repeated failure) or restarts; a re-read tool list
   * differs from before. **What** changed is never carried — the receiving side re-reads `list()` and
   * `knownTools()` instead (the same approach as #81's "one notification, then re-read"). Changes
   * piling up within one tick are collapsed into one.
   *
   * This also fires for an app's lifecycle (starting, running, stopped from being idle, dead) (A-8).
   * Since the sidebar and the fixed screen show `list()`'s status, every place that status changes has
   * to pass through here. The session side compares what it currently sees (the attached apps and
   * tools) and does nothing if unchanged, so more notifications never mean more work. Why this is not
   * split into two separate notifications: the day something that changes the list calls only one of
   * the two, that change would reach only one of the two kinds of listener.
   */
  onAppsChanged(listener: () => void): () => void {
    this.appsListeners.add(listener)
    return () => void this.appsListeners.delete(listener)
  }

  /**
   * The person turned an app's sharing on or off (#371 part A). Nothing about the app itself changed,
   * so nothing restarts: the list is announced again, and the session side recounts which apps are
   * attached (a session that attached the app from another project loses it when sharing goes off).
   */
  sharingChanged(): void {
    this.appsChanged()
  }

  private appsChanged(): void {
    if (this.appsNotePending || this.disposed) return
    this.appsNotePending = true
    queueMicrotask(() => {
      this.appsNotePending = false
      if (this.disposed) return
      for (const l of [...this.appsListeners]) {
        try {
          l()
        } catch (err) {
          // One listener's failure never blocks another session's update
          console.error('[apps] apps-changed listener failed:', err)
        }
      }
    })
  }

  /**
   * The **single path** through which an app's tool is called (M4 A-4).
   *
   * A call from a screen (`apps.invoke`), from a session's proxy server (A-5), and from another app
   * via the broker (D-2) all come through here. So audience checking, issuing a run id, cancellation,
   * the "changed" notification, and the ledger (A-6) all happen exactly once per call, through the
   * same code — with two paths, one of them eventually misses a check.
   */
  async call(ref: AppRef, name: string, args: Record<string, unknown>, caller: AppCaller, opts: AppCallOptions = {}): Promise<AppCallOutcome> {
    return this.calls.call(this.require(ref), name, args, caller, opts)
  }

  /** Reads an app's resource, starting the app the first time it is needed (`AppResources.readResource`, `app-resources.ts`) */
  readResource(ref: AppRef, uri: string): Promise<ReadResourceResult> {
    return this.resources.readResource(ref, uri)
  }

  /** The resources an app offers, following pagination up to a cap (`AppResources.listResources`, `app-resources.ts`) */
  listResources(ref: AppRef, maxPages?: number): Promise<ListResourcesResult['resources']> {
    return this.resources.listResources(ref, maxPages)
  }

  /**
   * One screen is holding this app open (called by ViewHost's open). While a screen is open, this is
   * never treated as an idle app — call the returned function to release the hold (close).
   */
  retainView(ref: AppRef): () => void {
    return this.lifecycle.retainView(this.require(ref), ref)
  }

  /** The tool that opens the fixed screen, and that screen; starts the app when first needed (`AppResources.homeView`, `app-resources.ts`) */
  homeView(ref: AppRef): Promise<{ tool: string; resourceUri: string }> {
    return this.resources.homeView(ref)
  }

  /**
   * A screen's origin handling (B-3) — the manifest's `view.origin`. Opaque if the app does not exist
   * or its manifest is invalid: an unknown app is never handed a real origin (a port that leaves
   * storage behind).
   */
  viewOrigin(ref: AppRef): 'opaque' | 'app' {
    return this.find(ref)?.manifest?.view?.origin ?? 'opaque'
  }

  /** Whether the app is discovered: its folder is there, in a project that is (or the user folder). Trusted or not */
  exists(ref: AppRef): boolean {
    return this.find(ref) !== undefined
  }

  /**
   * Lets a stopped app start again (B-6's "Restart"). Clears consecutive failures and backoff, and
   * stops it if running — **never starts it**, the next time it is needed does.
   */
  async restart(ref: AppRef): Promise<void> {
    const e = this.require(ref)
    await this.lifecycle.halt(e, 'restart requested')
    resetLife(e.life)
    // A stopped app had been detached from sessions — announce so it can attach again. A crashed app's
    // reason is also cleared, changing its status in the list (A-8)
    this.appsChanged()
  }

  /**
   * Creates a screen-less app in the user folder (M4 A-7, decision 8) — where an MCP server a person
   * approved turns into an app. **This never starts it.** The body and what it refuses:
   * `installUserApp` in `app-folders.ts`.
   */
  installUserApp(spec: UserAppSpec): ExternalAppInfo {
    return installUserApp(this.folderHost, spec)
  }

  /**
   * Checks an app (M4 C-3) — called by a building session's `check` and by `apps.check`. This is
   * where a building agent tests its own app in place of a person.
   *
   *   1. Rescans — reads the just-edited manifest under the same validation discovery uses
   *      (`parseManifest`)
   *   2. Restarts **with the current files** — a running process could still be old code. A call in
   *      progress is never cut off: this waits for it to finish (`checkDrainMs`), and past that, checks
   *      the running process instead and states so
   *   3. **Actually** calls for the tool list — in S-6, even a broken server's process stayed alive
   *   4. Reads each `ui://` screen the tools point at, one at a time
   *   5. Validates the naming, audience, annotation, and home problems (`check.ts`)
   *
   * **This never leaves the app in a strange state.** A check tries starting even a stopped (failed)
   * app — the same as a person pressing "Restart" (it clears consecutive failures). So repeating a
   * check never pushes an app further toward stopped: if it fails to start, that one failure
   * (crashed) and its reason are recorded, and if it starts, it becomes a normal running app (stopping
   * again if idle). A check never calls a tool, so it leaves no row in the run ledger.
   */
  async check(ref: AppRef): Promise<AppCheckReport> {
    return checkApp(
      {
        timing: this.timing,
        lifecycle: this.lifecycle,
        rescanNow: (r) => {
          const key = r.projectId ?? USER_SCOPE
          // A check is a request to read the current files right now — even a manifest change deferred because it was mid-turn is read now (C-4, `rescan`'s `now`)
          if (this.scopes.has(key)) this.rescan(key, { now: r.appId })
          else this.refresh()
        },
        find: (r) => this.find(r),
        blocker: (e, opts) => this.blocker(e, opts),
        appsChanged: () => this.appsChanged(),
      },
      ref,
    )
  }

  /**
   * Creates a new app from the template (M4 C-1b) — "New app" (`apps.create`) and the orchestrator's
   * `create_app` use the same door. **This never starts it.** The body and what it refuses:
   * `createApp` in `app-folders.ts`.
   */
  createApp(spec: NewAppSpec): ExternalAppInfo {
    return createApp(this.folderHost, spec)
  }

  /**
   * Removes a user-folder app (M4 A-7) — the path for withdrawing an approved MCP server from the
   * list. The folder moves to the trash; a project app is never removed. The body and what it
   * refuses: `removeUserApp` in `app-folders.ts`.
   */
  async removeUserApp(ref: AppRef): Promise<void> {
    return removeUserApp(this.folderHost, ref)
  }

  /** What making and removing an app folder reaches in the runtime (`app-folders.ts`) */
  private get folderHost(): FoldersHost {
    return {
      disposed: () => this.disposed,
      deps: this.deps,
      hasScope: (key) => this.scopes.has(key),
      rescan: (key) => this.rescan(key),
      refresh: () => this.refresh(),
      rescanUser: () => this.rescanUser(),
      find: (ref) => this.find(ref),
      require: (ref) => this.require(ref),
      info: (e) => this.info(e),
      dataDirOf: (ref) => this.startEnv.dataDirOf(ref),
      holdKey: (ref) => this.holdKey(ref),
      removing: this.removing,
      lifecycle: this.lifecycle,
      forgetImport: (appId) => this.handover.forget(appId),
    }
  }

  /** Rescans the user folder right now — scans everything if it has never scanned before (pre-startup) */
  private rescanUser(opts: { now?: string } = {}): void {
    if (this.scopes.has(USER_SCOPE)) this.rescan(USER_SCOPE, opts)
    else this.refresh()
  }

  /** Writes a secret value (clears it if `null`). A running app receives it starting from its next startup */
  setSecret(ref: AppRef, name: string, value: string | null): void {
    this.secrets.set(this.startEnv.appKey(ref), name, value)
  }

  /**
   * A person sets, changes, or clears a secret value (M4 E, the secrets section) — the body of
   * `apps.setSecret`.
   *
   * Only **the names the manifest declares** can be set. Setting a name the manifest never declared
   * does nothing, since the app never receives it (`forApp`), and the person is left asking "I set it,
   * why doesn't it work". Clearing does not check the name — even a value for a name no longer in the
   * declaration has to be removable. **Never carries the value in any message**: a denial travels all
   * the way to the screen as an RPC error.
   *
   * A running app is stopped **only after finishing a call in progress** — the next time it is needed,
   * it starts with the new value (an app receives its environment once, at startup). This also clears
   * a stopped app's failure count: setting a value for an app that failed to start repeatedly for lack
   * of a key is the person fixing it (the same as Restart).
   */
  updateSecret(ref: AppRef, name: string, value: string | null): void {
    const e = this.require(ref)
    if (value !== null) {
      if (!e.manifest) throw new AppUnavailableError(invalidReason(e))
      if (!(e.manifest.secrets ?? []).includes(name)) throw new AppUnavailableError(`This app does not declare a secret named ${name}`)
      const problem = secretValueProblem(value)
      if (problem) throw new AppUnavailableError(problem)
    }
    this.secrets.set(this.startEnv.appKey(ref), name, value)
    const L = e.life
    const fresh = () => {
      if (!L.proc && !L.starting) resetLife(L)
      this.appsChanged()
    }
    if (L.proc || L.starting) void this.lifecycle.haltWhenDrained(e, 'a secret changed; the next need starts it with the new value').then(fresh)
    else fresh()
    // The list's "set / unset" just changed — this announces it without waiting for the app to stop
    this.appsChanged()
  }

  // ── Handover: importing (E-3) ──────────────────────────────────────────────────────
  //
  // The body lives in `handover.ts`. Here, a denial worded for a person is translated into an RPC
  // error, and the list-shape of an app brought in is returned. The one place that blocks an imported
  // app from starting before confirmation is `held`, which a call, a startup, a check, and status all
  // check against.

  /** Prepares an import — stages it and returns what a person reviews. Nothing has been brought in yet */
  prepareImport(source: string): Promise<{ token: string; review: AppReview }> {
    if (this.disposed) throw new AppUnavailableError('The app runtime has shut down')
    return this.handover.prepare(source)
  }

  /** Brings a staged app into the user folder — disabled, or with `enable`, records the confirmation with the key the person reviewed. **This never starts it** */
  commitImport(token: string, opts: { enable: boolean; reviewKey?: string }): ExternalAppInfo {
    const id = this.handover.commit(token, opts)
    const made = this.find({ projectId: null, appId: id })
    if (!made) throw new AppUnavailableError(`The app was brought in, but discovery did not find it: ${id}`)
    return this.info(made)
  }

  cancelImport(token: string): void {
    this.handover.cancel(token)
  }

  /** The review dialog for an imported app — user-folder apps only (a project app follows the project's trust, decision 3) */
  reviewApp(ref: AppRef): AppReview {
    if (ref.projectId !== null) throw new AppUnavailableError("A project's apps follow the project's trust; there is nothing to review here")
    return this.handover.review(ref.appId)
  }

  /** Enables an imported app — only if the key from the confirmation dialog the person saw matches the current manifest */
  enableApp(ref: AppRef, key: string): ExternalAppInfo {
    if (ref.projectId !== null) throw new AppUnavailableError("A project's apps follow the project's trust; they are not enabled one by one")
    this.handover.enable(ref.appId, key)
    return this.info(this.require(ref))
  }

  // ── Handover: versions (E-1) ────────────────────────────────────────────────────────────

  /** Versions of an app outside git — user-folder apps only (a project app's versions are git, and the host's core reads those) */
  snapshots(ref: AppRef): (Snapshot & { current: boolean })[] {
    if (ref.projectId !== null) throw new AppUnavailableError('Project apps are versioned by git')
    this.rescanUser()
    return this.handover.versionsOf(ref.appId, this.require(ref).dir)
  }

  /**
   * Restores one version — captures the current code as a version before writing it back, clears the
   * consecutive-failure count since this is code the person chose, and **restarts with that code** (if
   * the app has ever started before. A call in progress is waited out — the same path as reflecting a
   * change). If the manifest also changed, a new entry is created and the old process stops after
   * finishing its call. If an imported app's version carries a different server or uses, that entry
   * waits on confirmation again.
   */
  restoreVersion(ref: AppRef, id: string): ExternalAppInfo {
    if (ref.projectId !== null) throw new AppUnavailableError("A project app's versions are its git history; restore it with git")
    this.rescanUser()
    const before = this.require(ref)
    this.handover.restore(ref.appId, id, before.dir)
    // A version the person chose — reads that version's manifest right now even if the building session is mid-turn
    this.rescanUser({ now: ref.appId })
    const e = this.require(ref)
    resetLife(e.life)
    void this.reflector.reloadIfChanged(ref, { startIfStopped: true, why: 'a previous version was restored' })
    this.appsChanged()
    return this.info(e)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.watchers.close()
    this.handover.dispose()
    this.reflector.dispose()
    this.appsListeners.clear()
    const all = [...this.scopes.values()].flatMap((s) => [...s.apps.values()])
    this.scopes.clear()
    await this.lifecycle.stopAll(all)
  }

  // ── Reflecting changes (C-4) ─────────────────────────────────────────────────────────────────

  /** This app's building session's turn ended (M4 C-4) — announced by the host from session state (`ChangeReflector.builderTurnEnded`) */
  builderTurnEnded(ref: AppRef): void {
    this.reflector.builderTurnEnded(ref)
  }

  /** The key for an open screen. Since this is never used in a path, it does not care about a project id's shape (unlike scopeDir) */
  private holdKey(ref: AppRef): string {
    return appKeyOf(ref.projectId, ref.appId)
  }

  /** An app that is gone takes its error bundles with it (`ErrorLog.forget`) */
  private forgetErrors(ref: AppRef): void {
    this.errorLog.forget(this.holdKey(ref))
  }

  private label(ref: AppRef): string {
    return appLabel(ref)
  }

  // ── Discovery ──────────────────────────────────────────────────────────────────────

  private require(ref: AppRef): AppEntry {
    const e = this.find(ref)
    if (!e) throw new AppUnavailableError(`There is no such app: ${ref.projectId ?? 'user'}/${ref.appId}`)
    return e
  }

  private find(ref: AppRef): AppEntry | undefined {
    return this.scopes.get(ref.projectId ?? USER_SCOPE)?.apps.get(ref.appId)
  }

  private info(e: AppEntry): ExternalAppInfo {
    const m = e.manifest
    const lastErrorAt = this.errorLog.lastAt(this.holdKey(e.ref))
    return {
      appId: e.ref.appId,
      projectId: e.ref.projectId,
      dir: e.dir,
      name: m?.name ?? null,
      version: m?.version ?? null,
      description: m?.description ?? null,
      home: m?.home ?? null,
      trusted: e.scope.trusted,
      status: this.status(e),
      error: e.error ?? this.held(e) ?? e.life.lastError,
      warnings: [...e.warnings, ...e.life.toolWarnings],
      // The full fingerprint is not needed — it is only ever a key for comparison, so the first 16 characters are enough
      ...(e.life.loaded ? { codeStamp: e.life.loaded.slice(0, 16) } : {}),
      ...(lastErrorAt !== undefined ? { lastErrorAt } : {}),
      // The panel span the app recommends on the grid (#306), already clamped by the manifest's reading
      ...(m?.view?.span ? { span: m.view.span } : {}),
      ...this.startEnv.secretSlots(e),
      ...this.importMark(e),
      // A user-folder app is available to every project already, so only a project app carries the mark (#371)
      ...(e.ref.projectId !== null && this.deps.shared?.(e.ref) ? { shared: true } : {}),
    }
  }

  /**
   * Whether an imported app is waiting on the person's confirmation (E-3) — the reason, or null. Only
   * a user-folder app can be an imported app (a project app is governed by project trust, decision 3).
   * On every call, the mark is checked against the current manifest (`AppHandover.gate`).
   */
  private held(e: AppEntry): string | null {
    return e.ref.projectId === null && e.manifest ? this.handover.gate(e.ref.appId, e.dir, e.manifest) : null
  }

  /** The mark of an imported app, for the list (E-3) — absent for an app that was not imported */
  private importMark(e: AppEntry): Pick<ExternalAppInfo, 'imported'> {
    const imported = e.ref.projectId === null ? this.handover.imported(e.ref.appId, e.dir) : undefined
    return imported ? { imported } : {}
  }

  /**
   * Why this app may not run right now, or null — **the one rule** a call, a start, a check, a reload and the list's
   * status all read, so none of them can let through what another refuses. In order:
   *
   *   invalid      the manifest did not pass validation
   *   untrusted    its project is not trusted — unless the calling session's boundary is open (`boundaryOpen`)
   *   unconfirmed  an imported app the person has not reviewed and enabled (E-3) — checked on every call: if server
   *                or uses changes after being enabled, it is blocked starting from the next startup
   *   removing     its folder is moving to the trash (`removeUserApp`) — nothing starts it meanwhile
   *   failed       it stopped after `maxFailures` failures in a row. `fresh` leaves this out: for a door that is
   *                about to give the app a fresh start itself (a check, a reload on changed files)
   */
  private blocker(e: AppEntry, opts: { boundaryOpen?: boolean; fresh?: boolean } = {}): Blocker | null {
    if (!e.manifest) return { kind: 'invalid', reason: invalidReason(e) }
    if (!e.scope.trusted && !opts.boundaryOpen) {
      return { kind: 'untrusted', reason: "This app's project is not trusted, so the app does not start — trust the project and it will" }
    }
    const held = this.held(e)
    if (held) return { kind: 'unconfirmed', reason: held }
    if (this.removing.has(this.holdKey(e.ref))) return { kind: 'removing', reason: 'This app is being removed' }
    if (e.life.gaveUp && !opts.fresh) {
      return {
        kind: 'failed',
        reason: `The app stopped after failing ${this.timing.maxFailures} times in a row — fix it, then restart it.\n${e.life.lastError ?? ''}`,
      }
    }
    return null
  }

  private status(e: AppEntry): ExternalAppInfo['status'] {
    const blocked = this.blocker(e)
    /*
     * An app being removed has no status of its own: its folder is gone a moment later, and the protocol's list of
     * statuses is read by a UI that may be a build older than this host (a swap), which would refuse a new value.
     * It reads as what it is until its folder moves: running while `removeUserApp` stops it, then stopped — or
     * failed, if it had stopped after repeated failures (`blocker` names removal before that).
     */
    if (blocked && blocked.kind !== 'removing') return blocked.kind
    const L = e.life
    if (L.gaveUp) return 'failed'
    if (L.proc?.alive) return 'running'
    if (L.starting) return 'starting'
    if (L.lastError) return 'crashed'
    return 'stopped'
  }

  /**
   * Rescans one scope. `now` is the id of an app whose manifest change should be read **right now** —
   * a building session's turn end, a check, or a version the person chose. Every other scan (watching,
   * `refresh`) defers a manifest change for an app whose building session is mid-turn until turn end
   * (see the comment below).
   */
  private rescan(key: string, opts: { now?: string } = {}): void {
    const held = this.scopes.get(key)
    if (!held || this.disposed) return
    const { scope } = held
    const result =
      scope.projectId === null
        ? scanApps(scope.root, USER_APPS_REL, [])
        : scanApps(scope.root, PROJECT_APPS_REL, ['', '.centralu'])
    const seen = new Set<string>()
    /** Whether there was a change that could change the set of apps attached to a session (A-5) */
    let changed = false
    for (const found of result.apps) {
      seen.add(found.folder)
      const prev = held.apps.get(found.folder)
      if (prev && prev.found.hash === found.hash && prev.found.error === found.error) {
        const lostTrust = prev.scope.trusted && !scope.trusted
        if (prev.scope.trusted !== scope.trusted) changed = true
        prev.scope = scope
        /*
         * An app in a project that lost trust is stopped immediately — it stays in the list. Only trust lost: an app an
         * `auto` session started in a project never trusted (`sessionBoundaryOpen`) was stopped by every rescan (#839)
         */
        if (lostTrust) void this.lifecycle.halt(prev, 'project is no longer trusted')
        // Did something outside the manifest change (server.mjs, a screen…) (C-4)? Measured only for an app that has started at least once
        else if (prev.life.stamp !== null && folderFingerprint(prev.dir) !== prev.life.stamp) this.reflector.folderChanged(prev)
        continue
      }
      /*
       * The manifest changed — a process started with the old command is stopped, and its counts and
       * remembered generation start fresh. A new call is received by the new entry. The old process is
       * stopped **only after a call in progress finishes** (C-4): editing files must never cut off
       * someone's call.
       */
      if (prev) {
        /*
         * **If the building session is mid-turn, this is deferred until turn end** (C-4). Replacing the
         * entry with a half-edited manifest would stop the old process, and an open screen would see the
         * changed code in the list, reopen, and load the half-edited code (measured: within a turn
         * spanning 10:09:55-10:11:09, "stopping: manifest changed" fired at 10:10:45, and the screen went
         * blank and reopened with the code still being edited). Until then, the old entry continues to
         * receive calls with its old manifest and old process. Turn end (`builderTurnEnded`) rescans with
         * `now` and moves everything over at once. Losing trust is never deferred this way.
         */
        if (opts.now !== found.folder && scope.trusted && prev.scope.trusted && this.deps.builderBusy?.(prev.ref)) {
          prev.scope = scope
          continue
        }
        void this.lifecycle.haltWhenDrained(prev, 'manifest changed')
      }
      held.apps.set(found.folder, newEntry(scope, found, this.deps.reservedIds))
      changed = true
    }
    for (const [id, e] of [...held.apps]) {
      if (seen.has(id)) continue
      held.apps.delete(id)
      void this.lifecycle.halt(e, 'app folder removed')
      this.forgetErrors(e.ref)
      changed = true
    }
    this.watchers.setWatched(key, scope.root, result.watch)
    if (changed) this.appsChanged()
  }

  private dropScope(key: string): void {
    const held = this.scopes.get(key)
    this.watchers.setWatched(key, held?.scope.root ?? join(this.deps.dataRoot, USER_APPS_REL), [])
    this.scopes.delete(key)
    for (const e of held?.apps.values() ?? []) {
      void this.lifecycle.halt(e, 'project removed')
      this.forgetErrors(e.ref)
    }
    if (held?.apps.size) this.appsChanged()
  }
}

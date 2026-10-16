import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult, ListResourcesResult, ReadResourceResult, Tool } from '@modelcontextprotocol/client'
import { APP_ID_MAX_LENGTH, APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, USER_APP_SCOPE, appKeyOf, appLabel, newAppIdProblem, type AppReview, type ExternalAppInfo, type NewAppIdProblem } from '@cc/protocol'
import { DirWatchers } from '../../dev-services/watch.js'
import { AppProcess, AppStartError, type SpawnSpec } from './app-process.js'
import { RUN_META, serveBroker } from './broker.js'
import { BrokerDesk, type BrokerHost, type CapabilityDecisionListed, type CapabilityDenial, type CapabilityOrigin } from './desk.js'
import { memoryCapabilityBook } from './capabilities.js'
import { checkScreen, checkTools, formatReport, type AppCheckReport, type CheckFinding, type CheckedTool } from './check.js'
import { ErrorLog } from './error-log.js'
import type { HeldErrorBundle, SentErrorBundle } from './errors.js'
import { folderFingerprint } from './fingerprint.js'
import { PROJECT_APPS_PARTS, PROJECT_APPS_REL, USER_APPS_PARTS, USER_APPS_REL, scanApps } from './discovery.js'
import { MANIFEST_FILE, MANIFEST_VERSION, parseManifest, toolNameError } from './manifest.js'
import { RUN_RETENTION_MS, RunRow, announcingLedger, type AgentUse, type AppRunListed } from './runs.js'
import { appTemplateDir, oneLine, scaffoldApp } from './scaffold.js'
import { placeAppFolder } from './placement.js'
import { SecretStore, redactor, secretValueProblem } from './secrets.js'
import type { AppRef } from './ref.js'
import { AppHandover } from './handover.js'
import type { Snapshot } from './versions.js'
import { resourceUriOf, visibilityOf, type Audience } from './visibility.js'

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
import { invalidReason, newEntry, resetLife, type AppEntry, type AppTool, type Blocker, type OpenRun, type Scope } from './app-entry.js'
import { DEFAULT_TIMING, type AppCaller, type AppCallOutcome, type AppRunStatus, type ExternalAppsDeps, type RuntimeTiming } from './runtime-types.js'

/**
 * The reason a new app id is rejected, worded for an agent and a person to read (C-1b). Validation is
 * one single function (`newAppIdProblem`, @cc/protocol) — only the wording is attached here. The new
 * app dialog attaches its own wording to the same validation result (`appIdHint`), while the
 * orchestrator's `create_app` reads this wording as-is.
 */
const APP_ID_PROBLEM: Record<NewAppIdProblem, string> = {
  shape: `an app id is lowercase letters, digits and hyphens (up to ${APP_ID_MAX_LENGTH}), starting with a letter or digit — no underscores: "__" separates names in a session's tool names`,
  reserved: `ids starting with "${RESERVED_NAME_PREFIX}" belong to Centralu itself`,
  'server-prefix': `ids starting with "${APP_SERVER_PREFIX}" are how apps attach to sessions — pick another`,
  builtin: 'that id is reserved — pick another',
}

/** Where a check reports what stops the app from running (`check`) */
const CHECK_WHERE: Record<Blocker['kind'], CheckFinding['where']> = {
  invalid: 'centralu.app.json',
  untrusted: 'trust',
  unconfirmed: 'review',
  removing: 'app',
  failed: 'start',
}

/** An app that cannot be called — the reason is exactly the message */
export class AppUnavailableError extends Error {
  readonly code = 'internal'
}

export class ExternalApps {
  /** Scope key → (app id → entry) */
  private scopes = new Map<string, { scope: Scope; apps: Map<string, AppEntry> }>()
  private watchers: DirWatchers
  private disposed = false
  private timing: RuntimeTiming
  private secrets: SecretStore
  /** Run id → open run. The broker's gatekeeper asks against this */
  private openRuns = new Map<string, OpenRun>()
  /**
   * (scope, app id) → open screen count. Tied to the name rather than the app entry (AppEntry): when
   * the manifest changes, a new entry is created, but the screen in front of the person stays open the
   * whole time. Tying this to the entry instead would leave the new entry thinking it has zero
   * screens, and demote an app with an open screen to idle.
   */
  private viewHolds = new Map<string, number>()
  private pipeSeq = 0
  /** `onAppsChanged` subscribers, and whether a notification is already scheduled for this tick */
  private appsListeners = new Set<() => void>()
  private appsNotePending = false
  /** Timers for reflecting changes (C-4) — per app name (holdKey). Carried over even when the manifest changes and a new entry is created */
  private turnEndTimers = new Map<string, NodeJS.Timeout>()
  private quietTimers = new Map<string, NodeJS.Timeout>()
  /** A reflect in progress — an overlapping call waits on the same one */
  private reloading = new Map<string, Promise<boolean>>()
  /** Recent error bundles per app name (holdKey) and which were sent (C-6) — `error-log.ts` */
  private errorLog = new ErrorLog(() => this.appsChanged())
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
  /** Apps being removed (`removeUserApp`, by `holdKey`) — none of them starts again while its folder moves */
  private removing = new Set<string>()
  /**
   * Open run → the person denied this run's request (or one further down its chain) (D-4) — recorded
   * by the desk. If that run ends in failure, this is attached to that failure's error bundle (it is
   * not a bug in the app, it is the person's decision), and if the run belongs to an app that called
   * another, it is passed up to the parent: if A called B, B's request was denied so B failed, and
   * that is why A failed, then the reason A's screen states is that same denial. Cleared once the run
   * ends.
   */
  private denials = new Map<string, CapabilityDenial>()
  /**
   * The broker desk (D) — the one place that resolves what an app requests over fd 3. A call between
   * apps (D-2) goes through this runtime's single path (`call`). Constructed in the constructor —
   * where the answer's storage (`deps.permissions`) and the wait cap (`timing`) are decided.
   */
  private desk: BrokerDesk
  /** Handover (E) — the staging area for an imported app and the person's confirmation (`handover.ts`) */
  private handover: AppHandover

  constructor(private deps: ExternalAppsDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    // Every ledger row passes through this one place — a tool-call row (`call`) and a broker-request row (the desk) alike. So the runs panel's own signal is also produced here, once
    const notify = deps.emitRunsChanged
    if (deps.runs && notify) this.deps = { ...deps, runs: announcingLedger(deps.runs, notify) }
    this.desk = new BrokerDesk(
      {
        has: (ref) => this.find(ref) !== undefined,
        name: (ref) => this.find(ref)?.manifest?.name ?? ref.appId,
        redactor: (ref) => this.masker(ref),
        origin: (runId) => this.chainOrigin(runId),
        chain: (runId) => this.chainOf(runId),
        denied: (runId, d) => {
          if (this.openRuns.has(runId) && !this.denials.has(runId)) this.denials.set(runId, d)
        },
        call: (ref, tool, args, caller, opts) => this.call(ref, tool, args, caller, opts),
      },
      deps.permissions ?? memoryCapabilityBook(),
      () => ({ questionMs: this.timing.capabilityQuestionMs, agentRateWindowMs: this.timing.agentRateWindowMs }),
      this.deps.runs ?? null,
    )
    this.secrets = new SecretStore(deps.dataRoot)
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
   * The chain leading up to this run (D-5) — the (app, tool) pairs from the call that started the
   * chain to this run. Only open runs are followed: a call beneath it lives only while its parent is
   * open (it is cancelled once the parent ends), so a running request's chain is never broken.
   */
  private chainOf(runId: string): { ref: AppRef; tool: string }[] {
    const path: { ref: AppRef; tool: string }[] = []
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && hops < 32; hops++) {
      path.unshift({ ref: run.entry.ref, tool: run.tool })
      run = run.caller.kind === 'app' ? this.openRuns.get(run.caller.parentRunId) : undefined
    }
    return path
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

  /**
   * Who started this run's chain (D-4) — walking up through parents to the first caller that is not
   * an app. For a screen, the answer is that screen's app (the question is attributed to its fixed
   * screen). If a parent along the way has already ended, this cannot be followed — returns null.
   */
  private chainOrigin(runId: string): CapabilityOrigin | null {
    let run = this.openRuns.get(runId)
    for (let hops = 0; run && run.caller.kind === 'app' && hops < 32; hops++) run = this.openRuns.get(run.caller.parentRunId)
    if (!run) return null
    if (run.caller.kind === 'session') return { kind: 'session', sessionId: run.caller.sessionId }
    if (run.caller.kind === 'view') return { kind: 'view', app: run.entry.ref }
    return null
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
    const all = await this.use(e, async () => e.life.tools ?? [], !!sessionId && this.sessionBoundaryOpen(sessionId))
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
  async call(
    ref: AppRef,
    name: string,
    args: Record<string, unknown>,
    caller: AppCaller,
    opts: {
      signal?: AbortSignal
      /**
       * Called once, the moment a run id is decided — used by a caller that needs the id before the
       * outcome is known (A-5's "long-running calls": returning "still running, run id is …" before
       * Codex's cap, rather than waiting for the outcome).
       */
      onRun?: (runId: string) => void
      /**
       * The text of a progress notification the app sent for this call (D) — a line the broker sent
       * the app, like "waiting on the person's approval in session X", is relayed up through this call
       * by the template's helper. Moved to somewhere the caller can display it (a session's tool card).
       * A wordless keepalive notification is never passed through.
       */
      onProgress?: (message: string) => void
    } = {},
  ): Promise<AppCallOutcome> {
    const e = this.require(ref)
    const runId = `run_${randomUUID()}`
    opts.onRun?.(runId)
    const t0 = Date.now()
    /*
     * A row is created as `running` the moment a call comes in, and corrected with its outcome when it
     * ends — a denial is also a row. What is masked is every secret stored for this app: whichever of
     * the arguments, the result, or the failure reason it ends up mixed into, only the name survives.
     */
    const redact = this.masker(e.ref)
    const row = new RunRow(
      this.deps.runs ?? null,
      {
        id: runId,
        projectId: e.ref.projectId,
        appId: e.ref.appId,
        kind: 'tool',
        tool: name,
        callerKind: caller.kind,
        callerSessionId: caller.kind === 'session' ? caller.sessionId : null,
        parentRunId: caller.kind === 'app' ? caller.parentRunId : null,
        createdAt: t0,
      },
      args,
      redact,
    )
    row.open()
    /** Whether it was actually sent to the app — "changed" only fires for a call that reached the app (a denial, cancellation while starting, or a failed startup changes nothing) */
    let sent = false
    /*
     * Is this a read-only tool (`readOnlyHint: true`)? Reading changes nothing, so "changed" is never
     * emitted for it either. Measured (65acb43): the template screen re-calls `show` on every
     * notification, and that `show` itself emits another notification, so a single screen called
     * `show` roughly 700 times per second (618 run-ledger rows in one second, 2035 in three seconds).
     * A tool with no annotation is treated as one that can change something, following MCP's own
     * default — if the wrong choice here is "does not notify", the screen shows a stale value.
     */
    let readOnly = false
    /** The process that received this call — its stderr is attached to the error bundle if the call fails (C-6) */
    let callee: AppProcess | null = null
    const done = (status: AppRunStatus, result: CallToolResult | null, error: string | null): AppCallOutcome => {
      const denial = this.denials.get(runId) ?? null
      this.denials.delete(runId)
      if (denial && status !== 'ok' && caller.kind === 'app' && this.openRuns.has(caller.parentRunId) && !this.denials.has(caller.parentRunId)) {
        this.denials.set(caller.parentRunId, denial)
      }
      /*
       * A call that reached the app failed (C-6) — this records only what could plausibly be the app's
       * own fault. A denial is policy, and a failure to start was already recorded separately by the
       * startup path. Arguments are masked under the same rule as the ledger — this bundle can become
       * the building session's prompt.
       */
      if (status === 'error' && sent) {
        this.recordError(
          e,
          {
            kind: 'tool',
            at: Date.now(),
            message: redact(error ?? '').split('\n')[0]!,
            stderr: [],
            tool: name,
            args: row.summary(),
            runId,
            denied: denial && { appId: denial.app.appId, projectId: denial.app.projectId, name: denial.name, capability: denial.capability, text: denial.text },
          },
          callee,
        )
      }
      const durationMs = Date.now() - t0
      row.close(status, error, result)
      if (sent && !readOnly) this.deps.emitChanged?.(e.ref, caller)
      return { runId, status, result, error, durationMs }
    }

    // Checks that end before anything is sent to the app — do not even need to start a process
    const open = caller.kind === 'session' && this.sessionBoundaryOpen(caller.sessionId)
    const blocked = this.blocker(e, { boundaryOpen: open })
    if (blocked) return done('rejected', null, blocked.reason)
    let parent: OpenRun | null = null
    if (caller.kind === 'app') {
      parent = this.openRuns.get(caller.parentRunId) ?? null
      if (!parent) return done('rejected', null, `The run that asked for this call is not open: ${caller.parentRunId}`)
    }
    if (opts.signal?.aborted) return done('cancelled', null, 'Cancelled before the call was sent')

    try {
      return await this.use(e, async (proc) => {
        const found = e.life.tools?.find((t) => t.tool.name === name)
        if (!found) return done('rejected', null, `This app has no tool named ${name}`)
        /*
         * A screen may call only `app` tools, and an agent or another app only `model` tools. A session
         * only ever receives `model` tools in its list to begin with (A-5), but a tool could still be
         * called if its name is known — hiding something from the list and blocking the call are
         * different things, and the blocking happens here.
         */
        const need: Audience = caller.kind === 'view' ? 'app' : 'model'
        if (!found.visibility.includes(need)) {
          return done('rejected', null, `${name} is not open to ${need === 'app' ? 'views' : 'agents'} (visibility: ${JSON.stringify(found.visibility)})`)
        }

        const upstream = [opts.signal, parent?.abort.signal].filter((x): x is AbortSignal => !!x)
        /*
         * If it was cancelled while the app was starting, this is never sent. Measured: a call
         * cancelled while starting ran a 5-second tool to completion anyway — a listener attached to a
         * signal that has already fired is never called.
         */
        if (upstream.some((sig) => sig.aborted)) return done('cancelled', null, 'Cancelled while the app was starting')
        const abort = new AbortController()
        const onUp = () => abort.abort(new Error('the caller cancelled this call'))
        for (const sig of upstream) sig.addEventListener('abort', onUp, { once: true })
        this.openRuns.set(runId, { entry: e, pipeId: e.life.pipeId, tool: name, caller, abort })
        sent = true
        readOnly = found.tool.annotations?.readOnlyHint === true
        callee = proc
        try {
          /*
           * Why `onprogress` is provided: the MCP SDK only attaches a progress token to a request when
           * this is present (in the client's request — without a token, the app has no way to send a
           * progress notification). So until now, `resetTimeoutOnProgress` did nothing at all. While an
           * app requests an agent and waits (D-1, which can take minutes), the template's helper has to
           * relay that wait up as this call's own progress, or the call gets cut off at
           * `callTimeoutMs`. If the notification carries a message, it is passed to the caller
           * (`onProgress`) — while the app waits on a person, the calling session's card can state what
           * it is waiting for. Before this, it was dropped here and never reached anywhere.
           */
          const result = await proc.client.callTool(
            { name, arguments: args, _meta: { [RUN_META]: runId } },
            {
              signal: abort.signal,
              timeout: this.timing.callTimeoutMs,
              resetTimeoutOnProgress: true,
              onprogress: (p) => {
                if (typeof p.message === 'string' && p.message.trim()) opts.onProgress?.(p.message)
              },
            },
          )
          return result.isError ? done('error', result, resultText(result) || 'The tool returned an error with no text') : done('ok', result, null)
        } catch (err) {
          if (abort.signal.aborted) return done('cancelled', null, 'The caller cancelled this call')
          return done('error', null, (err as Error).message)
        } finally {
          this.openRuns.delete(runId)
          // When a run ends, the broker work beneath it also ends — so nothing is left behind even if the app answered without waiting
          abort.abort()
          for (const sig of upstream) sig.removeEventListener('abort', onUp)
        }
      }, open)
    } catch (err) {
      // Failed to start (a failed startup, or changed while backing off) — never reached the app, but this is not a policy denial
      return done('error', null, (err as Error).message)
    }
  }

  /**
   * Reads an app's resource — the path a screen uses to read its own `ui://` document and resources
   * (B-3, B-4's `onreadresource`). Not a tool call, so no run record is kept, but the rules for
   * starting the app (trust, only when first needed) are the same.
   */
  async readResource(ref: AppRef, uri: string): Promise<ReadResourceResult> {
    const e = this.require(ref)
    return this.use(e, (proc) => proc.client.readResource({ uri }, { timeout: this.timing.connectTimeoutMs }))
  }

  /**
   * The list of resources an app offers (MCP `resources/list`, following pagination) — the basis an
   * in-conversation screen (B-1) uses to check that a `ui://` a tool declared **actually belongs to
   * this app** (from the plan, "blocking impersonation"). Starts the app under the same rule as
   * reading. Follows only up to a page cap — so an app that keeps handing out the next page cannot
   * hold the host hostage.
   */
  async listResources(ref: AppRef, maxPages = 20): Promise<ListResourcesResult['resources']> {
    const e = this.require(ref)
    return this.use(e, async (proc) => {
      const out: ListResourcesResult['resources'] = []
      let cursor: string | undefined
      for (let page = 0; page < maxPages; page++) {
        const r = await proc.client.listResources(cursor ? { cursor } : {}, { timeout: this.timing.connectTimeoutMs })
        out.push(...r.resources)
        cursor = r.nextCursor
        if (!cursor) break
      }
      return out
    })
  }

  /**
   * One screen is holding this app open (called by ViewHost's open). While a screen is open, this is
   * never treated as an idle app — call the returned function to release the hold (close).
   */
  retainView(ref: AppRef): () => void {
    const e = this.require(ref)
    const key = this.holdKey(e.ref)
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
      const now = this.find(ref)
      if (now) this.armIdle(now)
    }
  }

  /**
   * The tool that opens the fixed screen, and that screen itself (B-2) — the manifest's `home`, and
   * that tool's declared `_meta.ui.resourceUri`. Since this needs the tool list, if the app is down,
   * **this is where it starts**.
   *
   * A tool declaring no screen is never accepted. A fixed screen is one born from a tool call (from
   * the plan, "the two places a screen can appear"), and calling a tool with no screen would leave
   * only a result with nothing to open. Calling it anyway would leave the person watching the app's
   * state change with nothing appearing on screen. So this is refused **before** ever calling it. The
   * reason is worded for a person, since it shows up on screen verbatim.
   */
  async homeView(ref: AppRef): Promise<{ tool: string; resourceUri: string }> {
    const e = this.require(ref)
    if (!e.manifest) throw new AppUnavailableError(invalidReason(e))
    const home = e.manifest.home
    if (!home) throw new AppUnavailableError('This app has no screen: its manifest names no home tool')
    const all = await this.use(e, async () => e.life.tools ?? [])
    const found = all.find((t) => t.tool.name === home)
    if (!found) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" is not in its tool list`)
    const ui = resourceUriOf(found.tool)
    if (ui.error) throw new AppUnavailableError(`This app's screen is declared wrong: ${ui.error}`)
    if (!ui.uri) throw new AppUnavailableError(`This app has no screen: its home tool "${home}" declares no _meta.ui.resourceUri`)
    return { tool: home, resourceUri: ui.uri }
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
    await this.halt(e, 'restart requested')
    resetLife(e.life)
    // A stopped app had been detached from sessions — announce so it can attach again. A crashed app's
    // reason is also cleared, changing its status in the list (A-8)
    this.appsChanged()
  }

  /**
   * Creates a screen-less app in the user folder (M4 A-7, decision 8) — where an MCP server a person
   * approved turns into an app.
   *
   * If an approved server lived in a separate registry (app_settings), the approval flow and the
   * attach path would both be duplicated. That server's calls never went through the broker, were
   * never recorded, and could not even be removed from a list. Becoming an app puts it on the same one
   * path every other app takes (audience, the run ledger, starting only when first needed, stopping
   * when idle). Since it is a user-folder app, it attaches to the orchestrator (decision 4 — the same
   * place a previously approved server used to attach).
   *
   * Validation is the same single set discovery uses: a manifest is built and passed through
   * `parseManifest` before it is written (the id rule from #93 lives there too). A reserved id
   * cannot be taken. **If an app with the same id already exists** — if it is the same server, that
   * app is returned as-is (calling this again produces the same result: when a move was interrupted
   * partway and runs again), and if different, this refuses (a person-made app is never overwritten).
   *
   * How it is written: through `placeAppFolder` — to a temp folder starting with a dot (skipped by
   * discovery), then renamed, so there is never a moment where discovery could read a half-written
   * manifest as "a broken app"; the parent is created through the path guard, so an `apps/` that is
   * a link pointing outside the data folder stops it. The data folder is also created right away.
   * Rescanned immediately after writing: on the user side, nothing is watched while `apps/` does not
   * exist yet (watching the data folder itself would wake up on every write to store.db), so watching
   * never catches the very first app. **This never starts it** — it starts the first time it is
   * needed.
   */
  installUserApp(spec: { id: string; name: string; description: string; server: { command: string; args: string[] } }): ExternalAppInfo {
    if (this.disposed) throw new AppUnavailableError('The app runtime has shut down')
    if (this.deps.reservedIds.includes(spec.id)) throw new AppUnavailableError(`"${spec.id}" is a reserved app id — use another name`)
    const text = JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        id: spec.id,
        name: spec.name,
        version: '1.0.0',
        description: spec.description,
        server: { command: spec.server.command, args: spec.server.args },
      },
      null,
      2,
    )
    const parsed = parseManifest(text)
    if (!parsed.ok) throw new AppUnavailableError(`This cannot become an app — ${parsed.error}`)

    this.rescanUser()
    const ref: AppRef = { projectId: null, appId: spec.id }
    const dir = join(this.deps.dataRoot, ...USER_APPS_PARTS, spec.id)
    const held = this.find(ref)
    if (held || existsSync(dir)) {
      const same =
        held?.manifest?.server.command === spec.server.command &&
        JSON.stringify(held.manifest.server.args) === JSON.stringify(spec.server.args)
      if (held && same) return this.info(held)
      throw new AppUnavailableError(`Your user folder already has an app "${spec.id}" — use another name, or remove that app first`)
    }

    try {
      placeAppFolder(this.deps.dataRoot, null, spec.id, (staging) => {
        mkdirSync(staging)
        writeFileSync(join(staging, MANIFEST_FILE), text + '\n')
      })
    } catch (err) {
      throw new AppUnavailableError(`Could not write the app folder: ${(err as Error).message}`)
    }
    mkdirSync(this.dataDirOf(ref), { recursive: true })
    this.rescanUser()
    const made = this.find(ref)
    if (!made) throw new AppUnavailableError(`The app folder was written, but discovery did not find it: ${dir}`)
    return this.info(made)
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
    const label = appLabel(ref)
    const findings: CheckFinding[] = []
    const notes: string[] = []
    let tools: CheckedTool[] = []
    const screens: { uri: string; chars: number }[] = []
    let procLine: string | null = null
    const report = (stderr: string | null) => formatReport(label, { findings, tools, screens }, { process: procLine, notes, stderr })

    const key = ref.projectId ?? USER_SCOPE
    // A check is a request to read the current files right now — even a manifest change deferred because it was mid-turn is read now (C-4, `rescan`'s `now`)
    if (this.scopes.has(key)) this.rescan(key, { now: ref.appId })
    else this.refresh()
    const e = this.find(ref)
    if (!e) {
      findings.push({ level: 'problem', where: 'app', message: 'there is no such app — its folder was removed or renamed' })
      return report(null)
    }
    for (const w of e.warnings) findings.push({ level: 'warning', where: 'centralu.app.json', message: w })
    // A check gives a stopped app another start (see above), so only what a check cannot clear stops it here
    const blocked = this.blocker(e, { fresh: true })
    if (blocked) {
      findings.push({ level: 'problem', where: CHECK_WHERE[blocked.kind], message: blocked.kind === 'invalid' ? (e.error ?? 'the manifest is invalid') : blocked.reason })
      return report(null)
    }

    // Restarts with the current files — stopped in **the very same tick** the call finishes (see the comment on drain)
    let restarted = false
    for (;;) {
      if (e.life.inflight === 0) {
        const wasStopped = e.life.gaveUp
        void this.halt(e, 'check: starting again from the files on disk')
        resetLife(e.life)
        if (wasStopped) this.appsChanged()
        restarted = true
        break
      }
      const busy = e.life.inflight
      if (!(await this.drain(e, this.timing.checkDrainMs))) {
        const limit = this.timing.checkDrainMs >= 1000 ? `${Math.round(this.timing.checkDrainMs / 1000)} s` : `${this.timing.checkDrainMs} ms`
        notes.push(
          `${busy} call${busy === 1 ? ' was' : 's were'} still running after ${limit}, so the app was not restarted — ` +
            'this report is about the process that was already running, which may not have your latest code',
        )
        break
      }
    }

    let stderr: string | null = null
    try {
      await this.use(e, async (proc) => {
        const listed = await proc.client.listTools(undefined, { timeout: this.timing.connectTimeoutMs })
        proc.tools = listed.tools
        this.readTools(e, proc)
        const t = checkTools(e.manifest!, listed.tools)
        findings.push(...t.findings)
        tools = t.tools
        for (const uri of t.screens) {
          let read: ReadResourceResult | Error
          try {
            read = await proc.client.readResource({ uri }, { timeout: this.timing.connectTimeoutMs })
          } catch (err) {
            read = err as Error
          }
          const s = checkScreen(uri, read)
          findings.push(...s.findings)
          screens.push({ uri, chars: s.chars })
        }
        procLine = `pid ${proc.child.pid}, ${proc.client.getProtocolEra()} (${proc.client.getNegotiatedProtocolVersion()}), ${restarted ? 'restarted from the files on disk' : 'the process that was already running'}`
        stderr = proc.log.tail() || null
      })
    } catch (err) {
      // Failed to start — the reason already includes the tail of stderr (AppProcess.start)
      findings.push({ level: 'problem', where: 'start', message: (err as Error).message })
    }
    return report(stderr)
  }

  /**
   * Creates a new app from the template (M4 C-1b) — "New app" (`apps.create`) and the orchestrator's
   * `create_app` use the same door.
   *
   *   project app     `<project>/.centralu/apps/<id>/` — committed to the repository and shared with
   *                   the team (decision 1's default)
   *   user-folder app `<data folder>/apps/<id>/` — for something used across several projects
   *                   (`projectId: null`)
   *
   * Three things refused, all before the folder is created:
   *   - **the name**: the same rule as a proposed MCP server (`newAppIdProblem` — #93's characters and
   *     the `centralu` reservation, plus a ban on the `app-` prefix). Discovery still reads an id with
   *     the `app-` prefix (a hand-made app), but there is no reason for a newly created app to have a
   *     server name like `app-app-notes`. A reserved id is also refused.
   *   - **an untrusted project**: a created app is code that runs on this machine, and an app in an
   *     untrusted project never starts (decision 3). An app that can be created but never runs would
   *     leave the building session spinning its wheels.
   *   - **an id that already exists**: even a folder standing there with an invalid manifest belongs
   *     to a person or an agent — never overwritten.
   *
   * Writing follows the same method as `installUserApp` (`placeAppFolder`): expanded into a temp
   * folder starting with a dot, then renamed (so discovery never sees a half-written app). The parent folder is created one
   * segment at a time through the path guard (`ensureDirInside` — stops if `.centralu` is a link
   * pointing outside). The data folder is also created right away. Rescanned immediately after
   * writing — watching might not be looking at that location yet. **This never starts it** — it
   * starts the first time it is needed.
   */
  createApp(spec: { projectId: string | null; id: string; name: string; description?: string }): ExternalAppInfo {
    if (this.disposed) throw new AppUnavailableError('The app runtime has shut down')
    const idProblem = newAppIdProblem(spec.id, this.deps.reservedIds)
    if (idProblem) throw new AppUnavailableError(`"${spec.id}" cannot be an app id — ${APP_ID_PROBLEM[idProblem]}`)
    const name = oneLine(spec.name)
    if (!name) throw new AppUnavailableError('The app needs a name')
    const description = oneLine(spec.description ?? '') || `${name} (a Centralu app)`

    // Trust is read from the single source of truth (the store) every time this is called — never from the runtime's own copy of scope
    let root = this.deps.dataRoot
    if (spec.projectId !== null) {
      const project = this.deps.projects().find((p) => p.id === spec.projectId)
      if (!project) throw new AppUnavailableError(`There is no such project: ${spec.projectId}`)
      if (!project.trusted) {
        throw new AppUnavailableError('Centralu does not make apps in a project it does not trust — an app is code that runs on this machine, so trust the project first')
      }
      root = project.path
    }
    const key = spec.projectId ?? USER_SCOPE
    if (this.scopes.has(key)) this.rescan(key)
    else this.refresh()

    const ref: AppRef = { projectId: spec.projectId, appId: spec.id }
    const parts = spec.projectId === null ? USER_APPS_PARTS : PROJECT_APPS_PARTS
    const dir = join(root, ...parts, spec.id)
    if (this.find(ref) || existsSync(dir)) {
      throw new AppUnavailableError(`An app "${spec.id}" already exists (${dir}) — use another id`)
    }

    try {
      placeAppFolder(root, spec.projectId, spec.id, (staging) => {
        scaffoldApp(this.deps.templateDir ?? appTemplateDir(), staging, { id: spec.id, name, description })
      })
    } catch (err) {
      throw new AppUnavailableError(`Could not make the app folder: ${(err as Error).message}`)
    }
    mkdirSync(this.dataDirOf(ref), { recursive: true })
    this.rescan(key)
    const made = this.find(ref)
    if (!made) throw new AppUnavailableError(`The app folder was made, but discovery did not find it: ${dir}`)
    return this.info(made)
  }

  /**
   * Removes a user-folder app (M4 A-7) — the path for withdrawing an approved MCP server from the
   * list (a path that did not exist in the old registry).
   *
   * The folder is not deleted, only moved to `app-trash/` in the data folder: it could be a hand-made
   * app, and it is better to have a way to bring it back. The run ledger, data folder, and secrets
   * survive (a removed app's records are still readable — `runs`). **This never removes a project
   * app** — that is a file in a repository, and the place to withdraw it is git.
   *
   * A running app is stopped, and waited for, **before** the folder moves (#14). Windows refuses to
   * move a folder that a process has as its working directory, and an app runs in its own folder:
   * moving first failed with EBUSY and left the app in place and running. Nothing starts it again
   * meanwhile (`removing`). Rescanned after moving: an attached session detaches (appsChanged). A
   * Claude session drops it from its server set without restarting, and a Codex thread keeps the
   * tool name until its next thread, but calling it is refused with "not an attached app"
   * (attaching to a session re-checks on every call).
   */
  async removeUserApp(ref: AppRef): Promise<void> {
    if (ref.projectId !== null) {
      throw new AppUnavailableError("A project app is part of the project's repository — remove it there")
    }
    this.rescanUser()
    const e = this.require(ref)
    const key = this.holdKey(ref)
    this.removing.add(key)
    try {
      await this.halt(e, 'app removed', { awaitTree: true })
      const trash = join(this.deps.dataRoot, 'app-trash')
      mkdirSync(trash, { recursive: true })
      renameSync(e.dir, join(trash, `${ref.appId}-${Date.now()}`))
    } finally {
      this.removing.delete(key)
    }
    // Also drops the imported-app mark (E-3) — a folder restored from the trash is one a person moved back by hand (decision 3: a user-folder app is trusted)
    this.handover.forget(ref.appId)
    this.rescanUser()
  }

  /** Rescans the user folder right now — scans everything if it has never scanned before (pre-startup) */
  private rescanUser(opts: { now?: string } = {}): void {
    if (this.scopes.has(USER_SCOPE)) this.rescan(USER_SCOPE, opts)
    else this.refresh()
  }

  /** Writes a secret value (clears it if `null`). A running app receives it starting from its next startup */
  setSecret(ref: AppRef, name: string, value: string | null): void {
    this.secrets.set(this.appKey(ref), name, value)
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
    this.secrets.set(this.appKey(ref), name, value)
    const L = e.life
    const fresh = () => {
      if (!L.proc && !L.starting) resetLife(L)
      this.appsChanged()
    }
    if (L.proc || L.starting) void this.haltWhenDrained(e, 'a secret changed; the next need starts it with the new value').then(fresh)
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
    void this.reloadIfChanged(ref, { startIfStopped: true, why: 'a previous version was restored' })
    this.appsChanged()
    return this.info(e)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.watchers.close()
    this.handover.dispose()
    for (const t of [...this.turnEndTimers.values(), ...this.quietTimers.values()]) clearTimeout(t)
    this.turnEndTimers.clear()
    this.quietTimers.clear()
    this.appsListeners.clear()
    const all = [...this.scopes.values()].flatMap((s) => [...s.apps.values()])
    this.scopes.clear()
    // Within the shutdown budget (Tauri's 3 seconds) — the grace period is shortened, and it does not wait all the way through SIGKILL
    await Promise.allSettled([
      ...all.map((e) => this.halt(e, 'host shutting down', { graceMs: 1_000, awaitKill: false })),
      // Also processes belonging to no entry at all (see the `spawned` comment) — if one is already stopping, this waits for that same stop (stop only ever runs once)
      ...[...this.spawned].map((p) => p.stop(1_000, { awaitKill: false })),
    ])
    this.spawned.clear()
  }

  // ── Reflecting changes (C-4) ─────────────────────────────────────────────────────────────────

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
    if (this.disposed) return
    const key = this.holdKey(ref)
    clearTimeout(this.turnEndTimers.get(key))
    const t = setTimeout(() => {
      this.turnEndTimers.delete(key)
      /*
       * A manifest change deferred while mid-turn is read right now (`rescan`'s `now`). Even if
       * watching missed that change, it is read here. If a new entry was created, the old process
       * stops after finishing its call (`haltWhenDrained`), and the new entry is started **once** with
       * the new manifest — just like when only the folder changed, this starts an app even if it was
       * idle and stopped, as long as it has ever started before (this moves the building session's
       * tool list forward).
       */
      const before = this.find(ref)
      const scopeKey = ref.projectId ?? USER_SCOPE
      if (this.scopes.has(scopeKey) && !this.disposed) this.rescan(scopeKey, { now: ref.appId })
      const after = this.find(ref)
      if (before && after && after !== before) {
        if (before.life.stamp !== null) void this.startNewManifest(after, "the builder's turn ended and the manifest changed")
        return
      }
      void this.reloadIfChanged(ref, { startIfStopped: true, why: "the builder's turn ended and the app folder changed" })
    }, this.timing.turnEndDebounceMs)
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
  private folderChanged(e: AppEntry): void {
    if (this.deps.builderBusy?.(e.ref)) return
    const key = this.holdKey(e.ref)
    clearTimeout(this.quietTimers.get(key))
    const ref = e.ref
    const t = setTimeout(() => {
      this.quietTimers.delete(key)
      if (this.deps.builderBusy?.(ref)) return
      void this.reloadIfChanged(ref, { startIfStopped: false, why: 'the app folder changed and stayed quiet' })
    }, this.timing.reloadQuietMs)
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
  private reloadIfChanged(ref: AppRef, opts: { startIfStopped: boolean; why: string }): Promise<boolean> {
    const key = this.holdKey(ref)
    const running = this.reloading.get(key)
    if (running) return running
    const p = (async () => {
      const e = this.find(ref)
      // A changed folder gives a stopped app another chance (below), so only what that cannot clear stops it here
      if (!e || this.blocker(e, { fresh: true }) || this.disposed) return false
      const L = e.life
      if (L.stamp === null || folderFingerprint(e.dir) === L.stamp) return false
      if (!opts.startIfStopped && !L.proc?.alive) return false
      while (L.inflight > 0) await this.drain(e, 60_000)
      // The manifest changed and a new entry replaced this one, or it was removed, while waiting — a new entry starts through its own path
      if (this.find(ref) !== e || this.disposed) return false
      const pid = L.proc?.child.pid
      L.proc?.log.note(`reloading: ${opts.why}`)
      void this.halt(e, opts.why)
      resetLife(L)
      this.appsChanged()
      try {
        await this.use(e, async () => {})
        console.error(`[apps] ${this.label(ref)} reloaded (${opts.why})${pid ? `, was pid ${pid}` : ''}`)
        this.deps.emitChanged?.(ref)
      } catch (err) {
        // Failed to start — the reason is recorded both in the list (crashed) and in an error bundle. The building session's check reads that reason
        console.error(`[apps] ${this.label(ref)} reload failed: ${(err as Error).message.split('\n')[0]}`)
      }
      return true
    })().finally(() => this.reloading.delete(key))
    this.reloading.set(key, p)
    return p
  }

  /** Stops it only after finishing a call in progress — the way an old entry's process is collected when a manifest change replaces the entry */
  private async haltWhenDrained(e: AppEntry, why: string): Promise<void> {
    while (e.life.inflight > 0) await this.drain(e, 60_000)
    await this.halt(e, why)
  }

  /**
   * Starts a newly created entry with a new manifest (C-4) — for when reading a manifest deferred
   * until the building session's turn end replaces the entry. The old process is stopped by `rescan`
   * after finishing its call. If it starts, "changed" is sent to an open screen (the same as
   * `reloadIfChanged`).
   */
  private async startNewManifest(e: AppEntry, why: string): Promise<void> {
    if (this.blocker(e) || this.disposed) return
    try {
      await this.use(e, async () => {})
      console.error(`[apps] ${this.label(e.ref)} started on its new manifest (${why})`)
      this.deps.emitChanged?.(e.ref)
    } catch (err) {
      // Failed to start — the reason is recorded both in the list (crashed) and in an error bundle. The building session's check reads that reason
      console.error(`[apps] ${this.label(e.ref)} did not start on its new manifest: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────

  /** An app is never idle while in use — the idle timer is set again once it is done */
  private async use<T>(e: AppEntry, fn: (proc: AppProcess) => Promise<T>, boundaryOpen = false): Promise<T> {
    e.life.inflight += 1
    this.clearIdle(e)
    try {
      return await fn(await this.ensureRunning(e, boundaryOpen))
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
  private drain(e: AppEntry, ms: number): Promise<boolean> {
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
  private ensureRunning(e: AppEntry, boundaryOpen = false): Promise<AppProcess> {
    const L = e.life
    const blocked = this.blocker(e, { boundaryOpen })
    if (blocked) throw new AppUnavailableError(blocked.reason)
    if (L.proc?.alive) return Promise.resolve(L.proc)
    if (L.starting) return L.starting

    const epoch = L.epoch
    const p = (async () => {
      const wait = L.retryAt - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (L.epoch !== epoch || this.disposed) throw new AppUnavailableError('The app changed or was stopped, so this start was abandoned')
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
      if (e.ref.projectId === null) this.handover.snapshot(e.ref.appId, e.dir, 'started', L.stamp)
      let proc: AppProcess
      try {
        proc = await AppProcess.start(this.spawnSpec(e, pipeId))
      } catch (err) {
        if (L.epoch === epoch) {
          // If connecting failed with the remembered generation, that memory could be wrong — the next attempt probes again
          if (usedPrior) L.verdict = undefined
          this.fail(e, (err as Error).message)
          const started = err instanceof AppStartError ? err : null
          this.recordError(e, {
            kind: 'start',
            at: Date.now(),
            message: started?.head ?? (err as Error).message.split('\n')[0]!,
            stderr: started?.stderr ?? [],
            tool: null,
            args: null,
            runId: null,
          })
        }
        throw new AppUnavailableError((err as Error).message)
      }
      if (L.epoch !== epoch || this.disposed) {
        this.remember(proc)
        void proc.stop(this.timing.graceMs)
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
    this.appsChanged()
    const settled = () => {
      if (L.starting === p) L.starting = null
      this.appsChanged()
    }
    p.then(settled, settled)
    return p
  }

  private readTools(e: AppEntry, proc: AppProcess): void {
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
    if (forModel(kept) !== before) this.appsChanged()
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
    const where = this.label(e.ref)
    if (L.failures >= this.timing.maxFailures) {
      L.gaveUp = true
      // A stopped app never attaches to a session (decision 4) — announce so an already-attached session detaches it
      this.appsChanged()
      console.error(`[apps] ${where} stopped after ${L.failures} consecutive failures: ${reason.split('\n')[0]}`)
    } else {
      L.retryAt = Date.now() + this.timing.backoffBaseMs * 2 ** (L.failures - 1)
      console.error(`[apps] ${where} failed (${L.failures}/${this.timing.maxFailures}): ${reason.split('\n')[0]}`)
    }
  }

  private crashed(e: AppEntry, proc: AppProcess, reason: string): void {
    const L = e.life
    if (L.proc !== proc) return
    L.proc = null
    L.tools = null
    this.clearIdle(e)
    // If it died after running well for a long time, this is not a consecutive failure — counted from zero
    if (Date.now() - proc.startedAt >= this.timing.stableMs) L.failures = 0
    this.fail(e, reason)
    this.recordError(e, { kind: 'crash', at: Date.now(), message: reason.split('\n')[0]!, stderr: proc.log.tailLines(), tool: null, args: null, runId: null })
    // Cleans up the pipe and the log, and collects any descendant left in its group
    void proc.stop(0)
    // A running app died without warning — the person in front of the screen has to see the reason (A-8, B-6)
    this.appsChanged()
  }

  /** Records a started process — every time one is recorded, anything already ended is cleared out (so the list never grows over the host's lifetime) */
  private remember(proc: AppProcess): void {
    for (const p of this.spawned) if (!p.alive) this.spawned.delete(p)
    this.spawned.add(proc)
  }

  /** Stops it — because it went idle, changed, lost trust, or the host is exiting */
  private async halt(e: AppEntry, why: string, opts: { graceMs?: number; awaitKill?: boolean; awaitTree?: boolean } = {}): Promise<void> {
    const L = e.life
    L.epoch += 1
    this.clearIdle(e)
    const proc = L.proc
    L.proc = null
    L.tools = null
    if (!proc) return
    // A running app is stopping — it is not running in the list from this moment (A-8)
    this.appsChanged()
    proc.log.note(`stopping: ${why}`)
    await proc.stop(opts.graceMs ?? this.timing.graceMs, { awaitKill: opts.awaitKill, awaitTree: opts.awaitTree })
  }

  private armIdle(e: AppEntry): void {
    this.clearIdle(e)
    const L = e.life
    if (L.inflight > 0 || this.viewsOf(e) > 0 || !L.proc) return
    L.idle = setTimeout(() => {
      L.idle = null
      if (L.inflight === 0 && this.viewsOf(e) === 0) void this.halt(e, `idle for ${this.timing.idleMs}ms`)
    }, this.timing.idleMs)
    L.idle.unref()
  }

  private viewsOf(e: AppEntry): number {
    return this.viewHolds.get(this.holdKey(e.ref)) ?? 0
  }

  /** The key for an open screen. Since this is never used in a path, it does not care about a project id's shape (unlike scopeDir) */
  private holdKey(ref: AppRef): string {
    return appKeyOf(ref.projectId, ref.appId)
  }

  /** An app that is gone takes its error bundles with it (`ErrorLog.forget`) */
  private forgetErrors(ref: AppRef): void {
    this.errorLog.forget(this.holdKey(ref))
  }

  private clearIdle(e: AppEntry): void {
    if (e.life.idle) clearTimeout(e.life.idle)
    e.life.idle = null
  }

  /**
   * The shape to start with. What the app receives:
   *   - cwd = the app folder
   *   - `CENTRALU_APP_DATA` = a data folder outside the repository (created if it does not exist).
   *     Writing this inside the app folder would get it committed and leaked to the team (from the
   *     plan, "data and secrets")
   *   - only the secrets the manifest **declared**, as environment variables
   * What it never receives: the host's own variables (`CC_*`). Among them is the host's WebSocket
   * token (`CC_HOST_TOKEN`) — handing that to an app would let it call every one of the host's RPCs.
   */
  private spawnSpec(e: AppEntry, pipeId: number): SpawnSpec {
    const m = e.manifest!
    const scopeDir = this.scopeDir(e.ref)
    const dataDir = this.dataDirOf(e.ref)
    mkdirSync(dataDir, { recursive: true })
    const appKey = this.appKey(e.ref)
    const secrets = this.secrets.forApp(appKey, m.secrets ?? [])
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(this.deps.env ?? process.env)) {
      if (k.startsWith('CC_') || k.startsWith('CENTRALU_')) continue
      env[k] = v
    }
    Object.assign(env, secrets, { CENTRALU_APP_ID: e.ref.appId, CENTRALU_APP_DATA: dataDir })
    return {
      command: m.server.command,
      args: m.server.args,
      cwd: e.dir,
      env,
      logPath: join(this.deps.dataRoot, 'app-logs', scopeDir, `${e.ref.appId}.log`),
      logMaxBytes: this.timing.logMaxBytes,
      // Masks every stored value, even one absent from the declaration — masking it costs nothing
      redact: this.masker(e.ref),
      prior: e.life.verdict,
      probeTimeoutMs: this.timing.probeTimeoutMs,
      connectTimeoutMs: this.timing.connectTimeoutMs,
      exitWaitMs: this.timing.startExitWaitMs,
      serveFd3: (fd3, note) =>
        serveBroker(
          fd3,
          {
            // Only this pipe's app, and a run open on this pipe — someone else's id and a dead process's id both fail
            openRun: (runId) => {
              const run = this.openRuns.get(runId)
              return run && run.entry === e && run.pipeId === pipeId ? run.abort.signal : null
            },
            note,
            refused: (tool, args, why) => this.desk.refused({ ref: e.ref, name: m.name, manifest: m }, tool, args, why),
          },
          /*
           * The requesting app is this pipe's app, and the manifest is **the one read when this process
           * started.** If the manifest changed in the meantime, a new entry was created and this process
           * stops after finishing its call — while it is still running, it requests things under the
           * declaration it started with (what was validated is what is used).
           */
          (tool, args, call) => this.desk.handle({ ref: e.ref, name: m.name, manifest: m }, tool, args, call),
          { keepaliveMs: this.timing.brokerKeepaliveMs },
        ),
    }
  }

  /** An app's data folder — outside the app folder (from the plan, "data and secrets"). The app receives it as `CENTRALU_APP_DATA` */
  private dataDirOf(ref: AppRef): string {
    return join(this.deps.dataRoot, 'app-data', this.scopeDir(ref), ref.appId)
  }

  /** The scope name used as one path segment. A project id is a UUID — refused rather than written into a path if it does not look like one */
  private scopeDir(ref: AppRef): string {
    if (ref.projectId === null) return USER_SCOPE
    if (!/^[A-Za-z0-9-]+$/.test(ref.projectId)) throw new AppUnavailableError(`This project id cannot be used in a path: ${ref.projectId}`)
    return ref.projectId
  }

  /**
   * The function that masks every secret stored for this app (A-3, A-6) — whichever of a run's
   * arguments, its result, its failure reason or the app's own log a value ends up mixed into, only
   * its name survives. Built from the stored values at the moment it is asked for: a tool call's row,
   * a broker request's row and a starting process each take their own.
   */
  private masker(ref: AppRef): (text: string) => string {
    return redactor(this.secrets.all(this.appKey(ref)))
  }

  private appKey(ref: AppRef): string {
    return `${this.scopeDir(ref)}/${ref.appId}`
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
      ...this.secretSlots(e),
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

  /** Whether a value is set for each declared secret (E, the secrets section) — just the name and whether it is set. No field at all if there is no declaration */
  private secretSlots(e: AppEntry): Pick<ExternalAppInfo, 'secrets'> {
    const declared = e.manifest?.secrets ?? []
    if (declared.length === 0) return {}
    const stored = this.secrets.names(this.appKey(e.ref))
    return { secrets: declared.map((name) => ({ name, set: stored.has(name) })) }
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
        if (prev.scope.trusted !== scope.trusted) changed = true
        prev.scope = scope
        // An app in a project that lost trust is stopped immediately — it stays in the list
        if (!scope.trusted) void this.halt(prev, 'project is no longer trusted')
        // Did something outside the manifest change (server.mjs, a screen…) (C-4)? Measured only for an app that has started at least once
        else if (prev.life.stamp !== null && folderFingerprint(prev.dir) !== prev.life.stamp) this.folderChanged(prev)
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
        void this.haltWhenDrained(prev, 'manifest changed')
      }
      held.apps.set(found.folder, newEntry(scope, found, this.deps.reservedIds))
      changed = true
    }
    for (const [id, e] of [...held.apps]) {
      if (seen.has(id)) continue
      held.apps.delete(id)
      void this.halt(e, 'app folder removed')
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
      void this.halt(e, 'project removed')
      this.forgetErrors(e.ref)
    }
    if (held?.apps.size) this.appsChanged()
  }
}

/** Joins together the text parts of a result — becomes the one line a person reads (RPC's `text`) and a failure's reason */
export function resultText(result: CallToolResult): string {
  return result.content
    .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
    .join('\n')
}

import { parseJson } from '../dev-services/store/json.js'
import { isObj } from '../json-value.js'
import { USER_APP_SCOPE, appKeyOf, type AppReach, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import type { SessionApps } from '../adapters/contract.js'
import type { AppRef, BrokerHost, ExternalApps } from '../apps/external/runtime.js'
import { inTurn } from '../idle.js'
import { rpcError } from '../rpc-error.js'
import { AppAccess, writeShared } from './app-access.js'
import type { AppSessions, AppSessionsHost } from './app-sessions.js'
import type { DelegationHost } from './delegation-flow.js'
import type { HostCards } from './host-cards.js'
import type { OrchestratorProposals } from './orchestrator-proposals.js'
import type { RestartHost } from './restart-policy.js'
import type { RoutedCardsHost } from './routed-cards.js'
import { APP_NAMES_PREFIX, SessionAppsHub } from './session-apps.js'
import type { SessionTrashHost } from './session-trash.js'
import type { ToolQueriesHost } from './tool-queries.js'
import { isAppAgent } from './tool-profiles.js'

/** `orchestrator_apps_notice:<session id>`: set once an orchestrator's first turn by a build since #1205 has gone in (purged with the session) */
export const ROOT_APPS_NOTICE_PREFIX = 'orchestrator_apps_notice:'

/** The line an orchestrator that had root apps attached reads once, on its first turn since #1205 */
export const ROOT_APPS_NOTICE =
  'Project apps are no longer attached by default: find them with the find_apps command (centralu_run) and attach the one you need.'

/**
 * What the app wiring reaches of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type SessionAppWiringHost = Pick<DelegationHost, 'adapters' | 'autoBoundaryOpen' | 'builderRefOf' | 'ensureProjectAccess' | 'handles' | 'meta' | 'onEvent' | 'store'> &
  Pick<AppSessionsHost, 'defaultToolFor'> &
  Pick<SessionTrashHost, 'restartPolicy'> &
  Pick<RestartHost, 'restartSession'> &
  Pick<ToolQueriesHost, 'cacheLedger'> &
  Pick<RoutedCardsHost, 'toolProfileOf'> & {
    /** A session's row, or `session_not_found` */
    sessionOf: (sessionId: string) => SessionInfo
    appHostData: AppSessions['appHostData']
    runAppAgent: AppSessions['runAppAgent']
    agentRunEnded: AppSessions['agentRunEnded']
    askCapability: HostCards['askCapability']
    migrateApprovedMcpServers: OrchestratorProposals['migrateApprovedMcpServers']
  }

/**
 * The external app runtime as the sessions meet it (M4 A-5, #371): the hub that attaches apps to a session, another
 * project's apps attached on demand, the session's share of the broker, and an app set that changed under a live
 * process. Moved out of the session manager as it was (#428); what it reaches of the manager is `SessionAppWiringHost`.
 */
export class SessionAppWiring {
  constructor(private readonly host: SessionAppWiringHost) {}

  /**
   * Where external apps are attached to a session (M4 A-5). It is null on a host with no runtime
   * (most tests), and in that case the session accepts no apps — it is optional, like any other
   * service.
   */
  appsHub: SessionAppsHub | null = null
  /** Another project's apps, attached on demand (#371 part A) — null exactly when `appsHub` is */
  appAccess: AppAccess | null = null

  /** The session's share of the broker's body (M4 D) — called only after the runtime's gate has verified the
   * declaration */
  private brokerHost(): BrokerHost {
    return {
      defaultAgentTool: (projectId) => this.host.defaultToolFor(projectId),
      runAgent: (req, ctx) => this.host.runAppAgent(req, ctx),
      hostData: (name, app) => this.host.appHostData(name, app),
      agentLabel: (tool) => this.host.adapters.get(tool)?.descriptor.label ?? tool,
      askCapability: (q, signal) => this.host.askCapability(q, signal),
      agentRunEnded: (run) => this.host.agentRunEnded(run),
    }
  }
  useExternalApps(rt: ExternalApps, opts?: Omit<NonNullable<ConstructorParameters<typeof SessionAppsHub>[1]>, 'onDemand'>): void {
    this.appAccess?.dispose()
    this.appsHub?.dispose()
    /*
     * What a session attached itself (#371 part A) is counted by the hub on every count, through this
     * port — the hub keeps no copy, so the person's sharing switch and consent are read fresh each time.
     */
    const settings = this.host.store.settings
    this.appsHub = new SessionAppsHub(rt, {
      ...opts,
      // The names a session has seen stay with their apps for its life (#1141), kept with the session
      names: {
        load: (id) => {
          const raw = parseJson(settings.appSetting(`${APP_NAMES_PREFIX}${id}`))
          return isObj(raw) ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')) : {}
        },
        save: (id, names) => settings.setAppSetting(`${APP_NAMES_PREFIX}${id}`, JSON.stringify(names)),
      },
      projectName: (id) => this.host.store.projects.listProjects().find((p) => p.id === id)?.name,
      onDemand: {
        attached: (id) => this.appAccess?.attached(id) ?? [],
        /*
         * Only while the session holds the reader set (#382): attach_app and detach_app are part of it, so a
         * session the person turned the set off for (or that became a manager) would keep tools it can no
         * longer detach. The records stay; they count again once the set is back. The orchestrator holds them
         * as commands (#1205), for the root apps it attaches.
         */
        allowed: (session, app) => {
          const profile = this.host.toolProfileOf(session.id)
          return (profile === 'reader' || (profile === 'orchestrator' && session.kind === 'orchestrator')) && (this.appAccess?.allowed(session, app) ?? false)
        },
      },
    })
    this.appAccess = new AppAccess({
      boundaryOpen: (id, boundary) => this.host.autoBoundaryOpen(id, boundary),
      hub: this.appsHub,
      store: this.host.store,
      session: (id) => {
        const m = this.host.meta.get(id)
        if (!m || this.isAppAgentSession(m)) return null
        return { id: m.id, kind: m.kind, projectId: m.projectId, builderOf: this.host.builderRefOf(m) }
      },
      projects: () => this.host.store.projects.listProjects().map((p) => ({ id: p.id, name: p.name, trusted: p.trusted })),
      ensureAccess: (id, to, what, signal) => this.host.ensureProjectAccess(id, to, 'apps', what, signal),
      attachedChanged: (id) => this.sessionAppsChanged(id),
      ...(opts?.toolListWaitMs !== undefined ? { toolListWaitMs: opts.toolListWaitMs } : {}),
    })
    /*
     * Progress text sent by a session's app call (M4 D) — a line like "waiting on the person to
     * approve in session X" is attached as running output to that call's tool card
     * (`tool_output_delta`: a display-only chunk, never recorded). While an agent an app asked for is
     * waiting on the person, the calling session's card otherwise says nothing but "still running".
     */
    this.appsHub.onCallProgress((p) => {
      if (this.host.meta.has(p.sessionId)) this.host.onEvent({ type: 'tool_output_delta', sessionId: p.sessionId, callId: p.callId, text: `${p.message}\n` })
    })
    // The session's share of the broker's body (M4 D) — the runtime knows nothing about sessions, so this is
    // filled in here
    rt.attachBrokerHost(this.brokerHost())
    // Migrates a previously approved MCP server into an app (A-7) — this runs before any session comes up, so
    // the orchestrator has it from the very start
    this.host.migrateApprovedMcpServers(rt)
  }

  /**
   * The list of app tools and calls a bridge makes (M4 A-5, the Codex path). Answered by whatever is
   * attached to **the session's currently living handle** — decision 4, the caller (that session), and
   * the record all pass through the exact same place as Claude's in-process path.
   */
  /**
   * Whether a session can use one app's tools right now (#308, `apps.reach`) — asked when an item from
   * that app's view is dropped on the session's composer. Decision 4 with the session as `appsFor`
   * sees it (a session stood up by an app gets none), and what its live agent actually has.
   */
  appReach(sessionId: string, ref: AppRef): AppReach {
    const m = this.host.sessionOf(sessionId)
    if (!this.appsHub) return { reachable: false, reason: 'unavailable' }
    const key = this.isAppAgentSession(m) ? null : { id: m.id, kind: m.kind, projectId: m.projectId, builderOf: this.host.builderRefOf(m) }
    return this.appsHub.reach(key, ref, this.host.handles.get(sessionId))
  }

  async appSessionTools(sessionId: string, server: string): Promise<Record<string, unknown>[]> {
    return (await this.requireAppsHub().forSession(sessionId).tools(server)) as Record<string, unknown>[]
  }

  async callAppForSession(sessionId: string, server: string, name: string, args: Record<string, unknown>, waitMs?: number) {
    return this.requireAppsHub().forSession(sessionId).call(server, name, args, { waitMs })
  }

  /** The hub for a session's app attachments — an inline app view (M4 B-1) listens to a session's app calls
   * here. null if there is no runtime */
  sessionAppsHub(): SessionAppsHub | null {
    return this.appsHub
  }

  /**
   * An inline app view's event (M4 B-1). This event is produced by the host (inline-views.ts), not an
   * adapter, but goes through the same path — recorded (open and rejected only, with no body) and
   * broadcast. An event for a deleted session is dropped.
   */
  recordAppView(e: Extract<NormalizedEvent, { type: 'app_view' }>): void {
    if (!this.host.meta.has(e.sessionId)) return
    this.host.onEvent(e)
  }

  /**
   * A session attached or detached an app itself (#371 part A). Claude follows its set live, so the
   * tools are there now. A Codex thread keeps the servers it started with (`appAttachment`), so it is
   * restarted through resume: when the turn ends if it is in one (the tool call that asked is), at once
   * otherwise. Every call is checked against the current set either way, so a detached app's name
   * that lingers in the thread until then is refused.
   */
  sessionAppsChanged(sessionId: string): 'now' | 'next_turn' {
    this.appsHub?.sessionAppsChanged(sessionId)
    const handle = this.host.handles.get(sessionId)
    if (!handle) return 'next_turn'
    // Claude takes the new tools at once, and a changed tool list is a changed prompt (§6.1)
    if (!handle.appAttachment) {
      this.host.cacheLedger.note(sessionId, 'instructions')
      return 'now'
    }
    const m = this.host.meta.get(sessionId)
    if (m && inTurn(m.state)) {
      this.host.restartPolicy.restartAfterTurn.add(sessionId)
      this.host.restartPolicy.appsRestartAfterTurn.add(sessionId)
    } else {
      void this.host.restartSession(sessionId, 'thread_restart').catch(() => {})
    }
    return 'next_turn'
  }

  /**
   * The line an orchestrator reads once, on its first turn since #1205, when it had root apps attached before: its earlier
   * turns used `mcp__app-<id>__*` names that are gone now, and nothing else tells it why. Asked on every turn delivered;
   * the first one for an orchestrator marks it (`ROOT_APPS_NOTICE_PREFIX`), whether or not there was anything to say,
   * so a new orchestrator, or one that attaches a root app later, never reads it. "Had root apps" is read from the names
   * it has seen (`session_app_names:<id>`, #1141): a project's key there, for an orchestrator, was a root app given to
   * it, unless it is attached now (one carried through an adoption, `UserAppAdoptionRecords.carry`).
   */
  rootAppsNotice(sessionId: string): string | null {
    const m = this.host.meta.get(sessionId)
    if (!m || m.kind !== 'orchestrator') return null
    const settings = this.host.store.settings
    const key = `${ROOT_APPS_NOTICE_PREFIX}${sessionId}`
    if (settings.appSetting(key) !== null) return null
    settings.setAppSetting(key, '1')
    const book = parseJson(settings.appSetting(`${APP_NAMES_PREFIX}${sessionId}`))
    if (!isObj(book)) return null
    const attached = new Set((this.appAccess?.attached(sessionId) ?? []).map((x) => appKeyOf(x.ref.projectId, x.ref.appId)))
    const hadRootApp = Object.keys(book).some((k) => !k.startsWith(`${USER_APP_SCOPE}/`) && !attached.has(k))
    return hadRootApp ? ROOT_APPS_NOTICE : null
  }

  /**
   * Shares a project app with the person's other projects, or stops (#371 part A, `apps.setShared`).
   * Stored beside the person's other settings; the runtime reads it into the app list, and turning it
   * off detaches the app from every session that attached it (the hub's count asks again).
   */
  setAppShared(ref: { projectId: string; appId: string }, shared: boolean): void {
    const rt = this.requireAppsHub().rt
    if (!rt.list().some((a) => a.projectId === ref.projectId && a.appId === ref.appId)) {
      throw rpcError(`No such app: ${ref.appId}`)
    }
    writeShared(this.host.store.settings, ref, shared)
    rt.sharingChanged()
  }

  requireAppAccess(): AppAccess {
    if (!this.appAccess) throw rpcError('External apps are unavailable')
    return this.appAccess
  }

  requireAppsHub(): SessionAppsHub {
    if (!this.appsHub) throw rpcError('External apps are unavailable')
    return this.appsHub
  }

  /** App attachment for a single handle — passed to the adapter, and closed together whenever the adapter
   * that owns it closes */
  appsFor(m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>): SessionApps | undefined {
    /*
     * No app is ever attached to an agent session stood up at an app's request (M4 D-1) — not even on
     * resume (a person continuing the conversation after it finished). Attaching one would let that
     * session's agent call a project's own apps. That would let apps not even in `uses.apps` become
     * reachable through the agent (the agent carries an app's own declaration past its boundary), and
     * a called app asking for another agent would form a loop that sits entirely outside the chain (the
     * depth limit only counts a chain of app-to-app calls). The agent here only ever unpacks a single
     * piece of text the app handed it.
     */
    if (this.isAppAgentSession(m)) return undefined
    // A builder session receives its own app (C-3) — a user-folder app only ever goes to the orchestrator
    // under decision 4, so it is added here
    return this.appsHub?.attach({ id: m.id, kind: m.kind, projectId: m.projectId, builderOf: this.host.builderRefOf(m) }) ?? undefined
  }

  /** Is this an agent session stood up at an external app's request (M4 D-1; `isAppAgent` in tool-profiles.ts) */
  isAppAgentSession(m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>): boolean {
    return isAppAgent({ kind: m.kind, appId: m.appId ?? null, builder: this.host.builderRefOf(m) !== null })
  }
}

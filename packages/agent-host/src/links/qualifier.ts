import { ApprovalDetail, isUnknownCard } from '@cc/protocol'
import { qualify } from './machine-ids.js'
import { isObj, type Obj } from '../json-value.js'

/**
 * Rewrites what one linked machine says into the hub's terms, and the hub's terms back into the
 * machine's (docs/plans/remote-hub.md §3.3).
 *
 * Outbound (`out`): every id the remote hands over gets the machine's prefix, so the UI holds ids
 * that can only mean that machine. Inbound (`strip`): an id the UI sends to the remote must carry
 * this machine's prefix, and loses it. An id of another machine (or of the hub) is refused rather
 * than passed on: a remote host has no use for a stranger's id, and a call that mixes two machines
 * (a consent from one machine's project to another's)
 * is something phase 1 does not do.
 *
 * Results are rewritten structurally, field by field, from the shapes in `@cc/protocol`. Anything
 * the rewrite does not name passes as it is: a newer remote's extra field reaches the UI, which
 * reads it tolerantly (#339). Values are read as `unknown` on purpose: the remote is another build,
 * and the UI parses the result again through the method's schema.
 */

export class CrossMachineError extends Error {
  readonly code = 'internal'
  constructor(what: string, machine: string) {
    super(`${what} belongs to another machine than ${machine}; one call reaches one machine`)
  }
}

export class Qualifier {
  constructor(
    readonly machine: string,
    /** The machine's number for folding numeric ids (`encodeNumber`), from the registry */
    readonly slot: number,
    /**
     * The hub's session a session of this machine is a child of (#1038), by the session's hub-side id: start_agent with
     * a machine starts it there with no parent the machine knows, and the hub keeps who started it. Its rows and owner
     * events then name that session as `askedBy`, so the sidebar hangs it under its parent as it does a local child.
     */
    private readonly ownerOf?: (sessionId: string) => string | undefined,
  ) {}

  private readonly prefix = (): string => `${this.machine}.`

  /**
   * This machine's approval cards the hub could not read (#844), by the machine's own session id and the request id.
   * The hub's windows show such a card as a fallback with allow and deny only, but a window from before #844 still
   * offers "always", and the machine would keep it for a kind it knows (a project consent, an agent start). So the hub
   * refuses "always" for these (`LinkedMachine.call`): nobody can grant for good what was never shown in full here.
   * Seen on the card's event and on a session row that carries it; an answered card leaves.
   */
  private readonly unread = new Set<string>()

  private noteCard(sessionId: unknown, requestId: unknown, detail: unknown): void {
    if (typeof sessionId !== 'string' || typeof requestId !== 'string') return
    if (isUnknownCard(ApprovalDetail.parse(detail))) this.unread.add(`${sessionId}\u0000${requestId}`)
  }

  /** Whether the hub read this card of the machine (in the machine's own ids) as a fallback */
  unreadCard(sessionId: unknown, requestId: unknown): boolean {
    return typeof sessionId === 'string' && typeof requestId === 'string' && this.unread.has(`${sessionId}\u0000${requestId}`)
  }

  /** An id of this machine as the hub's UI sees it */
  id(value: string): string {
    return qualify(this.machine, value)
  }

  /** The same for a value that may be absent or null, which stays so */
  maybeId<T>(value: T): T | string {
    return typeof value === 'string' ? this.id(value) : value
  }

  /** Whether a hub-side id names this machine */
  owns(value: unknown): boolean {
    return typeof value === 'string' && value.startsWith(this.prefix())
  }

  /** A hub-side id back to the remote's own. Refuses an id of another machine */
  strip(value: unknown, what: string): string {
    if (typeof value !== 'string' || !this.owns(value)) throw new CrossMachineError(what, this.machine)
    return value.slice(this.prefix().length)
  }

  /** The same for a value that may be null or absent, which stays so */
  stripMaybe(value: unknown, what: string): unknown {
    return value === null || value === undefined ? value : this.strip(value, what)
  }

  // ── Results ─────────────────────────────────────────────────────────────────────────────

  /** `SessionInfo` (and `UpdateSettingsResult`, which extends it) */
  session(s: unknown): unknown {
    if (!isObj(s)) return s
    if (isObj(s.pendingApproval)) this.noteCard(s.id, s.pendingApproval.requestId, s.pendingApproval.detail)
    const id = this.maybeId(s.id)
    const owner = typeof id === 'string' ? this.ownerOf?.(id) : undefined
    return {
      ...s,
      id,
      projectId: this.maybeId(s.projectId),
      parentSessionId: this.maybeId(s.parentSessionId),
      ...(owner ? { askedBy: owner } : 'askedBy' in s ? { askedBy: this.maybeId(s.askedBy) } : {}),
      scopeSessionIds: Array.isArray(s.scopeSessionIds) ? s.scopeSessionIds.map((x) => this.maybeId(x)) : s.scopeSessionIds,
      machine: this.machine,
    }
  }

  sessions(list: unknown): unknown {
    return Array.isArray(list) ? list.map((s) => this.session(s)) : list
  }

  /** `{ session, resumed, reason?, ... }` from restart, resume and fork */
  sessionResult(r: unknown): unknown {
    return isObj(r) ? { ...r, session: this.session(r.session) } : r
  }

  /** `ProjectInfo` */
  project(p: unknown): unknown {
    if (!isObj(p)) return p
    const manager = p.worktreeManager
    return {
      ...p,
      id: this.maybeId(p.id),
      worktreeManager: isObj(manager) ? { ...manager, sessionId: this.maybeId(manager.sessionId) } : manager,
      machine: this.machine,
    }
  }

  projects(list: unknown): unknown {
    return Array.isArray(list) ? list.map((p) => this.project(p)) : list
  }

  /** `TerminalInfo` */
  terminal(t: unknown): unknown {
    return isObj(t) ? { ...t, terminalId: this.maybeId(t.terminalId) } : t
  }

  /** `CommandRunInfo` — its run id rides the terminal frame lane in place of a terminal id */
  run(r: unknown): unknown {
    return isObj(r) ? { ...r, runId: this.maybeId(r.runId) } : r
  }

  /** `StoredMessage`: its session, and the ids its payload names (#371's asked-by line, a handoff, an app's text) */
  message(m: unknown): unknown {
    if (!isObj(m)) return m
    return { ...m, sessionId: this.maybeId(m.sessionId), payload: this.payload(m.payload) }
  }

  messages(list: unknown): unknown {
    return Array.isArray(list) ? list.map((m) => this.message(m)) : list
  }

  private payload(p: unknown): unknown {
    if (!isObj(p)) return p
    const out: Obj = { ...p }
    // A stored event keeps the event's own fields, its session among them
    if (typeof p.sessionId === 'string') out.sessionId = this.id(p.sessionId)
    if (isObj(p.from) && typeof p.from.sessionId === 'string') out.from = { ...p.from, sessionId: this.id(p.from.sessionId) }
    if (typeof p.fromSessionId === 'string') out.fromSessionId = this.id(p.fromSessionId)
    if (isObj(p.fromApp)) out.fromApp = { ...p.fromApp, projectId: this.maybeId(p.fromApp.projectId) }
    if ('projectId' in p) out.projectId = this.maybeId(p.projectId)
    // A stored `app_view` open: the window reads only that a view stood there, but the id stays in the hub's terms
    if (typeof p.instanceId === 'string') out.instanceId = this.id(p.instanceId)
    if (isObj(p.detail)) out.detail = this.approvalDetail(p.detail)
    return out
  }

  /** `ApprovalDetail`: the kinds that name a project */
  approvalDetail(d: unknown): unknown {
    if (!isObj(d)) return d
    if (d.kind === 'capability' && isObj(d.app)) return { ...d, app: { ...d.app, projectId: this.maybeId(d.app.projectId) } }
    if (d.kind === 'project_access') {
      const side = (x: unknown) => (isObj(x) ? { ...x, id: this.maybeId(x.id) } : x)
      return { ...d, from: side(d.from), to: side(d.to) }
    }
    // Starting an agent (#561) names the caller's own project
    if (d.kind === 'agent_start' && isObj(d.project)) return { ...d, project: { ...d.project, id: this.maybeId(d.project.id) } }
    return d
  }

  /** `TrashedSession` */
  trashed(t: unknown): unknown {
    if (!isObj(t)) return t
    return {
      ...t,
      id: this.maybeId(t.id),
      project: isObj(t.project) ? { ...t.project, id: this.maybeId(t.project.id) } : t.project,
      machine: this.machine,
    }
  }

  /** `TrashedRun` (#378): its app's project is this machine's, and the record is read and deleted here */
  trashedRun(t: unknown): unknown {
    if (!isObj(t)) return t
    return { ...t, app: isObj(t.app) ? { ...t.app, projectId: this.maybeId(t.app.projectId) } : t.app, machine: this.machine }
  }

  /** `SubagentStepsHeld` and `TrashedSubagentSteps` (#418) */
  subagentSteps(t: unknown): unknown {
    if (!isObj(t)) return t
    return {
      ...t,
      sessionId: this.maybeId(t.sessionId),
      project: isObj(t.project) ? { ...t.project, id: this.maybeId(t.project.id) } : t.project,
      machine: this.machine,
    }
  }

  /** `ExternalAppInfo`: a project app is that project's; a user-folder app says which machine's folder */
  app(a: unknown): unknown {
    return isObj(a) ? { ...a, projectId: this.maybeId(a.projectId), machine: this.machine } : a
  }

  /** `ProjectConsent` */
  consent(c: unknown): unknown {
    return isObj(c) ? { ...c, fromProjectId: this.maybeId(c.fromProjectId), toProjectId: this.maybeId(c.toProjectId), machine: this.machine } : c
  }

  /** One `approvals.rules` row: its numeric id folded (`encodeNumber`), its owner qualified */
  rule(r: unknown, encode: (n: number) => number): unknown {
    if (!isObj(r)) return r
    return {
      ...r,
      id: typeof r.id === 'number' ? encode(r.id) : r.id,
      projectId: this.maybeId(r.projectId),
      sessionId: this.maybeId(r.sessionId),
      machine: this.machine,
    }
  }

  /** `messages.search` hits */
  hits(list: unknown): unknown {
    return Array.isArray(list) ? list.map((h) => (isObj(h) ? { ...h, sessionId: this.maybeId(h.sessionId) } : h)) : list
  }

  /**
   * `apps.inlineViews` rows and the `apps.inlineReopen` answer. The view instance is qualified like any id: the window
   * hands it back to open, call and close the view, and the hub routes those by it (plan §11)
   */
  inlineView(v: unknown): unknown {
    return isObj(v) ? { ...v, projectId: this.maybeId(v.projectId), instanceId: this.maybeId(v.instanceId) } : v
  }

  /** An `apps.runs` row: its app's project, the session that called it, and the agent session it stood up (the panel links to it) */
  appRun(r: unknown): unknown {
    return isObj(r)
      ? { ...r, projectId: this.maybeId(r.projectId), callerSessionId: this.maybeId(r.callerSessionId), sessionId: this.maybeId(r.sessionId) }
      : r
  }

  /**
   * The `agents.listExternalSessions` answer. `externalId` is the tool's own id for the conversation, so it stays as it is;
   * `importedAs` is the id of the Centralu session already open for it, which the window focuses (#701)
   */
  externalSessions(r: unknown): unknown {
    if (!isObj(r) || !Array.isArray(r.sessions)) return r
    return { ...r, sessions: r.sessions.map((s) => (isObj(s) ? { ...s, importedAs: this.maybeId(s.importedAs) } : s)) }
  }

  /**
   * The `apps.errors` answer: the app a declined request named is compared with the app on screen, whose project is
   * qualified, to decide which of the two wordings applies. `runId` is a run's own id and stays as `apps.runs` leaves it
   */
  errorBundles(r: unknown): unknown {
    if (!isObj(r)) return r
    const bundle = (b: unknown): unknown =>
      isObj(b) && isObj(b.denied) ? { ...b, denied: { ...b.denied, projectId: this.maybeId(b.denied.projectId) } } : b
    return { ...r, latest: bundle(r.latest), recent: Array.isArray(r.recent) ? r.recent.map(bundle) : r.recent }
  }

  /** The `apps.openView` answer: the pinned view's instance */
  openedView(v: unknown): unknown {
    return isObj(v) ? { ...v, instanceId: this.maybeId(v.instanceId) } : v
  }

  /** The `apps.viewDocument` answer: the app it names (a user-folder app's null project stays null) */
  viewDocument(d: unknown): unknown {
    return isObj(d) ? { ...d, projectId: this.maybeId(d.projectId) } : d
  }

  // ── Events ──────────────────────────────────────────────────────────────────────────────

  /**
   * One event of this machine in the hub's terms, or null for one the hub does not pass on.
   *
   * Dropped: what is about the remote host itself rather than its sessions and projects. The hub
   * has its own update, themes, preferences, agent CLIs and screen questions (and a host of v0.1.0-beta.10 or
   * before still sends `app_state_changed` for its control app), and an app-wide
   * error from another machine is not this UI's to show (§5). An event of a type this build does
   * not know is passed when it names a session (qualified), dropped otherwise.
   */
  event(e: unknown): Obj | null {
    if (!isObj(e) || typeof e.type !== 'string') return null
    const sid = typeof e.sessionId === 'string' ? this.id(e.sessionId) : undefined
    const base: Obj = { ...e, ...(sid !== undefined ? { sessionId: sid } : {}) }
    switch (e.type) {
      // Another machine's agent asking its own windows to apply (#665) must never relaunch the hub's window
      case 'update_status':
      case 'update_apply_request':
      case 'update_apply_go':
      case 'themes_changed':
      case 'prefs_changed':
      case 'app_state_changed':
      case 'agent_versions':
      case 'mail_changed':
      case 'external_app_questions_changed':
      case 'orchestrator_proposals_changed':
        return null
      case 'error':
        return sid === undefined ? null : base
      case 'session_created':
        return { ...base, session: this.session(e.session) }
      case 'user_message': {
        const out = { ...base }
        if (isObj(e.from) && typeof e.from.sessionId === 'string') out.from = { ...e.from, sessionId: this.id(e.from.sessionId) }
        if (isObj(e.fromApp)) out.fromApp = { ...e.fromApp, projectId: this.maybeId(e.fromApp.projectId) }
        return out
      }
      case 'handoff':
        return { ...base, fromSessionId: this.maybeId(e.fromSessionId) }
      case 'session_owner':
        return { ...base, askedBy: (sid !== undefined ? this.ownerOf?.(sid) : undefined) ?? this.maybeId(e.askedBy), parentSessionId: this.maybeId(e.parentSessionId) }
      case 'approval_request':
        this.noteCard(e.sessionId, e.requestId, e.detail)
        return { ...base, detail: this.approvalDetail(e.detail) }
      case 'approval_resolved':
        if (typeof e.sessionId === 'string' && typeof e.requestId === 'string') this.unread.delete(`${e.sessionId}\u0000${e.requestId}`)
        return base
      // The view's instance, which the window opens, calls and closes it by (plan §11)
      case 'app_view':
        return { ...base, projectId: this.maybeId(e.projectId), instanceId: this.maybeId(e.instanceId) }
      // The view whose own call caused it, so that view does not re-read what it already has (B-5)
      case 'external_app_state_changed':
        return {
          ...base,
          projectId: this.maybeId(e.projectId),
          ...(isObj(e.cause) ? { cause: { ...e.cause, instanceId: this.maybeId(e.cause.instanceId) } } : {}),
        }
      case 'external_app_runs_changed':
      case 'fs_changed':
        return { ...base, projectId: this.maybeId(e.projectId) }
      // `projects_changed`: a project another machine made (#515); the hub's windows re-read the merged list
      case 'external_apps_changed':
      case 'project_consents_changed':
        return base
      // `added` (#1220): a project that machine's orchestrator added, named as the hub's windows know it
      case 'projects_changed':
        return typeof e.added === 'string' ? { ...base, added: this.maybeId(e.added) } : base
      default:
        return sid === undefined ? null : base
    }
  }
}

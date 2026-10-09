import { qualify } from './machine-ids.js'

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

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

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
  ) {}

  private readonly prefix = (): string => `${this.machine}.`

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
    return {
      ...s,
      id: this.maybeId(s.id),
      projectId: this.maybeId(s.projectId),
      parentSessionId: this.maybeId(s.parentSessionId),
      ...('askedBy' in s ? { askedBy: this.maybeId(s.askedBy) } : {}),
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

  /** `ApprovalDetail`: the two kinds that name a project */
  approvalDetail(d: unknown): unknown {
    if (!isObj(d)) return d
    if (d.kind === 'capability' && isObj(d.app)) return { ...d, app: { ...d.app, projectId: this.maybeId(d.app.projectId) } }
    if (d.kind === 'project_access') {
      const side = (x: unknown) => (isObj(x) ? { ...x, id: this.maybeId(x.id) } : x)
      return { ...d, from: side(d.from), to: side(d.to) }
    }
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
   * has its own update, themes, agent CLIs and screen questions (and a host of v0.1.0-beta.10 or
   * before still sends `app_state_changed` for its control app), and an app-wide
   * error from another machine is not this UI's to show (§5). An event of a type this build does
   * not know is passed when it names a session (qualified), dropped otherwise.
   */
  event(e: unknown): Obj | null {
    if (!isObj(e) || typeof e.type !== 'string') return null
    const sid = typeof e.sessionId === 'string' ? this.id(e.sessionId) : undefined
    const base: Obj = { ...e, ...(sid !== undefined ? { sessionId: sid } : {}) }
    switch (e.type) {
      case 'update_status':
      case 'themes_changed':
      case 'app_state_changed':
      case 'agent_versions':
      case 'external_app_questions_changed':
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
      case 'approval_request':
        return { ...base, detail: this.approvalDetail(e.detail) }
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
      case 'external_apps_changed':
      case 'project_consents_changed':
        return base
      default:
        return sid === undefined ? null : base
    }
  }
}

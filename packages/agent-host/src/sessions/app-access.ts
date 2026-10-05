import type { ExternalAppInfo } from '@cc/protocol'
import { appMcpServerName } from '../apps/contract.js'
import type { AppRef } from '../apps/external/runtime.js'
import type { AppSessionKey, OnDemandApps, SessionAppsHub } from './session-apps.js'

/**
 * Another project's app tools, on demand (#371 part A) — `find_apps`, `attach_app` and `detach_app`.
 *
 * Decision 4 (apps.md §9.1) gives a project's session its own project's apps and nothing else. The
 * owner's decision for #371 keeps that, and lets a session reach further **only while it needs to**:
 * it searches the apps it could attach, attaches one (its tools join this session), and detaches it
 * (they leave). An app that is not attached costs no context.
 *
 * What may be attached, decided here and asked again on every count of a session's apps:
 *
 *   a project app of another project   only if the person shares it (`apps.setShared`, off by default),
 *                                      and only once the person allowed this pair of projects (the
 *                                      consent card, `ensureProjectAccess`, shared with part B)
 *   a user-folder app                  always: the person put it in their own folder for use across
 *                                      projects, so it needs neither a share switch nor a card
 *   from an untrusted project          nothing: its repository's text could be the one asking, and an
 *                                      untrusted project runs none of its own apps either
 *
 * The attachment is kept per session in the store's settings table (a JSON list under one key), so
 * it survives a host restart and the session's resume, and lasts until `detach_app` or the session
 * is deleted. Nothing about the app changes: it runs where it lives (its own folder, its own data),
 * and every call goes through the runtime's one path with the calling session recorded (§5).
 *
 * This module knows the runtime only through the hub (`host-core-blind-to-apps`).
 */

/** One app a session attached itself — kept in the store, so it outlives the host process */
type Record_ = {
  projectId: string | null
  appId: string
  /** The server name chosen when it was attached (`app-<id>`, or `app-<id>-2` if that was taken) — fixed for the session */
  server: string
  /** How the pair of projects was allowed: 'always' leans on the remembered consent, 'once' on this attachment alone */
  consent: 'always' | 'once' | 'none'
  at: number
}

/** The part of the store this module uses — the generic settings table and part B's consent rows */
export type AppAccessStore = {
  appSetting(key: string): string | null
  setAppSetting(key: string, value: string): void
  deleteAppSetting(key: string): void
  getProjectConsent(from: string, to: string, kind: 'apps'): unknown
}

export type AppAccessDeps = {
  hub: SessionAppsHub
  store: AppAccessStore
  /** The session as decision 4 sees it, or null for one that gets no apps at all (a session an app stood up) */
  session(sessionId: string): AppSessionKey | null
  projects(): readonly { id: string; name: string; trusted: boolean }[]
  /**
   * Asks the person for this pair of projects, unless an "always" is remembered (part B's
   * `ensureProjectAccess`): the consent card in the calling session, Allow once / Always / Deny.
   */
  ensureAccess(
    sessionId: string,
    toProjectId: string,
    what: { text: string; app: { appId: string; name: string } },
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }>
  /**
   * The session's set changed — the manager recounts its live handle and says when the agent has the
   * tools: `now` (Claude follows the set live) or `next_turn` (a Codex thread keeps the servers it
   * started with, so the manager restarts it through resume once the turn ends).
   */
  attachedChanged(sessionId: string): 'now' | 'next_turn'
  /** How long to wait for an app's tool list when it is attached (the hub's own cap by default) */
  toolListWaitMs?: number
}

/** One app `find_apps` offers */
export type FoundApp = {
  /** What `attach_app` takes: `<project name>/<app id>` for a project app, `<app id>` for a user-folder app */
  ref: string
  name: string
  /** The project it lives in, or null for the person's own folder */
  project: string | null
  description: string
  /** The tool names the agent would get, if the app has listed them since the host started (finding starts no app) */
  tools: string[] | null
}

export type AttachOutcome =
  | { ok: true; server: string; tools: string[]; when: 'now' | 'next_turn'; already?: boolean }
  | { ok: false; error: string }

export type DetachOutcome = { ok: true; server: string; when: 'now' | 'next_turn' } | { ok: false; error: string }

const KEY = (sessionId: string) => `session_apps:${sessionId}`
const SHARED_KEY = (ref: { projectId: string; appId: string }) => `app_shared:${ref.projectId}/${ref.appId}`
const UNUSABLE = new Set(['invalid', 'untrusted', 'unconfirmed', 'failed'])
const TOOL_LIST_WAIT_MS = 15_000

/** Whether the person shares this project app with their other projects (#371 part A) — the runtime's `shared` dep reads this */
export function readShared(store: Pick<AppAccessStore, 'appSetting'>, ref: AppRef): boolean {
  return ref.projectId !== null && store.appSetting(SHARED_KEY({ projectId: ref.projectId, appId: ref.appId })) === '1'
}

export function writeShared(store: Pick<AppAccessStore, 'setAppSetting' | 'deleteAppSetting'>, ref: { projectId: string; appId: string }, shared: boolean): void {
  if (shared) store.setAppSetting(SHARED_KEY(ref), '1')
  else store.deleteAppSetting(SHARED_KEY(ref))
}

export class AppAccess implements OnDemandApps {
  /** session id → its attachments, read from the store once and written through */
  private cache = new Map<string, Record_[]>()
  private stopGone: () => void

  constructor(private deps: AppAccessDeps) {
    // A deleted session's attachments go with it — an asleep one keeps them (it attaches them again when it wakes)
    this.stopGone = deps.hub.onSessionGone((id) => this.forget(id))
  }

  // ── OnDemandApps (the hub asks these on every count) ──

  attached(sessionId: string): readonly { ref: AppRef; server: string }[] {
    return this.records(sessionId).map((r) => ({ ref: { projectId: r.projectId, appId: r.appId }, server: r.server }))
  }

  allowed(session: AppSessionKey, app: ExternalAppInfo): boolean {
    const from = session.projectId
    if (from === null || !this.projectTrusted(from)) return false
    if (app.projectId === null) return true
    if (app.projectId === from || app.shared !== true) return false
    const r = this.records(session.id).find((x) => x.appId === app.appId && x.projectId === app.projectId)
    if (!r) return false
    // "Once" was this attachment's own answer; "always" holds only while the person keeps it (revoking detaches)
    return r.consent === 'once' || !!this.deps.store.getProjectConsent(from, app.projectId, 'apps')
  }

  // ── The three tools ──

  find(sessionId: string, query?: string): { ok: true; apps: FoundApp[] } | { ok: false; error: string } {
    const gate = this.gate(sessionId)
    if (!gate.ok) return gate
    const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const apps = this.candidates(gate.session)
      .map((a) => this.describe(a))
      .filter((f) => {
        const hay = [f.ref, f.name, f.project ?? '', f.description, ...(f.tools ?? [])].join(' ').toLowerCase()
        return words.every((w) => hay.includes(w))
      })
    return { ok: true, apps }
  }

  async attach(sessionId: string, ref: string, signal?: AbortSignal): Promise<AttachOutcome> {
    const gate = this.gate(sessionId)
    if (!gate.ok) return gate
    const { session } = gate
    const already = this.deps.hub.refsFor(session)
    const named = this.resolve(ref)
    if (!named.ok) return named
    const app = named.app
    const target: AppRef = { projectId: app.projectId, appId: app.appId }
    const has = already.find((h) => h.ref.appId === target.appId && h.ref.projectId === target.projectId)
    if (has) return { ok: true, server: has.server, tools: await this.toolNames(target), when: 'now', already: true }
    if (!this.candidates(session).some((a) => a.appId === app.appId && a.projectId === app.projectId)) {
      return { ok: false, error: this.whyNot(session, app) }
    }

    let consent: Record_['consent'] = 'none'
    if (app.projectId !== null) {
      const res = await this.deps.ensureAccess(
        sessionId,
        app.projectId,
        { text: `use its app ${app.name ?? app.appId}`, app: { appId: app.appId, name: app.name ?? app.appId } },
        signal,
      )
      if (!res.ok) return res
      consent = this.deps.store.getProjectConsent(session.projectId!, app.projectId, 'apps') ? 'always' : 'once'
      // The person may have taken a while: the app could have stopped being shared, or this session gone, meanwhile
      const again = this.gate(sessionId)
      if (!again.ok) return again
      if (!this.candidates(again.session).some((a) => a.appId === app.appId && a.projectId === app.projectId)) {
        return { ok: false, error: this.whyNot(again.session, app) }
      }
    }

    // A record the person's revoked "always" left hidden is replaced, not doubled
    const kept = this.records(sessionId).filter((r) => !(r.appId === app.appId && r.projectId === app.projectId))
    const taken = [...this.deps.hub.refsFor(session).map((h) => h.server), ...kept.map((r) => r.server)]
    const server = this.freeServer(app.appId, taken)
    this.save(sessionId, [...kept, { projectId: app.projectId, appId: app.appId, server, consent, at: Date.now() }])
    const when = this.deps.attachedChanged(sessionId)
    return { ok: true, server, tools: await this.toolNames(target), when }
  }

  detach(sessionId: string, ref: string): DetachOutcome {
    const mine = this.records(sessionId)
    const r = this.match(mine, ref.trim())
    if (!r) {
      const given = this.deps.session(sessionId)
      const own = given ? this.deps.hub.refsFor(given).find((h) => h.server === ref.trim() || h.ref.appId === ref.trim()) : undefined
      return {
        ok: false,
        error: own
          ? `${ref} is one of this session's own apps (its project's or given to it), not one attach_app added — it stays.`
          : `No app attached with attach_app matches ${JSON.stringify(ref)}. Attached: ${mine.map((x) => this.refOf(x)).join(', ') || 'none'}.`,
      }
    }
    this.save(
      sessionId,
      mine.filter((x) => x !== r),
    )
    return { ok: true, server: r.server, when: this.deps.attachedChanged(sessionId) }
  }

  /** The apps this session attached itself, as `find_apps` names them — for the tool texts */
  attachedRefs(sessionId: string): string[] {
    return this.records(sessionId).map((r) => this.refOf(r))
  }

  dispose(): void {
    this.stopGone()
  }

  // ── Inside ──

  private gate(sessionId: string): { ok: true; session: AppSessionKey } | { ok: false; error: string } {
    const session = this.deps.session(sessionId)
    if (!session) return { ok: false, error: 'This session cannot attach apps.' }
    if (session.projectId === null) return { ok: false, error: 'Only a session in a project can attach apps from other projects.' }
    if (!this.projectTrusted(session.projectId)) {
      return { ok: false, error: "This session's project is not trusted, so it cannot attach apps — the person can trust it from the project menu." }
    }
    return { ok: true, session }
  }

  /** What this session could attach now: shared apps of other trusted projects, and user-folder apps, minus what it has */
  private candidates(session: AppSessionKey): ExternalAppInfo[] {
    const have = this.deps.hub.refsFor(session)
    return this.deps.hub.rt
      .list()
      .filter((a) => !UNUSABLE.has(a.status))
      .filter((a) => a.projectId === null || (a.projectId !== session.projectId && a.shared === true))
      .filter((a) => !have.some((h) => h.ref.appId === a.appId && h.ref.projectId === a.projectId))
      .sort((x, y) => this.refOf(x).localeCompare(this.refOf(y)))
  }

  private whyNot(session: AppSessionKey, app: ExternalAppInfo): string {
    if (app.projectId !== null && app.projectId === session.projectId) return `${this.refOf(app)} is this project's own app; it is attached already when the project is trusted.`
    if (app.status === 'untrusted') return `${this.refOf(app)} is in a project the person has not trusted, so it does not run.`
    if (UNUSABLE.has(app.status)) return `${this.refOf(app)} cannot run now (${app.status}${app.error ? `: ${app.error.split('\n')[0]}` : ''}).`
    if (app.projectId !== null && app.shared !== true) return `${this.refOf(app)} is not shared with other projects. Only the person can share it (Settings → Apps).`
    return `${this.refOf(app)} cannot be attached to this session.`
  }

  private resolve(ref: string): { ok: true; app: ExternalAppInfo } | { ok: false; error: string } {
    const want = ref.trim()
    const all = this.deps.hub.rt.list()
    const slash = want.lastIndexOf('/')
    let app: ExternalAppInfo | undefined
    if (slash === -1) {
      const id = want.startsWith(appMcpServerName('')) && !all.some((a) => a.appId === want) ? want.slice(appMcpServerName('').length) : want
      app = all.find((a) => a.projectId === null && a.appId === id)
    } else {
      const project = want.slice(0, slash).trim()
      const id = want.slice(slash + 1).trim()
      const p = this.deps.projects().find((x) => x.id === project) ?? this.deps.projects().find((x) => x.name === project)
      app = p ? all.find((a) => a.projectId === p.id && a.appId === id) : undefined
    }
    if (!app) return { ok: false, error: `No app named ${JSON.stringify(want)}. Use a name find_apps gave (project/app, or app for your own apps).` }
    return { ok: true, app }
  }

  private match(mine: Record_[], ref: string): Record_ | undefined {
    return mine.find((r) => r.server === ref || this.refOf(r) === ref || (r.projectId !== null && `${r.projectId}/${r.appId}` === ref)) ?? mine.find((r) => r.appId === ref)
  }

  private describe(a: ExternalAppInfo): FoundApp {
    const known = this.deps.hub.rt.knownTools({ projectId: a.projectId, appId: a.appId }, 'model')
    const line = (a.description ?? '').split('\n')[0]!.trim()
    return {
      ref: this.refOf(a),
      name: a.name ?? a.appId,
      project: a.projectId === null ? null : this.projectName(a.projectId),
      description: line.length > 140 ? `${line.slice(0, 139)}…` : line,
      tools: known ? known.map((t) => t.name) : null,
    }
  }

  private refOf(a: { projectId: string | null; appId: string }): string {
    return a.projectId === null ? a.appId : `${this.projectName(a.projectId)}/${a.appId}`
  }

  private projectName(id: string): string {
    return this.deps.projects().find((p) => p.id === id)?.name ?? id
  }

  private projectTrusted(id: string): boolean {
    return this.deps.projects().find((p) => p.id === id)?.trusted === true
  }

  /** `app-<id>`, or the first `app-<id>-<n>` no app of this session uses — the session's own app keeps the plain name */
  private freeServer(appId: string, taken: string[]): string {
    const base = appMcpServerName(appId)
    if (!taken.includes(base)) return base
    for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
  }

  /** The app's agent tools for the tool result — started here if never listed, within the hub's cap; empty on failure */
  private async toolNames(ref: AppRef): Promise<string[]> {
    const known = this.deps.hub.rt.knownTools(ref, 'model')
    if (known) return known.map((t) => t.name)
    let timer: NodeJS.Timeout | undefined
    try {
      const listed = await Promise.race([
        this.deps.hub.rt.tools(ref, 'model'),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), this.deps.toolListWaitMs ?? TOOL_LIST_WAIT_MS))),
      ])
      return listed.map((t) => t.name)
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  private records(sessionId: string): Record_[] {
    let r = this.cache.get(sessionId)
    if (!r) {
      r = parse(this.deps.store.appSetting(KEY(sessionId)))
      this.cache.set(sessionId, r)
    }
    return r
  }

  private save(sessionId: string, list: Record_[]): void {
    this.cache.set(sessionId, list)
    if (list.length === 0) this.deps.store.deleteAppSetting(KEY(sessionId))
    else this.deps.store.setAppSetting(KEY(sessionId), JSON.stringify(list))
  }

  private forget(sessionId: string): void {
    this.cache.delete(sessionId)
    this.deps.store.deleteAppSetting(KEY(sessionId))
  }
}

/** A stored list — anything unreadable is dropped rather than trusted (the row is ours, but a hand edit is possible) */
function parse(raw: string | null): Record_[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter(
      (x): x is Record_ =>
        !!x &&
        typeof x === 'object' &&
        (typeof x.projectId === 'string' || x.projectId === null) &&
        typeof x.appId === 'string' &&
        typeof x.server === 'string' &&
        x.server.startsWith(appMcpServerName('')) &&
        (x.consent === 'always' || x.consent === 'once' || x.consent === 'none'),
    )
  } catch {
    return []
  }
}

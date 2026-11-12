import { z } from 'zod'
import { createListeners } from '@cc/common'
import { APP_SERVER_PREFIX, appKeyOf, appServerName, errorMessage, isAssistantKind, sameApp } from '@cc/protocol'
import type { AppReach, ExternalAppInfo, PermissionPreset, SessionKind } from '@cc/protocol'
import type { AppCallOpts, AppToolResult, AppToolSpec, SessionAppEntry, SessionApps, SessionAppTools } from '../adapters/contract.js'
import { presetAsks, runsUnasked } from '../apps/contract.js'
import { issuesText } from './tool-answers.js'
import type { AppCallOutcome, AppRef, ExternalApps } from '../apps/external/runtime.js'
import { durationText, raceTimeout, withTimeout } from '../timing.js'

/**
 * Attaches external apps to a session (M4 A-5) — **which session gets which app**, and the path
 * a session's agent calls an app through, are both decided once, here.
 *
 * The adapter does not know this decision. It attaches the list it is given in its own way
 * (Claude through an in-process proxy server, Codex through a stdio bridge), and every call goes
 * through `call`. `call` invokes the runtime's single path (`ExternalApps.call`) with the caller
 * `{ kind: 'session' }` — so a call made by an agent passes through the same visibility check,
 * gets the same run id, and is recorded the same way as one made by the UI (A-4, A-6).
 *
 * The one door the core knows about external apps through is `apps/external/runtime.ts`
 * (`host-core-blind-to-apps`). This file uses only that door too.
 */

/**
 * The shape of a session needed to decide which apps to attach — this is the whole of what
 * decision 4 sees. `builderOf` is the app that session is building (M4 C-3): a building session
 * always receives its own app.
 */
export type AppSessionKey = { id: string; kind: SessionKind; projectId: string | null; builderOf?: AppRef | null }

/**
 * The upper bound on how long we wait when an app whose tool list is unknown has to be spun up
 * to find out.
 *
 * The Claude CLI calls `tools/list` for every attached server as it starts a session, and Codex
 * waits for the bridge's `tools/list` as it starts a thread. If an app hangs while starting, the
 * session hangs with it — hence this cap; past it, the app is attached with an empty tool list.
 * If the app comes up later anyway, the list is read again and announced (immediately for
 * Claude, starting from the next thread for Codex). This must be shorter than the runtime's
 * connection cap (30 seconds) so that it is this cap that triggers first.
 */
export const TOOL_LIST_WAIT_MS = 15_000

/**
 * How long the outcome of a call that was already handed back early is kept (A-5, "long-running
 * calls"). An agent normally asks again with `run_status` within a few minutes. Anything older
 * than this is answered from the record (status and reason) only, without the result body.
 */
export const DETACHED_KEEP_MS = 60 * 60_000
/** The number of early-returned calls one session may hold — past this, the oldest finished ones are dropped first */
const DETACHED_PER_SESSION = 50

/**
 * A tool the host adds to every app proxy server (A-5) — to check the status and result of a
 * call that was already handed back early.
 *
 * It only reads (`readOnlyHint`) — so no preset ever asks about it (decision 5). If the app has
 * a tool with the same name, the host's own wins: the path for following up on a long-running
 * call must not differ from app to app.
 */
export const RUN_STATUS_TOOL = 'run_status'
const RUN_STATUS_SPEC: AppToolSpec = {
  name: RUN_STATUS_TOOL,
  title: 'Run status',
  description:
    'If a call to this app took long and you got "still running" with a run id (run_…) first, pass that id here to see its state now and its result once it has finished. Check with this instead of calling the tool again.',
  inputSchema: {
    type: 'object',
    properties: { run_id: { type: 'string', description: 'The run id you got first (it starts with run_)' } },
    required: ['run_id'],
  },
  annotations: { title: 'Run status', readOnlyHint: true, openWorldHint: false },
}

/** One call that was already handed back early — filled in once its outcome arrives */
type Detached = { sessionId: string; server: string; startedAt: number; outcome: AppCallOutcome | null }

/**
 * Card-id joining (M4 B-1) — how long a call start seen by the adapter and a call that came in
 * through the bridge wait for each other. Since both are two paths inside the same host (the
 * adapter's stdout, the bridge's WebSocket), they usually meet within a few ms. If the wait is
 * exceeded, that call simply gets no in-conversation card (the call itself keeps running).
 */
export const CALL_JOIN_WAIT_MS = 5_000
/** How long, and how many, unmatched call starts are kept — past this, the oldest are dropped first */
const NOTED_KEEP_MS = 60_000
const NOTED_MAX = 64

type Noted = { callId: string; server: string; tool: string; args: string; at: number }
type Waiter = { server: string; tool: string; args: string; resolve: (callId: string | null) => void; timer: NodeJS.Timeout }

/**
 * One instance of a session's agent calling an app tool (M4 B-1) — listened to by the
 * in-conversation UI.
 *
 * Announced the moment the call is made (does not wait for the outcome). The UI gets tool-input
 * when the call starts and tool-result when it ends — the order of these two promises follows
 * the order of the protocol.
 */
/** A progress line sent by a session's app call — which conversation, which card, and the one line */
export type SessionAppProgress = { sessionId: string; callId: string; message: string }

export type SessionAppCall = {
  sessionId: string
  ref: AppRef
  server: string
  tool: string
  args: Record<string, unknown>
  /** The conversation's tool-card id — either told to us by the adapter or joined by us. null if it is never found */
  callId: Promise<string | null>
  /** The call's outcome (the real one, even for a call that was already handed back early) */
  outcome: Promise<AppCallOutcome>
}

/**
 * States of an app that cannot be attached to a session (decision 4) — an invalid manifest, an
 * untrusted project, halted after repeated failures, and an imported app the person has not
 * turned on yet (M4 E-3). Even when not attached, the runtime blocks it again on every call (in
 * case the name lingers in a Codex thread).
 */
const UNUSABLE = new Set(['invalid', 'untrusted', 'unconfirmed', 'failed'])

type Hit = { ref: AppRef; server: string }

/**
 * Apps a session attached **itself**, outside decision 4's scope (#371 part A, `attach_app`): a
 * project app another project shares, or a user-folder app attached to a project's session. The
 * hub does not keep them or judge them; it asks this port (sessions/app-access.ts) every time it
 * counts a session's apps, so the answer is never a copy that outlives the person's choice.
 *
 *   attached   what the session attached, with the server name chosen when it did (stable for the
 *              session, so a Codex thread and a later call agree on it)
 *   allowed    whether the session may still use it: the app still shared, the pair of projects still
 *              allowed. Asked again on every count and therefore on every call (`find`), the same
 *              way trust is: turning sharing off takes the tools away from a Claude session at once,
 *              and a Codex thread that still holds the names is refused at the call
 */
export type OnDemandApps = {
  attached(sessionId: string): readonly Hit[]
  allowed(session: AppSessionKey, app: ExternalAppInfo): boolean
}

/**
 * Decision 4's scope, apart from the app's state: whether this session is ever given this app. The
 * assistant gets the user-folder apps, a project's sessions that project's apps (its root app included),
 * and a building session its own app as well (see `refsFor`).
 *
 * Not the root apps for the Assistant (#1205): each one was its own MCP server in every Assistant
 * request, so the list grew with every project the person trusted (#1141 had given them all). It finds and
 * attaches the one it needs (`find_apps` / `attach_app`, sessions/app-access.ts), as a project's session does.
 * The user-folder apps stay: an MCP server the person approved for the Assistant is one (A-7), and it is
 * promised from the start.
 */
function givesApp(session: AppSessionKey, app: Pick<ExternalAppInfo, 'appId' | 'projectId'>): boolean {
  return (
    (isAssistantKind(session.kind) ? app.projectId === null : session.projectId !== null && app.projectId === session.projectId) ||
    (session.builderOf != null && sameApp(session.builderOf, app))
  )
}

/**
 * Where the names a session has seen are kept (#1141): app key → server name, per session. A name a session's agent has
 * called (and a Codex thread keeps for its life) must never come to mean another app, so once given it stays with its
 * app for the session's life, across a host restart and a swap; the key goes with the session (`<name>:<session id>`
 * is purged with it). Absent (tests), names are remembered for this hub's life only.
 */
export type AppNameBook = {
  load(sessionId: string): Record<string, string>
  save(sessionId: string, names: Record<string, string>): void
}

/** `session_app_names:<session id>` in the store's settings: one JSON object per session */
export const APP_NAMES_PREFIX = 'session_app_names:'

/** A project's name as one segment of a server name: lowercase letters, digits and single hyphens */
const nameSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')

/**
 * `app-<id>` when `taken` does not hold it; else, with a `qualifier` (a project's slug), `app-<id>-<qualifier>`, then
 * `-2`, `-3`, …; without one, `app-<id>-2`, `-3`, ….
 */
export function freeServerName(appId: string, taken: ReadonlySet<string> | readonly string[], qualifier?: string): string {
  const has = (name: string) => (Array.isArray(taken) ? taken.includes(name) : (taken as ReadonlySet<string>).has(name))
  const base = appServerName(appId)
  if (!has(base)) return base
  const stem = qualifier ? `${base}-${qualifier}` : base
  for (let n = qualifier ? 1 : 2; ; n++) {
    const name = n === 1 ? stem : `${stem}-${n}`
    if (!has(name)) return name
  }
}

/**
 * An app's name in a session as the model writes it (#2231): its server name of before without `app-` (`board`,
 * `board-centralu`, `board-2`). The book (#1141) keeps the server names, which a session's earlier turns used.
 */
export const appNameOf = (server: string): string => (server.startsWith(APP_SERVER_PREFIX) ? server.slice(APP_SERVER_PREFIX.length) : server)

/**
 * The order apps new to a session are named in, when several arrive in one count: by id, the user folder's first, then
 * by project. Only the first naming follows it; after that a name stays with its app (`AppNameBook`).
 */
const byNameOrder = (x: Pick<ExternalAppInfo, 'appId' | 'projectId'>, y: Pick<ExternalAppInfo, 'appId' | 'projectId'>): number =>
  x.appId.localeCompare(y.appId) || (x.projectId === y.projectId ? 0 : x.projectId === null ? -1 : y.projectId === null ? 1 : x.projectId.localeCompare(y.projectId))

export class SessionAppsHub {
  /** session id → the attachment of the handle currently alive for it. Swapping the handle out lets a new one take its place */
  private live = new Map<string, Attachment>()
  /**
   * run id → an early-returned call. **Kept on the hub, not on the handle** — even after a
   * session respawns (resume, restart), the same session's agent must be able to keep asking
   * about it with the same id.
   */
  readonly detached = new Map<string, Detached>()
  private callListeners = createListeners<SessionAppCall>((err) => console.error(`[apps] session-call listener failed:`, err))
  private progressListeners = createListeners<SessionAppProgress>((err) => console.error(`[apps] session-call progress listener failed:`, err))
  private goneListeners = createListeners<string>((err) => console.error(`[apps] session-gone listener failed:`, err))

  constructor(
    readonly rt: ExternalApps,
    readonly opts: {
      toolListWaitMs?: number
      callJoinWaitMs?: number
      onDemand?: OnDemandApps
      /** Where the names a session has seen are kept (#1141) */
      names?: AppNameBook
      /** A project's name, for the name of a later app with an id another app of the session already has */
      projectName?: (projectId: string) => string | undefined
      /**
       * Asks the person before an app tool runs when the session's turn is a session's request (§9.7, #1447): the one door every call of an agent
       * passes through, whatever the CLI and its preset. It runs `run` at once in any other turn
       */
      whenAsked?: (
        sessionId: string,
        call: { name: string; args: Record<string, unknown>; readOnly?: boolean },
        signal: AbortSignal | undefined,
        run: () => Promise<AppToolResult>,
        refused: (text: string) => AppToolResult,
      ) => Promise<AppToolResult>
      /**
       * The person's say on an app tool that does not run unasked (#2231, decision 5): the host decides at the call, with
       * its arguments, on every CLI. Absent only in tests that run no card, where every call runs
       */
      approval?: AppApproval
    } = {},
  ) {}

  /**
   * A session moved into a project behind its handle's back (#1141: a user-folder app's builder or agent, when the app's
   * folder became a project in place). The live attachment's view of the session follows — its project, and the app it
   * builds now under that project — and is counted again, so the builder is given its own app without a restart.
   */
  sessionMoved(sessionId: string, projectId: string): void {
    const a = this.live.get(sessionId)
    if (!a) return
    a.session.projectId = projectId
    if (a.session.builderOf && a.session.builderOf.projectId === null) a.session.builderOf = { projectId, appId: a.session.builderOf.appId }
  }

  /** Creates the attachment for one handle — handed to the adapter, and closed by the adapter when the handle closes */
  attach(session: AppSessionKey): SessionAppAttachment {
    const a = new Attachment(this, session)
    this.live.set(session.id, a)
    return a
  }

  /**
   * The door the `app` tool comes in through (#2231), on every CLI: the attachment of the session's **currently live
   * handle**, or null when it has none (asleep or closed), so no app is called in the name of a session with no handle.
   */
  liveFor(sessionId: string): SessionAppAttachment | null {
    return this.live.get(sessionId) ?? null
  }

  /**
   * Listens for a session's app calls (M4 B-1). The in-conversation UI checks here whether a
   * tool has a screen attached and opens it. This layer does not know about the UI — it only
   * announces.
   */
  onCall(listener: (c: SessionAppCall) => void): () => void {
    return this.callListeners.add(listener)
  }

  /**
   * Listens for progress lines sent by a session's app call (M4 D) — a one-liner such as
   * "waiting on the person" received from an app's intermediary. The manager attaches it to that
   * session's tool card as running output. This layer does not know about the conversation — it
   * only announces.
   */
  onCallProgress(listener: (p: SessionAppProgress) => void): () => void {
    return this.progressListeners.add(listener)
  }

  /** @internal The attachment announces one progress line */
  progress(p: SessionAppProgress): void {
    this.progressListeners.emit(p)
  }

  /** A session has **been deleted** (different from being asleep — an asleep session wakes back up). The signal to tear down that session's UI */
  onSessionGone(listener: (sessionId: string) => void): () => void {
    return this.goneListeners.add(listener)
  }

  /** Called by the manager when it deletes a session */
  sessionGone(sessionId: string): void {
    this.goneListeners.emit(sessionId)
  }

  /** @internal The attachment announces one call — a listener's failure does not block the call */
  announce(c: SessionAppCall): void {
    this.callListeners.emit(c)
  }

  /** @internal A closed attachment vacates its spot — does not touch it if a new handle has already taken over */
  release(a: Attachment): void {
    if (this.live.get(a.session.id) === a) this.live.delete(a.session.id)
  }

  /**
   * The apps this session receives (decision 4).
   *
   *   assistant                the user-folder apps — it belongs to no project, so it gets no project's inner apps,
   *                               and it attaches a root app when it needs one (#1205, `givesApp`)
   *   a project's session         that project's apps — only if the project is trusted. A worktree session
   *                               carries the same project id, so it receives the root's apps too
   *                               (A-2: one instance per project)
   *   other (no project)          none
   *   a building session (C-3)    the above, plus **its own app** — the building session of a user-folder
   *                               app has no project, so the rule above would give it nothing. Calling
   *                               the tools of the app it is building is exactly that session's job
   *
   * Trust is read from the runtime's state (`untrusted`) — there is one source of truth (the
   * store), and the runtime reads it fresh on every call. Keeping a copy here would let that copy
   * keep answering "yes" even after trust is revoked.
   */
  refsFor(session: AppSessionKey): Hit[] {
    /*
     * An untrusted project's apps attach nowhere (owner, #1141): its root app and the apps inside it, to no session, its
     * own project's included, and under `auto` too. #603's opening of an untrusted project's apps to an auto session
     * no longer applies to apps; the project's sessions still run and may read its code
     */
    const usable = this.rt.list().filter((a) => !UNUSABLE.has(a.status))
    const hits = this.named(session, usable.filter((a) => givesApp(session, a))).sort((x, y) => x.server.localeCompare(y.server))
    /*
     * Then what the session attached itself (#371 part A), after decision 4's apps and in the order it
     * attached them. One the rule already gives is not added twice, and one whose server name is taken
     * (an app that later appeared in the session's own project under the same name) steps back: the
     * session's own app keeps its name, which every earlier turn of the conversation used.
     */
    const taken = new Set(hits.map((h) => h.server))
    for (const x of this.opts.onDemand?.attached(session.id) ?? []) {
      const app = usable.find((a) => sameApp(a, x.ref))
      if (!app || taken.has(x.server) || hits.some((h) => sameApp(h.ref, x.ref))) continue
      if (!this.opts.onDemand!.allowed(session, app)) continue
      hits.push({ ref: x.ref, server: x.server })
      taken.add(x.server)
    }
    return hits
  }

  /** Names this hub has given, per session: the book's, read once, and what it gave since */
  private names = new Map<string, Record<string, string>>()

  /** The books changed behind this hub (#1141: an app moved into a project carries its names to its new key): read again */
  reloadNames(): void {
    this.names.clear()
  }

  /**
   * The server names of the apps decision 4 gives a session (#1141): a name the session has seen stays with its app for
   * the session's life, even while the app is gone, so it never comes to mean another app; an app new to the session
   * gets `app-<id>` when no app of the session holds it, else a name qualified by its project
   * (`app-<id>-<project>`, then `-2`, … if that is taken too). What it attached itself keeps the names it was given
   * then (`OnDemandApps`), and those are taken as well.
   */
  private named(session: AppSessionKey, apps: readonly ExternalAppInfo[]): Hit[] {
    const book = this.bookOf(session.id)
    const taken = new Set([...Object.values(book), ...(this.opts.onDemand?.attached(session.id) ?? []).map((x) => x.server)])
    let added = false
    const hits: Hit[] = []
    for (const a of [...apps].sort(byNameOrder)) {
      const key = appKeyOf(a.projectId, a.appId)
      let server = book[key]
      if (!server) {
        const base = appServerName(a.appId)
        const slug = a.projectId ? nameSlug(this.opts.projectName?.(a.projectId) ?? '') || a.projectId.slice(0, 8).toLowerCase() : 'user'
        server = !taken.has(base) ? base : freeServerName(a.appId, taken, slug)
        book[key] = server
        taken.add(server)
        added = true
      }
      hits.push({ ref: { projectId: a.projectId, appId: a.appId }, server })
    }
    if (added) this.opts.names?.save(session.id, book)
    return hits
  }

  /** The names this session has seen its apps under, by app key (#1141): the book's, read once, and what was given since */
  private bookOf(sessionId: string): Record<string, string> {
    let book = this.names.get(sessionId)
    if (!book) {
      book = { ...(this.opts.names?.load(sessionId) ?? {}) }
      this.names.set(sessionId, book)
    }
    return book
  }

  /**
   * The server name `attach_app` gives an app (#1141, third review): the one this session saw it under before, if no other
   * app of the session holds it now, else the first free `app-<id>`, `app-<id>-2`, …. Never a name the session's book
   * gives another app, so an app gone for a moment (its manifest broken while it is edited) finds its name free when it
   * returns, and the name is written in the book, so it stays with this app too. `inUse` is what the session holds now.
   */
  claimAttachName(sessionId: string, ref: AppRef, inUse: readonly string[]): string {
    const book = this.bookOf(sessionId)
    const key = appKeyOf(ref)
    const taken = new Set([...inUse, ...Object.entries(book).filter(([k]) => k !== key).map(([, server]) => server)])
    const had = book[key]
    const server = had && !taken.has(had) ? had : freeServerName(ref.appId, taken)
    if (had !== server) {
      book[key] = server
      this.opts.names?.save(sessionId, book)
    }
    return server
  }

  /**
   * Whether a session can use one app's tools right now, and if not, why (#308, `apps.reach`). The same
   * rule as `refsFor`, asked the other way round so the answer can name what fails first: an app this
   * session is never given (`other-project`) before one it would be given but cannot be attached
   * (trust, then the app's own state). `session` is null for a session that gets no apps at all (one stood
   * up by an app, manager `appsFor`). Every agent reaches its apps through Centralu's `app` tool (#2231), so
   * what the rule gives is what the agent can call, at once. A root app the Assistant may attach and has not
   * is reachable (#1205): its agent attaches it with `attach_app`, and the person has nothing to do.
   */
  reach(session: AppSessionKey | null, ref: AppRef): AppReach {
    const app = this.rt.list().find((a) => sameApp(a, ref))
    if (!app) return { reachable: false, reason: 'unavailable' }
    // An app the session attached itself (#371 part A) counts like one the rule gives, under the name it was given
    const own = session?.id ? this.opts.onDemand?.attached(session.id).find((x) => sameApp(x.ref, ref)) : undefined
    const onDemand = !!session && !!own && this.opts.onDemand!.allowed(session, app)
    // A root app the Assistant has not attached (#1205): it attaches it itself, with nothing for the person to do
    const selfServed = !!session && !own && isAssistantKind(session.kind) && app.root === true && !!this.opts.onDemand
    // One it attached whose project has since lost trust: the person is told to trust the project, not that it is another's
    const lostTrust = !!own && app.status === 'untrusted'
    if (!session || (!givesApp(session, app) && !onDemand && !selfServed && !lostTrust)) return { reachable: false, reason: 'other-project' }
    // An untrusted project's apps attach nowhere, auto included (owner, #1141)
    if (app.status === 'untrusted') return { reachable: false, reason: 'untrusted' }
    if (UNUSABLE.has(app.status)) return { reachable: false, reason: 'app-unusable', status: app.status }
    if (selfServed && !this.opts.onDemand!.allowed(session, app)) return { reachable: false, reason: 'other-project' }
    return { reachable: true }
  }

  /** @internal Records an early-returned call — sweeps out old ones every time it does */
  remember(runId: string, d: Detached): void {
    const now = Date.now()
    for (const [id, x] of this.detached) {
      if (x.outcome && now - x.startedAt > DETACHED_KEEP_MS) this.detached.delete(id)
    }
    const mine = [...this.detached].filter(([, x]) => x.sessionId === d.sessionId)
    for (const [id, x] of mine.slice(0, Math.max(0, mine.length - DETACHED_PER_SESSION + 1))) {
      if (x.outcome) this.detached.delete(id)
    }
    this.detached.set(runId, d)
  }

  dispose(): void {
    this.callListeners.clear()
    this.goneListeners.clear()
    for (const a of [...this.live.values()]) a.close()
  }
}

/**
 * The app a name means in this session (#2231): the name the `app` tool lists (`board`), or the server name a session's
 * earlier turns used (`app-board`). The listed name wins where both would match.
 */
export function namedApp<T extends { server: string }>(apps: readonly T[], name: string): T | undefined {
  const n = name.trim()
  return apps.find((a) => a.server === appServerName(n)) ?? apps.find((a) => a.server === n)
}

/** What the `app` tool and the adapter see of a session's live attachment (#2231) */
export type SessionAppAttachment = SessionApps & SessionAppTools

/**
 * The person's say on an app call (#2231): the session's preset now, whether its live agent runs under the person's own
 * bypass (`SessionHandle.bypassesApprovals`), and the host's card in the session's approval slot (`HostCards.askHost`)
 */
export type AppApproval = {
  preset(sessionId: string): PermissionPreset
  bypassed(sessionId: string): boolean
  ask(sessionId: string, detail: { kind: 'other'; raw: string }, signal: AbortSignal): Promise<'allow' | 'always' | 'always_project' | 'deny' | null>
}

/** The attachment for one handle — what the adapter and the `app` tool see of a session's apps */
class Attachment implements SessionAppAttachment {
  /**
   * Calls made by this handle that have not finished yet (including early-returned ones, and ones waiting on the person's
   * card). When the session stops or the handle closes, everything here is cancelled — the cancellation is carried by the
   * runtime all the way down to the app (notifications/cancelled) and any intermediary work beneath it (A-4's parent
   * signal), and a card still standing is withdrawn.
   */
  private inflight = new Set<AbortController>()
  private closed = false
  /** Card-id joining (B-1) — call starts seen by the adapter, and calls waiting to be joined */
  private noted: Noted[] = []
  private waiters: Waiter[] = []

  constructor(
    private hub: SessionAppsHub,
    readonly session: AppSessionKey,
  ) {}

  current(): SessionAppEntry[] {
    if (this.closed) return []
    const infos = this.hub.rt.list()
    return this.hub.refsFor(this.session).map(({ ref, server }) => {
      const known = this.hub.rt.knownTools(ref, 'model')
      const info = infos.find((a) => sameApp(a, ref))
      return {
        name: appNameOf(server),
        server,
        appId: ref.appId,
        title: info?.name ?? ref.appId,
        description: info?.description ?? '',
        tools: known ? withRunStatus(known.map(toSpec)) : null,
      }
    })
  }

  async tools(server: string): Promise<AppToolSpec[]> {
    const hit = this.find(server)
    if (!hit) throw new Error(`This session has no app named ${appNameOf(server)}`)
    const known = this.hub.rt.knownTools(hit.ref, 'model')
    if (known) return withRunStatus(known.map(toSpec))
    /*
     * This is the first moment it is needed — spin up the app and read its list. If the cap is exceeded or it fails to
     * start, answer with an empty list and log the reason. Starting itself keeps going in the background, and the next
     * listing has the tools.
     */
    try {
      return withRunStatus((await withTimeout(this.hub.rt.tools(hit.ref, 'model'), this.hub.opts.toolListWaitMs ?? TOOL_LIST_WAIT_MS, 'Its tool list')).map(toSpec))
    } catch (err) {
      console.error(`[apps] ${server} listed no tools for now: ${errorMessage(err).split('\n')[0]}`)
      return withRunStatus([])
    }
  }

  /**
   * One call of the `app` tool (#2231), in order: the app must be this session's now; the tool must exist and the arguments
   * fit its schema, or the answer is the schema and nothing runs; a session's request turn asks the Assistant's person
   * (`whenAsked`, #1447); the person's card where the preset asks (`approve`); then the runtime's one call path.
   */
  async call(server: string, tool: string, args: Record<string, unknown>, opts: AppCallOpts = {}): Promise<AppToolResult> {
    if (this.closed || !this.find(server)) return failure(`This session has no app named ${appNameOf(server)}.`)
    const wrong = await this.argsProblem(server, tool, args)
    if (wrong) return failure(wrong)
    const abort = new AbortController()
    const onUp = () => abort.abort()
    if (opts.signal?.aborted) abort.abort()
    else opts.signal?.addEventListener('abort', onUp, { once: true })
    this.inflight.add(abort)
    const deadline = opts.waitMs ? Date.now() + opts.waitMs : null
    const left = () => (deadline === null ? undefined : Math.max(1_000, deadline - Date.now()))
    const run = async (): Promise<AppToolResult> => {
      const refused = await this.approve(server, tool, args, abort.signal, left())
      return refused ? failure(refused) : this.callNow(server, tool, args, { signal: abort.signal, waitMs: left(), callId: opts.callId })
    }
    try {
      const gate = this.hub.opts.whenAsked
      if (!gate) return await run()
      // Named with a dot so no app tool can pass for one of the Assistant's own reading tools or undoable commands
      const call = { name: `${server}.${tool}`, args, ...(this.readOnly(server, tool) ? { readOnly: true as const } : {}) }
      return await gate(this.session.id, call, abort.signal, run, failure)
    } finally {
      this.inflight.delete(abort)
      opts.signal?.removeEventListener('abort', onUp)
    }
  }

  /** What is wrong with a call before it runs: an unknown tool, or arguments its schema refuses (said with the schema) */
  private async argsProblem(server: string, tool: string, args: Record<string, unknown>): Promise<string | null> {
    const tools = await this.tools(server)
    const spec = tools.find((t) => t.name === tool)
    if (!spec) return `${appNameOf(server)} has no tool ${JSON.stringify(tool)}. Its tools: ${tools.map((t) => t.name).join(', ') || '(none listed yet)'}.`
    const issues = schemaIssues(spec.inputSchema, args)
    return issues ? `Wrong arguments for ${tool}: ${issues}. Nothing ran. Its arguments: ${JSON.stringify(spec.inputSchema)}` : null
  }

  /**
   * Decision 5 at the call (#2231): null when the call may run, else why it may not. A tool that runs unasked never asks;
   * otherwise the preset decides (`presetAsks`), and a card the person has not answered within the path's bound is
   * withdrawn, so the bridge's ceiling never cuts a call that is waiting on them.
   */
  private async approve(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, waitMs: number | undefined): Promise<string | null> {
    const approval = this.hub.opts.approval
    if (!approval || tool === RUN_STATUS_TOOL) return null
    const preset = approval.preset(this.session.id)
    if (this.unasked(server, tool, preset, args) || !presetAsks(preset, approval.bypassed(this.session.id))) return null
    const card = new AbortController()
    const withdraw = () => card.abort()
    signal.addEventListener('abort', withdraw, { once: true })
    let late = false
    const timer = waitMs === undefined ? null : setTimeout(() => ((late = true), card.abort()), waitMs)
    try {
      const raw = `${appNameOf(server)}: ${tool} ${JSON.stringify(args).slice(0, 300)}`
      const answer = await approval.ask(this.session.id, { kind: 'other', raw }, card.signal)
      if (answer === 'deny') return 'The person denied this call. Nothing ran.'
      if (answer !== null) return null
      return late
        ? `The person did not answer the card for this call within ${Math.round(waitMs! / 1000)} s, so it was withdrawn and nothing ran. Tell them what you want to do, and call again once they agree.`
        : 'The card for this call was withdrawn. Nothing ran.'
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', withdraw)
    }
  }

  private async callNow(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; waitMs?: number; callId?: string },
  ): Promise<AppToolResult> {
    const hit = this.find(server)
    // An unattached app never reaches the runtime — the only apps this session can call are the ones decision 4 gave it
    if (!hit) return failure(`This session has no app named ${appNameOf(server)}.`)
    if (tool === RUN_STATUS_TOOL) return this.runStatus(hit, args)

    /*
     * One cancellation handle per call — whichever comes first pulls it, either the caller's
     * signal (the CLI's notifications/cancelled) or this session stopping (cancelAll). Even a
     * call that was already handed back early stays here until it actually finishes.
     */
    const abort = new AbortController()
    const onUp = () => abort.abort()
    if (opts.signal?.aborted) abort.abort()
    else opts.signal?.addEventListener('abort', onUp, { once: true })
    this.inflight.add(abort)

    let runId: string | null = null
    /** This call's conversation card — joined below. Progress lines arrive after the call reaches the app, by which point it is set */
    let card: Promise<string | null> | null = null
    const sessionId = this.session.id
    const onProgress = (message: string) =>
      void card?.then((callId) => {
        // A call with no card (e.g. a call from a Claude subagent) has nowhere to attach the message — the call itself keeps running
        if (callId) this.hub.progress({ sessionId, callId, message })
      })
    const pending = this.hub.rt
      .call(hit.ref, tool, args, { kind: 'session', sessionId: this.session.id }, { signal: abort.signal, onRun: (id) => (runId = id), onProgress })
      // Vanished mid-call (the app's folder was deleted) — return it as a failed call instead of throwing
      .catch((err: Error): AppCallOutcome => ({ runId: runId ?? '', status: 'error', result: null, error: err.message, durationMs: 0 }))
      .finally(() => {
        this.inflight.delete(abort)
        opts.signal?.removeEventListener('abort', onUp)
      })
    // The in-conversation UI (B-1) listens here — every call goes through joining: each call must consume its own noted start, or a leftover entry could be joined to the wrong call
    this.hub.announce({
      sessionId: this.session.id,
      ref: hit.ref,
      server,
      tool,
      args,
      callId: (card = this.joinCall(server, tool, args, opts.callId)),
      outcome: pending,
    })
    if (!opts.waitMs) return toResult(await pending)

    /*
     * **The call on the timed-out side** (the plan's "long-running calls"). Codex cuts off an MCP
     * tool call at 300 seconds. Before that (at 240 seconds), the run id and "still running" are
     * handed back early, and the call is left running — its result still lands in the app's UI
     * and record, and the agent follows up with `run_status`. Left to be cut off, the app's work
     * would keep going while the agent lost any way to get the result.
     */
    const first = await raceTimeout(
      pending.then((o) => ({ o })),
      opts.waitMs,
      null,
    )
    if (first) return toResult(first.o)
    const entry: Detached = { sessionId: this.session.id, server, startedAt: Date.now() - opts.waitMs, outcome: null }
    this.hub.remember(runId!, entry)
    void pending.then((o) => (entry.outcome = o))
    const seconds = Math.round(opts.waitMs / 1000)
    return {
      content: [
        {
          type: 'text',
          text:
            `This call is still running (past ${seconds} s). Run id: ${runId}\n` +
            `The call has not stopped and carries on. Do not call it again: app(action="call", app=${JSON.stringify(appNameOf(server))}, tool="${RUN_STATUS_TOOL}", args={"run_id": ${JSON.stringify(runId)}}) gives its result.`,
        },
      ],
      isError: false,
      structuredContent: { runId, status: 'running' },
    }
  }

  /**
   * `run_status` — sees only the runs this session made **to this app**. A run made by another
   * session or by the UI is invisible, since its result belongs to that other side (even knowing
   * its run id does not help).
   *
   * An early-returned run answers with the full result body; every other run (one that finished
   * in time, or an old one) answers only with whatever status and reason the record knows — the
   * record keeps no result body (A-6: even the arguments are kept only as a summary).
   */
  private runStatus(hit: Hit, args: Record<string, unknown>): AppToolResult {
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
    if (!runId) return failure(`${RUN_STATUS_TOOL} needs a run_id`)
    const d = this.hub.detached.get(runId)
    if (d && d.sessionId === this.session.id && d.server === hit.server) {
      if (!d.outcome) {
        const seconds = Math.round((Date.now() - d.startedAt) / 1000)
        return {
          content: [{ type: 'text', text: `Run ${runId} is still running (${seconds} s so far). Check again a little later.` }],
          isError: false,
          structuredContent: { runId, status: 'running' },
        }
      }
      const o = d.outcome
      const done = toResult(o)
      return {
        content: [{ type: 'text', text: `Run ${runId} has finished (${o.status}, ${durationText(o.durationMs)}). Its result:` }, ...done.content],
        isError: done.isError,
        structuredContent: { runId, status: o.status, ...(done.structuredContent ? { result: done.structuredContent } : {}) },
      }
    }
    const row = this.hub.rt.runs(hit.ref, 500).find((r) => r.id === runId && r.callerKind === 'session' && r.callerSessionId === this.session.id)
    if (!row) return failure(`Unknown run id: ${runId} — a session can see only the runs it started on this app`)
    const why = row.error ? ` — ${row.error}` : ''
    return {
      content: [{ type: 'text', text: `Run ${runId}: ${row.status}${why}${row.status === 'running' ? '' : ' (its result is no longer kept)'}` }],
      isError: row.status !== 'ok' && row.status !== 'running',
      structuredContent: { runId, status: row.status },
    }
  }

  private readOnly(server: string, tool: string): boolean {
    const hit = this.find(server)
    if (!hit) return false
    // A tool the host added — it only reads status
    if (tool === RUN_STATUS_TOOL) return true
    /*
     * Looks only at the list already read, without spinning up the app. The approval callback is
     * invoked over a tool from the list the model has **already seen**, so if it is invoked while
     * the list is unknown, that tool was not one the model chose from our list — in that case, ask.
     */
    const found = this.hub.rt.knownTools(hit.ref, 'model')?.find((t) => t.name === tool)
    return found?.annotations?.readOnlyHint === true
  }

  private unasked(server: string, tool: string, preset: PermissionPreset, args: Record<string, unknown>): boolean {
    if (this.readOnly(server, tool)) return true
    const hit = this.find(server)
    if (!hit) return false
    const found = this.hub.rt.knownTools(hit.ref, 'model')?.find((t) => t.name === tool)
    if (!found) return false
    /*
     * "Own" is read from the session, not from the app: the app is a project's own when the session belongs to that
     * project (`givesApp`), and `find` only finds an app whose project is trusted. The Assistant has no project,
     * and an app the session attached itself (`attach_app`) belongs to another project or to the user: neither is
     * covered by this project's trust, so their tools keep asking.
     */
    const own = !isAssistantKind(this.session.kind) && hit.ref.projectId !== null && hit.ref.projectId === this.session.projectId
    return runsUnasked(found, { own, preset, args })
  }

  cancelAll(): void {
    for (const abort of [...this.inflight]) abort.abort()
  }

  noteCall(callId: string, app: string, tool: string, args: unknown): void {
    if (this.closed || !callId) return
    const server = namedApp(this.hub.refsFor(this.session), app)?.server
    if (!server) return
    const key = argsKey(args)
    // The bridge arrived first — the waiting call is exactly this card
    const w = this.waiters.findIndex((x) => x.server === server && x.tool === tool && x.args === key)
    if (w !== -1) {
      const [waiter] = this.waiters.splice(w, 1)
      clearTimeout(waiter!.timer)
      waiter!.resolve(callId)
      return
    }
    this.pruneNoted()
    this.noted.push({ callId, server, tool, args: key, at: Date.now() })
    if (this.noted.length > NOTED_MAX) this.noted.shift()
  }

  callEnded(callId: string): void {
    this.noted = this.noted.filter((n) => n.callId !== callId)
  }

  /**
   * This call's card id (B-1).
   *
   * **If the adapter tells us the id, that is the answer** — it is the id the agent's MCP client
   * sent along with the request, so no joining is needed. Any noted start under the same id is
   * discarded (the case where both paths announced it). If there is none, it is the oldest noted
   * start whose (server, tool, args) match. If there is not one of those yet either, wait a
   * moment — the adapter's notification can arrive later than the bridge's call.
   */
  private joinCall(server: string, tool: string, args: Record<string, unknown>, explicit?: string): Promise<string | null> {
    if (explicit) {
      this.callEnded(explicit)
      return Promise.resolve(explicit)
    }
    const key = argsKey(args)
    this.pruneNoted()
    const i = this.noted.findIndex((n) => n.server === server && n.tool === tool && n.args === key)
    if (i !== -1) return Promise.resolve(this.noted.splice(i, 1)[0]!.callId)
    if (this.closed) return Promise.resolve(null)
    const waitMs = this.hub.opts.callJoinWaitMs ?? CALL_JOIN_WAIT_MS
    return new Promise((resolve) => {
      const waiter: Waiter = {
        server,
        tool,
        args: key,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== waiter)
          resolve(null)
        }, waitMs),
      }
      waiter.timer.unref?.()
      this.waiters.push(waiter)
    })
  }

  private pruneNoted(): void {
    const cutoff = Date.now() - NOTED_KEEP_MS
    if (this.noted.length && this.noted[0]!.at < cutoff) this.noted = this.noted.filter((n) => n.at >= cutoff)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // A closed handle's calls have nowhere to be received — stop even the early-returned ones
    this.cancelAll()
    this.noted = []
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer)
      w.resolve(null)
    }
    this.hub.release(this)
  }

  /**
   * server name → app. **Decision 4 is re-checked on every call** — even an app that was attached
   * when the session spawned is not called if it has since lost trust or halted. Codex cannot
   * change the servers attached while a thread is running, so this check is the actual place that
   * blocks a detached app.
   */
  private find(server: string): Hit | null {
    if (this.closed) return null
    return this.hub.refsFor(this.session).find((h) => h.server === server) ?? null
  }
}

type RuntimeTool = Awaited<ReturnType<ExternalApps['tools']>>[number]

/**
 * The comparison key for arguments — JSON that ignores key order. The arguments the adapter sees
 * may be a string (Codex's `item.arguments`) or an object. If it is a string, it is parsed and
 * brought to the same shape.
 */
function argsKey(args: unknown): string {
  let v = args
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown
    } catch {
      return v as string
    }
  }
  return stable(v ?? {})
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** Adds the host's `run_status` to an app's tool list — an app tool with the same name is hidden (see RUN_STATUS_SPEC) */
function withRunStatus(tools: AppToolSpec[]): AppToolSpec[] {
  return [...tools.filter((t) => t.name !== RUN_STATUS_TOOL), RUN_STATUS_SPEC]
}

/** A runtime tool (MCP `Tool`) → the shape exposed to a session. outputSchema is dropped (see below) */
function toSpec(t: RuntimeTool): AppToolSpec {
  /*
   * Why outputSchema is not carried over: a result that has gone through the proxy server can
   * disagree with the shape the app declared — a refusal or a cancellation is a one-line message
   * made by the host. If a receiving client trusts the declaration and validates against it, that
   * one line turns into "the shape is wrong," and the real reason gets hidden. structuredContent
   * is still carried through on the result as-is.
   */
  return {
    name: t.name,
    ...(t.title !== undefined ? { title: t.title } : {}),
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
    ...(t._meta ? { _meta: t._meta } : {}),
  }
}

/** A runtime outcome → the tool result an agent receives */
export function toResult(o: AppCallOutcome): AppToolResult {
  if (o.result) {
    return {
      content: o.result.content,
      isError: o.status !== 'ok',
      ...(o.result.structuredContent ? { structuredContent: o.result.structuredContent as Record<string, unknown> } : {}),
    }
  }
  const what = o.status === 'cancelled' ? 'was cancelled' : o.status === 'rejected' ? 'was refused' : 'failed'
  return failure(`The app call ${what} — ${o.error ?? 'no reason was given'}`)
}

/**
 * What a tool's input schema refuses in a call's arguments, or null (#2231): read with zod's JSON Schema reader, so the
 * check is the one Centralu's own tools get. A schema zod cannot read is not checked, as neither CLI checked it before.
 */
function schemaIssues(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  let checked
  try {
    checked = z.fromJSONSchema(schema).safeParse(args)
  } catch {
    return null
  }
  return checked.success ? null : issuesText(checked.error)
}

function failure(text: string): AppToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

import { APP_ID_MAX_LENGTH, appKeyOf } from '@cc/protocol'
import type { AppReach, ExternalAppInfo, SessionKind } from '@cc/protocol'
import type { AppToolResult, AppToolSpec, AttachedApp, SessionApps, SessionHandle } from '../adapters/contract.js'
import { appMcpServerName } from '../apps/contract.js'
import type { AppCallOutcome, AppRef, ExternalApps } from '../apps/external/runtime.js'
import { raceTimeout } from '../timing.js'
import { withTimeout } from './with-timeout.js'
import { rpcError } from '../rpc-error.js'

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
 * orchestrator gets the user-folder apps, a project's sessions that project's apps (its root app included),
 * and a building session its own app as well (see `refsFor`).
 *
 * Not the root apps for the orchestrator (#1205): each one was its own MCP server in every orchestrator
 * request, so the list grew with every project the person trusted (#1141 had given them all). It finds and
 * attaches the one it needs (`find_apps` / `attach_app`, sessions/app-access.ts), as a project's session does.
 * The user-folder apps stay: an MCP server the person approved for the orchestrator is one (A-7), and it is
 * promised from the start.
 */
function givesApp(session: AppSessionKey, app: Pick<ExternalAppInfo, 'appId' | 'projectId'>): boolean {
  return (
    (session.kind === 'orchestrator' ? app.projectId === null : session.projectId !== null && app.projectId === session.projectId) ||
    (session.builderOf?.appId === app.appId && session.builderOf.projectId === app.projectId)
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
 * The longest server name an app is given: `app-<id>` of the longest id (#1141, third review). A tool reads
 * `mcp__<server>__<tool>`, which tools cap at 64 characters, so a name qualified by its project or numbered never leaves
 * a tool less room than a plain `app-<id>` does: at most 43 characters before the tool, 21 for it.
 */
export const SERVER_NAME_MAX = appMcpServerName('x'.repeat(APP_ID_MAX_LENGTH)).length

/**
 * `app-<id>` when `taken` does not hold it; else, with a `qualifier` (a project's slug), `app-<id>-<qualifier>`, then
 * `-2`, `-3`, …; without one, `app-<id>-2`, `-3`, …. Never longer than `SERVER_NAME_MAX`: the stem is cut before the
 * number, so a long id or project name stays unique by its number.
 */
export function freeServerName(appId: string, taken: ReadonlySet<string> | readonly string[], qualifier?: string): string {
  const has = (name: string) => (Array.isArray(taken) ? taken.includes(name) : (taken as ReadonlySet<string>).has(name))
  const base = appMcpServerName(appId)
  if (!has(base)) return base
  const stem = qualifier ? `${base}-${qualifier}` : base
  for (let n = qualifier ? 1 : 2; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const name = stem.slice(0, SERVER_NAME_MAX - suffix.length).replace(/-+$/, '') + suffix
    if (!has(name)) return name
  }
}

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
  private stopListening: () => void
  private callListeners = new Set<(c: SessionAppCall) => void>()
  private progressListeners = new Set<(p: SessionAppProgress) => void>()
  private goneListeners = new Set<(sessionId: string) => void>()

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
        call: { name: string; args: Record<string, unknown> },
        signal: AbortSignal | undefined,
        run: () => Promise<AppToolResult>,
        refused: (text: string) => AppToolResult,
      ) => Promise<AppToolResult>
    } = {},
  ) {
    this.stopListening = rt.onAppsChanged(() => {
      for (const a of [...this.live.values()]) a.recheck()
    })
  }

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
    a.recheck()
  }

  /** Creates the attachment for one handle — handed to the adapter, and closed by the adapter when the handle closes */
  attach(session: AppSessionKey): SessionApps {
    const a = new Attachment(this, session)
    this.live.set(session.id, a)
    return a
  }

  /**
   * The door the bridge (the adapter that cannot attach in-process — Codex) comes in through.
   * Since the bridge is a separate process, it only carries a session id and a server name — the
   * attachment of that session's **currently live handle** answers on its behalf. If there is no
   * live handle (the session is asleep or closed), it is refused: an app cannot be called under
   * the name of a session with no handle.
   */
  forSession(sessionId: string): SessionApps {
    const a = this.live.get(sessionId)
    if (!a) throw rpcError(`This session cannot call apps right now (it is not running): ${sessionId}`, 'session_not_found')
    return a
  }

  /**
   * Listens for a session's app calls (M4 B-1). The in-conversation UI checks here whether a
   * tool has a screen attached and opens it. This layer does not know about the UI — it only
   * announces.
   */
  onCall(listener: (c: SessionAppCall) => void): () => void {
    this.callListeners.add(listener)
    return () => void this.callListeners.delete(listener)
  }

  /**
   * Listens for progress lines sent by a session's app call (M4 D) — a one-liner such as
   * "waiting on the person" received from an app's intermediary. The manager attaches it to that
   * session's tool card as running output. This layer does not know about the conversation — it
   * only announces.
   */
  onCallProgress(listener: (p: SessionAppProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => void this.progressListeners.delete(listener)
  }

  /** @internal The attachment announces one progress line */
  progress(p: SessionAppProgress): void {
    for (const l of [...this.progressListeners]) {
      try {
        l(p)
      } catch (err) {
        console.error(`[apps] session-call progress listener failed:`, err)
      }
    }
  }

  /** A session has **been deleted** (different from being asleep — an asleep session wakes back up). The signal to tear down that session's UI */
  onSessionGone(listener: (sessionId: string) => void): () => void {
    this.goneListeners.add(listener)
    return () => void this.goneListeners.delete(listener)
  }

  /** Called by the manager when it deletes a session */
  sessionGone(sessionId: string): void {
    for (const l of [...this.goneListeners]) {
      try {
        l(sessionId)
      } catch (err) {
        console.error(`[apps] session-gone listener failed:`, err)
      }
    }
  }

  /** @internal The attachment announces one call — a listener's failure does not block the call */
  announce(c: SessionAppCall): void {
    for (const l of [...this.callListeners]) {
      try {
        l(c)
      } catch (err) {
        console.error(`[apps] session-call listener failed:`, err)
      }
    }
  }

  /**
   * A session attached or detached an app itself (#371 part A) — recount what its live handle sees.
   * Claude follows at once (`setMcpServers`); a Codex thread keeps what it started with, and the
   * caller restarts it when the turn ends.
   */
  sessionAppsChanged(sessionId: string): void {
    this.live.get(sessionId)?.recheck()
  }

  /** @internal A closed attachment vacates its spot — does not touch it if a new handle has already taken over */
  release(a: Attachment): void {
    if (this.live.get(a.session.id) === a) this.live.delete(a.session.id)
  }

  /**
   * The apps this session receives (decision 4).
   *
   *   orchestrator                the user-folder apps — it belongs to no project, so it gets no project's inner apps,
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
      const app = usable.find((a) => a.appId === x.ref.appId && a.projectId === x.ref.projectId)
      if (!app || taken.has(x.server) || hits.some((h) => sameRef(h.ref, x.ref))) continue
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
    for (const a of [...this.live.values()]) a.recheck()
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
        const base = appMcpServerName(a.appId)
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
    const key = appKeyOf(ref.projectId, ref.appId)
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
   * (trust, then the app's own state), and then what the live agent has (`live.appAttachment`: a Codex
   * thread keeps the servers it started with). `session` is null for a session that gets no apps at
   * all (one stood up by an app, manager `appsFor`). With no live agent the session attaches what the
   * rule gives it when it wakes, so the rule's answer stands. A root app the orchestrator may attach and
   * has not is reachable (#1205): its agent attaches it with `attach_app`, and the person has nothing to do.
   */
  reach(session: AppSessionKey | null, ref: AppRef, live?: Pick<SessionHandle, 'appAttachment'>): AppReach {
    const app = this.rt.list().find((a) => a.appId === ref.appId && a.projectId === ref.projectId)
    if (!app) return { reachable: false, reason: 'unavailable' }
    // An app the session attached itself (#371 part A) counts like one the rule gives, under the name it was given
    const own = session?.id ? this.opts.onDemand?.attached(session.id).find((x) => sameRef(x.ref, ref)) : undefined
    const onDemand = !!session && !!own && this.opts.onDemand!.allowed(session, app)
    // A root app the orchestrator has not attached (#1205): it attaches it itself, with nothing for the person to do
    const selfServed = !!session && !own && session.kind === 'orchestrator' && app.root === true && !!this.opts.onDemand
    // One it attached whose project has since lost trust: the person is told to trust the project, not that it is another's
    const lostTrust = !!own && app.status === 'untrusted'
    if (!session || (!givesApp(session, app) && !onDemand && !selfServed && !lostTrust)) return { reachable: false, reason: 'other-project' }
    // An untrusted project's apps attach nowhere, auto included (owner, #1141)
    if (app.status === 'untrusted') return { reachable: false, reason: 'untrusted' }
    if (UNUSABLE.has(app.status)) return { reachable: false, reason: 'app-unusable', status: app.status }
    if (selfServed && !this.opts.onDemand!.allowed(session, app)) return { reachable: false, reason: 'other-project' }
    if (selfServed) return { reachable: true }
    const server = givesApp(session, app) ? (this.refsFor(session).find((h) => sameRef(h.ref, ref))?.server ?? appMcpServerName(app.appId)) : own!.server
    const attached = live?.appAttachment?.(server) ?? 'attached'
    if (attached === 'restart') return { reachable: false, reason: 'restart' }
    if (attached === 'failed') return { reachable: false, reason: 'bridge-failed' }
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
    this.stopListening()
    this.callListeners.clear()
    this.goneListeners.clear()
    for (const a of [...this.live.values()]) a.close()
  }
}

/** The attachment for one handle — the implementation of `SessionApps` as the adapter sees it */
class Attachment implements SessionApps {
  private listeners = new Set<() => void>()
  /**
   * Calls made by this handle that have not finished yet (including early-returned ones). When
   * the session stops or the handle closes, everything here is cancelled — the cancellation is
   * carried by the runtime all the way down to the app (notifications/cancelled) and any
   * intermediary work beneath it (A-4's parent signal).
   */
  private inflight = new Set<AbortController>()
  /** The shape last announced (or first seen) — if it is unchanged, nothing is announced */
  private seen: string
  private closed = false
  /** Card-id joining (B-1) — call starts seen by the adapter, and calls waiting to be joined */
  private noted: Noted[] = []
  private waiters: Waiter[] = []

  constructor(
    private hub: SessionAppsHub,
    readonly session: AppSessionKey,
  ) {
    this.seen = JSON.stringify(this.current())
  }

  current(): AttachedApp[] {
    if (this.closed) return []
    return this.hub.refsFor(this.session).map(({ ref, server }) => {
      const known = this.hub.rt.knownTools(ref, 'model')
      return { server, appId: ref.appId, tools: known ? withRunStatus(known.map(toSpec)) : null }
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** @internal The runtime says "something may have changed" — announce only if what this session sees actually changed */
  recheck(): void {
    if (this.closed) return
    const now = JSON.stringify(this.current())
    if (now === this.seen) return
    this.seen = now
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch (err) {
        console.error(`[apps] session ${this.session.id.slice(0, 8)} change listener failed:`, err)
      }
    }
  }

  async tools(server: string): Promise<AppToolSpec[]> {
    const hit = this.find(server)
    if (!hit) throw new Error(`This app is not attached to this session: ${server}`)
    const known = this.hub.rt.knownTools(hit.ref, 'model')
    if (known) return withRunStatus(known.map(toSpec))
    /*
     * This is the first moment it is needed — spin up the app and read its list. If the cap is
     * exceeded or it fails to start, attach it with an empty list and log the reason. Starting
     * itself keeps going in the background, and the runtime announces once the list is read.
     */
    try {
      return withRunStatus((await withTimeout(this.hub.rt.tools(hit.ref, 'model'), this.hub.opts.toolListWaitMs ?? TOOL_LIST_WAIT_MS, 'Its tool list')).map(toSpec))
    } catch (err) {
      console.error(`[apps] ${server} attached with no tools for now: ${(err as Error).message.split('\n')[0]}`)
      return withRunStatus([])
    }
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; waitMs?: number; callId?: string } = {},
  ): Promise<AppToolResult> {
    const gate = this.hub.opts.whenAsked
    // A tool that only reads is not asked about, as for the CLI's own card (`readOnly`); anything else of an app asks when a session's request is the turn
    if (!gate || this.closed || !this.find(server) || this.readOnly(server, tool)) return this.callNow(server, tool, args, opts)
    // Named with a dot so no app tool can pass for one of the orchestrator's own reading tools
    return gate(this.session.id, { name: `${server}.${tool}`, args }, opts.signal, () => this.callNow(server, tool, args, opts), failure)
  }

  private async callNow(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; waitMs?: number; callId?: string },
  ): Promise<AppToolResult> {
    const hit = this.find(server)
    // An unattached app never reaches the runtime — the only apps this session can call are the ones decision 4 gave it
    if (!hit) return failure(`This app is not attached to this session: ${server}`)
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
            `The call has not stopped and carries on. Do not call it again: pass this id as run_id to the ${RUN_STATUS_TOOL} tool of the same server to get its result.`,
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
        content: [{ type: 'text', text: `Run ${runId} has finished (${o.status}, ${Math.round(o.durationMs / 1000)} s). Its result:` }, ...done.content],
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

  readOnly(server: string, tool: string): boolean {
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

  cancelAll(): void {
    for (const abort of [...this.inflight]) abort.abort()
  }

  noteCall(callId: string, server: string, tool: string, args: unknown): void {
    if (this.closed || !callId) return
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
    this.listeners.clear()
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

function sameRef(a: AppRef, b: AppRef): boolean {
  return a.appId === b.appId && a.projectId === b.projectId
}

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
    inputSchema: t.inputSchema as Record<string, unknown>,
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

function failure(text: string): AppToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

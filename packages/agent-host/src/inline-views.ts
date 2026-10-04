import type { CallToolResult } from '@modelcontextprotocol/client'
import { APP_VIEWS_LIVE_PER_SESSION, type NormalizedEvent } from '@cc/protocol'
import { resourceUriOf, type AppRef, type ExternalApps } from './apps/external/runtime.js'
import type { SessionAppCall, SessionAppsHub } from './sessions/session-apps.js'
import type { ViewHost } from './views/view-host.js'

/**
 * An app view inside a conversation (M4 B-1) — when a session's agent calls an app tool that has a
 * view, the view attaches under that call's card (item 1 of the plan's "two places a view is
 * born," the spec's original intended use).
 *
 * This layer does three things.
 *   1. Listens for a session's app calls (`SessionAppsHub.onCall`), and if that tool declares
 *      `_meta.ui.resourceUri`, opens a view instance (`ViewHost.open` — holds the app open while it
 *      is open). Emits an `app_view` event with the input when the call starts and the result when
 *      it ends. Per the spec, the view receives tool-input → tool-result (or tool-cancelled).
 *   2. **Checks that the view belongs to that app before opening it** (the plan's "block
 *      impersonation"). If the `ui://` the tool declared is not in that app's `resources/list`, it
 *      is not opened, and a rejection is recorded. The same applies if the result points at a
 *      different view.
 *   3. Closes the instance — when the UI says so, when the session is deleted, and when the app
 *      disappears or can no longer run.
 *
 * This layer never changes the call. Even when the view fails to open (rejected, no matching card),
 * the call still runs and the agent still gets its result — the view is an addition for the person,
 * never a condition of the call.
 *
 * Who made the call is known by the attachment (session-apps.ts). Which card it belongs to is
 * either reported by the adapter or matched by `callId` (Claude: the request's `_meta`; Codex:
 * matched against the call start the adapter observed). The manager and the runtime know nothing
 * about this layer — the host (main.ts) and the tests wire it in with `attachInlineViews` (the same
 * arrangement as app-view-source.ts).
 */

type AppViewEvent = Extract<NormalizedEvent, { type: 'app_view' }>

/**
 * The numbers for views inside a conversation (B-1). The defaults are the product's values, and
 * tests use smaller ones.
 *
 * **What reopening needs is kept only in the host's memory.** To reopen a view without calling the
 * tool again (calling it again would change the app's state again), the input and result of that
 * call have to exist. The result is the app's own, unexamined, so its contents are unknown, and the
 * run record (A-6) keeps only a summary of the arguments — so this is never written to disk, and
 * its size is capped. It disappears when the host restarts, and at that point the placeholder only
 * offers "open app."
 */
export type InlineLimits = {
  /** The number of views kept open at once in one conversation — once exceeded, the oldest open one is closed first (the plan: only a handful of live views) */
  livePerSession: number
  /** The number of calls kept so they can be reopened in one conversation — once exceeded, the oldest is dropped first */
  keptPerSession: number
  /** The cap on one call's input plus result (in JSON character count) — once exceeded, it is not kept */
  keptCallMax: number
  /** The cap across the entire host — once exceeded, the oldest anywhere is dropped first */
  keptTotalMax: number
}

export const DEFAULT_INLINE_LIMITS: InlineLimits = {
  // Matches the number of frames the UI renders — an instance beyond that count holds the app open but is never shown
  livePerSession: APP_VIEWS_LIVE_PER_SESSION,
  keptPerSession: 20,
  keptCallMax: 256 * 1024,
  keptTotalMax: 8 * 1024 * 1024,
}

/** One view inside a conversation — one call, one card. This slot lives on as long as it is kept, even as instances come and go */
type InlineView = {
  sessionId: string
  callId: string
  ref: AppRef
  tool: string
  uri: string
  /** The open instance. null once closed — the slot itself remains (for reopening) */
  instanceId: string | null
  /** The order it was opened in — the cap closes the oldest **open** one first. Reopening gets a new number */
  openedAt: number
  toolInput: Record<string, unknown>
  /** The call's outcome — neither exists while it is still running */
  toolResult: CallToolResult | null
  cancelled: string | null
  /** Whether it can be reopened — false if the outcome was too large or the app impersonated another view */
  kept: boolean
  /** The size being kept (counted against keptTotalMax) */
  bytes: number
}

export type InlineViewsDeps = {
  rt: ExternalApps
  views: ViewHost
  hub: SessionAppsHub
  /** The path an event is emitted through — on the host, the manager's record and broadcast (`SessionManager.recordAppView`) */
  emit: (e: AppViewEvent) => void
  log?: (line: string) => void
  limits?: Partial<InlineLimits>
}

/** A reopened view — what AppFrame resends per the spec (the input, and either the result or a cancellation) */
export type ReopenedView = {
  instanceId: string
  appId: string
  projectId: string | null
  tool: string
  toolInput: Record<string, unknown>
  toolResult?: CallToolResult
  cancelled?: string
}

/** Cannot be reopened — the reason is the message itself (it stands as is in the placeholder) */
function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 'internal' })
}

export class InlineViews {
  /** session → (card id → view) */
  private bySession = new Map<string, Map<string, InlineView>>()
  private byInstance = new Map<string, InlineView>()
  private stops: (() => void)[]
  private disposed = false
  private readonly log: (line: string) => void
  private readonly limits: InlineLimits
  private seq = 0
  private keptBytes = 0

  constructor(private deps: InlineViewsDeps) {
    this.log = deps.log ?? ((line) => console.error(line))
    this.limits = { ...DEFAULT_INLINE_LIMITS, ...deps.limits }
    this.stops = [
      deps.hub.onCall((c) => {
        this.onCall(c).catch((err: unknown) => this.log(`[apps] inline view failed: ${(err as Error)?.message ?? String(err)}`))
      }),
      deps.hub.onSessionGone((sessionId) => this.dropSession(sessionId)),
      deps.rt.onAppsChanged(() => this.recheckApps()),
    ]
  }

  /**
   * The UI took the view down (`apps.closeView`). true if it was a view inside a conversation —
   * closes the instance and releases the app. Any other instance (a fixed view) is closed by the
   * caller directly on ViewHost.
   */
  close(instanceId: string): boolean {
    const v = this.byInstance.get(instanceId)
    if (!v) return false
    this.shut(v)
    return true
  }

  /**
   * Reopens a collapsed view (RPC `apps.inlineReopen`) — **never calls the tool again.** Opens a
   * new instance and returns the input and outcome that were being kept (AppFrame resends them per
   * the spec). If the call is still running, it is returned without an outcome, and `result` or
   * `cancelled` arrives as usual once it finishes. If it is already open, this is that same
   * instance.
   *
   * Checks again whether the view belongs to that app — the app may have changed while collapsed.
   * Opening it applies the cap again (a different view may get closed). Fails with a reason if it
   * cannot be reopened.
   */
  async reopen(sessionId: string, callId: string): Promise<ReopenedView> {
    const v = this.bySession.get(sessionId)?.get(callId)
    if (!v || !v.kept) refuse("This view's result is no longer kept. Open the app instead")
    if (!v.instanceId) {
      const gone = this.unavailable(v.ref)
      if (gone) refuse(gone)
      // An app stopped after repeated failures does not start on its own — opening the view leaves nowhere to call it (Restart is on the fixed view)
      if (this.deps.rt.list().find((a) => a.appId === v.ref.appId && a.projectId === v.ref.projectId)?.status === 'failed') {
        refuse('This app stopped after failing repeatedly. Restart it, then reopen this view')
      }
      const refusal = await this.refusal(v.ref, v.uri)
      if (refusal) refuse(refusal)
      // While waiting, another side may have already opened it first
      if (!v.instanceId) {
        let instanceId: string
        try {
          instanceId = this.deps.views.open(v.ref, v.uri).instanceId
        } catch {
          refuse('This app is no longer available')
        }
        v.instanceId = instanceId
        v.openedAt = ++this.seq
        this.byInstance.set(instanceId, v)
        this.capLive(v.sessionId, v)
      }
    }
    return {
      instanceId: v.instanceId!,
      appId: v.ref.appId,
      projectId: v.ref.projectId,
      tool: v.tool,
      toolInput: v.toolInput,
      ...(v.toolResult ? { toolResult: v.toolResult } : {}),
      ...(v.cancelled !== null ? { cancelled: v.cancelled } : {}),
    }
  }

  /**
   * The views held for one conversation (RPC `apps.inlineViews`) — the basis (`kept`) a reopened UI
   * uses to decide whether to offer "Reopen" on a past card's placeholder. Also reports an open
   * instance: since a reopened UI does not know that instance (there is no frame to resend the
   * input and result to), it is closed and the app released, and reopened again if the person wants
   * it. No body is carried — it arrives when reopened.
   */
  list(sessionId: string): { callId: string; appId: string; projectId: string | null; tool: string; kept: boolean; instanceId: string | null }[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
      .sort((a, b) => a.openedAt - b.openedAt)
      .map((v) => ({ callId: v.callId, appId: v.ref.appId, projectId: v.ref.projectId, tool: v.tool, kept: v.kept, instanceId: v.instanceId }))
  }

  /** Which session and which card this instance's view belongs to — null if it is not a view inside a conversation */
  owner(instanceId: string): { sessionId: string; callId: string; ref: AppRef; tool: string } | null {
    const v = this.byInstance.get(instanceId)
    return v ? { sessionId: v.sessionId, callId: v.callId, ref: v.ref, tool: v.tool } : null
  }

  /**
   * Takes back a view the previous host had open in a conversation, after a planned hand-over
   * (view-handover.ts; ViewHost has already opened the instance under its old id). Without this,
   * the instance would still serve its view but belong to no conversation: its messages would go
   * out as a fixed view's, to whichever conversation the caller named, and deleting the session
   * would not close it.
   *
   * The slot is **not kept for reopening.** Its input and result were never written down (see
   * InlineLimits), so once this view is closed its card offers "open app", as after any restart.
   * A conversation's live cap is not applied again: these were within it on the previous host.
   */
  adopt(v: { sessionId: string; callId: string; ref: AppRef; tool: string; uri: string; instanceId: string }): void {
    if (this.disposed || this.byInstance.has(v.instanceId)) return
    this.track({
      sessionId: v.sessionId,
      callId: v.callId,
      ref: { projectId: v.ref.projectId ?? null, appId: v.ref.appId },
      tool: v.tool,
      uri: v.uri,
      instanceId: v.instanceId,
      openedAt: ++this.seq,
      toolInput: {},
      toolResult: null,
      cancelled: null,
      kept: false,
      bytes: 0,
    })
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.stops) stop()
    for (const v of [...this.byInstance.values()]) this.shut(v)
    this.bySession.clear()
  }

  private async onCall(c: SessionAppCall): Promise<void> {
    /*
     * Does this tool have a view — checked against **the list the agent receives** (the model
     * tools). Exactly as the app declared it. Usually a list already read exists (the agent calls
     * only after receiving the list). If not, the call is already in the middle of starting the
     * app anyway, so that list is waited on.
     */
    const known = this.deps.rt.knownTools(c.ref, 'model') ?? (await this.deps.rt.tools(c.ref, 'model').catch(() => null))
    const def = known?.find((t) => t.name === c.tool)
    if (!def) return
    const ui = resourceUriOf(def)
    if (!ui.uri) return
    const callId = await c.callId
    const where = `${c.ref.projectId === null ? 'user' : c.ref.projectId.slice(0, 8)}/${c.ref.appId} ${c.tool}`
    if (!callId) {
      this.log(`[apps] ${where}: no conversation card matched this call — its view is not shown`)
      return
    }
    if (this.disposed) return
    const base = { type: 'app_view', sessionId: c.sessionId, callId, appId: c.ref.appId, projectId: c.ref.projectId, tool: c.tool } as const

    const refusal = await this.refusal(c.ref, ui.uri)
    if (refusal) {
      this.log(`[apps] ${where}: view rejected — ${refusal}`)
      this.deps.emit({ ...base, phase: 'rejected', reason: refusal })
      return
    }
    let instanceId: string
    try {
      instanceId = this.deps.views.open(c.ref, ui.uri).instanceId
    } catch (err) {
      // The app disappeared in the meantime — nothing was opened, so there is no view to report. The agent still receives the call's outcome
      this.log(`[apps] ${where}: view not opened — ${(err as Error).message}`)
      return
    }
    const v: InlineView = {
      sessionId: c.sessionId,
      callId,
      ref: c.ref,
      tool: c.tool,
      uri: ui.uri,
      instanceId,
      openedAt: ++this.seq,
      toolInput: c.args,
      toolResult: null,
      cancelled: null,
      kept: true,
      bytes: 0,
    }
    this.track(v)
    this.keep(v)
    this.deps.emit({ ...base, phase: 'open', instanceId, toolInput: c.args })
    // Only a handful of live views stay open — counted after this one opens (the one closed is the oldest open one)
    this.capLive(c.sessionId, v)

    const o = await c.outcome
    /*
     * If the result points at **a different view**, that is impersonation — per the spec, a view
     * comes from the tool's declaration, not from the result. This never reads that field of the
     * result, but a result trying to claim another app's view is never passed through to that view
     * as is either.
     */
    const claimed = o.result ? resultViewUri(o.result) : null
    if (claimed !== null && claimed !== ui.uri) {
      const reason = `This call's result points at ${claimed}, not at the screen its tool declares (${ui.uri})`
      this.log(`[apps] ${where}: view rejected — ${reason}`)
      this.shut(v)
      this.forget(v)
      this.deps.emit({ ...base, phase: 'rejected', reason })
      return
    }
    if (o.result) v.toolResult = o.result
    else v.cancelled = o.error ?? `The call ended without an answer (${o.status})`
    const kept = this.keep(v)
    if (o.result) this.deps.emit({ ...base, phase: 'result', toolResult: o.result, kept })
    else this.deps.emit({ ...base, phase: 'cancelled', reason: v.cancelled!, kept })
  }

  /**
   * Recomputes the size being kept, and keeps it within the cap. Returns true if it is kept.
   *
   * If one call exceeds the cap, its input and outcome are discarded and the slot is left as
   * unable to be reopened (an already-open view lives on as is — nothing already given to a view is
   * ever taken back from it). If the per-conversation or total cap is exceeded, the oldest **slot
   * without an open instance** is dropped first — dropping the slot of an open view would leave the
   * message it sends (ui/message) with no owner.
   */
  private keep(v: InlineView): boolean {
    this.keptBytes -= v.bytes
    v.bytes = 0
    if (v.kept) {
      const bytes = jsonLength(v.toolInput) + (v.toolResult ? jsonLength(v.toolResult) : 0) + (v.cancelled?.length ?? 0)
      if (bytes > this.limits.keptCallMax) {
        v.kept = false
        this.log(`[apps] ${v.ref.appId} ${v.tool}: this call's view is too large to keep for reopening (${bytes} characters)`)
      } else v.bytes = bytes
    }
    // A slot that is not kept discards its body — a slot that can never be reopened has no reason to hold onto memory
    if (!v.kept) {
      v.toolInput = {}
      v.toolResult = null
    }
    this.keptBytes += v.bytes
    const mine = this.bySession.get(v.sessionId)
    if (mine) {
      const spare = [...mine.values()].filter((x) => !x.instanceId).sort((a, b) => a.openedAt - b.openedAt)
      while (mine.size > this.limits.keptPerSession && spare.length) this.forget(spare.shift()!)
    }
    if (this.keptBytes > this.limits.keptTotalMax) {
      const spare = [...this.bySession.values()]
        .flatMap((m) => [...m.values()])
        .filter((x) => !x.instanceId && x.bytes > 0)
        .sort((a, b) => a.openedAt - b.openedAt)
      while (this.keptBytes > this.limits.keptTotalMax && spare.length) this.forget(spare.shift()!)
    }
    return v.kept && !!this.bySession.get(v.sessionId)?.has(v.callId)
  }

  /** Drops the slot (the instance is closed by the caller first) */
  private forget(v: InlineView): void {
    const mine = this.bySession.get(v.sessionId)
    if (mine?.get(v.callId) !== v) return
    mine.delete(v.callId)
    if (mine.size === 0) this.bySession.delete(v.sessionId)
    this.keptBytes -= v.bytes
    v.bytes = 0
  }

  /**
   * Keeps one conversation's live views within the cap — closes and reports (`closed`) the oldest
   * open one first. The UI sends that view a teardown and collapses it into a placeholder. The view
   * just opened is never the one closed.
   */
  private capLive(sessionId: string, keep: InlineView): void {
    const open = [...(this.bySession.get(sessionId)?.values() ?? [])].filter((x) => x.instanceId).sort((a, b) => a.openedAt - b.openedAt)
    const n = this.limits.livePerSession
    for (const old of open.slice(0, Math.max(0, open.length - n))) {
      if (old === keep) continue
      this.shut(old)
      this.deps.emit({
        type: 'app_view',
        sessionId,
        callId: old.callId,
        appId: old.ref.appId,
        projectId: old.ref.projectId,
        tool: old.tool,
        phase: 'closed',
        reason: `Only the ${n} most recent app views in a conversation stay open`,
      })
    }
  }

  /**
   * Does this view belong to this app — its `ui://` has to be in the resource list that app
   * serves. The document is only ever read from the instance's own app anyway (ViewHost), but a
   * declaration claiming someone else's name is cut off here with a recorded reason: the person
   * building the app needs to know why the view is not opening. A resource template is not
   * accepted (v1).
   */
  private async refusal(ref: AppRef, uri: string): Promise<string | null> {
    let listed: { uri: string }[]
    try {
      listed = await this.deps.rt.listResources(ref)
    } catch (err) {
      return `Could not check this app's screens: ${(err as Error).message.split('\n')[0]}`
    }
    if (listed.some((r) => r.uri === uri)) return null
    return `This app does not serve ${uri}. A tool may only show its own app's screen`
  }

  private track(v: InlineView): void {
    let mine = this.bySession.get(v.sessionId)
    if (!mine) this.bySession.set(v.sessionId, (mine = new Map()))
    const prev = mine.get(v.callId)
    if (prev) {
      this.shut(prev)
      this.forget(prev)
      mine = this.bySession.get(v.sessionId) ?? new Map()
      this.bySession.set(v.sessionId, mine)
    }
    mine.set(v.callId, v)
    if (v.instanceId) this.byInstance.set(v.instanceId, v)
  }

  /** Closes the instance (releases the app). The record remains. Calling this twice still closes it once */
  private shut(v: InlineView): void {
    if (!v.instanceId) return
    this.byInstance.delete(v.instanceId)
    this.deps.views.close(v.instanceId)
    v.instanceId = null
  }

  /**
   * The reason this app's view cannot be rendered — the app disappeared, its project is no longer
   * trusted, or its manifest is broken. Since a view's HTML is also that app's code, all three cases
   * close the view and never reopen it (the same rule as the fixed view, B-2). A crashed or stopped
   * app is not one of these — the view's next call restarts the app. The reason is written in plain
   * language, since it stands as is in the view.
   */
  private unavailable(ref: AppRef): string | null {
    const info = this.deps.rt.list().find((a) => a.appId === ref.appId && a.projectId === ref.projectId)
    if (!info) return 'This app was removed'
    if (info.status === 'untrusted') return "This app's project is no longer trusted"
    // An imported app waiting for review (E-3) — if what runs after enabling it changed, the view's HTML is also code from before the person reviewed it again
    if (info.status === 'unconfirmed') return info.error ?? 'This imported app is not enabled'
    if (info.status === 'invalid') return `This app's manifest is invalid: ${info.error ?? 'unknown error'}`
    return null
  }

  /** A session was deleted — closes and forgets all of that session's views. There is no conversation left to notify */
  private dropSession(sessionId: string): void {
    const mine = this.bySession.get(sessionId)
    if (!mine) return
    for (const v of [...mine.values()]) {
      this.shut(v)
      this.forget(v)
    }
    this.bySession.delete(sessionId)
  }

  /**
   * The app disappeared or can no longer run — closes any open view and reports the reason. Since
   * a view's HTML is also that app's code, the view of a project that lost trust is never kept
   * rendered (the same rule as the fixed view, B-2). A crashed or stopped app is not closed —
   * the view's next call restarts the app.
   */
  private recheckApps(): void {
    if (this.byInstance.size === 0) return
    for (const v of [...this.byInstance.values()]) {
      const reason = this.unavailable(v.ref)
      if (!reason) continue
      this.shut(v)
      this.deps.emit({
        type: 'app_view',
        sessionId: v.sessionId,
        callId: v.callId,
        appId: v.ref.appId,
        projectId: v.ref.projectId,
        tool: v.tool,
        phase: 'closed',
        reason,
      })
    }
  }
}

/** The length written as JSON — the ruler used to measure the size being kept. An unwritable value counts as infinite (never kept) */
function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The view the result points at (`_meta.ui.resourceUri`, or the old shape `_meta["ui/resourceUri"]`) — null if absent */
function resultViewUri(result: CallToolResult): string | null {
  const meta = result._meta as { ui?: { resourceUri?: unknown }; 'ui/resourceUri'?: unknown } | undefined
  const raw = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri']
  return raw === undefined || raw === null ? null : String(raw)
}

/**
 * The host's seam — main.ts and the tests wire this in with the same function. Listens for calls
 * on the manager's own attachment (hub), and emits events through the manager's record and
 * broadcast path. Call this after the runtime has been attached to the manager (`useExternalApps`).
 */
export function attachInlineViews(
  mgr: { sessionAppsHub(): SessionAppsHub | null; recordAppView(e: AppViewEvent): void },
  rt: ExternalApps,
  views: ViewHost,
  opts: { log?: (line: string) => void; limits?: Partial<InlineLimits> } = {},
): InlineViews {
  const hub = mgr.sessionAppsHub()
  if (!hub) throw new Error('attachInlineViews: the session manager has no external apps (call useExternalApps first)')
  return new InlineViews({ rt, views, hub, emit: (e) => mgr.recordAppView(e), ...opts })
}

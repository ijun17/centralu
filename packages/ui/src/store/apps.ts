import { APP_VIEWS_LIVE_PER_SESSION } from '@cc/protocol'
import type { ExternalAppInfo, NormalizedEvent, StoredMessage } from '@cc/protocol'
import type { AppToolResult } from '@cc/platform/ports'
import type { AppState, InlineView, PinnedView, StoreGet, StoreSet } from './state.js'
import { externalAppKey, gridAppViewKey, isApp } from './appKeys.js'
import { returnsToPanel } from './screens.js'
import { reloadBudget } from './reloadBudget.js'
import { viewReconnect } from './viewReconnect.js'

/**
 * External apps in the store: the app list and its re-reads, the views an app stands in (a pinned
 * view, opened from the sidebar or the grid, and an in-conversation view under a tool call's card),
 * following an app to new code, and the capability questions apps ask. `appActions` holds the
 * store's actions for them; the rest is what those actions and the event handlers share.
 */

/** The number assigning the order things came alive — it only ever increases, across all sessions */
let inlineLiveSeq = 0

/**
 * Folds one host `app_view` event into a session's view history. Events that **close** a live view
 * (`closed`, or `rejected` on an already-open view) are not handled here — teardown must go first,
 * so those go through the store's own closing path (`closeInlineView`).
 */
export function applyAppView(views: Record<string, InlineView> | undefined, e: Extract<NormalizedEvent, { type: 'app_view' }>): Record<string, InlineView> {
  const cur = views?.[e.callId]
  const base = { callId: e.callId, appId: e.appId, projectId: e.projectId, tool: e.tool }
  const put = (v: InlineView) => ({ ...views, [e.callId]: v })
  switch (e.phase) {
    case 'open':
      return put({ ...base, state: 'live', instanceId: e.instanceId ?? null, toolInput: e.toolInput, kept: true, liveAt: ++inlineLiveSeq })
    case 'result':
      return cur ? put({ ...cur, toolResult: e.toolResult as AppToolResult | undefined, kept: e.kept ?? cur.kept }) : (views ?? {})
    case 'cancelled':
      return cur ? put({ ...cur, cancelled: e.reason ?? 'The call ended without an answer', kept: e.kept ?? cur.kept }) : (views ?? {})
    case 'rejected':
      return put({
        ...(cur ?? { ...base, instanceId: null, liveAt: 0 }),
        state: cur?.state === 'live' || cur?.state === 'closing' ? cur.state : 'parked',
        rejected: e.reason ?? 'This view was refused',
        reason: e.reason,
        kept: false,
      })
    case 'closed':
      // Already closing or closed — just record the reason (the store closes it if it is still live)
      return cur && cur.state !== 'live' ? put({ ...cur, reason: cur.reason ?? e.reason }) : (views ?? {})
  }
}

/**
 * The frame of the in-conversation view currently drawn (M4 B-1) — a handle for sending teardown
 * before it closes.
 *
 * The view (`InlineView`) registers here while its frame is mounted, and unregisters when it comes
 * down. The store uses this to send teardown before closing, and the conversation list uses this to
 * know "this row has a drawn view" — the basis for holding that row before the virtual scroll can
 * drop it. The frame belongs to the DOM, so it is not kept in the store's state; each change only
 * bumps a counter (`inlineFramesVersion`) so the list re-renders.
 */
export type InlineFrame = { teardown(): Promise<unknown> }
export const inlineFrames = new Map<string, InlineFrame>()
export const inlineFrameKey = (sessionId: string, callId: string) => `${sessionId}\n${callId}`

/** Whether this card's view is currently drawn as a frame */
export function inlineFrameShown(sessionId: string, callId: string): boolean {
  return inlineFrames.has(inlineFrameKey(sessionId, callId))
}

/**
 * The frame of the pinned view currently drawn (M4 C-4) — the same reason as the in-conversation
 * view's handle. When the app comes up again with new code, the store reopens that view
 * (`reloadPinnedView`). Teardown must go out **before** it comes down (per spec), and the frame
 * belongs to the DOM, so the view is the one that registers and unregisters it.
 */
const pinnedFrames = new Map<string, InlineFrame>()

export function registerPinnedFrame(key: string, frame: InlineFrame): () => void {
  pinnedFrames.set(key, frame)
  return () => {
    if (pinnedFrames.get(key) === frame) pinnedFrames.delete(key)
  }
}

/**
 * The cap on how many times a single view can **automatically** reopen to follow new code (M4 C-4)
 * — this many within this window. Past the cap it stops reopening automatically and just marks it
 * "changed" for the person to press. See the comment on `followAppCode` for why.
 */
export const AUTO_RELOADS = 3
export const AUTO_RELOAD_WINDOW_MS = 60_000
const autoReloads = reloadBudget(AUTO_RELOADS, AUTO_RELOAD_WINDOW_MS)

/** The app's current code as reported by the list — `null` if unknown (never came up, or an old host) */
export function codeStampOf(apps: readonly ExternalAppInfo[], projectId: string | null, appId: string, machine?: string | null): string | null {
  return apps.find((a) => isApp(a, projectId, appId, machine))?.codeStamp ?? null
}

/**
 * The app came up again with new code — reopen that app's open views (M4 C-4). Runs every time the
 * list is re-read.
 *
 * When a builder session's turn ends, the host brings the app back up with new code. But an open
 * view's HTML is from when it was opened, so the app has changed while the screen in front of the
 * person is still the old one. The decision comes down to **a single fingerprint change**: if the
 * code that was up when the view was opened (`codeStamp`) differs from the list's current code, it is
 * stale HTML. An app that came back up with the same code (it died and came back, or was restarted)
 * has the same fingerprint, so nothing happens. If the fingerprint was unknown when the view opened
 * (the app came up for the first time at that instant), only the first value learned is recorded.
 *
 * A "changed" notification (`external_app_state_changed`) never reopens a view on its own. That
 * notification means a value inside the app changed, and the view re-reads it through its own state
 * tool — hooking a reopen onto that would create a loop, where a reopened view's first call fires
 * another notification.
 *
 * Even so, an app can keep coming back up with new code without pause — for an app that writes to its
 * own folder, a reopened view's `home` call can change the folder, and the host reflects that by
 * bringing it up yet again. So there is a cap on how many times a single view reopens on its own
 * (three within a minute). Past that, it only shows "changed" and waits for the person to press it —
 * the loop is broken by a human hand.
 */
function followAppCode(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void): void {
  const { externalApps, pinnedViews, inlineViews } = get()
  for (const pv of pinnedViews) {
    if (pv.phase !== 'open' || !pv.instanceId) continue
    const now = codeStampOf(externalApps, pv.projectId, pv.appId, pv.machine)
    if ((pv.codeStamp ?? null) === null) {
      if (now !== null) set((s) => ({ pinnedViews: s.pinnedViews.map((p) => (p.key === pv.key ? { ...p, codeStamp: now } : p)) }))
      continue
    }
    if (now === pv.codeStamp || pv.stale) continue
    if (autoReloads.allow(`pinned\n${pv.key}`)) void get().reloadPinnedView(pv.key)
    else set((s) => ({ pinnedViews: s.pinnedViews.map((p) => (p.key === pv.key ? { ...p, stale: true } : p)) }))
  }
  for (const [sessionId, views] of Object.entries(inlineViews)) {
    for (const v of Object.values(views)) {
      if (v.state !== 'live' || !v.instanceId) continue
      const now = codeStampOf(externalApps, v.projectId, v.appId, get().sessions[sessionId]?.machine)
      const patch = (next: Partial<InlineView>) =>
        set((s) => {
          const cur = s.inlineViews[sessionId]?.[v.callId]
          return cur ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [v.callId]: { ...cur, ...next } } } } : {}
        })
      if ((v.codeStamp ?? null) === null) {
        if (now !== null) patch({ codeStamp: now })
        continue
      }
      if (now === v.codeStamp || v.stale) continue
      if (autoReloads.allow(`inline\n${sessionId}\n${v.callId}`)) void get().reloadInlineView(sessionId, v.callId)
      else patch({ stale: true })
    }
  }
}

/**
 * Keeps a conversation's live views within the cap (`APP_VIEWS_LIVE_PER_SESSION`) — closes the
 * longest-live one first. Never closes the view that just came alive. The host keeps the same cap,
 * so both sides usually close the same view together — because there is only one path to closing
 * (only a live view is closed), it is never closed twice.
 */
export function capInlineViews(get: () => AppState, sessionId: string, keep: string): void {
  const live = Object.values(get().inlineViews[sessionId] ?? {})
    .filter((v) => v.state === 'live')
    .sort((a, b) => a.liveAt - b.liveAt)
  const over = live.length - APP_VIEWS_LIVE_PER_SESSION
  for (const v of live.slice(0, Math.max(0, over))) {
    if (v.callId === keep) continue
    void get().closeInlineView(sessionId, v.callId, `Only the ${APP_VIEWS_LIVE_PER_SESSION} most recent app views in a conversation stay open`)
  }
}

/**
 * A queue for re-reading the external app list (M4 A-8). If another "changed" arrives while a read
 * is in flight, it reads once more after the current one finishes. Overlapping reads can let a
 * late-departing answer arrive first, letting an old list overwrite the new one. This actually
 * overlaps while an app is coming up, since broadcasts arrive back to back (coming up → up).
 */
let externalAppsReading: Promise<void> | null = null
let externalAppsAgain = false

/**
 * An in-conversation app view's slot within conversation history (M4 B-1). History only says "some
 * app's view stood under this card (or was rejected)" — no input, no result. So a past card only ever
 * shows a placeholder. Whether it can be reopened (`kept`) is unknown until the host is asked: if the
 * host has already come back up, it is holding nothing. If the same card has both an open and a
 * rejection (the result pointed at someone else's view), the rejection wins as the later row.
 */
export function inlineViewsFromHistory(msgs: StoredMessage[]): Record<string, InlineView> {
  const out: Record<string, InlineView> = {}
  for (const m of msgs) {
    if (m.kind !== 'app_view') continue
    const p = m.payload as { callId?: unknown; appId?: unknown; projectId?: unknown; tool?: unknown; phase?: unknown; reason?: unknown }
    if (typeof p?.callId !== 'string' || typeof p.appId !== 'string') continue
    const base: InlineView = {
      callId: p.callId,
      appId: p.appId,
      projectId: typeof p.projectId === 'string' ? p.projectId : null,
      tool: typeof p.tool === 'string' ? p.tool : '',
      state: 'parked',
      instanceId: null,
      kept: false,
      liveAt: 0,
    }
    const reason = typeof p.reason === 'string' ? p.reason : undefined
    out[p.callId] = p.phase === 'rejected' ? { ...base, rejected: reason ?? 'This view was refused', reason } : base
  }
  return out
}

/** Adds slots read from history — never touches a card this UI already knows about (a live one, or one this UI closed) */
export function mergeInlineHistory(
  all: Record<string, Record<string, InlineView>>,
  sessionId: string,
  past: Record<string, InlineView>,
): Record<string, Record<string, InlineView>> {
  if (Object.keys(past).length === 0) return all
  return { ...all, [sessionId]: { ...past, ...all[sessionId] } }
}

/**
 * Asks the host which views it is still holding for this conversation, and fixes up the placeholders
 * (M4 B-1, `apps.inlineViews`).
 *
 * A held card gains "Reopen"; a discarded one loses it. Among instances left open that this UI is not
 * drawing, it closes them — a UI that reopened does not know that frame (it has no input or result to
 * send), and leaving it open lets that instance keep holding onto the app. If the person wants it
 * back, "Reopen" opens a fresh one. If it could not even ask (an old host), the placeholder only
 * offers the path to open the app.
 */
export async function syncInlineViews(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void, sessionId: string): Promise<void> {
  const platform = get().platform
  if (!platform) return
  let kept: Awaited<ReturnType<typeof platform.apps.inlineViews>>
  try {
    kept = await viewReconnect(platform, () => platform.apps.inlineViews(sessionId))
  } catch {
    return
  }
  if (kept.length === 0) return
  set((s) => {
    const mine = { ...s.inlineViews[sessionId] }
    for (const k of kept) {
      const cur = mine[k.callId]
      if (cur && cur.state !== 'parked') continue
      mine[k.callId] = {
        ...(cur ?? { callId: k.callId, appId: k.appId, projectId: k.projectId, tool: k.tool, state: 'parked' as const, instanceId: null, liveAt: 0 }),
        kept: k.kept && !cur?.rejected,
      }
    }
    return { inlineViews: { ...s.inlineViews, [sessionId]: mine } }
  })
  for (const k of kept) {
    if (!k.instanceId || releasedOrphans.has(k.instanceId)) continue
    const cur = get().inlineViews[sessionId]?.[k.callId]
    if (cur?.reopening) continue
    if (cur && cur.state !== 'parked' && cur.instanceId === k.instanceId) continue
    // Between two reads of history (before an earlier close has reached the host), the same instance is never closed twice — an instance id is never reused
    const id = k.instanceId
    releasedOrphans.add(id)
    void platform.apps
      .closeView(id)
      .catch(() => {})
      .finally(() => releasedOrphans.delete(id))
  }
}

/**
 * Claims this window's pinned views after a reconnect (#392).
 *
 * The host leases a pinned view to the connection that opened it, and closes it a few minutes after
 * that connection ends unless a window claims it, so a reloaded or closed window does not hold its
 * apps open for good. This window is still here, so it claims what it shows. A view the host no
 * longer has (the window was away longer than the host waited) goes back to idle, which opens it
 * again, as after a restart. An older host has no such call and never closes a view on its own, so
 * a failure here leaves everything as it is.
 */
export async function holdPinnedViews(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void): Promise<void> {
  const platform = get().platform
  const held = get().pinnedViews.flatMap((p) => (p.phase === 'open' && p.instanceId ? [p.instanceId] : []))
  if (!platform || held.length === 0) return
  let missing: string[]
  try {
    missing = await viewReconnect(platform, () => platform.apps.holdViews(held))
  } catch {
    return
  }
  if (missing.length === 0) return
  const gone = new Set(missing)
  set((s) => ({
    pinnedViews: s.pinnedViews.map((p) =>
      p.instanceId && gone.has(p.instanceId)
        ? { ...p, phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null, codeStamp: null, stale: false }
        : p,
    ),
  }))
}

/**
 * An instance left open that a reopened UI is closing (`syncInlineViews`). Held only while its close is on its way:
 * once the host has answered, it no longer lists the instance, and one it still lists is open and closed again. Kept
 * for good, this grew by one id per orphan for the life of the window (#392).
 */
const releasedOrphans = new Set<string>()

/** The store's actions for external apps */
type AppActions = Pick<
  AppState,
  | 'refreshExternalApps'
  | 'setAppShared'
  | 'removeUserApp'
  | 'refreshAppQuestions'
  | 'answerAppQuestion'
  | 'closeInlineView'
  | 'reopenInlineView'
  | 'sendViewMessage'
  | 'openApp'
  | 'takeBuilderPaneFor'
  | 'ensurePinnedView'
  | 'ensureGridAppView'
  | 'dismissPinnedView'
  | 'leavePinnedView'
  | 'startPinnedView'
  | 'releasePinnedView'
  | 'closeApp'
  | 'restartApp'
  | 'reloadPinnedView'
  | 'reloadInlineView'
  | 'createApp'
>

export const appActions = (set: StoreSet, get: StoreGet): AppActions => ({
  async refreshExternalApps() {
    const platform = get().platform
    if (!platform) return
    if (externalAppsReading) {
      externalAppsAgain = true
      return externalAppsReading
    }
    externalAppsReading = (async () => {
      do {
        externalAppsAgain = false
        try {
          const externalApps = await platform.apps.list()
          set({ externalApps })
          get().pruneFoldedGroups()
          // If an app came up again with new code, reopen that app's open views (M4 C-4)
          followAppCode(get, set)
        } catch {
          // If it cannot be read, the old list stays — the next broadcast or reconnect re-reads it
        }
      } while (externalAppsAgain)
    })().finally(() => {
      externalAppsReading = null
    })
    return externalAppsReading
  },

  async setAppShared(projectId, appId, shared) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.apps.setShared(appId, projectId, shared)
    } catch (e) {
      set({ toast: `Could not change sharing: ${(e as Error).message}` })
    }
  },

  async removeUserApp(appId, machine) {
    const platform = get().platform
    if (!platform) return false
    try {
      await platform.apps.remove(appId, null, machine ?? undefined)
      return true
    } catch (e) {
      set({ toast: `Could not remove the app: ${(e as Error).message}` })
      return false
    }
  },

  async refreshAppQuestions() {
    const platform = get().platform
    if (!platform) return
    try {
      const appQuestions = await platform.apps.questions()
      set((s) => ({ appQuestions, appQuestionsVersion: s.appQuestionsVersion + 1 }))
    } catch {
      // If it cannot be read, the old list stays — the next broadcast or reconnect re-reads it
    }
  },

  async answerAppQuestion(questionId, decision) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.apps.answerQuestion(questionId, decision)
    } catch (e) {
      set({ toast: (e as Error).message || 'Could not answer the question' })
    }
    // Whether the answer landed or not (already closed), align to the list the host knows — so an answered question does not linger on screen
    await get().refreshAppQuestions()
  },

  async closeInlineView(sessionId, callId, reason) {
    const v = get().inlineViews[sessionId]?.[callId]
    if (!v || v.state !== 'live') return
    const patch = (next: Partial<InlineView>) =>
      set((s) => {
        const cur = s.inlineViews[sessionId]?.[callId]
        return cur ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [callId]: { ...cur, ...next } } } } : {}
      })
    // Closing — the frame stays standing until teardown's answer comes back. A second close arriving in this window returns from the guard above
    patch({ state: 'closing', reason })
    await inlineFrames.get(inlineFrameKey(sessionId, callId))?.teardown().catch(() => {})
    // The session was deleted in the meantime (gone along with the whole screen), or another path already closed it
    if (get().inlineViews[sessionId]?.[callId]?.state !== 'closing') return
    /*
     * A placeholder draws neither the input nor the result, and reopening takes both from the host (#392). Kept
     * here, each parked card held its call's whole input and outcome (up to 256 KB each) for the life of the
     * window, and a long conversation parks one card per app call.
     */
    patch({ state: 'parked', instanceId: null, toolInput: undefined, toolResult: undefined })
    if (v.instanceId) void get().platform?.apps.closeView(v.instanceId).catch(() => {})
  },

  async reopenInlineView(sessionId, callId) {
    const platform = get().platform
    const v = get().inlineViews[sessionId]?.[callId]
    if (!platform || !v || v.state !== 'parked' || v.reopening || v.rejected || !v.kept) return
    const patch = (next: Partial<InlineView>) =>
      set((s) => {
        const cur = s.inlineViews[sessionId]?.[callId]
        return cur ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [callId]: { ...cur, ...next } } } } : {}
      })
    patch({ reopening: true })
    try {
      const r = await viewReconnect(platform, () => platform.apps.reopenInlineView(sessionId, callId))
      // If an outcome (from a call still running) arrived during the reopen, it is the newer one
      const now = get().inlineViews[sessionId]?.[callId]
      patch({
        state: 'live',
        instanceId: r.instanceId,
        toolInput: r.toolInput,
        toolResult: r.toolResult ?? now?.toolResult,
        cancelled: r.cancelled ?? now?.cancelled,
        reason: undefined,
        liveAt: ++inlineLiveSeq,
        // The code the new instance opens with (C-4) — reopened again if the list's fingerprint ever differs from this
        codeStamp: codeStampOf(get().externalApps, v.projectId, v.appId, get().sessions[sessionId]?.machine),
      })
      capInlineViews(get, sessionId, callId)
    } catch (e) {
      patch({ kept: false, reason: (e as Error).message })
    } finally {
      patch({ reopening: false })
    }
  },

  async sendViewMessage(sessionId, instanceId, text) {
    const platform = get().platform
    if (!platform) return false
    try {
      await platform.apps.sendViewMessage(sessionId, instanceId, text)
      return true
    } catch (e) {
      set({ toast: `Could not send the app's message: ${(e as Error).message}` })
      return false
    }
  },

  openApp(projectId, appId, opts) {
    // Only a user-folder app needs its machine named (#82); a project app's id already carries it
    const machine = projectId ? null : (opts?.machine ?? null)
    const key = externalAppKey(projectId, appId, machine)
    set((s) => ({
      view: 'app',
      focusedApp: machine ? { projectId, appId, machine } : { projectId, appId },
      ...(opts?.builder ? { builderPaneFor: key } : {}),
      // What is picked must be shown (the same rule as `focusSession`) — any covering wide surface is dismissed
      overlay: null,
      // Picking a screen = having passed the intro (the same reason as `setView`, #63)
      introSeen: true,
      ...(projectId ? { focusedProjectId: projectId } : {}),
      pinnedViews: s.pinnedViews.some((p) => p.key === key)
        ? s.pinnedViews
        : [
            ...s.pinnedViews,
            { key, projectId, appId, ...(machine ? { machine } : {}), phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null },
          ],
    }))
    get().saveWorkspace()
  },

  takeBuilderPaneFor(key) {
    if (get().builderPaneFor === key) set({ builderPaneFor: null })
  },

  ensurePinnedView(projectId, appId) {
    const key = externalAppKey(projectId, appId)
    if (get().pinnedViews.some((p) => p.key === key)) return
    set((s) => ({
      pinnedViews: [
        ...s.pinnedViews,
        { key, projectId, appId, phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null },
      ],
    }))
  },

  ensureGridAppView(projectId, appId, machine) {
    // A linked machine's user-folder app opens on that machine (#82): the view carries it, as a pinned view does
    const own = projectId ? null : (machine ?? null)
    const key = gridAppViewKey(projectId, appId, own)
    if (get().pinnedViews.some((p) => p.key === key)) return
    set((s) => ({
      pinnedViews: [
        ...s.pinnedViews,
        { key, projectId, appId, ...(own ? { machine: own } : {}), phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null },
      ],
    }))
  },

  async dismissPinnedView(key) {
    await pinnedFrames.get(key)?.teardown().catch(() => {})
    get().closeApp(key)
  },

  leavePinnedView(key) {
    const s = get()
    if (!returnsToPanel(s, key)) return false
    set({ view: 'focus', focusedApp: null })
    get().saveWorkspace()
    return true
  },

  async startPinnedView(key) {
    const platform = get().platform
    const pv = get().pinnedViews.find((p) => p.key === key)
    if (!platform || !pv || pv.phase !== 'idle') return
    const patch = (fn: (p: PinnedView) => PinnedView) =>
      set((s) => ({ pinnedViews: s.pinnedViews.map((p) => (p.key === key ? fn(p) : p)) }))
    patch((p) => ({ ...p, phase: 'opening', error: null }))
    try {
      const openKey = crypto.randomUUID()
      let recover = false
      const v = await viewReconnect(platform, () => {
        const reclaim = recover
        recover = true
        return platform.apps.openView(pv.appId, pv.projectId, pv.machine ?? undefined, openKey, reclaim)
      })
      /*
       * It was closed while opening (its slot is gone), or the app was blocked and returned to idle.
       * The instance just opened has nowhere to go — if it is not released, a view nobody sees ends up
       * holding onto the app forever (blocking idle-app teardown).
       */
      const now = get().pinnedViews.find((p) => p.key === key)
      if (!now || now.phase !== 'opening') {
        void platform.apps.closeView(v.instanceId).catch(() => {})
        return
      }
      // The code this instance was opened with — if the list's fingerprint ever differs from this, it is stale HTML (`followAppCode`)
      const codeStamp = codeStampOf(get().externalApps, pv.projectId, pv.appId, pv.machine)
      patch((p) => ({ ...p, phase: 'open', instanceId: v.instanceId, toolInput: v.toolInput, toolResult: v.toolResult, codeStamp }))
    } catch (e) {
      if (get().pinnedViews.find((p) => p.key === key)?.phase === 'opening') {
        patch((p) => ({ ...p, phase: 'failed', error: (e as Error).message }))
      }
    }
  },

  releasePinnedView(key) {
    const pv = get().pinnedViews.find((p) => p.key === key)
    if (!pv) return
    if (pv.instanceId) void get().platform?.apps.closeView(pv.instanceId).catch(() => {})
    set((s) => ({
      pinnedViews: s.pinnedViews.map((p) =>
        p.key === key ? { ...p, phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null, codeStamp: null, stale: false, updatedAt: null } : p,
      ),
    }))
  },

  closeApp(key) {
    const pv = get().pinnedViews.find((p) => p.key === key)
    if (!pv) return
    if (pv.instanceId) void get().platform?.apps.closeView(pv.instanceId).catch(() => {})
    set((s) => {
      const focused = !!s.focusedApp && externalAppKey(s.focusedApp.projectId, s.focusedApp.appId, s.focusedApp.machine) === key
      return {
        pinnedViews: s.pinnedViews.filter((p) => p.key !== key),
        ...(focused ? { focusedApp: null } : {}),
        // The view being watched was closed — returns to the session it had been viewing before (`focusedSessionId` is untouched)
        ...(focused && s.view === 'app' ? { view: 'focus' as const } : {}),
      }
    })
    get().saveWorkspace()
  },

  async restartApp(key) {
    const platform = get().platform
    const pv = get().pinnedViews.find((p) => p.key === key)
    if (!platform || !pv) return
    const patch = (fn: (p: PinnedView) => PinnedView) =>
      set((s) => ({ pinnedViews: s.pinnedViews.map((p) => (p.key === key ? fn(p) : p)) }))
    if (pv.instanceId) void platform.apps.closeView(pv.instanceId).catch(() => {})
    /*
     * Set to `restarting`, not `idle`. With `idle`, the view would reopen immediately (if the app can
     * be opened), and that open could reach the host before `restart` does. Then `restart` would tear
     * down the app just brought up, and the open would fail with "the app went down and startup
     * stopped." Reopening happens only after `restart` finishes.
     */
    // "Updated" is a message for a view that reopened with new code — it is never re-attached to a view the person just restarted themselves
    patch((p) => ({ ...p, phase: 'restarting', instanceId: null, toolInput: undefined, toolResult: undefined, error: null, codeStamp: null, stale: false, updatedAt: null }))
    try {
      // A linked machine's user-folder app (#82) is restarted on that machine
      await platform.apps.restart(pv.appId, pv.projectId, pv.machine ?? undefined)
      patch((p) => (p.phase === 'restarting' ? { ...p, phase: 'idle' } : p))
    } catch (e) {
      patch((p) => (p.phase === 'restarting' ? { ...p, phase: 'failed', error: `Could not restart: ${(e as Error).message}` } : p))
    }
  },

  async reloadPinnedView(key) {
    const platform = get().platform
    const pv = get().pinnedViews.find((p) => p.key === key)
    if (!platform || !pv || pv.phase !== 'open' || !pv.instanceId) return
    const instanceId = pv.instanceId
    // Notified before it comes down (per spec) — the view saves or cleans up during this window
    await pinnedFrames.get(key)?.teardown().catch(() => {})
    // It was closed in the meantime, or a different path (restart, losing trust) already brought it down first — that path's job
    if (get().pinnedViews.find((p) => p.key === key)?.instanceId !== instanceId) return
    void platform.apps.closeView(instanceId).catch(() => {})
    // Setting it to `idle` makes the view reopen it (if the app can be opened) — the same slot, a fresh instance. The new fingerprint is received once it opens
    set((s) => ({
      pinnedViews: s.pinnedViews.map((p) =>
        p.key === key
          ? { ...p, phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null, codeStamp: null, stale: false, updatedAt: Date.now() }
          : p,
      ),
    }))
  },

  async reloadInlineView(sessionId, callId) {
    const v = get().inlineViews[sessionId]?.[callId]
    if (!v || v.state !== 'live') return
    // If the host is not holding the input and outcome, it cannot be reopened — it is closed instead of left as stale HTML (the path to open the app is still there)
    if (!v.kept) return get().closeInlineView(sessionId, callId, 'Closed because the app now runs new code')
    await get().closeInlineView(sessionId, callId, "Reopening with the app's new code")
    await get().reopenInlineView(sessionId, callId)
    set((s) => {
      const cur = s.inlineViews[sessionId]?.[callId]
      return cur?.state === 'live'
        ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [callId]: { ...cur, stale: false, updatedAt: Date.now() } } } }
        : {}
    })
  },

  async createApp(spec) {
    const platform = get().platform
    if (!platform) throw new Error('Not connected to the host')
    // A refusal is thrown as is — the host's own message is the reason (an id already taken, an untrusted project). The window shows that message
    const made = await platform.apps.create(spec)
    const { app, builder } = made
    /*
     * Placed into the list immediately. The host also sends its own list broadcast
     * (`external_apps_changed`), but waiting for it would leave the sidebar without a row for a while
     * after the window closes, and the pinned view would see "no such app" (a pinned view only opens
     * an app that is in the list). Once the broadcast arrives, the whole list is re-read, so the row
     * set here is simply replaced by that answer.
     */
    set((s) => ({
      externalApps: s.externalApps.some((a) => a.appId === app.appId && a.projectId === app.projectId)
        ? s.externalApps
        : [...s.externalApps, app],
    }))
    void get().refreshExternalApps()
    // The builder session is also registered right away for the same reason — the same path as the host's `session_created`, so arriving twice still counts as once
    if (builder) get().dispatchEvent({ type: 'session_created', sessionId: builder.id, session: builder })
    get().openApp(app.projectId, app.appId)
    if (!builder) {
      set({ toast: `${app.name ?? app.appId} was made, but its builder session could not start: ${made.builderError ?? 'unknown reason'}` })
    }
    return made
  },
})

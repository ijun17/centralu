import { errorMessage, APP_VIEWS_LIVE_PER_SESSION } from '@cc/protocol/client'
import type { ExternalAppInfo, NormalizedEvent, StoredMessage } from '@cc/protocol/client'
import type { AppToolResult } from '@cc/platform/ports'
import type { AppState, InlineView, PinnedView, StoreGet, StoreSet } from './state.js'
import { gridAppViewKey, isApp } from './appKeys.js'
import { appKeyOf, noteAppArrivals } from '@cc/core'
import { usesLines } from './uses-lines.js'
import { appTitleOf } from './names.js'
import { returnsToPanel } from './screens.js'
import { reloadBudget } from './reloadBudget.js'
import { viewReconnect } from './viewReconnect.js'
import { coalescedRead } from './single-flight.js'

// External apps in the store: the list, pinned and in-conversation views, following new code, capability questions.

// The order views came alive, across all sessions
let inlineLiveSeq = 0

// Closing a live view is not done here: teardown goes first, through `closeInlineView`
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
 * Drawn in-conversation view frames (M4 B-1), registered by `InlineView`: the store sends teardown through them, and the
 * list holds a row with one against the virtual scroll. DOM, so outside state; `inlineFramesVersion` counts changes.
 */
export type InlineFrame = { teardown(): Promise<unknown> }
export const inlineFrames = new Map<string, InlineFrame>()
export const inlineFrameKey = (sessionId: string, callId: string) => `${sessionId}\n${callId}`

export function inlineFrameShown(sessionId: string, callId: string): boolean {
  return inlineFrames.has(inlineFrameKey(sessionId, callId))
}

// Drawn pinned view frames (M4 C-4), as above: teardown goes out before a view comes down (per spec)
const pinnedFrames = new Map<string, InlineFrame>()

export function registerPinnedFrame(key: string, frame: InlineFrame): () => void {
  pinnedFrames.set(key, frame)
  return () => {
    if (pinnedFrames.get(key) === frame) pinnedFrames.delete(key)
  }
}

// Automatic reopens of one view within the window below (M4 C-4); past it the view is only marked "changed"
const AUTO_RELOADS = 3
const AUTO_RELOAD_WINDOW_MS = 60_000
const autoReloads = reloadBudget(AUTO_RELOADS, AUTO_RELOAD_WINDOW_MS)

// null if unknown: never came up, or an old host
export function codeStampOf(apps: readonly ExternalAppInfo[], projectId: string | null, appId: string, machine?: string | null): string | null {
  return apps.find((a) => isApp(a, projectId, appId, machine))?.codeStamp ?? null
}

// `liveOnly` skips a view no longer live (the close and reopen steps patch parked and closing views on purpose)
export function patchInlineView(set: (fn: (s: AppState) => Partial<AppState>) => void, sessionId: string, callId: string, next: Partial<InlineView>, liveOnly = false): void {
  set((s) => {
    const cur = s.inlineViews[sessionId]?.[callId]
    return cur && (!liveOnly || cur.state === 'live') ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [callId]: { ...cur, ...next } } } } : {}
  })
}

/**
 * Reopens views whose `codeStamp` differs from the list's (M4 C-4), on every list read; an unknown stamp only learns the
 * first value. `external_app_state_changed` never reopens: a reopened view's first call would fire it again. An app that
 * writes its own folder can restart on each `home`, hence the cap: past it a person breaks the loop.
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
      const patch = (next: Partial<InlineView>) => patchInlineView(set, sessionId, v.callId, next)
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

// The host keeps the same cap and closes the same view; only a live view closes, so never twice
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
 * History holds no view's input or result, so a past card is a placeholder, `kept` unknown until the host is asked
 * (M4 B-1). A rejection after an open wins as the later row.
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

// Never touches a card this UI already knows (a live one, or one it closed)
export function mergeInlineHistory(
  all: Record<string, Record<string, InlineView>>,
  sessionId: string,
  past: Record<string, InlineView>,
): Record<string, Record<string, InlineView>> {
  if (Object.keys(past).length === 0) return all
  return { ...all, [sessionId]: { ...past, ...all[sessionId] } }
}

/**
 * Fixes the placeholders by what the host still holds (M4 B-1): a held card gains "Reopen". An instance left open that
 * this UI does not draw is closed, or it holds its app; an old host leaves only the path to open the app.
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
    // Not closed twice by two reads before the first close lands; instance ids are never reused
    const id = k.instanceId
    releasedOrphans.add(id)
    void platform.apps
      .closeView(id)
      .catch(() => {})
      .finally(() => releasedOrphans.delete(id))
  }
}

/**
 * The host closes a pinned view a few minutes after its connection ends unless claimed (#392). A view it no longer has
 * goes back to idle, which opens it again; an older host has no such call and never closes one.
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

// Only while the close is on its way: kept for good it grows by one id per orphan (#392)
const releasedOrphans = new Set<string>()

type AppActions = Pick<
  AppState,
  | 'refreshExternalApps'
  | 'dismissAppArrival'
  | 'setAppShared'
  | 'setAppOff'
  | 'removeUserApp'
  | 'refreshAppQuestions'
  | 'answerAppQuestion'
  | 'closeInlineView'
  | 'reopenInlineView'
  | 'sendViewMessage'
  | 'openApp'
  | 'takeBuilderPaneFor'
  | 'takeRunsPanelFor'
  | 'ensurePinnedView'
  | 'ensureGridAppView'
  | 'dismissPinnedView'
  | 'leavePinnedView'
  | 'startPinnedView'
  | 'releasePinnedView'
  | 'closeApp'
  | 'restartApp'
  | 'stopApp'
  | 'reloadPinnedView'
  | 'reloadInlineView'
  | 'createApp'
>

export const appActions = (set: StoreSet, get: StoreGet): AppActions => ({
  refreshExternalApps() {
    return coalescedRead(
      'externalApps',
      get,
      (platform) => platform.apps.list(),
      (externalApps) => {
        set({ externalApps })
        noteArrivals(get, set)
        get().pruneFoldedGroups()
        followAppCode(get, set)
      },
    )
  },

  async setAppShared(projectId, appId, shared) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.apps.setShared(appId, projectId, shared)
    } catch (e) {
      set({ toast: `Could not change sharing: ${errorMessage(e)}` })
    }
  },

  async setAppOff(projectId, appId, off) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.apps.setOff(appId, projectId, off)
    } catch (e) {
      const info = get().externalApps.find((a) => isApp(a, projectId, appId))
      set({ toast: `Could not turn ${info ? appTitleOf(info) : appId} ${off ? 'off' : 'on'}: ${errorMessage(e)}` })
    }
  },

  async removeUserApp(appId, machine) {
    const platform = get().platform
    if (!platform) return false
    try {
      await platform.apps.remove(appId, null, machine ?? undefined)
      return true
    } catch (e) {
      set({ toast: `Could not remove the app: ${errorMessage(e)}` })
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
      // The old list stays; the next broadcast or reconnect reads it again
    }
  },

  async answerAppQuestion(questionId, decision) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.apps.answerQuestion(questionId, decision)
    } catch (e) {
      set({ toast: errorMessage(e) || 'Could not answer the question' })
    }
    // Landed or not (already closed), the host's list is read, so an answered question does not linger
    await get().refreshAppQuestions()
  },

  async closeInlineView(sessionId, callId, reason) {
    const v = get().inlineViews[sessionId]?.[callId]
    if (!v || v.state !== 'live') return
    const patch = (next: Partial<InlineView>) => patchInlineView(set, sessionId, callId, next)
    // The frame stands until teardown answers; a second close meanwhile returns at the guard above
    patch({ state: 'closing', reason })
    await inlineFrames.get(inlineFrameKey(sessionId, callId))?.teardown().catch(() => {})
    // The session was deleted meanwhile, or another path closed it
    if (get().inlineViews[sessionId]?.[callId]?.state !== 'closing') return
    // Reopening reads them from the host (#392); kept, a parked card holds input and outcome, up to 256 KB each
    patch({ state: 'parked', instanceId: null, toolInput: undefined, toolResult: undefined })
    if (v.instanceId) void get().platform?.apps.closeView(v.instanceId).catch(() => {})
  },

  async reopenInlineView(sessionId, callId) {
    const platform = get().platform
    const v = get().inlineViews[sessionId]?.[callId]
    if (!platform || !v || v.state !== 'parked' || v.reopening || v.rejected || !v.kept) return
    const patch = (next: Partial<InlineView>) => patchInlineView(set, sessionId, callId, next)
    patch({ reopening: true })
    try {
      const r = await viewReconnect(platform, () => platform.apps.reopenInlineView(sessionId, callId))
      // An outcome that arrived during the reopen (a call still running) is the newer one
      const now = get().inlineViews[sessionId]?.[callId]
      patch({
        state: 'live',
        instanceId: r.instanceId,
        toolInput: r.toolInput,
        toolResult: r.toolResult ?? now?.toolResult,
        cancelled: r.cancelled ?? now?.cancelled,
        reason: undefined,
        liveAt: ++inlineLiveSeq,
        // `followAppCode` compares the list's stamp with this (C-4)
        codeStamp: codeStampOf(get().externalApps, v.projectId, v.appId, get().sessions[sessionId]?.machine),
      })
      capInlineViews(get, sessionId, callId)
    } catch (e) {
      patch({ kept: false, reason: errorMessage(e) })
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
      set({ toast: `Could not send the app's message: ${errorMessage(e)}` })
      return false
    }
  },

  openApp(projectId, appId, opts) {
    // Only a user-folder app needs its machine named (#82); a project app's id already carries it
    const machine = projectId ? null : (opts?.machine ?? null)
    const key = appKeyOf(projectId, appId, machine)
    set((s) => ({
      view: 'app',
      focusedApp: machine ? { projectId, appId, machine } : { projectId, appId },
      ...(opts?.builder ? { builderPaneFor: key } : {}),
      ...(opts?.runs ? { runsPanelFor: key } : {}),
      // What is picked is shown, as in `focusSession`, and passes the intro, as in `setView` (#63)
      overlay: null,
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

  takeRunsPanelFor(key) {
    if (get().runsPanelFor === key) set({ runsPanelFor: null })
  },

  ensurePinnedView(projectId, appId) {
    const key = appKeyOf(projectId, appId)
    if (get().pinnedViews.some((p) => p.key === key)) return
    set((s) => ({
      pinnedViews: [
        ...s.pinnedViews,
        { key, projectId, appId, phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null },
      ],
    }))
  },

  ensureGridAppView(projectId, appId, machine) {
    // Only a user-folder app needs its machine named (#82)
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
      // Closed or blocked while opening: released, or an unseen view holds the app for good
      const now = get().pinnedViews.find((p) => p.key === key)
      if (!now || now.phase !== 'opening') {
        void platform.apps.closeView(v.instanceId).catch(() => {})
        return
      }
      const codeStamp = codeStampOf(get().externalApps, pv.projectId, pv.appId, pv.machine)
      patch((p) => ({ ...p, phase: 'open', instanceId: v.instanceId, toolInput: v.toolInput, toolResult: v.toolResult, codeStamp }))
    } catch (e) {
      if (get().pinnedViews.find((p) => p.key === key)?.phase === 'opening') {
        patch((p) => ({ ...p, phase: 'failed', error: errorMessage(e) }))
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
      const focused = !!s.focusedApp && appKeyOf(s.focusedApp.projectId, s.focusedApp.appId, s.focusedApp.machine) === key
      return {
        pinnedViews: s.pinnedViews.filter((p) => p.key !== key),
        ...(focused ? { focusedApp: null } : {}),
        // Back to the session viewed before (`focusedSessionId` is untouched)
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
     * `restarting`, not `idle`: an idle view reopens at once, and an open that reaches the host before `restart` would be
     * torn down by it. No "Updated" mark either: that is for a view that followed new code.
     */
    patch((p) => ({ ...p, phase: 'restarting', instanceId: null, toolInput: undefined, toolResult: undefined, error: null, codeStamp: null, stale: false, updatedAt: null }))
    try {
      await platform.apps.restart(pv.appId, pv.projectId, pv.machine ?? undefined)
      patch((p) => (p.phase === 'restarting' ? { ...p, phase: 'idle' } : p))
    } catch (e) {
      patch((p) => (p.phase === 'restarting' ? { ...p, phase: 'failed', error: `Could not restart: ${errorMessage(e)}` } : p))
    }
  },

  async stopApp({ key, appId, projectId, machine }) {
    const platform = get().platform
    if (!platform) return
    // Its open view closes first: it holds the app, and reopening would start it again
    if (get().pinnedViews.some((p) => p.key === key)) {
      await pinnedFrames.get(key)?.teardown().catch(() => {})
      get().closeApp(key)
    }
    try {
      await platform.apps.restart(appId, projectId, machine ?? undefined)
    } catch (e) {
      set({ toast: `Could not stop ${appId}: ${errorMessage(e)}` })
    }
  },

  async reloadPinnedView(key) {
    const platform = get().platform
    const pv = get().pinnedViews.find((p) => p.key === key)
    if (!platform || !pv || pv.phase !== 'open' || !pv.instanceId) return
    const instanceId = pv.instanceId
    // Teardown before it comes down (per spec), so the view can save or clean up
    await pinnedFrames.get(key)?.teardown().catch(() => {})
    // Another path (restart, lost trust) brought it down meanwhile
    if (get().pinnedViews.find((p) => p.key === key)?.instanceId !== instanceId) return
    void platform.apps.closeView(instanceId).catch(() => {})
    // `idle` makes the view reopen it: the same slot, a fresh instance
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
    // Not held by the host, it cannot reopen: closed rather than left as stale HTML
    if (!v.kept) return get().closeInlineView(sessionId, callId, 'Closed because the app now runs new code')
    await get().closeInlineView(sessionId, callId, "Reopening with the app's new code")
    await get().reopenInlineView(sessionId, callId)
    patchInlineView(set, sessionId, callId, { stale: false, updatedAt: Date.now() }, true)
  },

  dismissAppArrival(key) {
    if (!get().appArrivals.some((a) => a.key === key)) return
    set((s) => ({ appArrivals: s.appArrivals.filter((a) => a.key !== key) }))
    get().saveWorkspace()
  },

  async createApp(spec) {
    const platform = get().platform
    if (!platform) throw new Error('Not connected to the host')
    // A refusal is thrown as is: the host's message is the reason the window shows
    const made = await platform.apps.create(spec)
    const { app, builder } = made
    // An app the person made here is no news to them: seen before the list brings it (#1141)
    const madeIn = app.projectId
    if (madeIn && get().appsSeen[madeIn]) {
      const key = appKeyOf(madeIn, app.appId)
      set((s) => ({ appsSeen: { ...s.appsSeen, [madeIn]: [...new Set([...(s.appsSeen[madeIn] ?? []), key])].sort() } }))
    }
    // Listed at once, not at `external_apps_changed`: a pinned view opens only a listed app; the re-read replaces it
    set((s) => ({
      externalApps: s.externalApps.some((a) => isApp(a, app.projectId, app.appId, app.machine))
        ? s.externalApps
        : [...s.externalApps, app],
    }))
    void get().refreshExternalApps()
    // Through the host's `session_created` path, so arriving twice counts once
    if (builder) get().dispatchEvent({ type: 'session_created', sessionId: builder.id, session: builder })
    get().openApp(app.projectId, app.appId)
    if (!builder) {
      set({ toast: `${appTitleOf(app)} was made, but its builder session could not start: ${made.builderError ?? 'unknown reason'}` })
    }
    return made
  },
})

// The next read looks at the project afresh (#1141)
export function forgetArrivalsOf(get: StoreGet, set: StoreSet, projectId: string): void {
  const s = get()
  if (!(projectId in s.appsSeen) && !s.appArrivals.some((a) => a.projectId === projectId)) return
  const { [projectId]: _gone, ...seen } = s.appsSeen
  set({ appsSeen: seen, appArrivals: s.appArrivals.filter((a) => a.projectId !== projectId) })
  get().saveWorkspace()
}

// Each app a trusted project gained is an inbox notice once (#1141), saved with the workspace so a reload is silent
function noteArrivals(get: StoreGet, set: StoreSet): void {
  const s = get()
  const trusted = new Set(Object.values(s.projects).filter((p) => p.trusted).map((p) => p.id))
  const apps = s.externalApps.flatMap((a) =>
    a.projectId ? [{ key: appKeyOf(a.projectId, a.appId), projectId: a.projectId, appId: a.appId, title: appTitleOf(a), asks: a.uses ? usesLines(a.uses) : [] }] : [],
  )
  const { seen, arrived } = noteAppArrivals(apps, trusted, s.appsSeen, Date.now())
  const held = new Set(s.appArrivals.map((a) => a.key))
  const fresh = arrived.filter((a) => !held.has(a.key))
  const kept = s.appArrivals.filter((a) => trusted.has(a.projectId) && apps.some((x) => x.key === a.key))
  if (JSON.stringify(seen) === JSON.stringify(s.appsSeen) && fresh.length === 0 && kept.length === s.appArrivals.length) return
  set({ appsSeen: seen, appArrivals: [...kept, ...fresh] })
  get().saveWorkspace()
}

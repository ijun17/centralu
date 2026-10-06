import { create } from 'zustand'
import { APP_VIEWS_LIVE_PER_SESSION, DEFAULT_UI_PREFERENCES, SessionInfo, SUBAGENT_STEPS_PAGE, TEXT_SIZES, parseUiPreferences } from '@cc/protocol'
import type {
  AppQuestion,
  ToolStatus,
  Attachment,
  CommandRunInfo,
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  NormalizedEvent,
  SavedCommand,
  PermissionPreset,
  ProjectInfo,
  QuestionAnswer,
  StoredMessage,
  SubagentStep,
  ToolDefaults,
  ToolName,
  UiPreferences,
  UiPreferencesPatch,
  ThemeFileEntry,
  UpdateStatus,
  AgentVersions,
} from '@cc/protocol'
import {
  allDoneNotification,
  applyEvent,
  badgeCount,
  countWaiting,
  notificationFor,
  suggestMatcher,
  projectAccessQuestion,
  DEFAULT_NOTIFY_POLICY,
  type NotifyPolicy,
  bumpSeq,
  initialSession,
  markRead as markReadPure,
  rename as renamePure,
  appPanelId,
  appKeyOf,
  gridPanelKey,
  sanitizeGridSpan,
  withPanelSpan,
  gridSessionIds,
  sanitizeGridPanels,
  sanitizeArrangements,
  sessionPanelId,
  type ProjectArrangement,
  type SessionSummary,
} from '@cc/core'
import type { AppCreated, AppToolResult, ConnectionState, NewAppSpec, Platform, WorkspaceSnapshot } from '@cc/platform/ports'
import { isOnScreen } from '../app/onscreen.js'
import { activateTab, defaultLayout, sanitizeLayout, type PanelGroup, type PanelTab } from './panelLayout.js'
import { reloadBudget } from './reloadBudget.js'

/**
 * The store only does the wiring — all state-change logic lives in core (docs/state-management.md
 * §2). Commands go out through ports, and state updates come in only as events routed through the
 * core reducer (CQRS-lite: no optimistic updates).
 */

/**
 * The wide surface that covers the conversation. `null` means nothing is covering it.
 *  - viewer: a single file (`viewerPath`)
 *  - git: the whole of changes, history and branches. If `path` is given, it opens that file's
 *    diff first
 *
 * `pick` counts opens instead of naming one. The wide view now outlives the click that made
 * it — the change list beside it is no longer covered (#15), so it keeps being clicked while
 * the view is up. That makes "open this file" an **event**, not a state: two clicks on the
 * same row are two instructions, and the fields below are identical for both. Without a
 * number that moves, the second one is indistinguishable from no click at all.
 */
export type Overlay =
  | { kind: 'viewer' }
  | {
      kind: 'git'
      path?: string | null
      /** Which group was clicked — a partially staged file appears in both groups (#160) */
      staged?: boolean
      sha?: string | null
      sub?: 'changes' | 'history' | 'branches'
      pick: number
    }
  | null

/**
 * One higher than the last one opened. Coming from outside git resets it to 1 — panels opened
 * in between are appended fresh.
 */
const nextPick = (o: Overlay): number => (o?.kind === 'git' ? o.pick : 0) + 1

/**
 * The tab set and arrangement live in panelLayout.ts (#20) — the single `panelTab`
 * value became a group structure when the panel learned to split, and the reasoning
 * for what the tabs *are* (e.g. why `history` sits beside `git` rather than inside it,
 * #21) moved with the type. Re-exported so screens keep one import site for the store.
 */
export type { PanelGroup, PanelTab } from './panelLayout.js'

/**
 * A single thing that happened off screen.
 *
 * `sessionId` is the identity — if the same session finishes again, the card is updated rather
 * than added. That way one busy session cannot crowd out the rest, and the card count never
 * exceeds the session count.
 */
export type Notice = {
  sessionId: string
  kind: 'done' | 'approval' | 'error'
  /** The session's name at that moment — kept as written even if the session is renamed later */
  name: string
  at: number
}

/**
 * An attachment plus the bytes needed to display it.
 *
 * `data` is used only to render the image thumbnail — storage and transfer always go through the
 * path (D-1). When sending, the just-read bytes are already at hand, so they are filled in
 * without a round trip; after a restart, the host supplies the file again from `loadMessages`
 * (the same rule as the agent images in #40).
 */
export type ChatAttachment = Attachment & { data?: string }

/** Not yet sent. The text and attachments move together — binding only one to the session leaves
 * the pair half fixed */
export type Draft = { text: string; attachments: ChatAttachment[] }
export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** Limits on the evidence panel's width. Too narrow kills the path; too wide kills the conversation */
export const PANEL_MIN = 260
export const PANEL_MAX = 900
export const PANEL_DEFAULT = 340

/** Width of the session list (observation lane) */
/** The height "history" takes up in the git tab. "Changes" gets the rest */

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 480
export const SIDEBAR_DEFAULT = 240

/**
 * The five steps of overall text size (the middle one is the default) — the protocol's
 * `TEXT_SIZES`, since the size is a preference (`UiPreferences.textSize`, #312 step 5).
 *
 * The value is the root's CSS zoom factor. The alternative of scaling only the font (switching to
 * rem) would be a full rewrite, because every bit of text in this codebase is fixed in px
 * (text-xs…), and if only the text grows while the panel does not, line wrapping breaks first
 * in a narrow grid panel. Scaling the whole screen by the same factor is predictable instead,
 * because it follows the same rule as the OS's own display scaling.
 */
export const TEXT_SCALES = TEXT_SIZES

/**
 * The minimum width the conversation lane must keep.
 *
 * Without this, stretching both side panels squeezes the center down to zero and beyond, pushing
 * the whole layout past the window edge so the entire screen scrolls horizontally (this actually
 * happened during dogfooding). Worse, in that state the handle position calculation goes wrong,
 * creating feedback where dragging it makes it grow larger still.
 */
export const CENTER_MIN = 360

/**
 * Clamps to the width that can actually fit inside the window.
 *
 * Why `zoom` is needed (for overall text size): the layout width is in zoom coordinates, while
 * `window.innerWidth` is in **real pixels**. Without dividing by it, the available width gets
 * inflated at higher zoom and the layout is pushed past the window edge. The minimum width, on
 * the other hand, is **pinned to real pixels** — if it were allowed to grow with the zoom level up
 * to the point where the panel could be narrowed, raising the zoom in a narrow window would let
 * the panel eat the whole screen (per a dogfooding request: the minimum width stays fixed).
 */
function fitWidth(px: number, minReal: number, max: number, otherLane: number, zoom = 1): number {
  const winW = (typeof window === 'undefined' ? 1280 : window.innerWidth) / zoom
  const available = winW - otherLane - CENTER_MIN / zoom
  return Math.min(max, Math.max(Math.round(minReal / zoom), Math.round(Math.min(px, available))))
}

/**
 * The key for one external app. An app is identified by (project, id) — the `notes` app of two
 * different projects are two different apps. `_user` is the user-folder app; it matches the
 * host's scope name and never collides with a project id (a UUID).
 */
export function externalAppKey(projectId: string | null | undefined, appId: string): string {
  return appKeyOf(projectId, appId)
}

/**
 * The key of an app's view on the grid (#288) — a pinned view of its own, apart from the app's
 * pinned view (`externalAppKey`) that the app view and its project screen share.
 *
 * Owner decision (2026-10-04): the same app can stand in more than one place at once, and each
 * place is its own view while the app's process is shared. The grid and the project screen are
 * different screens with different lives — × on the grid must not tear down the view a person left
 * on the project screen, and the other way round — so the grid's entry is keyed apart. Everything
 * else about it is a pinned view's: opened by `home`, laid over its panel (`pinned-app/slots.ts`),
 * hidden rather than unloaded while another screen is looked at, followed to new code, and torn
 * down first whenever it goes. `grid:` cannot begin an app key, whose first segment is a project
 * id or `_user`.
 */
export function gridAppViewKey(projectId: string | null, appId: string): string {
  return `grid:${appKeyOf(projectId, appId)}`
}

/**
 * A single pinned view (M4 B-2) — an app opened from the sidebar. **It survives a focus change**:
 * going to look at a session and coming back leaves the same instance (same document, same view
 * state). It only comes down when closed or when the app disappears.
 *
 *   idle        Not opened yet (or the app has stopped and is waiting to be reopened). If the app
 *               can still be opened, the view opens.
 *   opening     The host is calling `home` — this covers the time the app takes to come up.
 *   open        The instance is up.
 *   failed      Failed to open — `error` says why.
 *   restarting  The person pressed "Restart" — the host is tearing the app down and clearing its
 *               state. When it finishes, it goes to `idle` and reopens.
 */
export type PinnedView = {
  key: string
  projectId: string | null
  appId: string
  phase: 'idle' | 'opening' | 'open' | 'failed' | 'restarting'
  instanceId: string | null
  toolInput: Record<string, unknown> | undefined
  toolResult: AppToolResult | undefined
  error: string | null
  /**
   * The app's code as of when this instance was opened (`ExternalAppInfo.codeStamp`, M4 C-4). If
   * the value in the app list differs from this, this view's HTML is stale — it is reopened
   * (`followAppCode`). `null` when unknown at open time; otherwise set to the first value learned.
   */
  codeStamp?: string | null
  /** When reopened with new code — the "Updated" badge in the header shows briefly */
  updatedAt?: number | null
  /**
   * The code changed again but it was not reopened automatically (it changed too often in too
   * short a span) — the person has to press to reopen it.
   */
  stale?: boolean
}

/**
 * A single in-conversation app view (M4 B-1) — a view that sits under a tool-call card. Its
 * lifetime is set by the host's `app_view` event (open → result/cancelled → closed).
 *
 *   live      The host has an instance open. If the card is on screen, its frame is drawn.
 *   closing   Being closed — teardown is sent to the drawn frame and its answer is awaited (per
 *             spec, this notice goes out **before** it comes down).
 *   parked    Only a placeholder stands. It says why it was parked (`reason`) and what can still
 *             be done (reopen, open the app).
 *
 * There is exactly one path to closing (`closeInlineView`): falling out of the virtual scroll, the
 * cap on live views, or the host closing it (the app disappeared, lost trust, or was impersonated),
 * or the frame failing to mount. Whoever closes it, teardown goes first.
 */
export type InlineView = {
  callId: string
  appId: string
  projectId: string | null
  tool: string
  state: 'live' | 'closing' | 'parked'
  instanceId: string | null
  toolInput?: Record<string, unknown>
  toolResult?: AppToolResult
  /** Ended without an answer — the view gets `tool-cancelled` with this reason instead of `tool-result` */
  cancelled?: string
  /** The view was not opened (impersonation blocked) — the reason. Such a view is given no way to reopen */
  rejected?: string
  /** Why it was parked as a placeholder */
  reason?: string
  /**
   * Whether the host holds this call's input and outcome so it can reopen **without calling the
   * tool again**. The host carries this in the outcome (`kept`). If reopening is refused this is
   * false, and the placeholder then offers only the path to open the app.
   */
  kept: boolean
  /** The order in which it came alive — the cap closes the longest-live view first (reopening gets a new number) */
  liveAt: number
  /** The app's code as of when it came alive — same meaning as the pinned view's field (`PinnedView.codeStamp`, M4 C-4) */
  codeStamp?: string | null
  /** When reopened with new code — the "Updated" badge on the title line shows briefly */
  updatedAt?: number
  /** The code changed again but it was not reopened automatically — the person has to press to reopen it */
  stale?: boolean
}

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
const inlineFrames = new Map<string, InlineFrame>()
const inlineFrameKey = (sessionId: string, callId: string) => `${sessionId}\n${callId}`

export function registerInlineFrame(sessionId: string, callId: string, frame: InlineFrame): () => void {
  const key = inlineFrameKey(sessionId, callId)
  inlineFrames.set(key, frame)
  useStore.setState((s) => ({ inlineFramesVersion: s.inlineFramesVersion + 1 }))
  return () => {
    if (inlineFrames.get(key) !== frame) return
    inlineFrames.delete(key)
    useStore.setState((s) => ({ inlineFramesVersion: s.inlineFramesVersion + 1 }))
  }
}

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
function codeStampOf(apps: readonly ExternalAppInfo[], projectId: string | null, appId: string): string | null {
  return apps.find((a) => a.appId === appId && a.projectId === projectId)?.codeStamp ?? null
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
    const now = codeStampOf(externalApps, pv.projectId, pv.appId)
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
      const now = codeStampOf(externalApps, v.projectId, v.appId)
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

/** The current scale (a `TEXT_SCALES` value). Used to convert between real pixels and zoom coordinates */
export function useTextZoom(): number {
  return useStore((s) => s.prefs.textSize)
}

export type ChatItem = (
  /**
   * pending: the UI drew this optimistically and has not yet gotten the host's confirmation
   * (`user_message`).
   * from: a message that another session sent, not the person (FR-11 — orchestrator instructions,
   * worker reports).
   */
  /**
   * attachments: things sent along with it. Images are drawn as real thumbnails (the successor to
   * the 📎 label — back when the label was mixed into the text, what was drawn and what was sent
   * could differ, causing a double render, #75).
   */
  | {
      kind: 'user'
      seq: number
      text: string
      attachments?: ChatAttachment[]
      pending?: boolean
      from?: { sessionId: string; name: string }
      /** A message sent by an in-conversation app view (M4 B-1) — the person chose to send it, but the app wrote it */
      fromApp?: { appId: string; projectId: string | null; name: string }
    }
  | { kind: 'assistant'; seq: number; text: string }
  /** A reasoning summary (#58). Only codex gives text — claude's thinking shows only through the session's thinkingTokens */
  | { kind: 'reasoning'; seq: number; text: string }
  /*
   * An image the agent produced (#40). Persisted as a file (under attachments/, referenced by path,
   * 500MB cap). If `data` is empty, `note` says why (failures are shown, not hidden).
   */
  | { kind: 'image'; seq: number; mime: string; data: string; path?: string; note?: string }
  /**
   * live: the tail of output while running (#58, codex outputDelta). Discarded once `result` comes
   * in — the full output lives in `result`.
   * callId: the name by which the result/output finds its own row (#98) — falls back to the old
   * positional rule (`ownerOf`) when absent.
   */
  | {
      kind: 'tool'
      seq: number
      tool: string
      title: string
      readOnly: boolean
      callId?: string
      result?: string
      ok?: boolean
      live?: string
    }
  | { kind: 'approval'; seq: number; requestId: string; summary: string; decision?: string }
  /**
   * A boundary marker for the conversation (e.g. a compaction point). A fact about the conversation, not part of it.
   * `notice` is there when the line is a tool's notice the host made readable (#342); `text` is then its one-line form.
   */
  | { kind: 'mark'; seq: number; text: string; notice?: NoticeLine }
) & {
  /**
   * The **number within the session** the host assigned when it stored this row (the store's
   * `messages.seq`, #79).
   *
   * This is a different number from `seq`. `seq` is the React key, and live items get theirs from
   * `chatSeq`, which is shared across all sessions. The history cursor (`history.oldestSeq`) and the
   * merge of history with live items go **only by this number**. If the render key were to leak
   * into the cursor, `loadOlder` would start reading from the wrong place: the first time the
   * session for an app's requested agent was opened, a stored 8-line session ended up with a
   * cursor of 48, and the whole conversation got appended a second time (measured 2026-09-25).
   *
   * Absent on rows that are never stored (like `message_image`, whose event carries no number, or
   * an optimistic message before confirmation). A merged message carries the number of its first chunk
   * — the same rule the host's `loadMessages` uses.
   */
  storedSeq?: number
}

/**
 * One launch card's subagent steps on screen (#222).
 *
 *   open     the section is expanded
 *   rows     the steps read so far, oldest first, by their number within the launch (`seq`)
 *   more     the host has more past `rows` than one page carried; live steps wait for those to be read
 *   loading  a page is being read
 *   error    why the last read failed, shown in place of the steps
 */
export type SubagentSteps = { open: boolean; rows: StoredMessage[]; more: boolean; loading: boolean; error: string | null }

export type AppState = {
  platform: Platform | null
  connection: ConnectionState
  /**
   * How many times the connection came back to a host that could not replay what was missed
   * (`resync_required`) — in practice another host lifetime: a restart, or a build switch behind
   * the keeper's front door (#280). An open app view asks for its address again on every change
   * (AppFrame): the new host may serve it at another address, or not at all.
   */
  hostResyncs: number
  projects: Record<string, ProjectInfo>
  /**
   * How many times, per project, we have heard "the working tree may have moved" (#160). Bumped
   * by one each time `refreshProjectGit` actually goes and asks. The evidence panel's change list,
   * history and collapsed strip hold their own lists, so they never heard a re-read that only
   * updated `project.git` (the sidebar's summary) — they now subscribe to this counter and re-read
   * together on turn end, window focus, approval, and branch switch.
   */
  gitEpoch: Record<string, number>
  sessions: Record<string, SessionSummary>
  /**
   * Which agent tools this machine has, as the host reports them.
   *
   * The screens that draw a row per tool used to read a `TOOL_META` constant compiled into
   * `@cc/protocol`, which meant the set of tools was fixed at build time and a new adapter
   * could not appear without editing the protocol. It arrives over the wire now, so it has
   * to be held somewhere every screen can reach — the chips in the sidebar need the label
   * and the mark synchronously, once per row.
   */
  tools: ToolStatus[]
  chat: Record<string, ChatItem[]>
  /**
   * Text not yet sent — kept **per session**.
   *
   * It used to be held by the composer component itself. That binds the text to the screen's spot
   * rather than to the session: switching sessions in the focus view reuses the same component, so
   * text written for A was still sitting in B's composer — sending it as is would **go to the
   * wrong session** (confirmed by measurement). Conversely, in the grid, which swaps out
   * components, the text vanished along with the unmounted component.
   *
   * Not put in the store's persisted snapshot. It is not heavy enough to need to survive the app
   * being closed and reopened.
   */
  drafts: Record<string, Draft>
  /**
   * Whether a conversation was left standing at its newest line — **per session** (#31).
   *
   * The flag used to be a ref inside the chat stream, so it was born `true` with every
   * mount, and the grid mounts and unmounts panels as you move around: look at another
   * session, come back, and the panel had decided for itself that you were at the bottom.
   * Fourth time state that belongs to the work has been kept by the view instead (drafts,
   * the elapsed count, expanded folders, this).
   *
   * Per session, and that is the opposite call from expanded folders (#16) on purpose. An
   * open folder is a fact about *the code*, so every session on that repo wants it; where
   * you are in a conversation is a fact about *that conversation*, and you read one at a
   * time.
   *
   * **What is kept is "were you at the bottom", not the offset.** A pixel `scrollTop`
   * restored into a virtualiser that has not measured its rows yet lands *near* the right
   * place — which is the symptom #31 reported, not a cure for it. The bottom needs no
   * measurements to be reachable: it is wherever the content ends.
   *
   * Absent means yes: a conversation nobody has scrolled starts at its newest line. Not
   * persisted — where you had scrolled to is not worth surviving the app closing.
   */
  stickToBottom: Record<string, boolean>
  /**
   * When a conversation was left somewhere other than the bottom, **which row and where in it** it
   * was showing (#61).
   *
   * The comment above, that no pixel offset is kept, is still true — pinning a raw `scrollTop` into
   * a virtualizer that has not yet measured its rows lands only *near* the right place. But that
   * conclusion had been read as "keep nothing at all," and the result was that any conversation not
   * at the bottom restarted from the top every time it was reopened (#61's "the scroll jumps to
   * the top").
   *
   * So what is kept is not a pixel but a **row**: the `seq` of the item spanning the top of the
   * screen, and the offset within that item. `seq` is a fact independent of measurement, so it
   * still points at the same row after remeasuring, and the remaining few pixels are re-fit every
   * frame while rows are being measured.
   *
   * Absent when the conversation was at the bottom — `stickToBottom` already says that, and the
   * bottom needs no measurement to be reached. Not persisted: how far one had read is not worth
   * carrying past the app closing.
   */
  scrollAnchor: Record<string, { seq: number; offset: number }>
  /**
   * When the turn a session is currently running started — the instant, per session.
   *
   * The "Waiting for response" line used to take `Date.now()` on mount and count up from
   * there, so switching views restarted the clock: a turn three minutes old read as if it
   * had just begun (issue #23). The component was holding the wrong half. **Elapsed time is
   * derived; the start instant is the fact.** Keeping the instant here means the count is
   * recomputed rather than resumed, and nothing depends on a component staying alive.
   *
   * Not `waitingSince`, which sounds like the same thing and is the opposite one: that is
   * when the session started waiting for *a human* (approval, input, error), and the
   * reducer sets it to null the moment a session goes back to `working` — precisely when
   * this line is on screen. Two clocks, because there are two directions of waiting.
   *
   * Not persisted. A turn does not survive the app closing.
   */
  workingSince: Record<string, number>
  /**
   * Which folders are expanded in the file tree — **per project** (issue #16).
   *
   * The tree rows used to hold this themselves, so it went away with the component: moving
   * between sessions collapsed everything and you dug down the same path again. Third time
   * we have made this mistake (drafts, the elapsed count, this).
   *
   * Per project, not per session, and the difference is not an accident. A draft is
   * something *you* were saying to *one* agent, so it belongs to that session. An expanded
   * folder is a fact about **the code** — `src/features/session` is where the work is no
   * matter which of that project's sessions you happen to be reading. Two sessions on the
   * same repo want the same tree open; two projects almost never do.
   *
   * **Not persisted, deliberately.** The complaint was "every time", and every time meant
   * every session switch — dozens an hour. A relaunch happens once a day, and it is exactly
   * the moment the tree is most likely to be wrong: branches moved, folders were deleted,
   * a worktree came and went. Restoring yesterday's paths would either quietly expand into
   * nothing or fire a listDir per stale path on first paint, which is the cost the lazy
   * tree exists to avoid. There is a mechanical reason too: the workspace snapshot is one
   * layout record written straight through to the host with no debounce, so persisting this
   * would mean an RPC per folder click. If a relaunch turns out to hurt, it can move there
   * later — but it should arrive as its own decision, not as a side effect of this one.
   */
  expandedDirs: Record<string, string[]>
  /**
   * Whether the file tree shows what `.gitignore` hides (issue #17).
   *
   * **Defaults to on.** It used to default to off, and that was the wrong way round for a
   * tree you open to *look at a file*: the file you want is often exactly the one git does
   * not track — a `.env`, a build artefact you are checking, a local note. A tree that
   * silently omits it does not read as filtered, it reads as "that file is not there", and
   * the toggle that would explain it is one line of small text you were not looking at.
   *
   * Still a toggle rather than always-on, because of *what* is behind it: not a curiosity
   * or two but `node_modules`, `dist`, `.next` — thousands of entries that sort in among
   * `src`. Whoever finds that unusable turns it off once, and it stays off. Shown rows read
   * in ink-faint, since "the repo does not track this" is background information, not urgency.
   *
   * **Global, and remembered** — unlike expanded folders, which belong to their project.
   * That difference is the point: an open folder is a fact about a repo, while this is a
   * way of looking, and a way of looking belongs to the person. It sits with panelOpen and
   * panelTab in the workspace snapshot for the same reason, and unlike a folder click it is
   * flipped rarely, so a write per flip costs nothing.
   */
  showIgnored: boolean
  /**
   * Whether to keep the composer folded in grid panels (user request, 2026-09-10).
   *
   * When on, each panel's composer stays folded down to **only the rounded card's top edge**, and
   * rises to **float over** the conversation when the mouse is over the bottom of the panel. The
   * conversation's height does not change, so the row being read is not pushed around. When off, it
   * stays expanded at all times, as before.
   */
  foldComposer: boolean
  /**
   * Whether to **let the spinning marker move** (user request, 2026-09-13). The grid panel border
   * and the sidebar session icon are independent of each other — they differ in size and position,
   * so they are distracting in different ways.
   *
   * When off, the marker does not disappear, it **stops**: the same rainbow stays, only the angle
   * is fixed. The message "this is currently running" is kept; only the motion is removed.
   *
   * The reason this setting exists is power draw, not taste. Measured (2026-09-13, WKWebView):
   * while one session was spinning, Centralu's total CPU usage dropped from 7.0% to 2.9%. Motion
   * that never rests pins the screen at its maximum refresh rate, and that cost is set not by *what*
   * is moving but by **whether anything is moving at all**.
   */
  spinGrid: boolean
  spinSessionIcon: boolean
  focusedSessionId: string | null
  /** Git, files and the viewer belong to the project — they must be viewable without a session */
  focusedProjectId: string | null
  /**
   * The project whose session-creation window is open (`null` means closed).
   *
   * This used to be local state on the sidebar panel, and was lifted into the store because **the
   * first-run screen needs to open this window.** The moment a project is created, the first-run
   * screen disappears (`App` branches on whether any project exists), so the only way for that
   * screen to hand off its next step is to reserve a window that will stand somewhere else, in
   * place of the screen that is about to disappear.
   */
  newSessionFor: string | null
  /**
   * A worktree suggestion from the manager (#69). Set by `propose_worktree_session`, and consumed
   * when that project's new-session window opens — the window comes up with the worktree toggle on
   * and the branch name filled in. The reason it is keyed to the project: letting it bleed into
   * another project's window would contaminate the suggestion.
   */
  /**
   * A queue (dogfooding for #69): when the manager suggested two branches back to back, a single
   * slot meant only the last one survived — the first suggestion had to be typed by hand after
   * reading the name off the conversation. Each time the window opens, it consumes that project's
   * oldest suggestion (FIFO).
   */
  worktreeProposals: { projectId: string; branch: string }[]
  /**
   * The orchestrator's MCP server suggestion (`propose_mcp_server` → the person's one-click approval
   * → the app registers it and restarts the orchestrator). The list here is a copy; the host holds
   * the truth.
   */
  mcpProposals: { name: string; command: string; args: string[]; why?: string }[]
  refreshMcpProposals(): Promise<void>
  /**
   * How many times, per external app, we have heard "the state changed" (M4 B-5). Keyed by
   * `externalAppKey`. The size of the value carries no meaning — only **the fact that it changed**
   * does. An open `AppFrame` reads this as `changeSignal` and sends the view
   * `centralu/notifications/changed`. Counted even when the app is not in the list. The store does
   * not know the external app list, and missing a signal while waiting for the list is worse.
   */
  externalAppChanges: Record<string, number>
  /**
   * The view instance whose call caused the last bump to that app's counter — only when the change
   * came from a call the view itself made, otherwise `null` (`external_app_state_changed.cause`).
   * `AppFrame` does not notify when the counter went up by exactly one and that one was its own.
   */
  externalAppChangedBy: Record<string, string | null>
  /**
   * How many times, per external app, we have heard "a row shown in the runs panel started or
   * finished" (M4 D-6, `external_app_runs_changed`). Keyed by `externalAppKey`. Read only by the
   * runs panel (`RunsPanel`) — it does not reach the view. Calls to read-only tools, and the chains
   * they start, also arrive here.
   */
  externalAppRunChanges: Record<string, number>
  /**
   * Discovered external apps and their state (M4 A-8) — a copy of the host's `apps.list`. The host
   * holds the source of truth: this is never edited here, only re-read in full when
   * `external_apps_changed` arrives. The list every screen reads (status, scope) is built from it by
   * `app-catalog.ts`.
   */
  externalApps: ExternalAppInfo[]
  refreshExternalApps(): Promise<void>
  /**
   * The theme files in the data folder's `themes/` (#312), as the host last read them —
   * re-read in full on `themes_changed` (a save from Settings, an editor, an agent).
   */
  themeFiles: ThemeFileEntry[]
  /**
   * The last version of each theme file that read cleanly. A file someone is halfway through
   * editing comes back broken; the screen keeps showing this version of it until it reads again,
   * rather than dropping to the preset mid-edit.
   */
  lastGoodThemes: Record<string, ThemeFileEntry>
  refreshThemes(): Promise<void>
  /**
   * Capability questions for chains started from a view (M4 D-4) — a copy of the host's
   * `apps.questions`. Re-read in full when `external_app_questions_changed` arrives, and on
   * reconnect. A question stands on the pinned view of the app that started the chain (`origin`),
   * and that app's sidebar row carries a badge. Questions for chains started from a session are not
   * here — they are that session's approval card instead.
   */
  appQuestions: AppQuestion[]
  /** How many times the questions changed — the signal for wherever remembered answers are shown (the runs panel) to re-read */
  appQuestionsVersion: number
  /** How many times a remembered cross-project consent was added or revoked (#371) — Settings re-reads its list on it */
  projectConsentsVersion: number
  refreshAppQuestions(): Promise<void>
  /** Answers a capability question — a failure (the question is already closed) is reported as a toast and the list is re-read */
  answerAppQuestion(questionId: string, decision: 'allow' | 'deny'): Promise<void>
  /**
   * Removes an app from the user folder (M4 A-7). The list follows from the host's broadcast. The
   * caller is confirmed first.
   * @returns whether it was removed — a failure is reported as a toast
   */
  removeUserApp(appId: string): Promise<boolean>
  /**
   * Shares a project app with the person's other projects, or stops (#371 part A). The list follows
   * from the host's broadcast; a failure is reported as a toast.
   */
  setAppShared(projectId: string, appId: string, shared: boolean): Promise<void>
  resolveMcpProposal(name: string, approve: boolean): Promise<void>
  /** The orchestrator's skill suggestion (#71) — the same suggest-then-one-click-approve rail */
  skillProposals: { name: string; content: string; why?: string }[]
  refreshSkillProposals(): Promise<void>
  resolveSkillProposal(name: string, approve: boolean): Promise<void>
  /**
   * Whether the new-session window opens with the worktree checkbox on (#69). Turned on by the `+`
   * on the manager's row, because a session created under a manager defaults to a worktree session.
   * Turning it off in the window is free (a preset, not a requirement).
   */
  newSessionWorktree: boolean
  /** The initial branch name for the new-session window (#69) — filled by a suggestion. An empty string means none */
  newSessionBranch: string
  /**
   * The oldest history point currently on screen, per session.
   * Conversation the model has forgotten to compaction still survives in our store, so this is
   * where reading further back starts from.
   */
  history: Record<string, { oldestSeq: number; more: boolean; loading: boolean }>
  /**
   * The steps of a native subagent, per session and launch card (#222) — present once the person has opened that
   * card's steps, and only then read from the host. Kept here rather than in the card, so a card the virtual list
   * detaches and draws again comes back as it was left (open, loaded), not collapsed and reading again.
   */
  subagentSteps: Record<string, Record<string, SubagentSteps>>
  /** Opens or closes a launch card's steps; the first opening reads them */
  toggleSubagentSteps(sessionId: string, callId: string): void
  /** Reads the next page of a launch card's steps */
  loadMoreSubagentSteps(sessionId: string, callId: string): Promise<void>
  /**
   * The session currently being woken up.
   *
   * Picking a session **wakes it immediately.** It used to wake on send, which piles the whole
   * process-startup time onto the time between turning the app on and the first response. Worse, a
   * sleeping session has no process to ask, so it cannot even hand back its slash-skill list. The
   * act of picking already means "I am about to use this session," so preparation starts right then.
   */
  resuming: Record<string, boolean>
  /**
   * **Why** waking it failed.
   *
   * This used to fail silently ("it will retry when sending anyway"). But the screen read "sending a
   * message will resume it automatically" while it actually would not resume, and the person had no
   * way to find out why (pointed out during dogfooding). No silent failures — the reason is written
   * right there.
   */
  wakeError: Record<string, string>
  /**
   * Whether waking it failed **because another side is holding it**.
   *
   * This is never decided by pattern-matching the reason text with a regex — the moment the wording
   * changes, that check breaks silently. The host sends this down as its own separate signal, and it
   * is simply carried as is. Only when this is true is "split off and continue" offered (that is the
   * only case where that path is actually open).
   */
  wakeLocked: Record<string, boolean>
  /**
   * Whether the evidence lane (git, files) is open.
   * Why it is a panel and not a tab: git status is not a screen that **replaces** the conversation,
   * it is **evidence** for what the conversation claims. Grouping things that are not alternatives
   * to each other into tabs produces "where do I see that?" (this actually came up during
   * dogfooding).
   */
  panelOpen: boolean
  /**
   * The tab arrangement (#20): groups stacked vertically, each an ordered tab list
   * plus its active tab. One group is the everyday panel; two is the split. Global —
   * one arrangement for the whole app, not per project — and carried in the workspace
   * snapshot, because the panel's shape is a way of looking, and a way of looking
   * belongs to the person (the same call as showIgnored, #17).
   */
  panelLayout: PanelGroup[]
  /**
   * The **share the top group takes** of the two vertically split groups (0.15–0.85, per a
   * dogfooding request). Meaningless with a single group. A fixed 50/50 split could not capture the
   * actual use of "the terminal can be narrow, but the diff needs to be wide" — the split ratio is
   * also a way of viewing, so it is carried in the snapshot.
   */
  panelSplit: number
  /**
   * Width of the evidence panel (px). Using the terminal makes people want to widen it, so it must be
   * adjustable
   */
  panelWidth: number
  /** Width of the session list (px) */
  sidebarWidth: number
  /**
   * Projects whose session list is folded (#205, user request 2026-09-28 — the sidebar got crowded
   * as projects grew in number).
   *
   * Remembered per project and carried in the workspace snapshot — the sidebar is a way of viewing
   * the whole app, and a way of viewing belongs to the person (the same call as `showIgnored`, #17).
   * The only door to folding is the arrow on the name row: the name is where the project screen is
   * opened from (#206), so doubling it as the fold control would always put one of the two purposes
   * at odds with the other.
   *
   * Folding does not hide the signal — the name row instead reports the number of sessions waiting
   * (the sidebar's `FoldSummary`).
   */
  foldedProjects: string[]
  /** Folds or unfolds that project's session rows (#205) */
  toggleProjectFold(projectId: string): void
  /** Unfolds only this project and folds all the rest (#205) — for focusing on one in a single move */
  foldOtherProjects(projectId: string): void
  /**
   * What the person did to each project's screen (#203): the order they dragged its panels into and
   * the panels they hid. The panels themselves are derived from what the project has (`arrangePanels`).
   *
   * Kept in the workspace snapshot, next to the fold above, rather than in a host table like the
   * grid's `grid_panels`. It is a way of looking at a project that only this UI reads and writes;
   * the host acts on none of it. Its ids are sessions *and* apps, which a table keyed to the
   * sessions table could not hold without its own cleanup rules for apps. And what the grid's
   * table buys — dropping a panel when its session goes — is already given here by deriving the
   * panels from the session list. Deleting a project drops its entry (`deleteProject`).
   */
  projectPanels: Record<string, ProjectArrangement>
  /** Writes one project's arrangement whole and saves the snapshot */
  arrangeProject(projectId: string, next: ProjectArrangement): void
  /**
   * The person's span for each app's panel on the grid (#306), keyed by `appKeyOf` — Settings → Apps. The default for
   * every placement of that app that has no span of its own (from the panel's top bar), and ahead of the app's own
   * recommendation (core's `resolveGridSpan`). An app with no entry takes its recommendation, else 1 × 1.
   *
   * Kept in the workspace snapshot, like `projectPanels`: a way of looking that only this UI reads, about an app the
   * host's tables do not key (a user-folder app has no project). The choice for one placement is on the placement
   * itself, in the host's grid table, because it goes when the panel goes.
   */
  appSpans: Record<string, GridSpan>
  /** Sets or clears (`null`) the person's span for an app, and saves the snapshot */
  setAppSpan(projectId: string | null, appId: string, span: GridSpan | null): void
  /**
   * Sets or clears (`null`) the span of one app panel on the grid, keyed by core's `gridPanelKey` — the panel's top bar
   * (#306). Saved with the grid, like a move.
   */
  setGridPanelSpan(key: string, span: GridSpan | null): Promise<void>
  /**
   * Per-project command run state — a projection of the host's `commands.state` (#60, moved into
   * the terminal panel). The host's buffer holds the log body; this only holds the facts a badge
   * needs to read (is it running, what did it end with). Why this lives in the store: "it is
   * running" is not only the run window's own concern, it is a fact the tab badge and the collapsed
   * strip must read too — the gap this piece exists to close is that leaving a dev server on and
   * moving away left no trace of it visible anywhere. Keyed projectId → command → last run.
   */
  commandRuns: Record<string, Record<string, CommandRunInfo>>
  /**
   * The wide surface. Code and diffs cannot be read in a 360px panel.
   * It covers the conversation and is dismissed with Escape — coming back, the conversation still
   * has its scroll position intact.
   */
  overlay: Overlay
  inboxOpen: boolean
  toast: string | null
  appFocused: boolean
  /**
   * The session that just finished responding — the trigger for one sweep of the screen.
   * `at` is kept alongside it because the sweep must fire **every time**, even when the same session
   * finishes twice in a row (it is used as a key).
   */
  completion: { sessionId: string; at: number } | null
  /**
   * Things that happened off screen — notification cards that pile up in the top right.
   *
   * **They do not disappear on their own.** An OS banner is dismissed after a few seconds, so
   * anything that arrived while the person was away is already gone by the time they get back. That
   * is the part a banner cannot cover for this app, so this stays. There are exactly three ways it is
   * dismissed: seeing that session, clicking the card to go there, or pressing ×.
   *
   * Only one is kept per session. If one busy session filled the screen, the rest would get buried.
   */
  notices: Notice[]
  /** The file the code viewer is showing (a project-relative path) */
  viewerPath: string | null
  /**
   * Which project that file belongs to — only when the side that opened it said so (#182). A file
   * link in the grid carries its own panel's project. Picking from the focused session, in a WKWebView
   * where a button click does not move focus, meant a link in an adjacent panel opened the same
   * relative path in the focused panel's project instead. `null` follows focus, as before.
   */
  viewerProjectId: string | null
  paletteOpen: boolean
  /**
   * The number of windows currently open (#158) — raised when a screen-covering layer like `Modal`
   * or the command window opens and lowered when it closes (`useOpenLayer`). A window's open state
   * is usually local state on that component, so the store has no other way to know. Without the
   * approval card's y/n/a checking this value, pressing y to confirm a "Delete this session?" window
   * had let through a command hidden behind it.
   */
  openLayers: number
  /**
   * Approval requests that have had a response sent but not yet answered (#158) — `requestId` →
   * `true`. If a second input arrives on the same card (two key presses, the card and the rail)
   * before the first response's result reaches the screen, the second response became a "vanished
   * request" and recorded a command that had already run as denied.
   */
  approvalsInFlight: Record<string, true>
  /**
   * The number of attachments currently uploading, per session (#180). A chip only enters the draft
   * once the host has finished storing it, and sending during that window sent only the text —
   * the chip that finished later attached itself to the draft afterward and rode along with the next
   * message. The composer refuses to send while this value is above zero.
   */
  uploading: Record<string, number>
  /** The usage modal (FR-9) */
  usageOpen: boolean
  settingsOpen: boolean
  /**
   * A request to open the session settings menu (model, effort, permissions) (2026-09-07, the
   * `/model` GUI command). The menu's open state is local state on `SessionSettings` — this only
   * carries the signal. `at` is needed so that requesting the same session twice in a row still
   * opens it each time.
   */
  settingsMenuRequest: { sessionId: string; at: number } | null
  notifyPolicy: NotifyPolicy
  /**
   * Where this install stands relative to the registry (issue #43).
   *
   * **Owned entirely by the host** — not a single field here is computed. Both checking and
   * installing happen on that side; this value is only the seat where the result lands once it
   * arrives. `null` means it has not even been asked yet (before connecting), not "it is up to
   * date."
   */
  update: UpdateStatus | null
  /**
   * The agent CLIs installed on this machine, and whether idle sessions move to a newer one by themselves (#297).
   * Owned by the host like `update`; null until the host has answered, or when it is too old to know.
   */
  agentVersions: AgentVersions | null
  /**
   * What this person has chosen about the screen (protocol's `UiPreferences`).
   *
   * **Fetched once at startup and seated here.** Letting the consumer (the composer) ask on demand
   * would mean it runs on defaults while the answer is late, and the rule changes out from under
   * the person's fingers — if the send key changed that way, the message would already be sent by
   * the time it did.
   */
  prefs: UiPreferences

  attach(platform: Platform): Promise<void>
  dispatchEvent(e: NormalizedEvent): void
  /**
   * Show a session.
   *
   * `preferGrid` is for the doors that alerts open (the inbox, the "done" cards): if the
   * session already has a panel on the grid, go there instead of replacing the grid with
   * one big pane. You put it on the grid to watch it; an alert about it is not a reason to
   * take the other panels off the screen. Deliberate navigation — the sidebar, the palette —
   * leaves this off: picking a row means "give me that one, large".
   *
   * `reveal: false` keeps a folded project folded (#205). Every other door unfolds the
   * session's project, so the row it lands on is visible; see `focusSession` for the two
   * callers that pass it.
   */
  focusSession(id: string | null, opts?: { preferGrid?: boolean; reveal?: boolean }): void
  focusProject(id: string): void
  setAppFocused(focused: boolean): void
  /**
   * The builder session whose conversation is open beside a visible pinned view (M4 C-5,
   * `BuilderPane`) — a session that is on screen (`isOnScreen`). That session's turn ending is a
   * sweep, not a card. Set by opening a pinned view, and set to `null` when it closes or is hidden.
   */
  builderPaneSessionId: string | null
  setBuilderPane(sessionId: string | null): void
  /** Dismisses notification cards (× pressed, or that session was seen) */
  dismissNotices(sessionIds: string[]): void
  /**
   * Reads one page of the newest history, merges it with the conversation on screen, and sets the
   * cursor (#79, `mergePage`). The same path serves a session opened for the first time, a re-read
   * that catches up on a conversation continued elsewhere (`history_synced`), and a resync that
   * fills a gap — there used to be a separate `force` that swapped in only for re-reads. Now, within
   * a page's range, history is always the source of truth.
   */
  loadHistory(sessionId: string): Promise<void>
  /** Prepends older conversation (the way to read conversation from before a compaction) */
  loadOlder(sessionId: string): Promise<void>
  saveWorkspace(): void
  togglePanel(open?: boolean): void
  /** Picking a tab opens the panel even if it was collapsed — what you picked must be visible */
  setPanelTab(tab: PanelTab): void
  /**
   * Replace the tab arrangement (#20). Callers hand in the output of the pure functions
   * in panelLayout.ts (moveTab / splitTab / …) — the store only wires and persists, per
   * docs/state-management.md §2.
   */
  setPanelLayout(groups: PanelGroup[]): void
  setPanelSplit(share: number): void
  setPanelWidth(px: number): void
  setSidebarWidth(px: number): void
  /**
   * Opens a file in the wide overlay (the common entry point for the file tree and the git panel).
   * If `projectId` is given, the file belongs to that project — otherwise the focused session's project
   */
  openFile(path: string, projectId?: string | null): void
  /** Right-click on a file link in the conversation — reveals it in Finder under the link's own project (or the currently viewed session's project if none is given) */
  revealFile(path: string, projectId?: string | null): Promise<void>
  /**
   * Opens the full git screen (changes, history, branches) as an overlay. If `path` is given, opens
   * that file's diff first. `staged` says which side the diff is — if not given, opens that path's
   * first entry.
   */
  openGit(path?: string, staged?: boolean): void
  /** Expands a single commit in the wide space (a diff cannot be read in 340px) */
  openCommit(sha: string): void
  /** The branch-switching screen */
  openBranches(): void
  closeOverlay(): void
  toggleInbox(open?: boolean): void
  togglePalette(open?: boolean): void
  toggleUsage(open?: boolean): void
  toggleSettings(open?: boolean): void
  /**
   * The app-import window (M4 E-3) — opened by the sidebar's Import and by deep links (E-4).
   * `source` is the origin to pre-fill in the window (the deep link's address), and `fromLink`
   * tells the window it was "opened by a link." The window reads or downloads nothing until the
   * person presses Review.
   */
  importDialog: { source: string; fromLink: boolean; at: number } | null
  openImport(source?: string, fromLink?: boolean): void
  closeImport(): void
  /** The `/model` GUI command — opens that session's settings menu (model, effort, permissions) */
  requestSettingsMenu(sessionId: string): void
  /** Checks right now (the settings button). A failure stays on screen but is not thrown */
  checkUpdate(force?: boolean): Promise<void>
  /** Turns periodic checking on and off */
  setUpdateAuto(enabled: boolean): Promise<void>
  /** "Apply updates automatically when idle" on and off (#352) */
  setUpdateAutoApply(enabled: boolean): Promise<void>
  /**
   * Reads the installed agent CLIs (#297). `force: false` is the window gaining focus: the host answers with a reading
   * from moments ago rather than reading again. Never throws; an older host that does not know it leaves this null.
   */
  checkAgentVersions(force?: boolean): Promise<void>
  /** "Move idle sessions to a newly installed agent CLI" on and off (#297) */
  setAgentAutoApply(enabled: boolean): Promise<void>
  /** Restarts every idle session that runs an older CLI on the installed one (#297) — the header's action */
  applyAgentVersions(): Promise<void>
  /**
   * Changes screen settings — sends **only what changed**.
   *
   * The screen seats the record the host hands back as is (not an optimistic update): if a setting
   * that failed to be recorded is only turned on in the screen, the next time it is turned on it is
   * quietly back where it started.
   */
  setPrefs(patch: UiPreferencesPatch): Promise<void>
  /** Installs the new version. **Does not restart** — it tells the person and stops when done */
  applyUpdate(): Promise<void>
  /**
   * "Apply now" (#352): relaunches the desktop window into the installed version. The keeper is
   * told first and holds every agent through it. A refusal (the keeper too old to hold on with
   * background mode off, the bundle not replaced) is shown, never silent.
   */
  applyUpdateNow(): Promise<void>
  setNotifyPolicy(p: NotifyPolicy): void
  /** Attaches something not yet sent to a session (removed if it is empty) */
  setDraft(sessionId: string, draft: Draft): void
  /** Remember whether the conversation was left at its newest line (#31) */
  setStickToBottom(sessionId: string, sticking: boolean): void
  /** Records the row that was showing when it was left (#61). `null` clears it — meaning it was at the bottom */
  setScrollAnchor(sessionId: string, anchor: { seq: number; offset: number } | null): void
  /** Open or close a folder in the file tree. The project owns it, not the session (#16) */
  toggleDir(projectId: string, path: string): void
  /** Show or hide what .gitignore hides (#17) */
  setShowIgnored(show: boolean): void
  setFoldComposer(fold: boolean): void
  setSpinGrid(on: boolean): void
  setSpinSessionIcon(on: boolean): void
  setToast(msg: string | null): void
  /** Opens/closes the session-creation window (`null` closes it) */
  openNewSession(projectId: string | null, opts?: { worktree?: boolean }): void
  /**
   * Creates a worktree manager's slot (#76) — **before** its first branch.
   *
   * Once created, it takes the person there: it exists so they can talk to the thing they just
   * created, so stopping at just adding a row to the list would leave the job half done.
   */
  createWorktreeManager(projectId: string, baseBranch: string): Promise<void>

  addProject(path: string): Promise<ProjectInfo>
  /**
   * A project just registered whose trust is still being asked about (M4, decision 3). Asked
   * **once**, at registration — answering or dismissing it clears it. Nothing is blocked while it
   * is being asked (it stands under that project in the sidebar): right after registering there is
   * also a path where the new-session window pops up immediately, and stacking a window on a window
   * would leave both half-read. A project left unanswered stays untrusted, and can be changed at any
   * time from the project menu.
   */
  trustAsk: string | null
  answerTrustAsk(trust: boolean): Promise<void>
  /**
   * Turns trust on and off. The app list follows from the host's broadcast
   * (`external_apps_changed`).
   *
   * A session already running receives trust only when a session comes up (#92, the manager's
   * `projectTrusted`) — a changed trust setting takes effect only from the next time that session
   * restarts or resumes. That fact is stated in a single line **only when there is a running
   * session**. Saying it when there is none would be a warning about nothing, and not saying it when
   * there is one would let the person believe that turning off trust changed those sessions too, at
   * that instant.
   */
  setProjectTrusted(projectId: string, trusted: boolean): Promise<void>
  /**
   * Delete a project — the record here, and optionally the folder on disk.
   *
   * Two calls, in this order and not the other: the trash first, the record second. The
   * path is only known from the record, so removing it first would leave nothing to point
   * the trash at; and if the trash refuses (a browser has none), nothing has been deleted
   * yet and the whole thing stops with the reason. The reverse order can lose the folder
   * *and* the history in the failure case, which is the one case that matters.
   */
  deleteProject(projectId: string, deleteFiles: boolean): Promise<void>
  /**
   * Ask for this project's git status again, debounced (issue #41).
   *
   * `project.git` was measured once, at attach, and never again — so the sidebar's changed
   * count was a snapshot from app start that an agent's edits and commits never moved.
   * Everything that shows git for a project reads that one field, so this writes back
   * there rather than growing a second, parallel copy for the sidebar.
   *
   * Returns nothing and is safe to call from anywhere: the call is a *hint* that the tree
   * may have moved, not a request the caller waits on.
   */
  refreshProjectGit(projectId: string): void
  /**
   * Changing a repository on purpose, from inside the app (issue #49).
   *
   * #41 gave the sidebar three ways to hear that a tree moved — a turn ending, an approval
   * granted, the window regaining focus — and every one of them is a *guess* that something
   * probably happened elsewhere. The git panel then went straight to `platform.git` and told
   * only itself, so **committing, the one change we make deliberately and know about, was the
   * only one the sidebar never heard**. The count sat on its old value until an unrelated
   * signal happened to fire.
   *
   * So the writes come through here and the refresh is part of the operation rather than
   * something each call site has to remember. Reads stay on `platform.git`: a panel asking
   * for its own file list or a diff is nobody else's business, and routing those through the
   * store would put a debounce in front of a list that has to repaint on the click.
   *
   * `push` is deliberately absent. It moves nothing the sidebar shows — `ProjectInfo['git']`
   * is branch, changed count and is-repo, with no ahead/behind — so a refresh after it would
   * be a status call whose answer can only be identical.
   */
  gitStage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  gitCommit(projectId: string, message: string): Promise<{ ok: boolean; message?: string }>
  /** Switching branch is the one of these that moves the **name** the sidebar shows, not the count */
  gitCheckout(
    projectId: string,
    branch: string,
  ): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  /**
   * Replace this project's saved shell commands (issue #44).
   * Adding one and deleting one both arrive here as "the list is this now".
   */
  setProjectCommands(projectId: string, commands: SavedCommand[]): Promise<void>
  /** Saves the worktree provisioning setup (#69) — called from the new-session window's worktree section */
  saveWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /** Reads the host's run ledger — when the evidence panel views a project, so a running command stays visible even after just reloading the UI */
  loadCommandRuns(projectId: string): Promise<void>
  /** Runs a saved command (#44 → #60). If the same command is already running, the host kills it and starts fresh */
  runCommand(projectId: string, command: string): Promise<void>
  /** Stops a dev server — the outcome comes back through `terminal.onExit` and is recorded in `commandRuns`. The log survives */
  stopCommand(projectId: string, command: string): Promise<void>
  createSession(
    projectId: string,
    opts?: {
      tool?: ToolName
      model?: string
      /** When given, this value is used instead of the project default — used to carry a dying session's settings whole through a handoff */
      effort?: string
      verbosity?: string
      serviceTier?: string
      permissionPreset?: PermissionPreset
      initialPrompt?: string
      /** An inherited handoff note — enters as a marker in the record, not as the first message (#102) */
      handoff?: { from: string; note: string; fromSessionId?: string }
      /** Resumes a previous session the tool already had (including a conversation created in a terminal) */
      resumeExternalId?: string
      importHistory?: boolean
      /** Runs only this session in a git worktree (FR-2 option) */
      worktree?: boolean
      /** The worktree branch name (#69). If empty, the host uses an automatic name */
      worktreeBranch?: string
      /** Where to branch off from. If empty, the project's trunk, or if there is none, the current HEAD */
      worktreeBase?: string
    },
  ): Promise<SessionInfo>
  send(sessionId: string, text: string, attachments?: ChatAttachment[]): Promise<void>
  attachFile(sessionId: string, file: File): Promise<ChatAttachment | null>
  respondApproval(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny' | 'always',
    scope?: 'session' | 'project',
  ): Promise<void>
  /** Whether the answer reached the host — `false` means a toast was shown (an answer from the composer has `send` put the text back, #180) */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<boolean>
  interrupt(sessionId: string): Promise<void>
  /** Stops one background task (#290). A refusal or failure is a toast — silence would read as stopped */
  stopBackgroundTask(sessionId: string, taskId: string): Promise<void>
  /** Takes the ended background tasks off the session's list (#290) */
  clearBackgroundTasks(sessionId: string): Promise<void>
  /** Hides from the list / brings back (the record survives) */
  /** Restarts only the agent (the conversation stays as is) */
  restartSession(sessionId: string): Promise<boolean>
  /** Moves the session to the trash (#204); the two flags say what goes with it when it is deleted for good */
  deleteSession(sessionId: string, deleteWorktree?: boolean, deleteExternal?: boolean): Promise<void>
  /**
   * Brings a session back from the trash (#204). A project its restore registered again is added here, and asked
   * about trust as a newly added one is. Returns an error message, or null when it is back.
   */
  restoreFromTrash(sessionId: string): Promise<string | null>
  /**
   * Hands off and starts fresh (a dogfooding request — the way out of the 7-13 second resume delay
   * on an old codex thread). The dying session writes a handoff note → the new session starts from
   * that note → the old session (by default) is **actually** deleted, all the way down to the tool's
   * own original. Destruction comes last: nothing is deleted until the new session is successfully
   * up.
   *
   * tool: can also hand off to a different agent (the note is plain text, so it does not care which
   * tool reads it). Defaults to the current tool. Switching tools does not carry over the model,
   * effort, verbosity or speed — those are all tool-specific values, and handing codex's model name
   * to claude would fail right at session creation.
   * deleteOld: defaults to true. Turning it off leaves the old session standing — a branch, not a
   * switch.
   */
  /**
   * mode 'agent' (default): the dying session writes the note. 'record' (#78): asks the agent
   * nothing and has the host build the record straight from the store's own transcript — the way
   * out for a session whose service has been cut off.
   */
  handoffSession(
    sessionId: string,
    opts?: { tool?: ToolName; deleteOld?: boolean; mode?: 'agent' | 'record' },
  ): Promise<void>
  updateSessionSettings(
    sessionId: string,
    s: {
      model?: string | null
      effort?: string | null
      verbosity?: string | null
      serviceTier?: string | null
      permissionPreset?: PermissionPreset
    },
  ): Promise<void>
  resumeSession(sessionId: string): Promise<boolean>
  /**
   * Switches a session's agent (claude ↔ codex).
   * **The conversation does not carry over** — the caller must tell the person that beforehand.
   */
  switchTool(sessionId: string, tool: ToolName): Promise<void>
  /** Wakes a session the instant it is picked (so we do not wait for the first response) */
  wake(sessionId: string): Promise<void>
  /**
   * Branches off a locked conversation and continues it.
   * The only way out that does not require going elsewhere to close another app — the original is
   * left as is.
   */
  forkConversation(sessionId: string): Promise<void>
  /**
   * Recovery after reconnecting. Merges the host's session list into the store (sessions created,
   * changed or deleted while disconnected), and revives sessions that were running (when the host
   * dies, its processes die with it). If `resync` is true, event replay was not possible — the
   * conversation being viewed is also re-read from the store.
   */
  recoverAfterReconnect(resync?: boolean): Promise<void>
  /** Sidebar order (set by the person dragging) */
  reorderProjects(orderedIds: string[]): Promise<void>
  reorderSessions(projectId: string, orderedIds: string[]): Promise<void>
  /**
   * The grid.
   *
   * `view` is the value that picks one screen — the focus view and the grid only show **the same
   * session state** differently, so they never hold separate session data, only a different way of
   * viewing it. (That way, changing a model in the grid follows through to the sidebar and the focus
   * view too.)
   */
  /**
   * What is being viewed right now.
   *   focus        a single session (default)
   *   grid         the grid — controlling by eye
   *   orchestrator the orchestrator — controlling by talking
   */
  view: 'focus' | 'grid' | 'orchestrator' | 'app'
  /**
   * The app being viewed as a pinned view (M4 B-2). Stands on screen only while `view` is 'app'.
   * Not cleared by going to view something else — pressing the app's sidebar row again, and reviving
   * it, both return to the same place.
   */
  focusedApp: { projectId: string | null; appId: string } | null
  /** Open pinned views, in the order they were opened. Ones not visible stay alive too (`PinnedView`) */
  pinnedViews: PinnedView[]
  /**
   * In-conversation app views (M4 B-1) — session → (call id → view). Kept separate from cards
   * (`chat`): a view's lifetime is set by the host's `app_view`, and a live view must not disappear
   * even when the conversation history is re-read (`loadHistory`).
   */
  inlineViews: Record<string, Record<string, InlineView>>
  /** Bumped every time a drawn in-conversation view's frame comes or goes — the value itself carries no meaning (`registerInlineFrame`) */
  inlineFramesVersion: number
  /**
   * Closes an in-conversation view — the **single path to closing one**. Only closes a live view
   * (calling it twice counts as once). If a frame is drawn, teardown is sent first and its answer
   * awaited, then it is switched to a placeholder and the host is told to close the instance
   * (releasing the app; if the host already closed it, that close is a no-op).
   */
  closeInlineView(sessionId: string, callId: string, reason: string): Promise<void>
  /**
   * Reopens a closed view — without calling the tool again. Once the host returns the new instance
   * along with the input and outcome it was holding, the view receives them again per spec. If it
   * cannot be opened, the reason is left on the placeholder and reopening is withdrawn.
   */
  reopenInlineView(sessionId: string, callId: string): Promise<void>
  /**
   * Sends an app view's message into the conversation (M4 B-1, B-4) — called only after the person
   * has confirmed it. An in-conversation view sends to that conversation; a pinned view sends to
   * whichever conversation the person picked. Either way it is recorded as a message the app sent,
   * and the agent receives the app's text wrapped by the host.
   * @returns whether it was sent — a failure is reported as a toast
   */
  sendViewMessage(sessionId: string, instanceId: string, text: string): Promise<boolean>
  /**
   * Opens an app as a pinned view — creates its slot the first time, or goes to it if already open.
   *
   * `builder: true` opens its builder's conversation beside it too (`builderPaneFor`). That is how a view laid over a
   * panel — on the grid or the project screen — shows the builder: the panel has no room for the pane, so "Show the
   * conversation" goes to the app view through this same door the panel's Open uses.
   */
  openApp(projectId: string | null, appId: string, opts?: { builder?: boolean }): void
  /**
   * The pinned view key whose builder pane should open the next time that view is the one on screen (`openApp` with
   * `builder`) — the view opens it and clears this. Only this screen session's: not saved with the workspace.
   */
  builderPaneFor: string | null
  /** Clears `builderPaneFor` once the view it names has opened its builder pane */
  takeBuilderPaneFor(key: string): void
  /**
   * Gives the app a pinned view without going to it (#203). The project screen shows its apps' pinned views in its
   * panels, and this is the same entry `openApp` makes — so an app on the project screen and the same app opened from
   * the sidebar are one instance in one frame, and moving between them keeps the document.
   */
  ensurePinnedView(projectId: string | null, appId: string): void
  /**
   * Gives an app on the grid its view (#288), keyed `gridAppViewKey` — apart from the app's pinned view, so the grid
   * and the project screen each keep their own document. Does nothing if it already has one.
   */
  ensureGridAppView(projectId: string | null, appId: string): void
  /** Closes a pinned view from outside its own header (the project screen's ×) — teardown first, as every way down does */
  dismissPinnedView(key: string): Promise<void>
  /**
   * Leaves the app view without closing the view when the screen it goes back to shows the app anyway: its project's
   * screen, where the app is a panel (#203). Closing there would tear down the panel's view and open a new one at
   * once, losing whatever the person had in it. Returns whether it left; if not, the caller closes the view.
   */
  leavePinnedView(key: string): boolean
  /** Opens the slot's instance (the host calls `home`). Called by the view when the app can be opened */
  startPinnedView(key: string): Promise<void>
  /**
   * Releases the instance and returns the slot to idle — for when the app can no longer run
   * (it lost trust). The caller must call `AppFrame`'s teardown first. Once it can run again, the
   * view reopens it.
   */
  releasePinnedView(key: string): void
  /** Closes a pinned view — the caller must call teardown first. If it was being viewed, returns to the focus view */
  closeApp(key: string): void
  /**
   * Restarts the app and opens a fresh view (M4 B-6) — the "Restart" for a dead or stopped app, or a
   * view that failed to open. The caller calls teardown first. Releases the old instance, and reopens
   * (calls `home` fresh) **only after** the host has torn the app down and cleared its state.
   */
  restartApp(key: string): Promise<void>
  /**
   * Reopens a pinned view with the app's new code (M4 C-4) — the slot stays put (same row, same
   * focus), only the instance is new. Sends teardown to the drawn frame first, releases the old
   * instance, and the view reopens (calls `home` with the new code). Called both when the store
   * notices the code changed (`followAppCode`) and when the person presses "Reload".
   */
  reloadPinnedView(key: string): Promise<void>
  /**
   * Reopens an in-conversation view with the app's new code (M4 C-4) — closes it after teardown, then
   * opens a new instance with that call's input and outcome that the host was holding (without
   * calling the tool again). If the host is not holding them, it stays closed.
   */
  reloadInlineView(sessionId: string, callId: string): Promise<void>
  /**
   * Creates a new app (M4 C-1, the "New app" window) — the host expands the template and sets up a
   * builder session. On success, the app takes its place in the list, its pinned view opens, and the
   * builder session appears in the sidebar. If the host refuses, its message is thrown as is (shown
   * in the window).
   */
  createApp(spec: NewAppSpec): Promise<AppCreated>
  /** The orchestrator session id (`null` if never created — the screen shows an empty conversation plus suggested questions) */
  orchestratorId: string | null
  /** A session is being created for the first question (#63) — a flag so the empty screen does not look dead */
  orchestratorWaking: boolean
  /**
   * Pointing at the sidebar's Add project (#63).
   *
   * Turned on by the orchestrator's `propose_project`, and **turned off once the person goes through
   * that door or changes the subject.** Why turning it off is tied to an action rather than a timer:
   * turning off mid-read would be the same as never having pointed at all, and leaving it on forever
   * would stop being guidance and become nagging.
   */
  addProjectHint: boolean
  /**
   * Whether the intro screen (orchestrator plus tool cards) has been passed (#63).
   * Kept in the workspace snapshot — this screen appears exactly once, on first run.
   */
  introSeen: boolean
  /** The grid's panels, sessions and apps, in order (#288) — as stored by the host, unknown ones included (GridView leaves those out) */
  gridPanels: GridPanel[]
  setView(view: 'focus' | 'grid' | 'orchestrator'): void
  /**
   * Opens the orchestrator **screen**. Does not create a session (#63, deferred startup) — attaches
   * to one if it already exists, otherwise an empty conversation waits for the first question.
   * `askOrchestrator` is what creates it.
   */
  openOrchestrator(): Promise<void>
  /**
   * Asks the orchestrator something. **If there is no session, one is created at this moment** —
   * both the suggested-question cards and the empty screen's composer go through this door (#63).
   */
  /** Whether the first message reached the orchestrator — `false` means it was never born (the caller puts the text back, #180) */
  askOrchestrator(text: string): Promise<boolean>
  /** Passes the intro screen (#63): records the tool choice with the host, and goes to the orchestrator screen */
  completeIntro(tool: ToolName): Promise<void>
  /**
   * Saves the grid's panels whole — adding, removing and reordering are all this one call. An app panel no longer in
   * the list has its view closed, teardown first, as the project screen's × does.
   */
  setGridPanels(panels: GridPanel[]): Promise<void>
  rename(sessionId: string, name: string): Promise<void>
  markRead(sessionId: string): Promise<void>
}

/**
 * A conversation item's unique number. This value is both the React key and the virtual scroll's
 * item key.
 *
 * **Must never overlap an item read back from the store.** An overlap means two items share the
 * same key, and the virtual scroll draws them both in the same spot, mashing the text together as
 * if it had run on. (This was in fact the reported symptom "it sometimes renders strangely": a
 * session that had loaded history — stored seq 1..N — started its own seq count over at 1 the
 * moment a new message was appended.)
 * So this number is pushed above every stored item as it is brought in.
 */
/** A new object with one key removed (never mutates state directly) */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const next = { ...obj }
  delete next[key]
  return next
}

/**
 * Everything the store keeps per session, for sessions that are gone. Kept in one place so a deletion and a
 * reconnect that finds a session missing clear the same things.
 *
 * Everything kept per session goes together (#163). A leftover notification card would focus a nonexistent
 * session on click, showing "Select a project or session." The rest (history cursor, draft, wake error) is dead
 * weight nobody reads any more. The conversation's views go too — the host has already closed the instance — and
 * the read position goes with the session (#61). An id can come back: restoring a session from the trash brings
 * it back under the same id, and it then opens like a session read for the first time.
 */
function forgetSessions(s: AppState, gone: ReadonlySet<string>): Partial<AppState> {
  if (gone.size === 0) return {}
  const keep = <T,>(obj: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [id, v] of Object.entries(obj)) if (!gone.has(id)) out[id] = v
    return out
  }
  // Events parked for a session that will now never register would wait forever
  for (const id of gone) pendingEvents.delete(id)
  return {
    chat: keep(s.chat),
    inlineViews: keep(s.inlineViews),
    scrollAnchor: keep(s.scrollAnchor),
    notices: s.notices.filter((n) => !gone.has(n.sessionId)),
    history: keep(s.history),
    subagentSteps: keep(s.subagentSteps),
    drafts: keep(s.drafts),
    stickToBottom: keep(s.stickToBottom),
    wakeError: keep(s.wakeError),
    wakeLocked: keep(s.wakeLocked),
    focusedSessionId: s.focusedSessionId && gone.has(s.focusedSessionId) ? null : s.focusedSessionId,
  }
}

/**
 * A `set` that updates one session **after** awaiting an RPC (#163) — changes nothing if
 * `session_deleted` arrived in the meantime.
 *
 * The post-await `set` used to spread `{ ...s.sessions[id]!, … }`. If the session was deleted while
 * awaiting, that revived a near-empty row (`{"live":true}`), which broke code that iterates all
 * sessions (`s.touchedPaths is not iterable`). Every post-await session update now goes through this
 * gate, so any future addition gets the same rule.
 */
function ifSessionStill(
  sessionId: string,
  patch: (st: AppState, cur: AppState['sessions'][string]) => Partial<AppState>,
): (st: AppState) => Partial<AppState> {
  return (st) => {
    const cur = st.sessions[sessionId]
    return cur ? patch(st, cur) : {}
  }
}

let chatSeq = 0

/**
 * Keeps a conversation's live views within the cap (`APP_VIEWS_LIVE_PER_SESSION`) — closes the
 * longest-live one first. Never closes the view that just came alive. The host keeps the same cap,
 * so both sides usually close the same view together — because there is only one path to closing
 * (only a live view is closed), it is never closed twice.
 */
function capInlineViews(get: () => AppState, sessionId: string, keep: string): void {
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
 * Of the model and effort this project has remembered for this tool, keep only what **that tool
 * still accepts** (#107).
 *
 * Saving per tool is not enough by itself: models retire. A name picked yesterday may not be on
 * today's list, and sending it as is kills the session with a 400 on the first turn — a trade that
 * loses the session to preserve one remembered value. So it is checked at the moment of use, and
 * dropped if absent.
 *
 * **Nothing is dropped if the list could not be read.** `supported: false` means "unknown right now,"
 * not "that model does not exist," and dropping it for being unknown would silently erase what the
 * person chose during a moment the tool happened not to respond.
 *
 * Effort is dropped **together with** the model. Effort is a handle on the model
 * (`ModelOption.efforts`), so leaving it behind would land a `high` of unknown origin onto the
 * tool's default model.
 */
async function usableDefaults(
  platform: Platform,
  tool: ToolName,
  saved: ToolDefaults | undefined,
): Promise<ToolDefaults> {
  const none: ToolDefaults = { model: null, effort: null }
  if (!saved?.model) return saved ?? none
  try {
    const { supported, models } = await platform.agents.models(tool)
    if (!supported || models.length === 0) return saved
    return models.some((m) => m.id === saved.model) ? saved : none
  } catch {
    return saved // Same reason as above — failing to ask is not the same as "does not exist"
  }
}

/** A handoff in progress — calling it twice on the same session births two new sessions (module state: purely a re-entry guard, nothing to draw from it) */
const handoffInFlight = new Set<string>()

/**
 * The handoff prompt (per a dogfooding request to "prompt it properly" — specifically, that the
 * language the user is using needs to carry over). Only the dying session has the full context, so
 * it is the one that writes the note.
 *
 * **The note is received as the reply, and the host places the file** (#142). The agent used to
 * write directly into `.centralu/handoff/` inside the project. Once the note moved outside the
 * user's repository (into the data folder), writing it directly would have meant granting both
 * tools more permissions — so the agent only replies, and after that turn ends the host takes
 * **the reply as recorded in the store** and places it as a file (`agents.exportHandoffNote`). This
 * also sidesteps a second dogfooding finding (a reply scraped from the on-screen conversation mixed
 * in streaming chunks and leftover output from the previous turn): it is read from the host's
 * record, not the screen, only the reply to this specific request, and only after the turn ends.
 *
 * Exported because the e2e tests identify the handoff message by this wording.
 */
export function handoffPrompt(): string {
  return `You are about to be replaced by a fresh session that starts with no memory of this conversation. Write a handoff note for your successor. Your final message in this turn is the note: the app saves that message to a file and hands the file to your successor. Do not write the note to a file yourself, and do not add a preamble or a closing line around it — whatever your final message says is the note.

The note is the only thing your successor receives, so make it self-contained — never reference "the conversation above". It is saved as a file, not read as a chat message: **length is not a constraint**. Write with the density of a compaction summary, not the brevity of a reply — when in doubt, include it. If your context contains compaction summaries of earlier phases, transcribe their operational content (state, decisions, tips, conventions) rather than re-summarizing it — every re-summarization loses another layer.

Cover, in this order:
1. Project & goal — what this project is and what we are working toward.
2. Current state — what is done, what is mid-flight, and the exact state of unfinished work (files, branches, commands to resume).
3. Decisions & why — choices already made, with the reasons and evidence, so your successor does not relitigate them.
4. Next steps — what should happen next, in priority order.
5. Tips & pitfalls — this section evaporates first in handoffs, so be exhaustive, not selective: every practical trick, workaround, non-obvious command, environment quirk, mistake already made, dead end, and thing that looks right but is wrong. A tip that feels too small to mention is exactly the one to write down. If earlier parts of this conversation were compacted into summaries, carry forward every lesson those summaries mention — do not let them die with this session.
6. Working with the user — the language the user speaks, their tone, the response style they prefer, and standing instructions or conventions (build commands, commit style, things never to do).

Write the note itself in the language the user has mostly used in this conversation.`
}

/** The number of lines and characters carried in the preview — just enough to tell what happened, not enough to carry the note itself */
const PREVIEW_LINES = 10
const PREVIEW_CHARS = 700

/** The note's opening lines — blank lines are skipped (markdown notes commonly start with one) */
function notePreview(note: string): string {
  const lines: string[] = []
  for (const line of note.split('\n')) {
    if (!line.trim() && lines.length === 0) continue
    lines.push(line)
    if (lines.length >= PREVIEW_LINES) break
  }
  const head = lines.join('\n').slice(0, PREVIEW_CHARS)
  return head.length < note.trim().length ? `${head.trimEnd()}\n…` : head
}

/**
 * The successor's first message (#102) — **hands over the note's location, not the note itself.**
 *
 * The full note used to be the first message verbatim. But the prompt above tells the predecessor
 * "it is a file, so length is not a constraint" — the longer the note, the more thorough it is, and
 * the more thorough it is, the larger the single message the successor received grew (measured: handing
 * a long session off to codex produced an error the moment it arrived). The file is already sitting
 * where the host placed it, so the first message only needs to point at the path — only then does
 * length stop being a constraint in fact, not merely by declaration. That location is outside the
 * project (the data folder, #142), so the path is absolute. The host opens that folder so the
 * successor can read it without asking (Claude's additional working folder — Codex does not block
 * reading it).
 *
 * Why the preview rides along too: someone who only reads the conversation record still needs to
 * know what happened. Why it **explicitly** says reading in pieces or grepping is fine: without that
 * line, the agent reads the whole file and recreates the exact problem this design just removed.
 */
function handoffOpening(predecessor: string, note: string, path: string): string {
  return [
    `You are taking over from a session named "${predecessor}". It wrote a handoff note for you and it is on disk, outside the project folder: \`${path}\`. Read it before anything else.`,
    '',
    'The note can be long. Read it in pieces (head, tail, byte offsets) or grep it for what you need — you do not have to pull the whole file into one turn.',
    '',
    'It begins:',
    '',
    notePreview(note)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n'),
    '',
    'Reply first with a short summary of your understanding of the current state, in the language the note uses.',
  ].join('\n')
}

/**
 * Picks out only the **while-alive facts** from `SessionInfo` (approval, questions, activity,
 * limit, usage).
 *
 * These values live only in the host's memory, so if they are not carried over when the list
 * arrives after a reconnect or restart, a session can sit at `state=waiting_approval` with no card
 * payload and the approval never shows up on screen. Not spread whole, because `SessionInfo` has
 * fields `SessionSummary` does not (`externalId`, `createdAt`, …) that must not leak in.
 */
/** What the header's "Update idle sessions" did (#297), in one line: how many moved, and how many were busy */
export function appliedVersionsText(restarted: number, busy: number): string {
  const sessions = (n: number) => (n === 1 ? '1 session' : `${n} sessions`)
  const keep = busy === 1 ? 'keeps its version' : 'keep their version'
  if (restarted === 0 && busy === 0) return 'Every session already runs the installed version'
  if (restarted === 0) return `Nothing restarted: ${sessions(busy)} busy ${keep} for now`
  const moved = `Restarted ${sessions(restarted)} on the installed version`
  return busy === 0 ? moved : `${moved}; ${busy} busy ${keep} for now`
}

function liveFactsOf(
  s: SessionInfo,
): Pick<SessionSummary, 'pendingApproval' | 'pendingQuestions' | 'activity' | 'limit' | 'usage' | 'context' | 'backgroundTasks' | 'agentVersion'> {
  return {
    pendingApproval: s.pendingApproval,
    pendingQuestions: s.pendingQuestions,
    activity: s.activity,
    limit: s.limit,
    usage: s.usage,
    context: s.context,
    // Background work (#290) lives in the host's memory too — a reconnect reads back what was running and what ended
    backgroundTasks: s.backgroundTasks,
    // So does the CLI version the process runs (#297)
    agentVersion: s.agentVersion,
  }
}

/**
 * Keep `workingSince` in step with who is actually working (issue #23).
 *
 * A session that starts a turn gets the current instant; one that stops working loses its
 * entry, so the next turn cannot inherit the previous turn's start. An entry that is
 * already there is never overwritten — that is the whole point, since a turn's start does
 * not move just because we looked again.
 *
 * Returns `prev` unchanged when nothing moved. Zustand hands this object straight to
 * subscribers, so allocating a fresh one per streaming delta would re-render every reader
 * of it a few times a second for no reason.
 *
 * Sessions that were already running before we knew about them (first attach, reconnect)
 * are stamped with the moment we found out. That is not when the turn began, and we cannot
 * know when it did — the host does not send it. It is the earliest instant we can honestly
 * claim, and it is still stable across every view change after that.
 */
function trackWorkingSince(
  prev: Record<string, number>,
  sessions: Record<string, SessionSummary>,
  now: number,
): Record<string, number> {
  let next = prev
  const copy = () => (next === prev ? (next = { ...prev }) : next)
  for (const s of Object.values(sessions)) {
    if (s.state === 'working') {
      if (prev[s.id] == null) copy()[s.id] = now
    } else if (prev[s.id] != null) {
      delete copy()[s.id]
    }
  }
  // Drop instants for sessions that no longer exist — the ids never come back, but the map grows
  for (const id of Object.keys(prev)) if (!sessions[id]) delete copy()[id]
  return next
}

/** Pushes the counter up so it always uses a number bigger than any item brought in from the store */
function bumpSeqAbove(items: { seq: number }[]): void {
  for (const it of items) if (it.seq > chatSeq) chatSeq = it.seq
}

/**
 * Gives a row read from history a new key if it collides with a key already on screen (#79).
 *
 * History's key is the stored number, and a live item's key comes from `chatSeq`. In a session
 * where events arrived before history, a live key (say, 31) can coincide with a stored number
 * (row 31) not yet read. Two rows sharing one key makes the virtual scroll draw them on top of each
 * other in the same spot (see the `chatSeq` comment above). The side that gets rekeyed is always the
 * incoming history row — changing the key of a row already on screen would re-render it and make the
 * read position (`scrollAnchor`) lose track of that key. Because `chatSeq` was already raised by
 * `bumpSeqAbove` before this is called, the new key never collides with any stored number.
 */
function rekeyAgainst(incoming: ChatItem[], taken: Set<number>): ChatItem[] {
  return incoming.map((it) => (taken.has(it.seq) ? { ...it, seq: ++chatSeq } : it))
}

/**
 * Merges a history row and a screen row into one when they are the same message (#79). The shape
 * comes from history; the key and anything screen-only (a tool's live output, a confirmation mark)
 * come from the screen.
 *
 * A message still streaming is the exception: the host writes down its body every few hundred ms, so
 * if the screen's text continues history's text, the screen side is longer — in that case the screen
 * version is kept. If it does not continue (the initial connection only replayed the tail of the
 * message), history's version is the complete one.
 */
function settle(live: ChatItem, row: ChatItem): ChatItem {
  if ((live.kind === 'assistant' || live.kind === 'reasoning') && row.kind === live.kind && live.text.startsWith(row.text)) {
    return live
  }
  return {
    ...live,
    ...row,
    seq: live.seq,
    ...(live.kind === 'user' && live.pending ? { pending: false } : {}),
  } as ChatItem
}

/**
 * Whether an unnumbered row on screen is what already drew this history row first — matched by
 * content (#79).
 *
 * There are three kinds of unnumbered row: a message before confirmation (a mock never sends the
 * confirmation), an image (the host assigns the number only **after** writing the file, so the event
 * carries none), and an error (a mock never records the error, so it carries no number — the host's
 * own errors have carried a number since #161). All three exist in the host's store.
 */
function sameLine(live: ChatItem, row: ChatItem): boolean {
  if (live.kind === 'user' && row.kind === 'user') return !!live.pending && !row.from && !row.fromApp && live.text === row.text
  if (live.kind === 'image' && row.kind === 'image') return !!live.data && live.mime === row.mime && live.data === row.data
  if (live.kind === 'mark' && row.kind === 'mark') return live.text === row.text
  return false
}

/**
 * Merges the newest history page with the conversation on screen (#79) — rows are matched only by
 * stored number (`storedSeq`).
 *
 * This used to discard the page and set the cursor from the page alone whenever the screen already
 * had rows. That left a gap between the discarded page and the screen (`loadOlder` only reads above
 * the cursor), and setting the cursor from the render key at the top of the screen appended the same
 * conversation a second time.
 *
 * The page is the last N rows as of the moment the host read them, and within that range (first row
 * through last row) **the page is the source of truth.**
 *  - A screen row with the same number as a page row is merged into one (`settle`) — it does not
 *    appear twice, and the screen's key is kept.
 *  - A screen row older than the page (a stale chunk replayed by the initial connection) is
 *    discarded. Keeping it would leave a row that does not connect to the top of the page, and no
 *    matter where the cursor is set, the middle would either have a gap or duplicate content. A
 *    discarded row is brought back into place by `loadOlder`.
 *  - Approval rows are never drawn from history (`messagesToChat`) — they are kept in their numbered
 *    spot even when inside the range.
 *  - An unnumbered row inside the range is already held by the page (the three kinds covered by
 *    `sameLine`).
 * Screen rows after the range are simply appended as the tail — this is where a streaming message
 * and one just sent live. An unnumbered row at the head of the tail is treated as the same row as an
 * unmatched row at the end of the page if their content matches: it merely lacks a number, but it is
 * already recorded in the store.
 */
function mergePage(have: ChatItem[], page: ChatItem[], rows: StoredMessage[]): ChatItem[] {
  if (rows.length === 0) return have
  const first = rows[0]!.seq
  const last = rows[rows.length - 1]!.seq
  const at = new Map<number, number>()
  page.forEach((p, i) => {
    if (p.storedSeq !== undefined) at.set(p.storedSeq, i)
  })
  const out = [...page]
  /** Page slots that have taken in a screen row and inherited its key */
  const adopted = new Set<number>()
  const approvals: ChatItem[] = []

  let cut = -1
  have.forEach((it, i) => {
    if (it.storedSeq !== undefined && it.storedSeq <= last) cut = i
  })
  for (const it of have.slice(0, cut + 1)) {
    const n = it.storedSeq
    if (n === undefined || n < first) continue
    const i = at.get(n)
    if (i !== undefined) {
      if (!adopted.has(i)) out[i] = settle(it, page[i]!)
      adopted.add(i)
    } else if (it.kind === 'approval') approvals.push(it)
  }

  const tail: ChatItem[] = []
  let from = adopted.size ? Math.max(...adopted) + 1 : 0
  let head = true
  for (const it of have.slice(cut + 1)) {
    if (it.storedSeq !== undefined) head = false
    if (head) {
      let i = from
      while (i < page.length && (adopted.has(i) || !sameLine(it, page[i]!))) i++
      if (i < page.length) {
        out[i] = settle(it, page[i]!)
        adopted.add(i)
        from = i + 1
        continue
      }
    }
    tail.push(it)
  }

  // Only newly incoming history rows get rekeyed (rekeyAgainst) — a row that came from the screen keeps its key
  const screen = new Set([...[...adopted].map((i) => out[i]!.seq), ...approvals.map((a) => a.seq), ...tail.map((t) => t.seq)])
  out.forEach((it, i) => {
    if (!adopted.has(i)) out[i] = rekeyAgainst([it], screen)[0]!
  })

  const body: ChatItem[] = []
  for (const it of out) {
    while (approvals.length && it.storedSeq !== undefined && approvals[0]!.storedSeq! < it.storedSeq) body.push(approvals.shift()!)
    body.push(it)
  }
  return [...body, ...approvals, ...tail]
}

/**
 * What the composer's text becomes relative to an open question (#125, #174) — the composer's hint
 * text and `send` use **the same decision**. While the two were decided separately (the hint
 * text did not look at attachments), a person who attached a file was told to "write an answer," and
 * the text went to a new turn instead.
 *
 *  - `answer`: exactly one question, and no attachments — the text is that question's answer.
 *  - `drops`: a question is open but the text cannot be its answer. When one request has several
 *    questions, the card requires all of them answered, and a single line of text cannot say which
 *    one it answers, nor does an answer have room for an attachment. Sending it starts a new turn and
 *    the question is dropped.
 *  - `none`: no open question.
 */
/**
 * The project whose screen is showing (#203), or null. The project screen is the focus lane with no session
 * picked: `focusProject` releases the session focus to open it, and picking a session leaves it.
 */
export function projectScreenOf(
  s: Pick<AppState, 'view' | 'focusedSessionId' | 'focusedProjectId' | 'projects'>,
): string | null {
  const pid = s.view === 'focus' && !s.focusedSessionId ? s.focusedProjectId : null
  return pid && s.projects[pid] ? pid : null
}

/**
 * The project the focus lane is showing — its screen, one of its sessions or one of its apps — or null. The sidebar tints that
 * project's group, so the person can see which project they are in as well as which row.
 *
 * Only the focus lane counts: the grid and the orchestrator are views of their own, lit by their own buttons, and a
 * tinted project beside them would be a second answer to "what am I looking at".
 *
 * A focused session answers with **its own** project, not `focusedProjectId`. Opening a session that has no project
 * (a coordinator) leaves `focusedProjectId` on the project looked at last, and reading that would tint a project the
 * screen is not showing.
 */
export function openProjectOf(
  s: Pick<AppState, 'view' | 'focusedSessionId' | 'focusedProjectId' | 'focusedApp' | 'projects' | 'sessions'>,
): string | null {
  /*
   * An app open in the app view belongs to its project the way a session does: the person is inside that project, so
   * its group is tinted and the app's own row carries the mark. An app in the user folder belongs to no project and
   * tints nothing, like a session with no project.
   */
  if (s.view === 'app') {
    const pid = s.focusedApp?.projectId
    return pid && s.projects[pid] ? pid : null
  }
  if (!s.focusedSessionId) return projectScreenOf(s)
  if (s.view !== 'focus') return null
  const pid = s.sessions[s.focusedSessionId]?.projectId
  return pid && s.projects[pid] ? pid : null
}

/**
 * The sessions the project screen shows right now: every session of the project the person has not hidden. The
 * trash (#204) needs no rule here — a trashed session is not in `sessions`.
 */
export function projectScreenSessions(
  s: Pick<AppState, 'view' | 'focusedSessionId' | 'focusedProjectId' | 'projects' | 'sessions' | 'projectPanels'>,
): string[] {
  const pid = projectScreenOf(s)
  if (!pid) return []
  const hidden = new Set(s.projectPanels[pid]?.hidden ?? [])
  return Object.values(s.sessions)
    .filter((x) => x.projectId === pid && !hidden.has(sessionPanelId(x.id)))
    .map((x) => x.id)
}

/**
 * The apps the project screen shows as panels right now, as pinned view keys (#203). PinnedApps lays exactly these
 * over their panels, so it and ProjectView must not decide this separately.
 */
export function projectScreenAppKeys(
  s: Pick<AppState, 'view' | 'focusedSessionId' | 'focusedProjectId' | 'projects' | 'externalApps' | 'projectPanels'>,
): string[] {
  const pid = projectScreenOf(s)
  if (!pid) return []
  const hidden = new Set(s.projectPanels[pid]?.hidden ?? [])
  return s.externalApps
    .filter((a) => a.projectId === pid && !hidden.has(appPanelId(a.appId)))
    .map((a) => externalAppKey(pid, a.appId))
}

/**
 * The apps the grid shows as panels right now, as their grid view keys (#288, `gridAppViewKey`). PinnedApps lays exactly
 * these over the grid's panels, and GridView opens a view for each, so the two read this one answer. An app the list does
 * not have is not a panel (`visibleGridPanels`), so it gets no view either.
 */
export function gridScreenAppKeys(s: Pick<AppState, 'view' | 'gridPanels' | 'externalApps'>): string[] {
  if (s.view !== 'grid') return []
  const listed = new Set(s.externalApps.map((a) => appKeyOf(a.projectId, a.appId)))
  return s.gridPanels.flatMap((p) =>
    p.kind === 'app' && listed.has(appKeyOf(p.projectId, p.appId)) ? [gridAppViewKey(p.projectId, p.appId)] : [],
  )
}

/**
 * Whether leaving the app view for this pinned view lands on a screen that shows it in a panel (#203): the view is
 * the one on screen, and the focus lane it goes back to is its project's screen with the app not hidden there.
 */
export function returnsToPanel(
  s: Pick<AppState, 'view' | 'focusedApp' | 'focusedSessionId' | 'focusedProjectId' | 'projects' | 'externalApps' | 'projectPanels'>,
  key: string,
): boolean {
  if (s.view !== 'app' || !s.focusedApp || externalAppKey(s.focusedApp.projectId, s.focusedApp.appId) !== key) return false
  return projectScreenAppKeys({ ...s, view: 'focus' }).includes(key)
}

export function composerTarget(open: SessionSummary['pendingQuestions'], hasAttachments: boolean): 'answer' | 'drops' | 'none' {
  if (open.length === 0) return 'none'
  return open.length === 1 && open[0]!.questions.length === 1 && !hasAttachments ? 'answer' : 'drops'
}

/** A line left in the conversation for a question dropped by a new turn (#174) */
export function droppedQuestionsText(questions: string[]): string {
  const quoted = questions.map((q) => `"${q}"`).join(', ')
  return questions.length === 1
    ? `Question dropped — this message started a new turn instead of answering ${quoted}`
    : `Questions dropped — this message started a new turn instead of answering ${quoted}`
}

/**
 * The card that blocks asking the agent for a handoff note (#174) — `null` if there is none. The
 * store's `handoffSession` and the sidebar's confirmation window use the same decision.
 */
export function handoffBlockedBy(s: Pick<SessionSummary, 'pendingQuestions' | 'pendingApproval'>): 'question' | 'approval' | null {
  if (s.pendingQuestions.length > 0) return 'question'
  if (s.pendingApproval) return 'approval'
  return null
}

/** A message of unknown send status (#173) — bubble render key → what is needed to undo it. Cleared against the store after reconnecting */
type UnsureSend = { sessionId: string; text: string; attachments?: ChatAttachment[]; prevState?: SessionSummary['state'] }
const unsureSends = new Map<number, UnsureSend>()

/**
 * Undoes a message that failed to send — removes the bubble, returns the written text and
 * attachments to the composer, and returns "working" to its previous state.
 *
 * The written text goes back to the composer. The composer is cleared the instant a message is sent
 * (#38), so merely removing the bubble leaves the sentence **nowhere at all** — a toast reports the
 * failure but does not give the text back. If new text was written before the failure arrived, it is
 * not overwritten but prepended in front of it: in order, the failed message was written first.
 */
function unsend(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  u: UnsureSend & { seq: number },
  reason: string,
): void {
  set((s) => {
    const sessions =
      s.sessions[u.sessionId] && u.prevState
        ? { ...s.sessions, [u.sessionId]: { ...s.sessions[u.sessionId]!, state: u.prevState } }
        : s.sessions
    const drafts = draftsWith(s.drafts, u.sessionId, u.text, u.attachments)
    return {
      chat: { ...s.chat, [u.sessionId]: (s.chat[u.sessionId] ?? []).filter((i) => i.seq !== u.seq) },
      drafts,
      // Nothing is left to wait for, so the "working" indicator comes down too
      sessions,
      // ...and the clock we started above stops with it, so a later turn cannot inherit it
      workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      toast: `Could not send: ${reason}`,
    }
  })
}

/** Prepends unsent text and attachments to that session's draft — text written in the meantime is not overwritten (in order, the failed message came first) */
function draftsWith(drafts: Record<string, Draft>, sessionId: string, text: string, attachments?: ChatAttachment[]): Record<string, Draft> {
  const cur = drafts[sessionId] ?? EMPTY_DRAFT
  return {
    ...drafts,
    [sessionId]: {
      text: cur.text ? `${text}\n${cur.text}` : text,
      attachments: [...(attachments ?? []), ...cur.attachments],
    },
  }
}

function restoreDraft(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  sessionId: string,
  text: string,
  attachments?: ChatAttachment[],
): void {
  set((s) => (s.sessions[sessionId] ? { drafts: draftsWith(s.drafts, sessionId, text, attachments) } : {}))
}

/**
 * Resolves messages of unknown send status after reconnecting (#173). Merging in the store's latest
 * page (`mergePage`) settles a message the host received into the stored row for that same sentence
 * — reconnect replay may already have confirmed it via `user_message` first. If it is still pending
 * even so, the host never received it, and it is undone at that point. It is also undone if history
 * could not be read at all — a message that could not be confirmed cannot be treated as sent.
 *
 * The remaining gap: if the host is in the middle of reviving a sleeping session and has not yet
 * stored the message, it arrives only after this has already undone it here.
 */
async function settleUnsureSends(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void): Promise<void> {
  const mine = [...unsureSends].filter(([, u]) => get().sessions[u.sessionId])
  for (const [seq] of [...unsureSends]) if (!mine.some(([s]) => s === seq)) unsureSends.delete(seq)
  for (const id of new Set(mine.map(([, u]) => u.sessionId))) await get().loadHistory(id)
  for (const [seq, u] of mine) {
    unsureSends.delete(seq)
    const item = get().chat[u.sessionId]?.find((i) => i.seq === seq)
    if (item?.kind === 'user' && item.pending) unsend(set, { ...u, seq }, 'Connection lost')
  }
}

/**
 * Sets a new session's conversation to its opening prompt (#172) — **never overwrites.**
 *
 * The host broadcasts `session_created`, `handoff` and `user_message`, in that order, before the
 * response — the screen registers the session from the first one, so the other two are already
 * attached to this conversation by the time the response arrives. This used to overwrite the
 * conversation with a single pending opening prompt when the response came in, which erased the
 * handoff marker, and left behind a pending row whose confirming event had already passed, so the
 * same prompt appeared twice when history was later read. If the same sentence is already attached,
 * nothing new is set; if not, it is appended after what is there (an event arriving after the
 * response then confirms this row).
 */
function withOpeningPrompt(chat: Record<string, ChatItem[]>, id: string, text: string): Record<string, ChatItem[]> {
  const have = chat[id] ?? []
  if (have.some((it) => it.kind === 'user' && it.text === text)) return chat
  return { ...chat, [id]: [...have, { kind: 'user', seq: ++chatSeq, text, pending: true }] }
}

/**
 * Prepends an older page (#79). A row whose number is already on screen is not appended again, and
 * a row that collides with a key on screen gets a new key (`rekeyAgainst`).
 */
function prependPage(have: ChatItem[], older: ChatItem[]): ChatItem[] {
  const held = new Set(have.flatMap((it) => (it.storedSeq === undefined ? [] : [it.storedSeq])))
  const fresh = older.filter((it) => it.storedSeq === undefined || !held.has(it.storedSeq))
  return [...rekeyAgainst(fresh, new Set(have.map((it) => it.seq))), ...have]
}

/** The attachment size cap. Above this, the app visibly freezes both during the base64 conversion and the WS send */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Bytes → base64.
 *
 * Appending one character at a time (`binary += String.fromCharCode(b)`) rebuilds the string from
 * scratch every time, freezing the app for tens of seconds even for a single screenshot (a few MB)
 * — the screen looks as if nothing is happening. This was in fact the reported symptom "file
 * attachment does not work." Processed in chunks instead.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

/**
 * How much history is read back at a time — **a count of messages, not rows** (#66).
 * The host's `loadMessages` merges delta chunks into messages before counting them, so what arrives
 * is 100 real messages, not the "200 rows = 200 tokens = a couple of sentences" that 200 meant in
 * the days before that merge.
 */
const HISTORY_PAGE = 100

/** How many recent messages a non-focused session keeps — reopening it loads more from the store */
const WINDOW_SIZE = 50

/**
 * Cuts a conversation down to its last `WINDOW_SIZE` rows, or returns null when there is nothing to cut.
 *
 * **Shrinking the window moves the cursor along with it** (dogfooding, 2026-09-09: "older
 * conversation does not load above").
 *
 * This used to trim only `chat`. That left the top of the screen at the freshly trimmed spot
 * while the cursor (`oldestSeq`) stayed at its old value, so "load earlier conversation"
 * prepended **a range that does not connect to the screen** — the trimmed-away gap was never
 * seen again. The trim point is now the new cursor.
 *
 * The cursor is the top row's **stored number** (#79). Back when the render key was used, if
 * the top of the 50 kept rows was a live row, the cursor received a number shared across every
 * session. The window never starts at an unnumbered row (an image, a message before
 * confirmation) — it has no number to set, and that row lives in the store anyway, so
 * `loadOlder` brings it back. If there is no numbered row at all, nothing is trimmed: trimming
 * with no cursor would leave no way back into the trimmed gap.
 */
function trimWindow(items: ChatItem[]): { items: ChatItem[]; oldestSeq: number } | null {
  if (items.length <= WINDOW_SIZE) return null
  let top = items.length - WINDOW_SIZE
  while (top < items.length && items[top]!.storedSeq === undefined) top++
  const oldestSeq = items[top]?.storedSeq
  return oldestSeq === undefined ? null : { items: items.slice(top), oldestSeq }
}

/**
 * How long an off-screen conversation may grow before it is cut back to the window.
 *
 * Losing focus is not the only way a conversation grows out of sight: a worker the orchestrator
 * started, a session an app asked for, a grid panel that is not the focused one — none of them is
 * ever focused and then left, so the trim in `focusSession` never reached them, and every event
 * (screenshots included, base64 and all) stayed in memory for the life of the window. Twice the
 * window leaves slack, so the cut happens once per window's worth of rows rather than on every event.
 */
const OFFSCREEN_TRIM_AT = WINDOW_SIZE * 2

/** A holding pen for events belonging to a session not yet registered in the store (replayed right after registration) */
const pendingEvents = new Map<string, NormalizedEvent[]>()

/**
 * A queue for re-reading the external app list (M4 A-8). If another "changed" arrives while a read
 * is in flight, it reads once more after the current one finishes. Overlapping reads can let a
 * late-departing answer arrive first, letting an old list overwrite the new one. This actually
 * overlaps while an app is coming up, since broadcasts arrive back to back (coming up → up).
 */
let externalAppsReading: Promise<void> | null = null
let externalAppsAgain = false

/**
 * How long a project's git refresh waits for the next trigger before it runs (issue #41).
 *
 * The triggers arrive in bursts, not singly: three sessions in one project finishing
 * seconds apart, an approval granted and the turn it unblocked ending right after, a
 * focus and a visibilitychange for one alt-tab. Each of those would otherwise be its own
 * `git status` over the same working tree. One trailing window per project collapses a
 * burst into one measurement, and it has to be short enough that the number has already
 * moved by the time the eye goes looking for it — 800ms is under the glance.
 *
 * The delay also puts the measurement *after* the write it was told about, which matters
 * for the approval trigger: the edit lands in the moment following the "allow", not in it.
 */
const GIT_REFRESH_MS = 800

/**
 * Pending git refreshes, one timer per project — module scope for the same reason
 * `subscriptions` is: nothing on screen reads a timer, so keeping it out of the store
 * costs no renders.
 */
const gitRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Whether two git summaries say the same thing — a refresh that found nothing must not redraw */
function sameGit(a: ProjectInfo['git'], b: ProjectInfo['git']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.branch === b.branch &&
    a.changedFiles === b.changedFiles &&
    a.isRepo === b.isRepo &&
    a.denied === b.denied
  )
}

/**
 * Replays events held while waiting for registration, in order, **only for sessions now
 * registered**.
 *
 * While only `createSession` drained this holding pen, events for a session that had already been
 * running on the host before the app was even opened stayed in the pen forever if they arrived
 * before `attach` registered the list — the entire output of the first turn was lost until a
 * restart. This is now called at every point a session gets registered. Cleared from the pen before
 * replay, so even overlapping calls never apply the same event twice.
 */
function replayPendingEvents(get: () => AppState): void {
  for (const id of [...pendingEvents.keys()]) {
    if (!get().sessions[id]) continue
    const buffered = pendingEvents.get(id)!
    pendingEvents.delete(id)
    for (const e of buffered) get().dispatchEvent(e)
  }
}

/**
 * Stacks a notification card — one per session.
 *
 * If the same session calls again, it is updated in place rather than added again, and **its
 * position keeps the order it was first added in.** Always sending it to the bottom would let a
 * busy session keep the cards constantly moving, so the card someone was about to press slips out
 * from under their finger.
 */
function pushNotice(set: (fn: (s: AppState) => Partial<AppState>) => void, notice: Notice): void {
  set((s) => {
    const at = s.notices.findIndex((n) => n.sessionId === notice.sessionId)
    if (at === -1) return { notices: [...s.notices, notice] }
    const notices = [...s.notices]
    notices[at] = notice
    return { notices }
  })
}

/**
 * Which tools the Usage modal should report on — deduplicated, in screen order (#26).
 *
 * Usage is an **account** property that differs per tool, so the only honest question is
 * "which tools are on screen right now". The old picker asked a narrower one — *the*
 * focused session's tool, then the project default, then a hardcoded `'claude'` — and
 * that question has no answer in the grid: `focusedSessionId` does not name one of nine
 * panels, so a grid of Codex agents fell through to Claude's limits with nothing on
 * screen saying a substitution had happened.
 *
 * Deduplicated because usage belongs to the account, not the session: two Claude panels
 * share one number, and printing it twice would suggest they are two separate budgets.
 *
 * **An empty result is a real result.** The `'claude'` fallback is gone — it turned
 * "we cannot tell" into "here is the wrong tool", which is the failure the caller has no
 * way to detect. The modal says it does not know instead.
 */
export function usageTools(s: AppState): ToolName[] {
  const out: ToolName[] = []
  const add = (t: ToolName | undefined) => {
    if (t && !out.includes(t)) out.push(t)
  }

  // The grid is the case where "the session you are looking at" is not singular
  if (s.view === 'grid') {
    for (const id of gridSessionIds(s.gridPanels)) add(s.sessions[id]?.tool)
    return out
  }

  // Focus (and the orchestrator) still look at one conversation — unchanged behaviour
  const session = s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined
  if (session) return [session.tool]
  add(s.focusedProjectId ? (s.projects[s.focusedProjectId]?.defaultTool ?? undefined) : undefined)
  return out
}

/**
 * True while `attach` restores the workspace snapshot. `saveWorkspace` does nothing then.
 *
 * The restore goes through the same setters a person uses (`focusSession`, `setPanelWidth`,
 * `setSidebarWidth`, `openOrchestrator`), and each of them saves. A save in the middle of the restore writes
 * the half-restored state back over the snapshot being read, so every field restored after that save is
 * stored as its default, and the next launch reads the default. It hit the folded projects (#205) and
 * `introSeen` (#63), each fixed by restoring that one field earlier, and then the spinning-marker
 * settings, which are restored last: the person turned both off, and after the machine restarted both
 * were on again (2026-09-30, on the real store: the snapshot held `false` for both at 06:18 and `true`
 * after the restart, with every other field unchanged). Reordering fixes one field at a time; not saving
 * while restoring fixes the class.
 */
let restoringWorkspace = false

/**
 * The latest workspace snapshot the host has not confirmed storing, and the one writer that sends it.
 *
 * A save used to be sent once and a failure swallowed (`.catch(() => {})`). On 2026-09-30 the machine
 * froze for hours; the person folded every project during that time, every save timed out (an RPC gives
 * up after 30 s), and after a restart the folds were gone because the stored snapshot never got them.
 * Now a failed save stays pending and goes out again: when the connection comes back, and after a short
 * backoff while connected.
 *
 * Only the **latest** snapshot is ever sent, and only one save is in flight at a time. A newer save
 * replaces the pending one instead of queueing behind it, so a retry can never write an older
 * arrangement over a newer one, and while a save is in flight the next one waits for it rather than
 * racing it.
 */
const workspaceSave = {
  pending: null as WorkspaceSnapshot | null,
  inFlight: false,
  retryTimer: null as ReturnType<typeof setTimeout> | null,
  /** Which step of `WORKSPACE_RETRY_MS` the next retry waits for. Reset by a stored save or a reconnect */
  attempt: 0,
  /** Bumped by a reset, so a save still settling from before it cannot touch the state after it */
  epoch: 0,
}

/**
 * The waits before retrying a failed save while connected. Past the last step it stops, and the
 * pending snapshot waits for the next reconnect or the next save: a host that fails every save is
 * not helped by being asked every 30 s forever.
 */
const WORKSPACE_RETRY_MS = [1_000, 5_000, 30_000] as const

function clearWorkspaceRetry(): void {
  if (workspaceSave.retryTimer) clearTimeout(workspaceSave.retryTimer)
  workspaceSave.retryTimer = null
}

/** Forgets any pending save. A new platform starts from its own stored snapshot, not the last one's leftovers */
function resetWorkspaceSave(): void {
  clearWorkspaceRetry()
  workspaceSave.pending = null
  workspaceSave.inFlight = false
  workspaceSave.attempt = 0
  workspaceSave.epoch++
}

/** Sends the pending snapshot unless one is already on its way (that one sends the newer when it settles) */
function flushWorkspace(get: () => AppState): void {
  if (restoringWorkspace || workspaceSave.inFlight) return
  const platform = get().platform
  const snap = workspaceSave.pending
  if (!platform || !snap) return
  clearWorkspaceRetry()
  workspaceSave.inFlight = true
  const epoch = workspaceSave.epoch
  platform.workspace.save(snap).then(
    () => {
      if (workspaceSave.epoch !== epoch) return // attach started over; this save belongs to before it
      workspaceSave.inFlight = false
      if (workspaceSave.pending === snap) {
        workspaceSave.pending = null
        workspaceSave.attempt = 0
      } else flushWorkspace(get) // A newer save came in meanwhile
    },
    () => {
      if (workspaceSave.epoch !== epoch) return
      workspaceSave.inFlight = false
      // A newer save came in meanwhile: it supersedes this one and goes now
      if (workspaceSave.pending !== snap) return flushWorkspace(get)
      // Disconnected: the reconnect sends it. Out of steps: the next reconnect or save does
      if (get().connection !== 'connected') return
      const wait = WORKSPACE_RETRY_MS[workspaceSave.attempt]
      if (wait === undefined) return
      workspaceSave.attempt++
      workspaceSave.retryTimer = setTimeout(() => {
        workspaceSave.retryTimer = null
        flushWorkspace(get)
      }, wait)
    },
  )
}

export const useStore = create<AppState>((set, get) => ({
  platform: null,
  connection: 'connecting',
  hostResyncs: 0,
  projects: {},
  gitEpoch: {},
  sessions: {},
  tools: [] as ToolStatus[],
  chat: {},
  drafts: {},
  stickToBottom: {},
  scrollAnchor: {},
  workingSince: {},
  expandedDirs: {},
  showIgnored: true,
  // Defaults to folded — the reason this feature exists at all is that a two-row grid leaves little room to read
  foldComposer: true,
  spinGrid: true,
  spinSessionIcon: true,
  focusedSessionId: null,
  focusedProjectId: null,
  newSessionFor: null,
  newSessionWorktree: false,
  newSessionBranch: '',
  worktreeProposals: [],
  mcpProposals: [] as { name: string; command: string; args: string[]; why?: string }[],
  externalAppChanges: {},
  externalAppRunChanges: {},
  externalAppChangedBy: {},
  externalApps: [] as ExternalAppInfo[],
  themeFiles: [] as ThemeFileEntry[],
  lastGoodThemes: {} as Record<string, ThemeFileEntry>,
  appQuestions: [] as AppQuestion[],
  appQuestionsVersion: 0,
  projectConsentsVersion: 0,
  skillProposals: [] as { name: string; content: string; why?: string }[],
  history: {},
  subagentSteps: {},
  resuming: {},
  wakeError: {},
  wakeLocked: {},
  panelOpen: true,
  panelLayout: defaultLayout(),
  view: 'focus' as 'focus' | 'grid' | 'orchestrator' | 'app',
  focusedApp: null as { projectId: string | null; appId: string } | null,
  pinnedViews: [] as PinnedView[],
  inlineViews: {} as Record<string, Record<string, InlineView>>,
  inlineFramesVersion: 0,
  gridPanels: [] as GridPanel[],
  builderPaneSessionId: null,
  builderPaneFor: null as string | null,
  orchestratorId: null as string | null,
  orchestratorWaking: false,
  introSeen: false,
  addProjectHint: false,
  trustAsk: null as string | null,
  panelSplit: 0.5,
  panelWidth: PANEL_DEFAULT,
  sidebarWidth: SIDEBAR_DEFAULT,
  foldedProjects: [],
  projectPanels: {} as Record<string, ProjectArrangement>,
  appSpans: {} as Record<string, GridSpan>,
  commandRuns: {} as Record<string, Record<string, CommandRunInfo>>,
  overlay: null,
  inboxOpen: false,
  toast: null,
  appFocused: true,
  completion: null as { sessionId: string; at: number } | null,
  notices: [] as Notice[],
  viewerPath: null,
  viewerProjectId: null,
  paletteOpen: false,
  openLayers: 0,
  approvalsInFlight: {} as Record<string, true>,
  uploading: {} as Record<string, number>,
  settingsMenuRequest: null as { sessionId: string; at: number } | null,
  usageOpen: false,
  settingsOpen: false,
  notifyPolicy: DEFAULT_NOTIFY_POLICY,
  importDialog: null as { source: string; fromLink: boolean; at: number } | null,
  update: null,
  agentVersions: null,
  prefs: DEFAULT_UI_PREFERENCES,

  async attach(platform) {
    /*
     * **Detach the previous subscription first.**
     *
     * A subscription is a **fresh closure** every time, so putting it in a Set never deduplicates
     * it. If `attach` runs twice, the same event is applied twice; three times, three times — the
     * screen shows text multiplied as is, arriving letter-duplicated like "호호스트가스트가" ("the
     * host is" with syllables doubled and overlapping) (this happened during dogfooding, once at ×3
     * and once at ×2).
     *
     * Streaming deltas are **cumulative**, which makes this failure mode especially bad: once it
     * goes wrong once, everything after it piles up wrong too. `attach` is built so calling it at any
     * time lands in the same state (idempotent).
     */
    detachAll()
    resetWorkspaceSave()
    set({ platform })
    subscriptions.push(
      platform.agents.subscribe((e) => get().dispatchEvent(e)),
      platform.agents.onConnectionChange((connection) => {
        const was = get().connection
        /*
         * resync_required: the connection itself is alive, but the host could not resend the
         * events that happened while it was disconnected (they fell outside the resend buffer).
         *
         * While nothing consumed this signal, two things went wrong: missed events were never
         * recovered, and the label logic drew anything other than `connected` as 'Disconnected',
         * so it **showed disconnected while actually connected**. The label is kept at `connected`,
         * and the gap is filled by a full resync (merging the session list and re-reading the
         * conversation being viewed).
         */
        if (connection === 'resync_required') {
          set({ connection: 'connected', hostResyncs: get().hostResyncs + 1 })
          void get().recoverAfterReconnect(true)
          return
        }
        set({ connection })
        // Disconnected and came back — revive sessions that were running
        if (connection === 'connected' && was !== 'connected') {
          // A save that failed while the host was away goes out now, with a fresh set of retries
          workspaceSave.attempt = 0
          flushWorkspace(get)
          void get().recoverAfterReconnect()
          // A new host (a restart, a switched build) read the installed CLIs before this window was back (#297)
          void get().checkAgentVersions(false)
        }
      }),
      /*
       * A command run's outcome (#60) — `runId` rides in the `terminalId` slot. A shell terminal's
       * exit has no matching id in `commandRuns`, so it is silently ignored. Why this is listened
       * for here rather than in a screen component: the badge must turn off even when the window
       * that was showing the log is closed.
       */
      platform.terminal.onExit((e) => {
        set((s) => {
          for (const [pid, runs] of Object.entries(s.commandRuns)) {
            for (const [cmd, r] of Object.entries(runs)) {
              if (r.runId !== e.terminalId || !r.running) continue
              return {
                commandRuns: {
                  ...s.commandRuns,
                  [pid]: { ...runs, [cmd]: { ...r, running: false, exitCode: e.exitCode } },
                },
              }
            }
          }
          return {}
        })
      }),
    )

    const [projects, sessions, gridPanels, tools, prefs, externalApps, themeFiles] = await Promise.all([
      platform.projects.list(),
      platform.agents.listSessions(),
      // The app must come up even if the layout cannot be read — the grid just looks empty
      // Sanitized: a host from before apps could stand on the grid answers bare session ids, which still read as sessions
      platform.agents.grid().then(sanitizeGridPanels).catch(() => [] as GridPanel[]),
      // Same reason: the tool list must not block the app either — if it cannot be read, only names show, with no label
      platform.agents.detect().catch(() => [] as ToolStatus[]),
      /*
        The screen settings must **never arrive later than the first screen.**

        Unlike something that is fine arriving late (like an update check), this value decides how
        the composer reads Enter. Arriving late means the send key changes while the person is
        already typing, and that mistake cannot be undone — the message is already gone.

        Even so, it must **never block**: if it cannot be read, use the default. An app that cannot
        come up because of one setting is far worse than whatever that setting does.
      */
      // Read through the schema, field by field: an older host answers without the fields it does not know
      platform.prefs.load().then(parseUiPreferences, () => DEFAULT_UI_PREFERENCES),
      // The external app list (A-8) also arrives with the first screen — so the sidebar's app rows
      // do not pop in late. The app still comes up if it cannot be read: the app rows just look
      // empty, and the next broadcast re-reads them
      platform.apps.list().catch(() => [] as ExternalAppInfo[]),
      // The theme files arrive with the preferences that choose among them, so the first screen
      // already has its theme — and a folder that cannot be read just means the presets
      platform.themes.list().catch(() => [] as ThemeFileEntry[]),
    ])
    const known: Record<string, SessionSummary> = Object.fromEntries(
      sessions.map((s) => [
        s.id,
        {
          /*
           * Take every stored setting the host hands back, not just one of them (issue #37).
           *
           * This asked for `effort` and stopped there, so a cold start rebuilt each session
           * with `model: null`, `permissionPreset: 'normal'` and `worktree: null` — the
           * defaults from initialSession — while the database still held what the user had
           * picked. Nothing was ever lost on the way down; the screen read back its own
           * defaults and presented them as the session, so every restart looked like the
           * settings had been thrown away (and the worktree badge vanished with them).
           * The reconnect merge builds the same summary from the same list and already names
           * all of these — two places that construct one thing have to ask for one set.
           */
          ...initialSession({
            id: s.id,
            projectId: s.projectId,
            kind: s.kind,
            appId: s.appId,
            askedBy: s.askedBy ?? null,
            name: s.name,
            tool: s.tool,
            model: s.model,
            effort: s.effort,
            verbosity: s.verbosity,
            serviceTier: s.serviceTier,
            permissionPreset: s.permissionPreset,
            worktree: s.worktree,
            parentSessionId: s.parentSessionId,
            merged: s.worktreeMerged,
            pr: s.worktreePr,
            goal: s.goal,
          }),
          autoNamed: s.autoNamed,
          state: s.state,
          live: s.live,
          lastSeq: s.lastSeq,
          lastReadSeq: s.lastReadSeq,
          waitingSince: s.waitingSince,
          // The while-alive facts also come from the host — without them, a session could sit at
          // state=waiting_approval with no payload to draw the card, and the approval request would
          // never appear on screen (measured after a restart)
          ...liveFactsOf(s),
        },
      ]),
    )
    set((st) => ({
      projects: Object.fromEntries(projects.map((p) => [p.id, p])),
      sessions: known,
      // A session can already be mid-turn when we arrive; stamp it now so the elapsed
      // line has an instant to count from instead of its own mount (issue #23)
      workingSince: trackWorkingSince(st.workingSince, known, Date.now()),
      gridPanels,
      tools,
      prefs,
      externalApps,
      themeFiles,
      lastGoodThemes: goodThemes(st.lastGoodThemes, themeFiles),
      connection: 'connected',
    }))

    // Replay events that arrived before the list was registered — the first output of a session that
    // was already running before the app was even opened is held here
    replayPendingEvents(get)

    // A suggestion awaiting approval stays on the host even across the app being closed and reopened
    // — its card must reappear
    void get().refreshMcpProposals()
    // Capability questions also survive on the host (M4 D-4) — an app's call waiting for an answer hangs there
    void get().refreshAppQuestions()
    void get().refreshSkillProposals()

    /*
     * Catches up on what the host already knows (issue #43).
     *
     * **Does not wait.** If the app came up late because of a version check, the order is backwards.
     * `force: false` means this usually just receives the host's cache, but when nothing is known
     * yet, it can end up waiting on the network — those few seconds must never stand in front of the
     * screen.
     *
     * Why a subscription alone is not enough: the host's first check happens right at startup, which
     * finishes before this window even attaches. The broadcast has already passed by then, so
     * whoever arrives late has to ask once for itself.
     */
    void get().checkUpdate(false)
    // The installed agent CLIs (#297), for the same reason: the host read them before this window attached
    void get().checkAgentVersions(false)

    // Come back to where you were (C-3). A session that no longer exists is quietly skipped.
    restoringWorkspace = true
    try {
      const snap = await platform.workspace.load()
      if (snap) {
        /*
         * Folded projects are restored **first of all** (#205). `focusSession` right below this
         * calls `saveWorkspace`, and if this value is still its initial state ([]) at that point, it
         * writes an empty list back over the snapshot just read, erasing the fold — the same thing
         * that happens to `introSeen` (see the comment below). Anything that is not a string is
         * discarded. (Saves are now held off for the whole restore, `restoringWorkspace`, so this order
         * is no longer what protects the fold.)
         */
        const savedFolds = (snap as { foldedProjects?: unknown }).foldedProjects
        if (Array.isArray(savedFolds)) {
          set({ foldedProjects: savedFolds.filter((id): id is string => typeof id === 'string') })
        }
        // The project screens' arrangements (#203), first for the same reason as the fold above
        set({ projectPanels: sanitizeArrangements((snap as { projectPanels?: unknown }).projectPanels) })
        // The person's span per app (#306). A snapshot from before it has none; an entry that is not a span is dropped
        const savedSpans = (snap as { appSpans?: unknown }).appSpans
        if (savedSpans && typeof savedSpans === 'object' && !Array.isArray(savedSpans)) {
          const spans: Record<string, GridSpan> = {}
          for (const [key, raw] of Object.entries(savedSpans)) {
            const span = sanitizeGridSpan(raw)
            if (span) spans[key] = span
          }
          set({ appSpans: spans })
        }
        if (snap.focusedSessionId && get().sessions[snap.focusedSessionId]) {
          /*
           * Reviving a session never unfolds it (#205). If the app was closed with the session's
           * project folded, that fold was left deliberately by the person too — unfolding it would
           * have this erase the remembered fold on every restart.
           */
          get().focusSession(snap.focusedSessionId, { reveal: false })
        }
        /*
         * The view comes back *after* the session, on purpose: focusSession forces
         * view:'focus' (selecting a session must show it), so restoring in the other
         * order would have the session restore quietly undo the view restore — the
         * exact bug being fixed, reintroduced by ordering.
         *
         * The orchestrator goes through its own door (openOrchestrator) rather than a
         * bare set: the view alone would be a "Waking the orchestrator…" screen that
         * nothing is actually waking.
         */
        /*
         * `introSeen` is restored **before** `view` (#63). `openOrchestrator` below calls
         * `saveWorkspace`, and if `introSeen` is still its initial state (`false`) at that point, it
         * writes `false` back over the snapshot just read, erasing the stored value — the next launch
         * showed the intro screen again (measured: a partial save mid-restore clobbers whichever
         * field is restored last). That class is now closed by `restoringWorkspace`.
         */
        if ((snap as { introSeen?: boolean }).introSeen === true) set({ introSeen: true })
        const savedView = (snap as { view?: unknown }).view
        if (savedView === 'grid') set({ view: 'grid' })
        else if (savedView === 'orchestrator') void get().openOrchestrator()
        else if (savedView === 'app') {
          /*
           * The app that was being viewed as a pinned view (B-2). The list is already loaded from
           * the first snapshot above — if the app no longer exists (its folder disappeared, its
           * project was deleted), it is not restored and the focus view is left as is. Opening it
           * has the host call `home`: what comes back to that spot is a single app process.
           */
          const app = snap.focusedApp
          if (app && get().externalApps.some((a) => a.appId === app.appId && a.projectId === app.projectId)) {
            get().openApp(app.projectId, app.appId)
          }
        }
        /*
         * Layout prefs come back even when the focused session is gone (#20). They used
         * to sit inside the session check above, so a snapshot whose session had been
         * deleted threw the whole arrangement away with it — but the panel's shape is a
         * fact about the person, not about any session. (The legacy `snap.tab` field is
         * still ignored: that tab structure was replaced by the three lanes.)
         */
        if (typeof snap.panelOpen === 'boolean') set({ panelOpen: snap.panelOpen })
        /*
         * The arrangement survives restart, globally (#20 decision). `panelLayout` is
         * the arrangement; `panelTab` is the pre-#20 single-tab field, kept as the
         * fallback so a snapshot written before the arrangement existed still restores
         * the tab that was showing.
         */
        const savedLayout = (snap as { panelLayout?: unknown }).panelLayout
        if (savedLayout != null) {
          set({ panelLayout: sanitizeLayout(savedLayout) })
          // The split ratio is also part of the arrangement — it comes back alongside the arrangement itself
          const savedSplit = (snap as { panelSplit?: unknown }).panelSplit
          if (typeof savedSplit === 'number' && Number.isFinite(savedSplit)) {
            get().setPanelSplit(savedSplit)
          }
        } else if (
          snap.panelTab === 'files' ||
          snap.panelTab === 'git' ||
          snap.panelTab === 'history' ||
          snap.panelTab === 'terminal'
        ) {
          set({ panelLayout: activateTab(defaultLayout(), snap.panelTab) })
        }
        if (typeof snap.panelWidth === 'number') get().setPanelWidth(snap.panelWidth)
        if (typeof snap.sidebarWidth === 'number') get().setSidebarWidth(snap.sidebarWidth)
        // `railWidth` (the control rail's width, #81) may still be in a snapshot an older build wrote.
        // The rail is gone (#97); the field is left unread rather than treated as a broken snapshot.
        const savedPolicy = (snap as { notifyPolicy?: NotifyPolicy }).notifyPolicy
        if (savedPolicy) set({ notifyPolicy: savedPolicy })
        // Whether the tree shows ignored files is a way of looking, so it comes back with
        // the rest of the panel's layout rather than being re-chosen every launch (#17).
        //
        // The `typeof` guard is what lets the default move. Reading the field as a plain
        // falsy check would make "never wrote one" indistinguishable from "turned it off",
        // and flipping the default to on would then quietly turn it back on for the one
        // person who had deliberately turned it off. An absent field takes the new default;
        // a stored `false` is a decision and outranks it.
        const savedIgnored = (snap as { showIgnored?: boolean }).showIgnored
        if (typeof savedIgnored === 'boolean') set({ showIgnored: savedIgnored })
        // The text size used to be restored here too; it is a preference now (UiPreferences.textSize),
        // and the host moved the snapshot's old step into it once (#312 step 5)
        // Same `typeof` guard — a stored `false` was the person's decision, and outranks the default
        const savedFold = (snap as { foldComposer?: boolean }).foldComposer
        if (typeof savedFold === 'boolean') set({ foldComposer: savedFold })
        // Same rule: a stored `false` means the person turned it off, so it outranks the default (on)
        const savedSpinGrid = (snap as { spinGrid?: boolean }).spinGrid
        if (typeof savedSpinGrid === 'boolean') set({ spinGrid: savedSpinGrid })
        const savedSpinIcon = (snap as { spinSessionIcon?: boolean }).spinSessionIcon
        if (typeof savedSpinIcon === 'boolean') set({ spinSessionIcon: savedSpinIcon })
      }
    } catch {
      /* The app works normally even with no snapshot */
    } finally {
      restoringWorkspace = false
    }

    /*
     * Wakes sessions parked in the grid ahead of time (dogfooding, the Mea session: reviving a large
     * codex thread measured at 7-13 seconds, and that cost belongs to codex itself, which we cannot
     * reduce. A cost that cannot be reduced can still be **moved to a time nobody is waiting on**).
     * Putting a session on the grid already means it is about to be watched — it needs to already be
     * alive by the time it is clicked.
     *
     * Woken one at a time: each panel brings up its own external process, so waking them all at once
     * would be a stampede of processes right at startup. `wake()` already skips a session that is
     * already alive or gone (including a panel focus-restore has already woken), and a failure is
     * left in that panel's `wakeError` — the same spot as when woken by a click, so no new failure
     * path is introduced.
     */
    void (async () => {
      for (const id of gridSessionIds(get().gridPanels)) {
        if (get().connection !== 'connected') return // Stop if disconnected — the reconnect path picks it back up
        await get().wake(id)
      }
    })()
  },

  /**
   * Saves every time state changes — "save on exit" is helpless against a crash.
   *
   * **This must be the only place that writes the snapshot.** The host replaces the layout whole,
   * so the moment a second writer saves a partial snapshot, each erases the other's fields — this
   * actually happened, when `setNotifyPolicy` saved separately with its own list, and the notify
   * policy and history height were quietly reset by the other save. A new field has to be
   * added **to this function**.
   *
   * The snapshot is not sent from here directly: it becomes the pending one and `flushWorkspace` sends
   * it, so a save that fails is sent again rather than dropped (see `workspaceSave`).
   */
  saveWorkspace() {
    // Nothing is saved while the snapshot is being restored: see `restoringWorkspace`
    if (restoringWorkspace) return
    const s = get()
    if (!s.platform) return
    workspaceSave.pending = {
      focusedSessionId: s.focusedSessionId,
      view: s.view,
      focusedApp: s.focusedApp,
      panelOpen: s.panelOpen,
      // The single-tab field predates the arrangement (#20). It keeps carrying the
      // top group's active tab so an older build reading this snapshot still lands
      // on the tab that was showing.
      panelTab: s.panelLayout[0]?.active,
      panelLayout: s.panelLayout,
      panelSplit: s.panelSplit,
      panelWidth: s.panelWidth,
      sidebarWidth: s.sidebarWidth,
      foldedProjects: s.foldedProjects,
      projectPanels: s.projectPanels,
      appSpans: s.appSpans,
      notifyPolicy: s.notifyPolicy,
      showIgnored: s.showIgnored,
      foldComposer: s.foldComposer,
      spinGrid: s.spinGrid,
      spinSessionIcon: s.spinSessionIcon,
      introSeen: s.introSeen,
    } as never
    flushWorkspace(get)
  },

  setBuilderPane(sessionId) {
    if (get().builderPaneSessionId !== sessionId) set({ builderPaneSessionId: sessionId })
  },

  setAppFocused(focused) {
    /*
     * **Only the false→true edge.** `onVisibility` fires once at mount while `appFocused`
     * is already true and `attach` has just fetched every project — refreshing on every
     * call would repeat that fetch for no new information. Focus and visibilitychange also
     * both fire for a single alt-tab; the debounce would collapse those anyway, but there
     * is no reason to arm two timers to learn one thing.
     */
    const returning = focused && !get().appFocused
    set({ appFocused: focused })
    /*
     * Coming back to the window is the only signal we get for work done **outside** the app
     * (issue #41): a commit typed in a terminal, a rebase, a `git clean`. Nothing in here
     * watched it happen, so no project is more suspect than another and all of them are
     * re-measured — refreshing only the focused one would leave every other sidebar row
     * exactly as stale as before, which is the bug.
     */
    if (returning) for (const id of Object.keys(get().projects)) get().refreshProjectGit(id)
    // The same signal for an agent CLI updated in a terminal (#297): the host reads the installed versions again
    if (returning) void get().checkAgentVersions(false)
  },

  dismissNotices(sessionIds) {
    if (sessionIds.length === 0) return
    const drop = new Set(sessionIds)
    set((s) => {
      const kept = s.notices.filter((n) => !drop.has(n.sessionId))
      // Leave it as is when nothing changed — putting in a new array reruns any effect watching this
      return kept.length === s.notices.length ? {} : { notices: kept }
    })
  },

  dispatchEvent(e) {
    /*
     * Events that do not belong to a session are handled **before the session guard** (issue #43).
     *
     * The `if (!sessionId) return` below is the widest door in this file, and anything caught by it
     * vanishes silently — placing the update status handling after it would make the host's message
     * arrive and do nothing, the worst kind of defect to trace.
     */
    if (e.type === 'update_status') {
      set({ update: e.status })
      return
    }
    // App-wide like update_status (#297): the installed agent CLIs, read on the host's own schedule
    if (e.type === 'agent_versions') {
      set({ agentVersions: e.status })
      return
    }

    if (e.type === 'themes_changed') {
      void get().refreshThemes()
      return
    }

    // A built-in app's document changed (#81). The only built-in app, the control rail, is gone (#97), so nothing reads it
    if (e.type === 'app_state_changed') return

    /*
     * An external app's tool call finished (M4 A-4 → B-5). Not re-read here. An external app's state
     * lives in the app process, and re-reading it is the open view's own job, through its state tool.
     * The store only counts, and that app's open `AppFrame`s turn this count's change into a single
     * notification.
     */
    if (e.type === 'external_app_state_changed') {
      const key = externalAppKey(e.projectId, e.appId)
      const by = e.cause?.kind === 'view' ? (e.cause.instanceId ?? null) : null
      set((s) => ({
        externalAppChanges: { ...s.externalAppChanges, [key]: (s.externalAppChanges[key] ?? 0) + 1 },
        externalAppChangedBy: { ...s.externalAppChangedBy, [key]: by },
      }))
      return
    }

    // An external app's run history changed (M4 D-6) — only counted. That app's runs panel re-reads on this count's change. The view never hears this
    if (e.type === 'external_app_runs_changed') {
      const key = externalAppKey(e.projectId, e.appId)
      set((s) => ({ externalAppRunChanges: { ...s.externalAppRunChanges, [key]: (s.externalAppRunChanges[key] ?? 0) + 1 } }))
      return
    }

    // An external app's slot or state changed (M4 A-8) — since what changed is not carried, the whole list is re-read
    if (e.type === 'external_apps_changed') {
      void get().refreshExternalApps()
      return
    }

    /*
     * A native subagent's step (#222). It is not the conversation: it changes no state, adds no row and never moves
     * unread. It only joins a launch card's steps the person has opened, once every earlier step is read (`more`
     * false) — appended past a page not read yet, it would leave a hole in the middle.
     */
    if (e.type === 'subagent_event') {
      if (e.stepSeq === undefined) return
      const cur = get().subagentSteps[e.sessionId]?.[e.parentCallId]
      if (!cur || cur.more || cur.rows.some((r) => r.seq === e.stepSeq)) return
      const row = subagentRow(e.sessionId, e.stepSeq, e.step)
      set((s) => putSubagentSteps(s.subagentSteps, e.sessionId, e.parentCallId, { ...cur, rows: [...cur.rows, row] }))
      return
    }

    // A cross-project consent was remembered or revoked (#371) — Settings' list re-reads on the version
    if (e.type === 'project_consents_changed') {
      set((s) => ({ projectConsentsVersion: s.projectConsentsVersion + 1 }))
      return
    }

    // A capability question was created or closed (M4 D-4) — same coarseness, the whole list is re-read
    if (e.type === 'external_app_questions_changed') {
      void get().refreshAppQuestions()
      return
    }

    const sessionId = e.sessionId
    if (!sessionId) return

    /*
     * The host caught up on a conversation continued from outside (through the tool's own
     * terminal). Its content already went into the store, so the screen is re-read whole — replaying
     * events row by row here could mix in with the part we already knew.
     */
    if (e.type === 'history_synced') {
      void get().loadHistory(sessionId)
      return
    }

    /*
     * The orchestrator changed this session's settings (#30).
     *
     * The toast is the point — if a setting changed by a hand other than the person's quietly seeped
     * into the screen, the next person to open the menu would be baffled by a value they never chose.
     * The value is a snapshot, so it is overwritten as is.
     */
    if (e.type === 'settings_changed') {
      const cur0 = get().sessions[sessionId]
      if (!cur0) return
      const what = [
        e.model !== cur0.model ? `model ${e.model ?? 'default'}` : null,
        e.effort !== cur0.effort ? `effort ${e.effort ?? 'default'}` : null,
        e.verbosity !== cur0.verbosity ? `verbosity ${e.verbosity ?? 'default'}` : null,
        (e.serviceTier ?? null) !== cur0.serviceTier ? `speed ${e.serviceTier ?? 'default'}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...s.sessions[sessionId]!,
            model: e.model,
            effort: e.effort,
            verbosity: e.verbosity,
            serviceTier: e.serviceTier ?? null,
          },
        },
        /*
         * A switch the agent tool made by itself (#304) updates the model shown without a toast: the tool's notice in
         * the conversation already says what changed and why, and a toast would interrupt for something that needs
         * nothing from the person.
         */
        ...(what && e.by !== 'tool' ? { toast: `Orchestrator changed ${cur0.name}: ${what}` } : {}),
      }))
      return
    }

    /** Whether this event already alerted the person — a flag so the same instant does not fire twice */
    let announced = false

    /*
     * The response finished — the trigger for one sweep of the screen.
     *
     * **Visibility is decided right now.** This used to keep only the fact, and let the screen
     * multiply in "is it visible" later, which lets the two moments fall out of sync: switching to
     * the session at the very instant it becomes visible would also make that later check true, so
     * **the sweep fired even though nothing had just finished** (dogfooding: "it also fires just from
     * switching session windows"). Worse, since this value was never cleared, it repeated every time
     * on switching back and forth.
     *
     * Deciding it once, at the instant the event happens, leaves no room to fall out of sync.
     * The instant is kept alongside it so the same session finishing twice in a row still fires each
     * time.
     *
     * Something that finished off screen is left as a **card**, not a sweep — since it was not being
     * watched, a passing signal would be missed. The two are two faces of the same event, and mutually
     * exclusive.
     */
    if (e.type === 'turn_complete') {
      const s = get()
      /*
       * **Seen = the app is in front, and that session is on screen.**
       *
       * The first half used to be missing. `isOnScreen` only checks which session is showing in the
       * UI, so it was true even with the app behind another window — but stepping away makes the
       * whole app invisible. So the sweep fired in an empty room, and the very card built for the
       * case of stepping away was never created. Exactly nothing happened in the one case a
       * notification mattered most.
       */
      const seen =
        s.appFocused &&
        isOnScreen(s.view, sessionId, {
          focusedSessionId: s.focusedSessionId,
          orchestratorId: s.orchestratorId,
          gridSessions: gridSessionIds(s.gridPanels),
          builderPaneSessionId: s.builderPaneSessionId,
          projectScreen: projectScreenSessions(s),
        })
      if (seen) {
        set({ completion: { sessionId, at: Date.now() } })
      } else {
        pushNotice(set, {
          sessionId,
          kind: 'done',
          name: s.sessions[sessionId]?.name ?? sessionId,
          at: Date.now(),
        })
        /*
         * The card and the sound go together. A card that piles up silently reads as "the card is
         * there, why did it not alert me," and to someone who stepped away, a card is only seen once
         * they come back — so a card alone is half the job. The sound follows the same policy as
         * every other notification — quietly leave only the card while the app is in view.
         */
        if (s.notifyPolicy.done && (!s.appFocused || s.notifyPolicy.whenFocused)) {
          announced = true
          void s.platform?.system
            .alert('done', s.notifyPolicy.sound)
            .catch((err: Error) => set({ toast: `Could not alert: ${err.message}` }))
        }
      }

      /*
       * A finished turn is the cheapest strong hint that the working tree moved (issue #41):
       * an agent just stopped editing in that folder, which is the very thing that made the
       * sidebar's changed count wrong. No filesystem watcher needed for the common case —
       * that is a bigger design (#34) and this must not wait for it.
       *
       * The session may not be registered yet (its events arrive buffered and are replayed
       * after `attach` lists it); the replay runs this branch again with a project to name.
       */
      const projectId = s.sessions[sessionId]?.projectId
      if (projectId) get().refreshProjectGit(projectId)
    }

    /*
     * The only notice for a session the host created on its own (#69) — the orchestrator's
     * `create_session`, or a manager set up by worktree adoption. Without this, such a session did
     * not appear until after a reconnect, and any event that arrived before that stayed stuck in the
     * holding pen forever (its release condition was "once registered," and nothing was there to
     * register it). A session created through an RPC is already registered by its response, so this
     * is silently discarded for that case.
     */
    if (e.type === 'session_created') {
      const parsed = SessionInfo.safeParse(e.session)
      if (parsed.success && !get().sessions[parsed.data.id]) {
        const s = parsed.data
        set((st) => ({
          sessions: {
            ...st.sessions,
            [s.id]: {
              ...initialSession({
                id: s.id,
                projectId: s.projectId,
                kind: s.kind,
                appId: s.appId,
                askedBy: s.askedBy ?? null,
                name: s.name,
                tool: s.tool,
                model: s.model,
                effort: s.effort,
                verbosity: s.verbosity,
                serviceTier: s.serviceTier,
                permissionPreset: s.permissionPreset,
                worktree: s.worktree,
                parentSessionId: s.parentSessionId,
                merged: s.worktreeMerged,
                pr: s.worktreePr,
                goal: s.goal,
              }),
              autoNamed: s.autoNamed,
              state: s.state,
                  live: s.live,
              lastSeq: s.lastSeq,
              lastReadSeq: s.lastReadSeq,
              waitingSince: s.waitingSince,
              ...liveFactsOf(s),
            },
          },
        }))
        // If there are events held from before registration, now is the moment to replay them
        replayPendingEvents(get)
      }
      return
    }

    /*
     * An in-conversation app view (M4 B-1). Lives separate from cards — the view finds its own spot
     * by the card's id. Recorded even before the session is registered: it takes its place under the
     * card the instant the card is drawn.
     */
    if (e.type === 'app_view') {
      const was = get().inlineViews[sessionId]?.[e.callId]
      set((s) => ({ inlineViews: { ...s.inlineViews, [sessionId]: applyAppView(s.inlineViews[sessionId], e) } }))
      // The host closed a live view — send teardown, then close it
      if ((e.phase === 'closed' || e.phase === 'rejected') && was?.state === 'live') {
        void get().closeInlineView(sessionId, e.callId, e.reason ?? 'This view was closed')
      }
      if (e.phase === 'open') {
        // The code this view was opened with (C-4) — if the list's fingerprint differs from this, it is stale HTML (`followAppCode`)
        const codeStamp = codeStampOf(get().externalApps, e.projectId, e.appId)
        set((s) => {
          const cur = s.inlineViews[sessionId]?.[e.callId]
          return cur?.state === 'live' ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [e.callId]: { ...cur, codeStamp } } } } : {}
        })
        capInlineViews(get, sessionId, e.callId)
      }
      return
    }

    // A deletion means the session is gone, so it does not run through the reducer
    if (e.type === 'session_deleted') {
      set((s) => {
        const sessions = { ...s.sessions }
        delete sessions[sessionId]
        return { sessions, ...forgetSessions(s, new Set([sessionId])) }
      })
      return
    }

    const cur = get().sessions[sessionId]
    if (!cur) {
      // An event that arrived before the session was registered (the initial prompt streaming right
      // away is one such case). Discarding it would lose the whole first turn, so it is held and
      // replayed right after registration.
      pendingEvents.set(sessionId, [...(pendingEvents.get(sessionId) ?? []), e])
      return
    }

    const next = applyEvent(cur, e, Date.now())
    /*
     * `chat[id]` being **absent** means "history has not been read yet" — focusing reads that and
     * calls for history. But a non-conversation event (a state change, context usage, and so on)
     * also arrives here, and writing `[]` for it would make that session read as "read, and empty,"
     * so **history is never called for again.** Dogfooding, 2026-09-25: an 11,550-line session
     * looked completely empty after reopening the app. An event the host sent while resuming it had
     * arrived before the user ever clicked that session. So no slot is created for a session that had
     * no conversation to append and no slot yet.
     */
    const had = get().chat[sessionId]
    const appended = appendChat(had ?? [], e)
    const chat = had === undefined && appended.length === 0 ? undefined : appended
    /*
     * A project suggestion (#63) ends with **pointing**, nothing more.
     *
     * Putting a folder-picker button inside the conversation would create a second door doing the
     * same job as the sidebar's Add project, and a first-time viewer would learn "projects are
     * something you ask the orchestrator to do" — which should be exactly backwards. So this only
     * lights up the sidebar button: there is one door in the app, and the orchestrator just points at
     * where it is.
     */
    if (e.type === 'tool_call' && /propose_project$/.test(e.summary.tool)) set({ addProjectHint: true })
    // An MCP server suggestion (`propose_mcp_server`) — the list is re-read because the host holds the truth
    if (e.type === 'tool_call' && /propose_mcp_server$/.test(e.summary.tool)) void get().refreshMcpProposals()
    // A skill suggestion (#71) — the same rule
    if (e.type === 'tool_call' && /propose_skill$/.test(e.summary.tool)) void get().refreshSkillProposals()
    /*
     * A worktree suggestion (#69) — the same principle (pointing), carrying one extra value: the
     * branch name. The adapter carries it in the title (there is no other channel). If the title is
     * exactly the tool's own name, the suggestion has no name — the window opens with an empty name.
     */
    if (e.type === 'tool_call' && /propose_worktree_session$/.test(e.summary.tool) && cur.projectId) {
      const branch = /propose_worktree_session$/.test(e.summary.title) ? '' : e.summary.title
      set((st) => ({
        worktreeProposals: st.worktreeProposals.some(
          (p) => p.projectId === cur.projectId && p.branch === branch,
        )
          ? st.worktreeProposals // The same suggestion arriving again does not queue up a second time (idempotent across replay and reconnect)
          : [...st.worktreeProposals, { projectId: cur.projectId as string, branch }],
      }))
    }
    /*
     * **Unread tracking (`lastSeq`) advances only by the seq the host assigns within the session.**
     *
     * It used to advance by the conversation item's render key (`chatSeq`, shared across every
     * session). That value flows through `markRead` into the host's `last_read_seq`, so after viewing
     * a 200-message session, even a single event arriving in a 2-message session inflated that
     * session's `last_read_seq` to around 201 — and even across a restart, its unread dot never
     * appeared again. The render key and the stored sequence are two different numbering schemes.
     */
    const hostSeq = 'seq' in e && typeof e.seq === 'number' ? e.seq : null
    let withSeq = hostSeq != null ? bumpSeq(next, hostSeq) : next
    // A message sent by me (or by the orchestrator) also gets marked read by the host — the screen follows
    if (e.type === 'user_message') withSeq = markReadPure(withSeq, e.seq)
    /*
     * A lock found after the session was already handed back (#168, item 5) — a slow background
     * resume. The host has dropped the handle, so the session is dormant again, and its dormant line
     * offers the same "Continue in a fork" as a lock found while waking.
     */
    const lockedLate = e.type === 'error' && e.error.code === 'conversation_locked' ? e.error.message : null
    if (lockedLate !== null) withSeq = { ...withSeq, live: false }

    set((st) => {
      const sessions = { ...st.sessions, [sessionId]: withSeq }
      /*
       * An off-screen conversation is cut back to the window (OFFSCREEN_TRIM_AT), never while a page of history is
       * still on its way: that page is merged against the rows it was asked for. The focused session is never cut,
       * even while the orchestrator, the grid or a pinned app covers it: it is the conversation the person returns
       * to, with the pages they loaded and their reading position (docs/state-management.md §4).
       */
      const trimmed =
        chat !== undefined &&
        chat.length > OFFSCREEN_TRIM_AT &&
        sessionId !== st.focusedSessionId &&
        !st.history[sessionId]?.loading &&
        !isOnScreen(st.view, sessionId, {
          focusedSessionId: st.focusedSessionId,
          orchestratorId: st.orchestratorId,
          gridSessions: gridSessionIds(st.gridPanels),
          builderPaneSessionId: st.builderPaneSessionId,
          projectScreen: projectScreenSessions(st),
        })
          ? trimWindow(chat)
          : null
      return {
        sessions,
        ...(lockedLate !== null
          ? { wakeError: { ...st.wakeError, [sessionId]: lockedLate }, wakeLocked: { ...st.wakeLocked, [sessionId]: true } }
          : {}),
        ...(trimmed
          ? {
              history: {
                ...st.history,
                [sessionId]: { oldestSeq: trimmed.oldestSeq, more: trimmed.oldestSeq > 1, loading: false },
              },
            }
          : {}),
        chat: chat === undefined ? st.chat : { ...st.chat, [sessionId]: trimmed ? trimmed.items : chat },
        // A turn begins because an event arrived — this is where its start instant is
        // recorded, so the elapsed line survives remounting (issue #23)
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })

    // Notifications are decided only when the state changed (the decision belongs to core, delivery to the system port)
    if (withSeq.state !== cur.state) {
      const st = get()
      const platform = st.platform
      if (!platform) return

      const ctx = { appFocused: st.appFocused, policy: st.notifyPolicy }
      const after = Object.values(st.sessions)
      const before = after.map((x) => (x.id === sessionId ? cur : x))

      const one = notificationFor({ id: sessionId, name: withSeq.name, state: withSeq.state }, cur.state, ctx)
      const all = allDoneNotification(after, before, ctx)
      // If there is a per-session notice, use only that — do not fire twice at the same instant
      // If a per-session completion already fired, "all done" does not fire on top of it — twice at the same instant is just noise
      const notice = one ?? (announced ? null : all)
      if (notice) {
        // The banner has been downgraded to a nice-to-have (this path is dead on macOS).
        // If it could not be sent, it is left on screen — disappearing silently would make "notifications do not arrive" undiagnosable.
        void platform.system.notify(notice.title, notice.body).catch((e: Error) => set({ toast: e.message }))
        // The path that actually reaches the person. Goes through neither permissions nor signing.
        void platform.system
          .alert(notice.kind, st.notifyPolicy.sound)
          .catch((e: Error) => set({ toast: `Could not alert: ${e.message}` }))
      }
      // An approval or error is only resolved once the person shows up → also left as a card so it survives until they come back.
      // "All done" is not about a single session, so it never creates a card (a per-session card already exists for that).
      if (one) {
        pushNotice(set, {
          sessionId,
          kind: one.kind === 'error' ? 'error' : 'approval',
          name: withSeq.name,
          at: Date.now(),
        })
      }
      void platform.system.setBadge(badgeCount(countWaiting(after)))
    }
  },

  /** Selects only the project — git, files and the viewer can be viewed without picking a session */
  focusProject(id) {
    set(() => ({
      focusedProjectId: id,
      /*
       * Picking a project **always** releases session focus — the click was made to see the project
       * screen. This used to release it only when a *different* project was picked, so clicking that
       * same project's name while already viewing one of its sessions left the session in place,
       * looking as if nothing had happened (user report 2026-09-28). The only callers are the
       * sidebar's name and the palette when it picks a project with no session — both want the
       * project screen.
       */
      focusedSessionId: null,
      // The project screen exists only in the focus lane — what the person picked must be shown (the same
      // rule as `focusSession`). This combination actually arose once onboarding started opening the
      // orchestrator view first (#63) (caught by e2e).
      view: 'focus',
      viewerPath: null,
  viewerProjectId: null,
      overlay: null,
    }))
    get().saveWorkspace()
  },

  focusSession(id, opts) {
    const prev = get().focusedSessionId
    const projectId = id ? get().sessions[id]?.projectId : undefined
    /*
     * Picking a session **must make that session visible.**
     *
     * With the grid left open, clicking a different session in the sidebar left the screen
     * unchanged: what was picked had changed but what was visible had not, so to the person who
     * clicked, nothing appeared to happen. This lives here because there are a dozen call sites
     * (sidebar, inbox, palette, approval banner, …) — attaching it at each call site means one of
     * them eventually gets missed.
     *
     * Deselecting (`null`) leaves the view untouched, because that is not "look at this."
     */
    /*
     * **The orchestrator goes to its own screen, not 'focus'** (a dogfooding bug).
     *
     * Turning on `view: 'focus'` unconditionally here meant clicking the orchestrator from the top
     * bar's "waiting for response" list opened the orchestrator's conversation **inside the frame of
     * the session screen.** Two symptoms came from that: the right-hand evidence lane came along
     * (`App`'s `hasEvidenceLane` decides by `view` — the orchestrator has no repository to view), and
     * the sidebar's orchestrator button looked unpressed (`active` also decides by `view`).
     *
     * The fix belongs here for the same reason as the comment above: this function has a dozen call
     * sites (inbox, notification card, palette, approval banner, shortcuts, …). Even one of them
     * meeting the orchestrator reproduces the same symptom, so the decision has to live in this one
     * place, not at each caller.
     */
    // If the session is already on the grid, the grid is the destination (see the `preferGrid` comment above)
    const onGrid = !!id && !!opts?.preferGrid && gridSessionIds(get().gridPanels).includes(id)
    const orchestrator = !!id && (id === get().orchestratorId || get().sessions[id]?.kind === 'orchestrator')
    /*
     * If the picked session's project is folded, it is unfolded (#205) — a picked session must also
     * be visible in the sidebar. The inbox, palette, notification card, next-waiting (⌘⇧A) and
     * new-session all pass through this door, so the decision lives here alone (same reason as
     * `view` above: a dozen call sites).
     *
     * **What gets unfolded is remembered** — the same as if the person had unfolded it with the
     * arrow. A path that unfolds briefly and re-folds on leaving was considered and rejected. That
     * would require a second, off-screen piece of state to decide "when to fold it back," and a
     * person cannot predict that moment — a row appearing and disappearing on its own is exactly why
     * unfolding on hover was rejected too. Remembering it means the arrow always states exactly what
     * is on screen, and reopening the app returns to exactly what was last seen.
     *
     * `reveal: false` happens in exactly two places: restoring a snapshot (a fold left there was also
     * left by the person) and clicking a grid panel (the session is already visible in its panel, and
     * if typing into a panel unfolded its project every time, folding would be pointless).
     */
    const reveal =
      opts?.reveal !== false && !!projectId && get().foldedProjects.includes(projectId)
    // Switching sessions clears any overlay — the new session's conversation must be visible first
    set({
      focusedSessionId: id,
      overlay: null,
      ...(reveal ? { foldedProjects: get().foldedProjects.filter((p) => p !== projectId) } : {}),
      ...(id
        ? {
            /*
             * The orchestrator can be placed on the grid too. If clicking its panel's composer or
             * notification got hijacked into the dedicated screen, "view side by side" would break
             * immediately. `preferGrid` is only ever the explicit intent `GridView` gives, so it is
             * the only case where the grid outranks the dedicated screen. A normal pick, like from
             * the sidebar or the palette, still goes to the orchestrator's dedicated screen.
             */
            view: onGrid ? ('grid' as const) : orchestrator ? ('orchestrator' as const) : ('focus' as const),
          }
        : {}),
      ...(projectId ? { focusedProjectId: projectId } : {}),
    })
    get().saveWorkspace()

    // Messages of a session that lost focus are trimmed (docs/state-management.md §4).
    // Holding all of ten sessions × hundreds of turns each would blow the §7.1 memory target.
    // The summary (state, unread, preview) stays intact, so the sidebar and inbox remain accurate.
    if (prev && prev !== id) {
      const items = get().chat[prev]
      const trimmed = items && trimWindow(items)
      if (trimmed) {
        set((s) => ({
          chat: { ...s.chat, [prev]: trimmed.items },
          history: {
            ...s.history,
            [prev]: { oldestSeq: trimmed.oldestSeq, more: trimmed.oldestSeq > 1, loading: false },
          },
        }))
      }
    }

    if (!id) return
    void get().markRead(id)
    // If the session's conversation has not been read yet, load it from storage (history survives even a host restart)
    const cur = get()
    /*
     * "Read" means **a cursor exists** (#79). Having conversation rows does not mean it was read —
     * if an event arrives before the screen does (a session the host created in the background, like
     * an app's requested agent, or an event replayed by the initial connection), only rows appear.
     *
     * Before this (09-09), such a session's cursor used to be set from the top row on screen. The
     * reasoning was that re-reading could wipe out a still-streaming message or an optimistically
     * drawn first prompt. But that number was the render key: a stored 8-line session ended up with a
     * cursor of 48, so "earlier conversation" appended the whole conversation a second time (measured
     * 2026-09-25), and whenever the key was lower than the stored number, the entire middle went
     * missing. Now that `loadHistory` merges with history rather than clearing the screen's rows
     * (`mergePage`), it is always safe to read.
     */
    if (!cur.history[id]) void get().loadHistory(id)
    void get().wake(id)
  },

  async loadHistory(sessionId) {
    const platform = get().platform
    if (!platform) return
    try {
      const msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE)
      const items = messagesToChat(msgs)
      bumpSeqAbove(items)
      set((s) => ({
        /*
         * Screen rows are merged with history, never discarded (#79, `mergePage`). This used to
         * discard the page whenever rows existed on screen — setting the cursor from the discarded
         * page. Re-reads (catching up on a conversation continued elsewhere, filling a gap) go
         * through the same path: within the page's range, history is the source of truth, and only
         * whatever streams after it belongs to the screen.
         * The cursor is the stored number of the top row of the merged result, i.e. the page's first
         * row — screen rows older than that were discarded during the merge.
         */
        chat: { ...s.chat, [sessionId]: mergePage(s.chat[sessionId] ?? [], items, msgs) },
        // Slots for past cards' app views (M4 B-1) — a view this UI already knows about (a live one) is left as is
        inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
        history: {
          ...s.history,
          [sessionId]: {
            oldestSeq: msgs[0]?.seq ?? 0,
            more: msgs.length >= HISTORY_PAGE,
            loading: false,
          },
        },
      }))
    } catch {
      // Even if history fails to load, a new conversation is still possible, so this is silently ignored
      return
    }
    await syncInlineViews(get, set, sessionId)
  },

  async loadOlder(sessionId) {
    const platform = get().platform
    const cur = get().history[sessionId]
    if (!platform || !cur?.more || cur.loading || cur.oldestSeq <= 1) return
    set((s) => ({ history: { ...s.history, [sessionId]: { ...cur, loading: true } } }))
    try {
      const msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE, cur.oldestSeq)
      const older = messagesToChat(msgs)
      bumpSeqAbove(older)
      set((s) => ({
        chat: { ...s.chat, [sessionId]: prependPage(s.chat[sessionId] ?? [], older) },
        inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
        history: {
          ...s.history,
          [sessionId]: {
            oldestSeq: msgs[0]?.seq ?? cur.oldestSeq,
            more: msgs.length >= HISTORY_PAGE,
            loading: false,
          },
        },
      }))
    } catch (e) {
      set((s) => ({
        history: { ...s.history, [sessionId]: { ...cur, loading: false } },
        toast: `Could not load past conversation: ${(e as Error).message}`,
      }))
    }
  },
  toggleSubagentSteps(sessionId, callId) {
    const cur = get().subagentSteps[sessionId]?.[callId]
    const open = !cur?.open
    set((s) => putSubagentSteps(s.subagentSteps, sessionId, callId, { ...(cur ?? SUBAGENT_STEPS_UNREAD), open }))
    // Read on the first opening, and again after a failed read — never while it is closed
    if (open && (!cur || cur.error)) void get().loadMoreSubagentSteps(sessionId, callId)
  },
  async loadMoreSubagentSteps(sessionId, callId) {
    const platform = get().platform
    const cur = get().subagentSteps[sessionId]?.[callId]
    if (!platform || !cur || cur.loading) return
    const after = cur.rows.at(-1)?.seq ?? 0
    set((s) => putSubagentSteps(s.subagentSteps, sessionId, callId, { ...cur, loading: true, error: null }))
    try {
      const page = await platform.agents.loadSubagentMessages(sessionId, callId, after, SUBAGENT_STEPS_PAGE)
      set((s) => {
        const now = s.subagentSteps[sessionId]?.[callId] ?? cur
        // A live step may have joined while the page was on its way: one row per number, in order
        const rows = [...new Map([...now.rows, ...page].map((r) => [r.seq, r])).values()].sort((a, b) => a.seq - b.seq)
        return putSubagentSteps(s.subagentSteps, sessionId, callId, { ...now, rows, more: page.length >= SUBAGENT_STEPS_PAGE, loading: false })
      })
    } catch (e) {
      set((s) =>
        putSubagentSteps(s.subagentSteps, sessionId, callId, {
          ...(s.subagentSteps[sessionId]?.[callId] ?? cur),
          loading: false,
          error: (e as Error).message,
        }),
      )
    }
  },
  togglePanel(open) {
    set((s) => ({ panelOpen: open ?? !s.panelOpen }))
    get().saveWorkspace()
  },

  setPanelTab(tab) {
    set((s) => ({ panelLayout: activateTab(s.panelLayout, tab), panelOpen: true }))
    get().saveWorkspace()
  },

  setPanelLayout(panelLayout) {
    set({ panelLayout })
    get().saveWorkspace()
  },

  setPanelWidth(px) {
    const s = get()
    const sidebar = s.panelOpen ? s.sidebarWidth : s.sidebarWidth
    set({ panelWidth: fitWidth(px, PANEL_MIN, PANEL_MAX, sidebar, s.prefs.textSize) })
    get().saveWorkspace()
  },

  setPanelSplit(share) {
    // If one group drops below 15%, only the tab strip remains and it reads as "gone" — a floor is set
    const clamped = Math.min(0.85, Math.max(0.15, share))
    if (clamped === get().panelSplit) return
    set({ panelSplit: clamped })
    get().saveWorkspace()
  },

  setSidebarWidth(px) {
    const s = get()
    // If the panel is collapsed, it only occupies a 32px strip
    const panel = s.panelOpen ? s.panelWidth : 32
    set({ sidebarWidth: fitWidth(px, SIDEBAR_MIN, SIDEBAR_MAX, panel, s.prefs.textSize) })
    get().saveWorkspace()
  },

  openFile(path, projectId) {
    set({ viewerPath: path, viewerProjectId: projectId ?? null, overlay: { kind: 'viewer' } })
  },

  /*
   * Opens Finder from a right-click. The path arrives with the same credentials as a file link
   * (relative to the currently viewed session's project), and goes through the same port as the file
   * tree's reveal — a failure is loud with the same wording as the tree's.
   */
  async revealFile(path, from) {
    const s = get()
    const projectId = from ?? (s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null)
    if (!projectId || !s.platform) return
    try {
      const res = await s.platform.fs.reveal(projectId, path)
      if (!res.supported) set({ toast: res.reason ?? 'Showing files is not available here' })
    } catch (e) {
      set({ toast: `Could not show ${path}: ${(e as Error).message}` })
    }
  },

  openGit(path, staged) {
    // The tab is recorded explicitly — clicking a changed file while viewing history must return to changes
    set((s) => ({ overlay: { kind: 'git', path: path ?? null, staged, sub: 'changes', pick: nextPick(s.overlay) } }))
  },

  openCommit(sha) {
    set((s) => ({ overlay: { kind: 'git', sha, sub: 'history', pick: nextPick(s.overlay) } }))
  },

  openBranches() {
    set((s) => ({ overlay: { kind: 'git', sub: 'branches', pick: nextPick(s.overlay) } }))
  },

  closeOverlay() {
    set({ overlay: null })
  },
  toggleInbox(open) {
    set((s) => ({ inboxOpen: open ?? !s.inboxOpen }))
  },
  togglePalette(open) {
    set((s) => ({ paletteOpen: open ?? !s.paletteOpen }))
  },
  toggleUsage(open) {
    set((s) => ({ usageOpen: open ?? !s.usageOpen }))
  },
  toggleSettings(open) {
    set((s) => ({ settingsOpen: open ?? !s.settingsOpen }))
  },
  openImport(source = '', fromLink = false) {
    // `at` is needed so a new link arriving at an already-open window still makes the window stand up again for that link (a request to open the same window twice)
    set({ importDialog: { source, fromLink, at: Date.now() }, settingsOpen: false })
  },
  closeImport() {
    set({ importDialog: null })
  },
  requestSettingsMenu(sessionId) {
    set({ settingsMenuRequest: { sessionId, at: Date.now() } })
  },

  /*
   * The three below all follow the same shape: tell the host, and seat whatever state comes back as
   * is.
   *
   * **Never drawn optimistically ahead of time.** This differs from other actions, and for a reason
   * — if the screen got ahead of itself here, it could write "installing" while nothing is actually
   * happening, and that is the worst lie possible about something that cannot be undone. The host
   * keeps sending progress as events, so waiting does not freeze the screen.
   */
  async checkUpdate(force = true) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.status(force) })
    } catch (e) {
      // A version check must never break the screen — the app matters more than the check itself
      set({ toast: `Could not check for updates: ${(e as Error).message}` })
    }
  },

  async setUpdateAuto(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.setAuto(enabled) })
    } catch (e) {
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async setUpdateAutoApply(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.setAutoApply(enabled) })
    } catch (e) {
      // An older host does not know the setting; say so rather than leave the box ticked
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async checkAgentVersions(force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.versions(force) })
    } catch {
      // An older host does not know it: the headers stay quiet rather than the screen breaking
    }
  },

  async setAgentAutoApply(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.setAutoApplyVersions(enabled) })
    } catch (e) {
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async applyAgentVersions() {
    const platform = get().platform
    if (!platform) return
    try {
      const { restarted, busy } = await platform.agents.applyVersions()
      set({ toast: appliedVersionsText(restarted.length, busy.length) })
    } catch (e) {
      set({ toast: `Could not restart the sessions: ${(e as Error).message}` })
    }
  },

  async refreshThemes() {
    const platform = get().platform
    if (!platform) return
    try {
      const themeFiles = await platform.themes.list()
      set((st) => ({ themeFiles, lastGoodThemes: goodThemes(st.lastGoodThemes, themeFiles) }))
    } catch {
      /* the folder could not be read this time — the screen keeps what it has */
    }
  },

  async setPrefs(patch) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ prefs: parseUiPreferences(await platform.prefs.save(patch)) })
    } catch (e) {
      // The screen is left as is — leaving a failed setting turned on means it quietly reverts the next time it is turned on
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  async applyUpdate() {
    const platform = get().platform
    if (!platform) return
    try {
      set({ update: await platform.updates.apply() })
    } catch (e) {
      set({ toast: `Could not update: ${(e as Error).message}` })
    }
  },

  async applyUpdateNow() {
    const relaunch = get().platform?.relaunch
    if (!relaunch) return
    try {
      await relaunch.relaunch()
    } catch (e) {
      set({ toast: `Could not apply the update: ${(e as Error).message}` })
    }
  },
  setNotifyPolicy(notifyPolicy) {
    set({ notifyPolicy })
    // The policy is carried in the workspace snapshot too (E-5) — saving goes through the single writer
    get().saveWorkspace()
  },
  setDraft(sessionId, draft) {
    set((s) => {
      // An empty draft is never kept — otherwise leftovers pile up even as sessions get deleted
      if (!draft.text && draft.attachments.length === 0) {
        if (!(sessionId in s.drafts)) return {}
        const { [sessionId]: _gone, ...rest } = s.drafts
        return { drafts: rest }
      }
      return { drafts: { ...s.drafts, [sessionId]: draft } }
    })
  },
  setStickToBottom(sessionId, sticking) {
    set((s) => {
      // Scrolling fires this by the dozen; only a change is worth a new state object
      if ((s.stickToBottom[sessionId] ?? true) === sticking) return {}
      // Sticking is the default, so it is recorded by *not* being recorded — that way the
      // map only ever holds the sessions someone has actually scrolled away from
      if (sticking) return { stickToBottom: omitKey(s.stickToBottom, sessionId) }
      return { stickToBottom: { ...s.stickToBottom, [sessionId]: false } }
    })
  },
  setScrollAnchor(sessionId, anchor) {
    set((s) => {
      if (!anchor) {
        // Left at the bottom — if the previous anchor were left behind, arriving next time would go to that old spot
        if (!(sessionId in s.scrollAnchor)) return {}
        return { scrollAnchor: omitKey(s.scrollAnchor, sessionId) }
      }
      const cur = s.scrollAnchor[sessionId]
      if (cur && cur.seq === anchor.seq && cur.offset === anchor.offset) return {}
      return { scrollAnchor: { ...s.scrollAnchor, [sessionId]: anchor } }
    })
  },
  toggleDir(projectId, path) {
    set((s) => {
      const cur = s.expandedDirs[projectId] ?? []
      /*
        Closing a folder leaves its children in the list on purpose. "As you left it" means
        the whole shape comes back when you open the parent again, not just its first row.
      */
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
      return { expandedDirs: { ...s.expandedDirs, [projectId]: next } }
    })
  },
  setShowIgnored(show) {
    set({ showIgnored: show })
    get().saveWorkspace()
  },
  toggleProjectFold(projectId) {
    set((s) => ({
      foldedProjects: s.foldedProjects.includes(projectId)
        ? s.foldedProjects.filter((id) => id !== projectId)
        : [...s.foldedProjects, projectId],
    }))
    get().saveWorkspace()
  },
  foldOtherProjects(projectId) {
    set((s) => ({ foldedProjects: Object.keys(s.projects).filter((id) => id !== projectId) }))
    get().saveWorkspace()
  },
  arrangeProject(projectId, next) {
    set((s) => ({ projectPanels: { ...s.projectPanels, [projectId]: next } }))
    get().saveWorkspace()
  },
  setAppSpan(projectId, appId, span) {
    const key = appKeyOf(projectId, appId)
    set((s) => {
      const { [key]: _old, ...rest } = s.appSpans
      return { appSpans: span ? { ...rest, [key]: span } : rest }
    })
    get().saveWorkspace()
  },
  async setGridPanelSpan(key, span) {
    await get().setGridPanels(withPanelSpan(get().gridPanels, key, span))
  },
  setFoldComposer(fold) {
    set({ foldComposer: fold })
    get().saveWorkspace()
  },

  setSpinGrid(on) {
    set({ spinGrid: on })
    get().saveWorkspace()
  },

  setSpinSessionIcon(on) {
    set({ spinSessionIcon: on })
    get().saveWorkspace()
  },

  setToast(toast) {
    set({ toast })
  },
  openNewSession(projectId, opts) {
    /*
     * A suggestion (#69) is consumed **at the moment it is opened** — no matter which door opens it
     * (the project's +, the manager's +, the suggestion row). Leaving it behind would contaminate an
     * unrelated window opened next.
     */
    const queue = get().worktreeProposals
    const at = projectId !== null ? queue.findIndex((p) => p.projectId === projectId) : -1
    const prop = at >= 0 ? queue[at] : undefined
    set({
      newSessionFor: projectId,
      newSessionWorktree: (opts?.worktree ?? false) || !!prop,
      newSessionBranch: prop?.branch ?? '',
      ...(prop ? { worktreeProposals: queue.filter((_, i) => i !== at) } : {}),
    })
  },

  async createWorktreeManager(projectId, baseBranch) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.projects.createWorktreeManager(projectId, baseBranch)
      /*
       * Registering the session is already done by the `session_created` event (#69). It is not
       * added a second time here because that path is the only one that also runs on a restart or in
       * a different window — adding it in two places lets one of them silently go stale. This only
       * updates **the project's own link** and takes the person there.
       */
      set((s) => {
        const p = s.projects[projectId]
        return p
          ? {
              projects: {
                ...s.projects,
                [projectId]: { ...p, worktreeManager: { sessionId: info.id, baseBranch } },
              },
            }
          : {}
      })
      get().focusSession(info.id)
    } catch (e) {
      /*
       * A failure is **returned to the caller's window** (#180). While this used to be swallowed into
       * a toast, it never reached the window's own `catch`, so the window closed anyway — the typed
       * branch name and the reason vanished together, and the toast was dismissed 2.5 seconds later.
       * The window keeps the reason in place instead.
       */
      throw new Error(`Could not start the worktree manager: ${(e as Error).message}`)
    }
  },

  async addProject(path) {
    const p = await get().platform!.projects.add(path)
    // Went through the door that was being pointed at, so the light turns off (#63) — a lingering hint blinking after the fact would be nagging
    set((s) => ({
      projects: { ...s.projects, [p.id]: p },
      addProjectHint: false,
      // A project already trusted (the same folder chosen again) is not asked about again
      trustAsk: p.trusted ? s.trustAsk : p.id,
    }))
    return p
  },

  async answerTrustAsk(trust) {
    const id = get().trustAsk
    if (!id) return
    set({ trustAsk: null })
    if (trust) await get().setProjectTrusted(id, true)
  },

  async setProjectTrusted(projectId, trusted) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    try {
      await platform.projects.setTrusted(projectId, trusted)
      set((s) => {
        const p = s.projects[projectId]
        return p ? { projects: { ...s.projects, [projectId]: { ...p, trusted } } } : {}
      })
      const running = Object.values(get().sessions).some((x) => x.projectId === projectId && x.live)
      if (running) set({ toast: 'Running sessions here pick up the new trust when they restart or resume.' })
    } catch (e) {
      set({ toast: `Could not change trust: ${(e as Error).message}` })
    }
  },

  async deleteProject(projectId, deleteFiles) {
    const platform = get().platform
    if (!platform || !get().projects[projectId]) return
    if (deleteFiles) {
      /*
       * `'.'` is the project root — the host's `resolveExisting` resolves relative to the root and
       * refuses anything outside it, so no absolute path is built and passed here. The hand that
       * deletes lives in the shell (Rust), and what that hand does is **move to trash** (the fs
       * port's rule: "Not a delete — that is the whole decision").
       */
      const r = await platform.fs.trash(projectId, '.')
      if (!r.supported) throw new Error(r.reason ?? 'This build cannot delete files')
    }
    await platform.projects.remove(projectId)
    /*
     * Sessions also disappear through the host's own `session_deleted`, but they are cleared here as
     * well: waiting for that event would leave a session row on screen for a project that no longer
     * exists.
     */
    set((s) => {
      const projects = omitKey(s.projects, projectId)
      const doomed = Object.values(s.sessions)
        .filter((x) => x.projectId === projectId)
        .map((x) => x.id)
      const sessions = { ...s.sessions }
      for (const id of doomed) delete sessions[id]
      return {
        projects,
        sessions,
        ...forgetSessions(s, new Set(doomed)),
        /*
         * What was kept per project goes with it. The id can come back (restoring one of its sessions from the trash
         * re-adds the project under its old id), and then it starts the way a newly added project does: the deletion
         * stopped its command runs, and a git epoch of 0 and folded folders are the defaults anyway.
         */
        gitEpoch: omitKey(s.gitEpoch, projectId),
        expandedDirs: omitKey(s.expandedDirs, projectId),
        commandRuns: omitKey(s.commandRuns, projectId),
        focusedProjectId: s.focusedProjectId === projectId ? null : s.focusedProjectId,
        trustAsk: s.trustAsk === projectId ? null : s.trustAsk,
        foldedProjects: s.foldedProjects.filter((id) => id !== projectId),
        projectPanels: Object.fromEntries(Object.entries(s.projectPanels).filter(([id]) => id !== projectId)),
      }
    })
    // The fold and the arrangement just dropped live in the snapshot — write it, or the next launch reads them back
    get().saveWorkspace()
  },

  refreshProjectGit(projectId) {
    const pending = gitRefreshTimers.get(projectId)
    if (pending !== undefined) clearTimeout(pending)
    gitRefreshTimers.set(
      projectId,
      setTimeout(() => {
        gitRefreshTimers.delete(projectId)
        const platform = get().platform
        // The project can be gone by the time the window closes (removed, or a reconnect
        // rebuilt the list). Measuring a folder nobody is showing helps no one.
        if (!platform || !get().projects[projectId]) return
        // Makes the panel's own held list re-read at the same moment too (#160). Bumped even when
        // the summary is unchanged — editing the same file again leaves the change count the same
        // while the content has changed
        set((s) => ({ gitEpoch: { ...s.gitEpoch, [projectId]: (s.gitEpoch[projectId] ?? 0) + 1 } }))
        void platform.projects
          .gitStatus(projectId)
          .then(({ git }) =>
            set((s) => {
              const cur = s.projects[projectId]
              /*
               * Nothing new is not an update. This runs after every turn and every return to
               * the window, and "the count is the same" is the common answer — handing every
               * row a fresh object each time would re-render the whole sidebar to redraw
               * identical text.
               */
              if (!cur || sameGit(cur.git, git)) return {}
              /*
               * **Only `git` is taken from the answer.** The host rebuilds the rest of
               * ProjectInfo from its own defaults, so swallowing the whole row would let a
               * reply that landed mid-`setProjectCommands` undo the list being edited.
               * This action was asked for one field; it writes one field.
               */
              return { projects: { ...s.projects, [projectId]: { ...cur, git } } }
            }),
          )
          /*
           * Silence on failure, deliberately. This is a number in the margin that nobody
           * asked for — a repo that has just been deleted, or a host that dropped the
           * project, must not put a toast in front of someone who was doing something else.
           * The stale count stays, which is exactly where we were before.
           */
          .catch(() => {})
      }, GIT_REFRESH_MS),
    )
  },

  /*
   * The three writes (issue #49). Each does the thing, then says the tree moved — the
   * `await` matters, because a status read that overtakes its own commit measures the repo
   * as it was and writes that back as news.
   *
   * Staging is in here even though it rarely moves the number (porcelain counts one line per
   * changed path whether it is staged or not). "Rarely" is not "never" — staging a file whose
   * content matches HEAD drops it out of status entirely — and the debounce plus `sameGit`
   * mean an answer identical to the last one costs one call and re-renders nothing. The
   * alternative is a rule about which writes qualify, which is the kind of rule that is
   * silently wrong for a year.
   */
  async gitStage(projectId, paths, unstage) {
    await get().platform!.git.stage(projectId, paths, unstage)
    get().refreshProjectGit(projectId)
  },

  async gitCommit(projectId, message) {
    const res = await get().platform!.git.commit(projectId, message)
    // Refresh even when the commit was refused: git can reject *after* moving something
    // (a hook that stages, a partial index update), and the count must not be left guessing.
    get().refreshProjectGit(projectId)
    return res
  },

  async gitCheckout(projectId, branch) {
    const res = await get().platform!.git.checkout(projectId, branch)
    get().refreshProjectGit(projectId)
    return res
  },

  async saveWorktreeSetup(projectId, setup) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    await platform.projects.setWorktreeSetup(projectId, setup)
    // The summary line must match the next time it opens — follows the host's own normalizing rule (an empty setup means `null`)
    const clean = setup && (setup.command || setup.copyFiles.length) ? setup : null
    set((s) => {
      const now = s.projects[projectId]
      return now ? { projects: { ...s.projects, [projectId]: { ...now, worktreeSetup: clean } } } : {}
    })
  },

  async setProjectCommands(projectId, commands) {
    const platform = get().platform
    const before = get().projects[projectId]
    if (!platform || !before) return
    // Draw it first. This is a list being edited by hand, and a row that appears only after
    // a round trip reads as a click that missed.
    set((s) => ({ projects: { ...s.projects, [projectId]: { ...before, commands } } }))
    try {
      const saved = await platform.projects.setCommands(projectId, commands)
      set((s) => {
        const now = s.projects[projectId]
        // The project could have gone while we were away; nothing to correct if so
        return now ? { projects: { ...s.projects, [projectId]: { ...now, commands: saved } } } : {}
      })
    } catch (e) {
      /*
       * Put the old list back and say so. A command that looks saved and is gone at the
       * next launch is the worse half of this: the menu would then say "nothing saved yet",
       * which reads as never having added it rather than as having lost it.
       */
      set((s) => ({
        projects: { ...s.projects, [projectId]: before },
        toast: `Could not save commands: ${(e as Error).message}`,
      }))
    }
  },

  async loadCommandRuns(projectId) {
    const platform = get().platform
    if (!platform) return
    try {
      const runs = await platform.commands.state(projectId)
      set((s) => ({
        commandRuns: {
          ...s.commandRuns,
          [projectId]: Object.fromEntries(runs.map((r) => [r.command, r])),
        },
      }))
    } catch {
      // If it could not be read, it is re-read the next time the panel opens — the badge is just dark for a moment
    }
  },

  async runCommand(projectId, command) {
    const platform = get().platform
    if (!platform) return
    try {
      // The size is re-measured for real once the log window (`CommandLog`) attaches — this is only a starting value
      const info = await platform.commands.run(projectId, command, 100, 30)
      set((s) => ({
        commandRuns: {
          ...s.commandRuns,
          [projectId]: { ...s.commandRuns[projectId], [command]: info },
        },
      }))
    } catch (e) {
      // No silent failures — believing it started when it did not leaves someone waiting on a log that never comes
      set({ toast: `Could not run: ${(e as Error).message}` })
    }
  },

  async stopCommand(projectId, command) {
    await get()
      .platform?.commands.stop(projectId, command)
      .catch(() => {})
  },

  async createSession(projectId, opts) {
    const platform = get().platform!
    const project = get().projects[projectId]!
    const tool = opts?.tool ?? project.defaultTool ?? get().tools[0]?.name ?? ''
    /*
     * The project's memory is pulled out **only for this tool** (#107). There used to be a single
     * model per project, and that one value was carried regardless of which tool was used — so even
     * when a handoff deliberately cleared the model on a tool switch (`sameTool ? … : undefined`),
     * this line filled it right back in.
     */
    const remembered = await usableDefaults(platform, tool, project.defaultModels?.[tool])
    const info = await platform.agents.createSession({
      projectId,
      cwd: project.path,
      // The chosen value travels straight to the host — the preset used to be pinned to 'normal' and the model was not even passed
      tool,
      model: opts?.model ?? remembered.model ?? undefined,
      // Effort follows the memory too (#69 ⑤) — remembering only the model meant Opus came back but high still had to be pressed again
      effort: opts?.effort ?? remembered.effort ?? undefined,
      verbosity: opts?.verbosity,
      serviceTier: opts?.serviceTier,
      permissionPreset: opts?.permissionPreset ?? 'normal',
      initialPrompt: opts?.initialPrompt,
      handoff: opts?.handoff,
      resumeExternalId: opts?.resumeExternalId,
      importHistory: opts?.importHistory,
      worktree: opts?.worktree,
      worktreeBranch: opts?.worktreeBranch,
      worktreeBase: opts?.worktreeBase,
    })
    set((s) => ({
      sessions: {
        ...s.sessions,
        [info.id]: {
          ...initialSession({
            id: info.id,
            projectId,
            name: info.name,
            tool: info.tool,
            /*
             * The settings are also taken exactly as the host answered (the other half left unfixed
             * by #37 — `attach` and the reconnect merge already receive everything, but this
             * optimistic registration alone was missing it). Measured during dogfooding: a session
             * created through a handoff had inherited its model and effort in the database, yet the
             * menu showed Default until the app restarted — reading as if the settings had not carried
             * over at all.
             */
            model: info.model,
            effort: info.effort,
            verbosity: info.verbosity,
            serviceTier: info.serviceTier,
            permissionPreset: info.permissionPreset,
            worktree: info.worktree,
            // Its parent is also decided by the host (#69) — missing this would put a session created under a manager at the top level until a restart
            parentSessionId: info.parentSessionId,
            merged: info.worktreeMerged,
            pr: info.worktreePr,
          }),
          lastSeq: info.lastSeq,
          lastReadSeq: info.lastReadSeq,
          ...liveFactsOf(info),
        },
      },
      /*
       * **The chosen tool becomes this project's default.**
       *
       * `default_tool` used to be pinned to 'claude' when a project was created and never updated
       * anywhere else — someone using codex had to re-press it forever, every time they created a new
       * session. Why there is no separate setting for this: the fact that the last choice becomes the
       * default **is already stated by the act of creating a session.** The host makes the same
       * decision in the same place (`manager.createSession`) — what happens here is an optimistic
       * update so it shows up right away in this run.
       */
      projects:
        opts?.tool && s.projects[projectId]
          ? { ...s.projects, [projectId]: { ...s.projects[projectId], defaultTool: opts.tool } }
          : s.projects,
      // The starting prompt was also said by me — it must show in the conversation (a gap caught by e2e)
      // Why `pending` is set: the host also stores the first prompt and announces it via `user_message`
      // — without this marker, the replayed event would draw the same message a second time (the same rule as `send()`)
      chat: opts?.initialPrompt ? withOpeningPrompt(s.chat, info.id, opts.initialPrompt) : s.chat,
    }))
    /*
     * `focusedSessionId` is not set directly — it goes through `focusSession` instead, where the
     * "a picked session must be shown" view enforcement lives. Setting it directly used to be fine:
     * while a dialog was in use, the screen was already the focus view. Once onboarding started
     * opening the orchestrator view first (#63), that created the combination where a session created
     * there was **never shown** (caught by e2e).
     */
    get().focusSession(info.id)

    // An imported session already has past conversation piled up on the host — pull it onto the screen
    if (opts?.importHistory && opts.resumeExternalId) {
      const msgs = await platform.agents.loadMessages(info.id)
      if (msgs.length > 0) {
        const restored = messagesToChat(msgs)
        bumpSeqAbove(restored)
        set((s) => ({ chat: { ...s.chat, [info.id]: restored } }))
      }
    }

    // Replays events held from before registration, in order
    replayPendingEvents(get)
    return info
  },

  /** Saves a file that came in through paste or drag to the host, and receives its attachment info (FR-13) */
  async attachFile(sessionId, file) {
    const platform = get().platform
    if (!platform) return null
    if (file.size > MAX_ATTACHMENT_BYTES) {
      set({ toast: `${file.name} is too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)` })
      return null
    }
    const count = (d: number) =>
      set((s) => {
        const n = (s.uploading[sessionId] ?? 0) + d
        const { [sessionId]: _was, ...rest } = s.uploading
        return { uploading: n > 0 ? { ...rest, [sessionId]: n } : rest }
      })
    count(1)
    try {
      const buf = await file.arrayBuffer()
      const b64 = toBase64(new Uint8Array(buf))
      const saved = await platform.agents.saveAttachment(
        sessionId,
        file.name,
        file.type || 'application/octet-stream',
        b64,
      )
      // An image draws its thumbnail immediately from the bytes just read — no round trip to the host is needed
      return saved.kind === 'image' ? { ...saved, data: b64 } : saved
    } catch (e) {
      set({ toast: `Could not attach: ${(e as Error).message}` })
      return null
    } finally {
      count(-1)
    }
  },

  async send(sessionId, text, attachments) {
    /*
     * **If a question is open, the composer's text is that question's answer, not a new turn.**
     *
     * This used to not check `pendingQuestions` at all. So sending text while a card was up cut off
     * the turn in progress, and an `AskUserQuestion` that never got an answer was cleaned up as
     * **a refused tool use** — the card vanished for no visible reason and the turn broke with
     * `error_during_execution` (an actual incident, 2026-09-23: the person only typed "can you ask
     * the question again?" and the question disappeared).
     *
     * Instead of blocking it, the intent is honored. Writing an answer by hand because none of the
     * options fit is a natural thing to do, and the card already has an "Other — write your own" slot.
     * The gesture and its meaning already agree.
     *
     * This is only done **when there is exactly one question.** With several questions in one
     * request, the card requires all of them answered (sending half lets the model invent the rest),
     * and a single line of text has no way to say which one it answers. It also steps aside when
     * there is an attachment — sending it as an answer would discard the attachment.
     */
    const open = get().sessions[sessionId]?.pendingQuestions ?? []
    const target = composerTarget(open, !!attachments?.length)
    if (target === 'answer' && text.trim()) {
      const only = open[0]!
      const landed = await get().answerQuestion(sessionId, only.requestId, [
        { question: only.questions[0]!.question, answers: [text.trim()] },
      ])
      /*
       * An answer that failed to land is put back into the composer (#180) — the same rule as a
       * normal send. The composer clears the instant it is sent, and an answer never leaves a bubble
       * in the conversation, so it cannot even be pulled back with the ↑ recall. If the question has
       * already gone (the host swapped it out), its card is dismissed too, and with nothing put back,
       * the written text would be nowhere at all. Putting it back never resends anything — if the
       * answer actually did land, the person just sees the card gone and can delete the text
       * themselves.
       */
      if (!landed) restoreDraft(set, sessionId, text, attachments)
      return
    }
    /*
     * The text cannot be an answer, but a question is open (#174) — sending it starts a new turn, and
     * a question left unanswered is cleaned up as a refused tool use, so its card disappears. The
     * composer's hint text says this before sending (`composerTarget`), and after sending, a line is
     * left in the conversation saying what was dropped — a card that vanishes with no explanation
     * would leave no trace that a question ever existed.
     */
    const dropped = target === 'drops' ? open.flatMap((q) => q.questions.map((x) => x.question)) : []

    const seq = ++chatSeq
    /*
     * Marked as "working" the instant it is sent.
     *
     * The host does send a `state_change`, but a sleeping session takes a few seconds to revive its
     * process, and the screen sits completely silent during that time — it is impossible to even tell
     * whether it was sent. What we already know is already settled: **it was sent, and an answer is
     * awaited.** A failure is undone below.
     */
    const prevState = get().sessions[sessionId]?.state
    // Talking again means the topic has moved on. Any lingering hint turns off here (#63)
    if (get().addProjectHint) set({ addProjectHint: false })
    set((s) => {
      const sessions = s.sessions[sessionId]
        ? { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'working' as const } }
        : s.sessions
      return {
        /*
          pending: I just drew this and have not yet gotten the host's confirmation.
          Once the host reports the same message via `user_message`, this item is settled into it —
          without this marker, the same message would be drawn twice.
        */
        chat: {
          ...s.chat,
          [sessionId]: [
            ...(s.chat[sessionId] ?? []),
            // Attachments are never mixed into `text` as a label (a 📎 name) — an image is drawn as a
            // real thumbnail, a file as a separate chip. `text` stays exactly what was sent, so
            // matching it against the `user_message` confirmation also relies on this (#75).
            { kind: 'user', seq, text, ...(attachments?.length ? { attachments } : {}), pending: true },
          ],
        },
        sessions,
        /*
          The wait starts here, not when the host's first event lands. Waking a sleeping
          session can take seconds, and those seconds are the ones a person is staring at —
          counting from the host's reply would quietly undercount the worst waits.
        */
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
      }
    })
    try {
      // The bytes already live in a file on the host — the send only carries the path (carrying `data` would double the payload)
      await get().platform!.agents.send(
        sessionId,
        text,
        attachments?.map(({ data: _, ...a }) => a),
      )
      if (dropped.length) {
        const mark: ChatItem = { kind: 'mark', seq: ++chatSeq, text: droppedQuestionsText(dropped) }
        set((s) => {
          const items = s.chat[sessionId] ?? []
          const at = items.findIndex((i) => i.seq === seq)
          return at < 0 ? {} : { chat: { ...s.chat, [sessionId]: [...items.slice(0, at), mark, ...items.slice(at)] } }
        })
      }
      // A successful send means the sleeping session was revived (the host resumes it on its own)
      set(
        ifSessionStill(sessionId, (s, cur) => ({
          sessions: cur.live ? s.sessions : { ...s.sessions, [sessionId]: { ...cur, live: true } },
          wakeError: omitKey(s.wakeError, sessionId),
          // Having sent successfully means the lock is gone — no reason to keep offering the fork option
          wakeLocked: omitKey(s.wakeLocked, sessionId),
        })),
      )
    } catch (err) {
      const e = err as Error & { code?: string }
      /*
       * **Unknown whether it was sent** (#173). If the socket drops, the client refuses a call that
       * never got an answer with `connection_lost` — but the host may already have received, stored
       * and broadcast that request (this is common when the connection drops while a sleeping session
       * is being revived). Reporting that as a failure and putting the text back would have the person
       * send it again, and the same instruction goes through twice. The bubble is instead left as
       * pending, and checked against the store after reconnecting (`settleUnsureSends`) — if it is
       * confirmed there, it was sent; if not, it is undone at that point.
       */
      if (e.code === 'connection_lost') {
        unsureSends.set(seq, { sessionId, text, attachments, prevState })
        set({ toast: 'Connection lost while sending — checking whether it arrived once reconnected' })
        return
      }
      // Silently swallowing a send failure would leave the person standing there waiting for an
      // answer forever. The bubble that looks sent is removed and what to do is reported.
      // The host revives a sleeping session on its own before sending — reaching this point means reviving itself failed
      unsend(set, { seq, sessionId, text, attachments, prevState }, e.message)
    }
  },

  async resumeSession(sessionId) {
    const platform = get().platform
    if (!platform) return false
    try {
      const res = await platform.agents.resumeSession(sessionId)
      set(
        ifSessionStill(sessionId, (s, cur) => ({
          sessions: { ...s.sessions, [sessionId]: { ...cur, live: res.resumed } },
          toast: res.resumed ? null : `Could not resume: ${res.reason ?? 'unknown reason'}`,
        })),
      )
      return res.resumed
    } catch (err) {
      set({ toast: `Could not resume: ${(err as Error).message}` })
      return false
    }
  },

  async respondApproval(sessionId, requestId, decision, scope) {
    // The "always allow" pattern is computed by core (the host does not know core, so it is carried here)
    const pending = get().sessions[sessionId]?.pendingApproval
    /*
     * A request is answered exactly once (#158). If a response already sent is still in flight, or if
     * that outcome already dismissed the card, this is not sent again. A card keeps its listener alive
     * until `approval_resolved` lands and React re-renders, so a second `y` in that window became a
     * "vanished request" on the host and recorded a command that had already run as Denied. Both the
     * card's key and its buttons go through this same path.
     */
    if (get().approvalsInFlight[requestId] || pending?.requestId !== requestId) return
    set((s) => ({ approvalsInFlight: { ...s.approvalsInFlight, [requestId]: true } }))
    const matcher =
      decision === 'always' && pending
        ? pending.detail.kind === 'command'
          ? suggestMatcher(pending.detail.command)
          : pending.detail.kind === 'file_edit'
            ? pending.detail.path
            : undefined
        : undefined
    /*
     * This used to be the one action in this store that swallowed a failure. Approval is exactly the
     * spot where **pressing it and having nothing happen is worst of all** — there is no way to tell
     * whether the command ran or not.
     */
    try {
      await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope, matcher)
      /*
       * What got remembered is stated using **the matcher actually sent** (#170). The card used to
       * compose its own wording separately, so even a kind with no matcher (`other`) was announced as
       * "Always allow in this session: other" — even though neither the adapter nor the store had kept
       * anything at all.
       */
      if (decision === 'always') {
        const access = pending?.detail.kind === 'project_access' ? pending.detail : null
        set({
          toast: access
            ? // A cross-project consent is remembered by the host for the pair, not by a matcher (#371)
              `Always allowed: ${access.from.name} → ${access.to.name}. Revoke it in Settings.`
            : matcher
              ? `Always allow in ${scope === 'project' ? 'this project' : 'this session'}: ${matcher}`
              : 'Allowed once — this kind of request cannot be always-allowed yet',
        })
      }
      /*
       * Letting an edit or a command through means the tree is **about to** move (issue #41).
       *
       * Waiting for `turn_complete` alone would freeze the count for as long as the turn
       * runs — ten minutes of watching an agent edit twenty files while the sidebar insists
       * nothing has changed. A denial changes nothing, so it buys no refresh, and neither
       * does an `other` approval, which is by definition something we cannot read.
       *
       * The debounce is what makes this affordable: a run of approvals costs one status.
       */
      const changing =
        decision !== 'deny' && (pending?.detail.kind === 'file_edit' || pending?.detail.kind === 'command')
      const projectId = get().sessions[sessionId]?.projectId
      if (changing && projectId) get().refreshProjectGit(projectId)
    } catch (e) {
      set({ toast: (e as Error).message || 'Could not send the approval' })
    } finally {
      // A failure must allow pressing it again. A success already dismissed the card, so the `pendingApproval` check above blocks a repeat
      set((s) => {
        const { [requestId]: _done, ...rest } = s.approvalsInFlight
        return { approvalsInFlight: rest }
      })
    }
  },

  /** Answers a set of options — the answer reaches the model as that tool's result */
  async answerQuestion(sessionId, requestId, answers) {
    try {
      await get().platform!.agents.answerQuestion(sessionId, requestId, answers)
      return true
    } catch (e) {
      set({ toast: (e as Error).message || 'Could not send the answer' })
      return false
    }
  },

  async interrupt(sessionId) {
    try {
      await get().platform!.agents.interrupt(sessionId)
    } catch (err) {
      // Silence after failing to stop would leave someone believing it stopped and waiting — the exact kind of failure this project forbids
      set({ toast: `Could not stop: ${(err as Error).message}` })
    }
  },

  async stopBackgroundTask(sessionId, taskId) {
    try {
      await get().platform!.agents.stopBackgroundTask(sessionId, taskId)
    } catch (err) {
      // The same rule as interrupt: a task that did not stop must not look stopped
      set({ toast: `Could not stop the task: ${(err as Error).message}` })
    }
  },

  async clearBackgroundTasks(sessionId) {
    try {
      await get().platform!.agents.clearBackgroundTasks(sessionId)
    } catch (err) {
      set({ toast: `Could not clear the list: ${(err as Error).message}` })
    }
  },

  /**
   * Moves a session to the trash (#204). The toast says where it went: a session that leaves the sidebar with no word
   * about where is the retired archive again (FR-20).
   */
  async deleteSession(sessionId, deleteWorktree, deleteExternal) {
    const platform = get().platform
    if (!platform) return
    const name = get().sessions[sessionId]?.name ?? 'Session'
    try {
      await platform.agents.deleteSession(sessionId, deleteWorktree, deleteExternal)
      set({ toast: `Moved to the trash: ${name} — Settings → Trash restores it` })
    } catch (e) {
      set({ toast: `Could not delete: ${(e as Error).message}` })
    }
  },

  async restoreFromTrash(sessionId) {
    const platform = get().platform
    if (!platform) return 'Not connected'
    try {
      const { session, project } = await platform.trash.restore(sessionId)
      if (project && !get().projects[project.id]) {
        set((s) => ({
          projects: { ...s.projects, [project.id]: project },
          trustAsk: project.trusted ? s.trustAsk : project.id,
        }))
      }
      // The host announces it too; this is the same path, so hearing it twice registers it once
      get().dispatchEvent({ type: 'session_created', sessionId: session.id, session } as NormalizedEvent)
      set({ toast: `Restored: ${session.name}` })
      return null
    } catch (e) {
      return (e as Error).message
    }
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

  async removeUserApp(appId) {
    const platform = get().platform
    if (!platform) return false
    try {
      await platform.apps.remove(appId, null)
      return true
    } catch (e) {
      set({ toast: `Could not remove the app: ${(e as Error).message}` })
      return false
    }
  },

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

  async refreshMcpProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.mcpProposals()
      set({ mcpProposals: r.proposals })
    } catch {
      /* The app is fine even if the suggestion list fails to load — the next event calls it again */
    }
  },

  async resolveMcpProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveMcpProposal(name, approve)
      set({
        toast: approve
          ? `Installing ${name} — restarting the orchestrator so it can use the new tools`
          : `Dismissed MCP proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${(e as Error).message}` })
    }
    await get().refreshMcpProposals()
  },

  async refreshSkillProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.skillProposals()
      set({ skillProposals: r.proposals })
    } catch {
      /* The app is fine even if this fails to load — the next event calls it again */
    }
  },

  async resolveSkillProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveSkillProposal(name, approve)
      set({
        toast: approve
          ? `Skill saved: ${name} — restarting the orchestrator so it takes effect`
          : `Dismissed skill proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${(e as Error).message}` })
    }
    await get().refreshSkillProposals()
  },

  async handoffSession(sessionId, opts) {
    const s = get()
    const session = s.sessions[sessionId]
    const project = session?.projectId ? s.projects[session.projectId] : null
    if (!s.platform || !session || !project || handoffInFlight.has(sessionId)) return
    const heirTool = opts?.tool ?? session.tool
    const mode = opts?.mode ?? 'agent'
    // The record mode's default is to **preserve** — the original of a session that cannot respond is kept until its successor is confirmed (#78)
    const deleteOld = opts?.deleteOld ?? mode === 'agent'
    // The same rule as a manager's own delete — if a live child exists, the final delete is refused
    // anyway. This filters it at the start instead of meeting the failure at the very end (right
    // before destruction).
    const liveKids = Object.values(s.sessions).filter(
      (x) => x.parentSessionId === sessionId && !x.merged,
    )
    if (session.worktree || liveKids.length > 0) {
      set({ toast: 'Worktree sessions cannot hand off yet — merge or delete them first' })
      return
    }
    /*
     * The path that asks the agent for a note **never starts while a card is up** (#174). The request
     * travels as an ordinary message, so if exactly one question is open, that message becomes the
     * question's answer (`send`), and the agent would receive the handoff request text as the answer
     * to "Which DB?" — an answer that has already reached the agent cannot be taken back. With several
     * questions open, or an approval pending, it becomes a new turn instead and the card is dropped.
     * Record mode never asks the agent, so it proceeds regardless. The sidebar's confirmation window
     * checks the same condition (`handoffBlockedBy`).
     */
    const blocked = mode === 'agent' ? handoffBlockedBy(session) : null
    if (blocked) {
      set({ toast: `Answer the open ${blocked} first, or hand off from the record` })
      return
    }
    handoffInFlight.add(sessionId)
    try {
      /*
       * The note's location is decided and written by the host (#142) — under the data folder, at
       * `handoff/<project id>/<departing session id>.md`. This used to clear that spot inside the
       * project first (#104: a file left by a past failure was then delivered as if it were the
       * freshly written note). Now the file is only returned as a path **after** the host has
       * overwritten it with this handoff's text, so there is no way to read a leftover file.
       */
      let note = ''
      let notePath = ''
      if (mode === 'record') {
        /*
         * Record mode (#78): asks the agent **nothing at all** — the reason this mode exists is
         * precisely that the agent cannot respond. The host builds the record from the store's own
         * transcript (plus, for a codex rollout, its compaction summaries).
         *
         * The host writes this to **the same file** as agent mode (#102) — only the producer differs,
         * and the first message the successor receives is identical between the two modes. The `text`
         * returned here is only for the preview.
         */
        const record = await s.platform.agents.exportHandoffRecord(sessionId, heirTool)
        note = record.text
        notePath = record.path
      } else {
      /*
       * If a turn is running, the request **waits for it to finish** first (measured in the Mea session: a
       * handoff where the prompt merged into (steered) the turn already in progress, so the report of the
       * work just done ended up glued to the top of the handoff note. Nothing was actually lost, but it read
       * as "a note with its beginning cut off"). Sending only after the turn boundary makes sure the reply
       * that follows is the handoff, whole.
       */
      const quietBy = Date.now() + 10 * 60_000
      while (get().sessions[sessionId]?.state === 'working') {
        if (Date.now() > quietBy) throw new Error('the session never finished its current turn')
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!get().sessions[sessionId]) throw new Error('the session disappeared')

      const prompt = handoffPrompt()
      /*
       * The last recorded point right before sending the request — the host reads the first human
       * message after this point as the request, and the reply after that as the note. Even if a
       * past handoff failed and the same request and its reply are still sitting in the conversation,
       * they are before this point. The point is asked of the host's own record: the screen's
       * `lastSeq` does not count a sent message until its confirmation (`user_message`) arrives, so it
       * can lag, and the first human message after a lagging point would not be this request.
       */
      const before = (await s.platform.agents.loadMessages(sessionId, 1)).at(-1)?.seq ?? 0
      await get().send(sessionId, prompt)
      // A send failure flows through the composer-restore path and leaves the prompt in the draft — since this was never written by the person, it is cleared
      if (!(get().chat[sessionId] ?? []).some((i) => i.kind === 'user' && i.text === prompt)) {
        if (get().drafts[sessionId]?.text.includes(prompt)) get().setDraft(sessionId, EMPTY_DRAFT)
        throw new Error('could not reach the session')
      }

      /*
       * **Waits for the turn to finish, then receives the note from the host** (#142) — never
       * scraped from the on-screen conversation (measured: leftover output from a turn still in
       * progress mixed into the top of the text and read as "cut off"). The host reads the last reply
       * after the request message from its own record and places it as a file. If the turn is still
       * running or there is no reply yet, it returns `null` and this asks again. Nothing is cleared if
       * no reply ever arrives.
       *
       * The received text is never sent whole to the successor (#102) — a preview is extracted, and
       * the full text is embedded in the record instead, because this text cannot be recreated once
       * the predecessor is gone.
       */
      const deadline = Date.now() + 10 * 60_000
      for (;;) {
        await new Promise((r) => setTimeout(r, 500))
        const st = get()
        const cur = st.sessions[sessionId]
        if (!cur) throw new Error('the session disappeared while writing the note')
        if (cur.state === 'error') throw new Error('the session hit an error while writing the note')
        if (Date.now() > deadline) throw new Error('timed out waiting for the handoff note')
        if (st.connection !== 'connected') continue // No decision is made while disconnected
        if (cur.state === 'working' || cur.state === 'waiting_approval') continue
        const got = await s.platform.agents.exportHandoffNote(sessionId, before).catch(() => null)
        if (got) {
          note = got.text
          notePath = got.path
          break
        }
      }
      }

      /*
       * The new session inherits **every one** of the dying session's settings (the rule #37 taught:
       * carrying over only one leaves the rest born fresh with defaults). Except **when the tool
       * changes, nothing is carried over** — model, effort, verbosity and speed are all tool-specific
       * values, and passing them across tools either kills session creation outright or leaves a
       * setting silently wrong. The name is always inherited, regardless.
       */
      const sameTool = heirTool === session.tool
      const info = await get().createSession(session.projectId!, {
        tool: heirTool,
        model: sameTool ? (session.model ?? undefined) : undefined,
        effort: sameTool ? (session.effort ?? undefined) : undefined,
        verbosity: sameTool ? (session.verbosity ?? undefined) : undefined,
        serviceTier: sameTool ? (session.serviceTier ?? undefined) : undefined,
        permissionPreset: session.permissionPreset,
        initialPrompt: handoffOpening(session.name, note, notePath),
        // The note's full text goes into the record (#102), along with the id (#106) — that id is
        // what tells the host's cleanup this note still has an owner; without it, deleting the
        // predecessor is the same as deleting the note
        handoff: { from: session.name, note, fromSessionId: sessionId },
      })
      await get().rename(info.id, session.name)

      /*
       * Grid slot succession (a dogfooding request, 2026-09-04): if the dying session was on the grid,
       * the successor takes its place at **the same index**. Emptying the slot with the delete and
       * then reinserting it would make the panel flicker away and reappear, shifting the order along
       * the way — so the swap happens before destruction. It swaps even with `deleteOld: false`: the
       * grid is a place for "sessions working right now," and the one that continues that work is the
       * successor — the surviving original is still reachable from the sidebar. `createSession` has
       * already focused the successor, so this only fixes up the lane (making it visible inside the
       * grid if it was on the grid).
       */
      const grid = get().gridPanels
      if (gridSessionIds(grid).includes(sessionId)) {
        await get().setGridPanels(
          grid.map((p) => (p.kind === 'session' && p.sessionId === sessionId ? { kind: 'session', sessionId: info.id } : p)),
        )
        get().focusSession(info.id, { preferGrid: true })
      }

      /*
       * **Nothing is cleaned up here** (#106).
       *
       * Cleanup has moved twice. The first time it was right here, right after `createSession` — the
       * successor had not even opened the file yet. #102 moved it to **the instant the successor's
       * first turn ends**, but that condition asks neither whether the turn succeeded nor whether the
       * note was ever read: in an actual incident, the first turn died with a 400 in under a second,
       * and the directory was empty within three minutes. What the successor received was a path to a
       * file that no longer existed, and that text can never be recreated — the predecessor who wrote
       * it had just been replaced.
       *
       * "Was it read" is not a fact we can observe. So the whole approach of hanging cleanup off a
       * turn is abandoned, and the two moments that cannot race the reader (session deletion, and
       * startup) are handed to the host instead (`manager.sweepOrphanHandoffNotes`). The cost of
       * leaving one extra file behind is close to zero — the note lives in the data folder, not the
       * user's repository (#142).
       */

      if (deleteOld) {
        // Destruction comes last — if this fails, both sessions are left standing (better than half deleted)
        await s.platform.agents.deleteSession(sessionId, false, true)
      }
      set({ toast: `Handed off: ${session.name}` })
    } catch (e) {
      // The next card after a live failure is record mode — the app tells the person instead of switching silently on its own (#78)
      const hint = mode === 'agent' ? ' — if the agent cannot respond, retry with "From the record"' : ''
      set({ toast: `Handoff failed: ${(e as Error).message}${hint}` })
    } finally {
      handoffInFlight.delete(sessionId)
    }
  },

  async switchTool(sessionId, tool) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.agents.switchTool(sessionId, tool)
      set((s) => ({
        sessions: s.sessions[sessionId]
          ? {
              ...s.sessions,
              [sessionId]: {
                ...s.sessions[sessionId]!,
                tool: info.tool,
                /*
                 * The model and its dependent settings are decided by the host (see the comment on
                 * `manager.switchTool`) — if the screen did not follow along, the menu would keep
                 * showing 'sonnet' turned on while the session itself actually ran on codex's default,
                 * a screen that gets more wrong the more it is read.
                 */
                model: info.model,
                effort: info.effort,
                verbosity: info.verbosity,
                serviceTier: info.serviceTier,
                live: false,
              },
            }
          : s.sessions,
      }))
    } catch (e) {
      set({ toast: `Could not switch the agent: ${(e as Error).message}` })
    }
  },

  async updateSessionSettings(sessionId, s) {
    const platform = get().platform
    if (!platform) return
    try {
      const info = await platform.agents.updateSettings(sessionId, s)
      set(ifSessionStill(sessionId, (st, cur) => ({
        sessions: {
          ...st.sessions,
          [sessionId]: {
            ...cur,
            model: info.model,
            effort: info.effort,
            verbosity: info.verbosity,
            serviceTier: info.serviceTier,
            permissionPreset: info.permissionPreset,
            worktree: info.worktree,
          },
        },
      })))
      /*
       * States exactly what changed. This used to say "Perms:" for anything that was not the model —
       * so even changing effort showed "Perms: normal," and what the screen said no longer matched
       * what had just been done. (Adding verbosity, #54, created a third place to lie, which is why
       * this is being fixed now.)
       */
      const changed =
        s.model !== undefined
          ? `Model: ${info.model ?? 'Default'}`
          : s.effort !== undefined
            ? `Effort: ${info.effort ?? 'default'}`
            : s.verbosity !== undefined
              ? `Verbosity: ${info.verbosity ?? 'default'}`
              : s.serviceTier !== undefined
                ? `Speed: ${info.serviceTier ?? 'default'}`
                : `Perms: ${info.permissionPreset}`
      /*
       * When it takes effect is also stated as it actually happened (#164). This used to always say
       * "(from next turn)," but the host could replace the process mid-turn on the spot and lose the
       * turn in progress. It now returns what the host actually did.
       */
      const when =
        info.applied === 'restarted' ? 'agent restarted'
        : info.applied === 'after_turn' ? 'applies when this turn ends'
        : 'from next turn'
      set({ toast: `${changed} (${when})` })
    } catch (e) {
      set({ toast: `Could not change settings: ${(e as Error).message}` })
    }
  },


  /**
   * Restarts only the agent. The conversation record is left as is; only the process is replaced —
   * creating a new session when a tool goes unresponsive would cut off the context.
   */
  /**
   * Wakes a sleeping session ahead of time (the instant it is picked).
   *
   * **A failure leaves its reason behind.** It is not raised as a toast — that would make the screen
   * noisy while someone is scanning through the list. Instead it is written onto that session's own
   * hint line, so whoever is looking can see why it is not resuming.
   */
  /**
   * After reconnecting, **revives sessions that were running.**
   *
   * When the host dies, the supervisor brings it back up (up to five times, with exponential
   * backoff), but that new host **knows none of the agent processes that were alive** — they died
   * along with it, and the new host's memory starts empty. So every session was left sitting asleep
   * on screen, and the person had to press each one by hand to wake it (dogfooding: "the session
   * connection drops in other places too").
   *
   * **The UI knows** what was running — the live state from right before the disconnect is right
   * here, and revival works from that. An archived session and one that was already asleep to begin
   * with are left untouched: using the disconnect as an excuse to turn on something the person never
   * turned on would not be recovery, it would be a different action entirely.
   */
  /**
   * Sidebar order.
   *
   * **The screen changes first, and the save follows.** If a dragged item waited for a round trip to
   * the server before moving, the hand would feel like it stumbled. If saving fails, it reverts to
   * whatever the host says is true — it is never left silently out of sync.
   */
  async reorderProjects(orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().projects
    set({ projects: Object.fromEntries(orderedIds.map((id) => [id, before[id]!]).filter(([, v]) => v)) })
    try {
      const fresh = await platform.projects.reorder(orderedIds)
      set({ projects: Object.fromEntries(fresh.map((p) => [p.id, p])) })
    } catch (e) {
      set({ projects: before, toast: `Could not save order: ${(e as Error).message}` })
    }
  },

  setView(view) {
    /*
     * Picking a screen = having passed the intro (#63).
     *
     * A person who clicks the grid or the orchestrator from the sidebar beside the intro screen is
     * saying "enough explaining, I want to use the app." If that click did not change the screen, the
     * button would look broken; hiding the button instead would force reading the intro — squarely
     * against this onboarding's premise of never forcing a conversation.
     */
    set({ view, introSeen: true })
    get().saveWorkspace()
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
    patch({ state: 'parked', instanceId: null })
    if (v.instanceId) void get().platform?.apps.closeView(v.instanceId).catch(() => {})
  },

  async reopenInlineView(sessionId, callId) {
    const platform = get().platform
    const v = get().inlineViews[sessionId]?.[callId]
    if (!platform || !v || v.state !== 'parked' || v.rejected || !v.kept) return
    const patch = (next: Partial<InlineView>) =>
      set((s) => {
        const cur = s.inlineViews[sessionId]?.[callId]
        return cur ? { inlineViews: { ...s.inlineViews, [sessionId]: { ...s.inlineViews[sessionId], [callId]: { ...cur, ...next } } } } : {}
      })
    try {
      const r = await platform.apps.reopenInlineView(sessionId, callId)
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
        codeStamp: codeStampOf(get().externalApps, v.projectId, v.appId),
      })
      capInlineViews(get, sessionId, callId)
    } catch (e) {
      patch({ kept: false, reason: (e as Error).message })
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
    const key = externalAppKey(projectId, appId)
    set((s) => ({
      view: 'app',
      focusedApp: { projectId, appId },
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
            { key, projectId, appId, phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null },
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

  ensureGridAppView(projectId, appId) {
    const key = gridAppViewKey(projectId, appId)
    if (get().pinnedViews.some((p) => p.key === key)) return
    set((s) => ({
      pinnedViews: [
        ...s.pinnedViews,
        { key, projectId, appId, phase: 'idle', instanceId: null, toolInput: undefined, toolResult: undefined, error: null },
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
      const v = await platform.apps.openView(pv.appId, pv.projectId)
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
      const codeStamp = codeStampOf(get().externalApps, pv.projectId, pv.appId)
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
      const focused = !!s.focusedApp && externalAppKey(s.focusedApp.projectId, s.focusedApp.appId) === key
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
      await platform.apps.restart(pv.appId, pv.projectId)
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

  async openOrchestrator() {
    const platform = get().platform
    if (!platform) return
    /*
     * The screen changes first. Even if the lookup is slow, if nothing happens in the meantime, the
     * person who clicked assumes the button is dead — the same reason a message is marked "working"
     * the instant it is sent.
     */
    // Landing here also counts as having passed the intro (the same reason as `setView`, #63)
    set({ view: 'orchestrator', introSeen: true })
    get().saveWorkspace()
    try {
      /*
       * **Only asks — never creates** (#63, deferred startup). Opening the screen and creating the
       * process are now separate: if there is none, an empty conversation (with suggested-question
       * cards) stands, and creation happens only in `askOrchestrator`, at the moment the first
       * question is asked. Creating it here as before would bring up a tool process for a person who
       * never even asked for it.
       */
      const info = await platform.agents.orchestratorPeek()
      if (!info) return
      set((s) => ({
        orchestratorId: info.id,
        sessions: {
          ...s.sessions,
          [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
        },
      }))
      // This is also a point where a session is first registered — replays any events held in the pen
      replayPendingEvents(get)
      if (!get().chat[info.id]) void get().loadHistory(info.id)
    } catch (e) {
      // If it could not be opened, the view reverts — the worst outcome is leaving an empty screen up with no explanation
      set({ view: 'focus', toast: `Could not open the orchestrator: ${(e as Error).message}` })
    }
  },

  async askOrchestrator(text) {
    const platform = get().platform
    if (!platform) return false
    let id = get().orchestratorId
    if (!id) {
      // The first question is the birth itself (#63) — the process comes up only the instant a card is pressed
      set({ orchestratorWaking: true })
      try {
        const info = await platform.agents.orchestrator()
        set((s) => ({
          orchestratorId: info.id,
          sessions: {
            ...s.sessions,
            [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
          },
        }))
        replayPendingEvents(get)
        id = info.id
      } catch (e) {
        set({ toast: `Could not start the orchestrator: ${(e as Error).message}` })
        return false
      } finally {
        set({ orchestratorWaking: false })
      }
    }
    // A failure from this point on has `send` put the text back into the composer (now the draft of a real session)
    await get().send(id, text)
    return true
  },

  async completeIntro(tool) {
    const platform = get().platform
    /*
     * The screen is passed through first — a failed setting save must not trap the person on the intro
     * screen (it runs on the default, claude). Clicking the card only records the setting; no process
     * comes up.
     */
    set({ introSeen: true })
    get().saveWorkspace()
    try {
      await platform?.agents.configureOrchestrator(tool)
    } catch (e) {
      set({ toast: `Could not save the choice: ${(e as Error).message}` })
    }
    void get().openOrchestrator()
  },

  /**
   * Saves the whole arrangement (adding, removing and reordering all arrive as this one action).
   *
   * The screen changes first and the save follows — if a dropped panel waited for a round trip to
   * the server before settling into place, the hand would feel like it stumbled. A failure reverts to
   * whatever the host says is true.
   */
  async setGridPanels(panels) {
    const platform = get().platform
    if (!platform) return
    const before = get().gridPanels
    /*
     * An app panel taken off the grid closes its view, teardown first — the project screen's × rule (#288). Here
     * rather than at the grid's ×, so every way a panel leaves the list (the ×, a test, a future caller) takes its view
     * with it instead of leaving a frame alive behind a screen that no longer shows it. The view is not inside the
     * panel (it is laid over it from PinnedApps), so the panel leaving first does not cut teardown off: the frame stays
     * in the document, hidden, until `dismissPinnedView` has had its answer.
     */
    const kept = new Set(panels.map(gridPanelKey))
    for (const p of before) {
      if (p.kind === 'app' && !kept.has(gridPanelKey(p))) void get().dismissPinnedView(gridAppViewKey(p.projectId, p.appId))
    }
    set({ gridPanels: panels })
    try {
      set({ gridPanels: sanitizeGridPanels(await platform.agents.setGridView(panels)) })
    } catch (e) {
      set({ gridPanels: before, toast: `Could not save layout: ${(e as Error).message}` })
    }
  },

  async reorderSessions(projectId, orderedIds) {
    const platform = get().platform
    if (!platform) return
    const before = get().sessions
    // Only this project's sessions get the new order; everything else stays exactly where it was
    const mine = new Set(orderedIds)
    const reordered: typeof before = {}
    for (const [id, s] of Object.entries(before)) {
      if (!mine.has(id)) reordered[id] = s
    }
    for (const id of orderedIds) if (before[id]) reordered[id] = before[id]!
    set({ sessions: reordered })
    try {
      await platform.agents.reorderSessions(projectId, orderedIds)
    } catch (e) {
      set({ sessions: before, toast: `Could not save order: ${(e as Error).message}` })
    }
  },

  async recoverAfterReconnect(resync = false) {
    const s = get()
    if (!s.platform) return
    // Resolves whether a message being sent at the moment of disconnect reached the host (#173)
    void settleUnsureSends(get, set)
    // Broadcasts from the gap while disconnected never come again — the app list (A-8) is also aligned to whatever the host currently knows
    void get().refreshExternalApps()
    void get().refreshAppQuestions()

    const wasLive = Object.values(s.sessions).filter((x) => x.live)

    const fresh = await s.platform.agents.listSessions().catch(() => null)
    if (!fresh) return

    /*
     * **The new host's list is merged in, never discarded.**
     *
     * This used to use `fresh` only to decide `live` and throw the rest away — a session created,
     * renamed or deleted elsewhere (a different app, a terminal) while disconnected stayed invisible
     * until the app was closed and reopened. Only the facts the host knows (name, state, read
     * position, approval/questions/limit, …) are overwritten; local derived state (preview,
     * `touchedPaths`, …) belongs to the reducer and is preserved.
     * Approval and questions also have the host as their source of truth — they could have been
     * resolved or newly arrived while disconnected, and keeping the local ones would leave behind a
     * card for a dead `requestId`.
     */
    set((st) => {
      const sessions: Record<string, SessionSummary> = {}
      for (const f of fresh) {
        const cur = st.sessions[f.id]
        sessions[f.id] = cur
          ? {
              ...cur,
              projectId: f.projectId,
              kind: f.kind,
              tool: f.tool,
              name: f.name,
              autoNamed: f.autoNamed,
              state: f.state,
              live: f.live,
              // `lastSeq` might already be further ahead here from an event we received — winding it back would resurrect an unread mark
              lastSeq: Math.max(cur.lastSeq, f.lastSeq),
              lastReadSeq: f.lastReadSeq,
              waitingSince: f.waitingSince,
              model: f.model,
              effort: f.effort,
              verbosity: f.verbosity,
              permissionPreset: f.permissionPreset,
              worktree: f.worktree,
              parentSessionId: f.parentSessionId,
              merged: f.worktreeMerged,
              pr: f.worktreePr,
              ...liveFactsOf(f),
            }
          : {
              ...initialSession({
                id: f.id,
                projectId: f.projectId,
                kind: f.kind,
                name: f.name,
                tool: f.tool,
                effort: f.effort,
                verbosity: f.verbosity,
                model: f.model,
                permissionPreset: f.permissionPreset,
                worktree: f.worktree,
                parentSessionId: f.parentSessionId,
                merged: f.worktreeMerged,
                pr: f.worktreePr,
              }),
              autoNamed: f.autoNamed,
              state: f.state,
              live: f.live,
              lastSeq: f.lastSeq,
              lastReadSeq: f.lastReadSeq,
              waitingSince: f.waitingSince,
              ...liveFactsOf(f),
            }
      }
      /*
       * The remains of a session deleted while disconnected are cleared the way `session_deleted` clears them: that
       * event fell into the gap and is never replayed, so this is the only place they can go (#163).
       */
      const gone = new Set(Object.keys(st.sessions).filter((id) => !sessions[id]))
      return {
        sessions,
        ...forgetSessions(st, gone),
        // Same reason as attach: a session may have been working across the gap, and the
        // sessions that vanished should not leave their instants behind (issue #23)
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })
    // If the merge registered a session for the first time, replay any events held in the pen from before it was registered
    replayPendingEvents(get)

    /*
     * Resync: events from the gap never come again — the screen's conversation is merged with the
     * store's own truth (`mergePage` fills the gap).
     *
     * **Every session holding a conversation, not just the one being viewed** (#173). This used to
     * re-read only the focused session, leaving every other session's conversation holding onto its
     * gap. Opening that session later would not re-read history, since a cursor already exists, so
     * the gap stayed unfilled until the app itself was reopened. A resync is rare, so the cost of
     * reading one page per session is affordable.
     */
    const focused = get().focusedSessionId
    if (resync) {
      const holding = new Set(Object.keys(get().chat))
      if (focused) holding.add(focused)
      for (const id of holding) if (get().sessions[id]) void get().loadHistory(id)
    }

    // Only revives a process that was running right before the disconnect but that the new host does not know about
    const alive = new Set(fresh.filter((x) => x.live).map((x) => x.id))
    const toWake = wasLive.filter(
      (x) => !alive.has(x.id) && get().sessions[x.id],
    )
    if (toWake.length === 0) return

    set({ toast: `Reconnected — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    // The merge already reflects the host's `live: false`, so `wake` never mistakenly thinks it is already alive
    for (const x of toWake) await get().wake(x.id)
  },

  async wake(sessionId) {
    const s = get()
    const session = s.sessions[sessionId]
    if (!s.platform || !session || session.live || s.resuming[sessionId]) return

    set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      const res = await s.platform.agents.resumeSession(sessionId)
      set(
        ifSessionStill(sessionId, (st, cur) => ({
          sessions: { ...st.sessions, [sessionId]: { ...cur, live: res.resumed } },
          wakeError: res.resumed
            ? omitKey(st.wakeError, sessionId)
            : { ...st.wakeError, [sessionId]: res.reason ?? 'unknown reason' },
          wakeLocked:
            res.resumed || !res.lockedElsewhere
              ? omitKey(st.wakeLocked, sessionId)
              : { ...st.wakeLocked, [sessionId]: true },
        })),
      )
    } catch (e) {
      set(
        ifSessionStill(sessionId, (st) => ({
          wakeError: { ...st.wakeError, [sessionId]: (e as Error).message },
          wakeLocked: omitKey(st.wakeLocked, sessionId),
        })),
      )
    } finally {
      set((st) => {
        const next = { ...st.resuming }
        delete next[sessionId]
        return { resuming: next }
      })
    }
  },

  async forkConversation(sessionId) {
    const s = get()
    if (!s.platform || s.resuming[sessionId]) return
    set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
    try {
      const res = await s.platform.agents.forkConversation(sessionId)
      set(ifSessionStill(sessionId, (st, cur) => ({
        sessions: { ...st.sessions, [sessionId]: { ...cur, live: res.resumed } },
        wakeError: res.resumed
          ? omitKey(st.wakeError, sessionId)
          : { ...st.wakeError, [sessionId]: res.reason ?? '' },
        // Once forked, it is no longer locked — if it failed, the fork option is left standing
        wakeLocked: res.resumed ? omitKey(st.wakeLocked, sessionId) : st.wakeLocked,
        toast: res.resumed
          ? 'Continuing in a forked conversation — the original is untouched'
          : `Could not fork: ${res.reason ?? 'unknown reason'}`,
      })))
    } catch (e) {
      set({ toast: `Could not fork: ${(e as Error).message}` })
    } finally {
      set((st) => {
        const next = { ...st.resuming }
        delete next[sessionId]
        return { resuming: next }
      })
    }
  },

  async restartSession(sessionId) {
    const platform = get().platform
    /*
     * **Prevents a second press** (dogfooding).
     *
     * Restarting kills the process and brings it back up, which takes a few seconds, and the screen
     * stayed silent through it. So the person pressed it again, and the second press **killed the
     * process that had just come up** — the exact button pressed to fix something was the one causing
     * the breakage.
     *
     * The lock is the same `resuming` that `wake` and `fork` use. All three state the same fact — "this
     * session's process is being replaced right now" — so keeping a separate indicator for each would
     * leave one button looking fine while another was mid-flight.
     */
    if (!platform || get().resuming[sessionId]) return false
    set((s) => {
      const sessions = { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'idle' as const } }
      // Restarting ends whatever turn was running — its clock goes with it (issue #23)
      return {
        sessions,
        workingSince: trackWorkingSince(s.workingSince, sessions, Date.now()),
        resuming: { ...s.resuming, [sessionId]: true },
      }
    })
    try {
      const r = await platform.agents.restartSession(sessionId)
      set(
        ifSessionStill(sessionId, (s, cur) => ({
          sessions: { ...s.sessions, [sessionId]: { ...cur, live: r.resumed } },
          wakeError: r.resumed
            ? omitKey(s.wakeError, sessionId)
            : { ...s.wakeError, [sessionId]: r.reason ?? '' },
          toast: r.resumed ? 'Agent restarted' : `Could not restart: ${r.reason ?? ''}`,
        })),
      )
      return r.resumed
    } catch (e) {
      // Letting this throw and stop here would leave the lock stuck forever — the button would stay dead
      set({ toast: `Could not restart: ${(e as Error).message}` })
      return false
    } finally {
      set((s) => ({ resuming: omitKey(s.resuming, sessionId) }))
    }
  },

  /**
   * Renaming a session (issue #5).
   *
   * **Passed to the host first, and the screen is fixed only after.** Drawing it optimistically first
   * would leave the new name on screen and the old one in the database on failure — the moment the
   * list is re-fetched, the name would revert with no explanation. This is a kind of mistake this
   * store has been burned by more than once. A failure is raised as a toast the same way as
   * `respondApproval`/`answerQuestion`.
   */
  async rename(sessionId, name) {
    const next = name.trim()
    if (!next) {
      set({ toast: 'Session name cannot be empty' })
      return
    }
    try {
      await get().platform!.agents.rename(sessionId, next)
    } catch (e) {
      set({ toast: `Could not rename: ${(e as Error).message}` })
      return
    }
    set(ifSessionStill(sessionId, (s, cur) => ({ sessions: { ...s.sessions, [sessionId]: renamePure(cur, next) } })))
  },

  async markRead(sessionId) {
    const s = get().sessions[sessionId]
    if (!s || s.lastReadSeq >= s.lastSeq) return
    await get().platform!.agents.markRead(sessionId, s.lastSeq)
    set(ifSessionStill(sessionId, (st, cur) => ({ sessions: { ...st.sessions, [sessionId]: markReadPure(cur, s.lastSeq) } })))
  },
}))

/**
 * Live subscriptions. Kept at module scope rather than in the store's state — a value the screen has
 * no reason to re-render on, so putting it in state would only add unnecessary renders.
 */
const subscriptions: (() => void)[] = []

function detachAll(): void {
  for (const off of subscriptions.splice(0)) off()
}

/**
 * The **tool row that owns** this result or live output (#98).
 *
 * Found by `callId`. This used to be found by position — a result went to "the oldest open row," and
 * live output to "the last open row." That was because a row did not carry a `callId`, and while only
 * one thing was ever open at a time, position and ownership were the same thing. A background agent's
 * card breaks that: it stays open the whole time its parent uses a different tool, so the positional
 * rule ended up **attaching the parent's Bash result to the agent card**, and routed the agent's
 * steps to the parent's open Bash card — reproducing on screen exactly the "mixed together with no
 * way to tell who did what" the issue described.
 *
 * A row with a `callId` only ever receives its own. The old positional rule is used only among rows
 * with no `callId` at all — kept for the shape of an older fixture that carries the call and its
 * result separately. Measured: across 44,140 `tool_call` rows in the store (28,517 claude, 15,623
 * codex), `callId` has never once collided within a single session (2026-09-25).
 */
function ownerOf(items: ChatItem[], callId: string, fallback: 'oldest' | 'latest'): number {
  if (callId) {
    const mine = items.findIndex((i) => i.kind === 'tool' && i.callId === callId)
    if (mine !== -1) return mine
  }
  const open = (i: ChatItem | undefined) => i?.kind === 'tool' && i.callId === undefined && i.result === undefined
  if (fallback === 'oldest') return items.findIndex(open)
  for (let i = items.length - 1; i >= 0; i--) if (open(items[i])) return i
  return -1
}

/** Carries the stored number the host sent along onto the item (#79) — omitted when there is none */
const stored = (seq: number | undefined): { storedSeq?: number } => (seq === undefined ? {} : { storedSeq: seq })

/**
 * Does this hold a row with this stored number already (#79)?
 *
 * If a history page arrives first and an event for the same row follows (replaying an event held in
 * the pen), the same message would appear twice. Rows with the same stored number are the same row.
 * Used only for events where one row is one item. A streaming chunk carrying the same number more
 * than once is normal, so it is not filtered here.
 */
function holds(items: ChatItem[], seq: number | undefined): boolean {
  return seq !== undefined && items.some((i) => i.storedSeq === seq)
}

/**
 * Does this chunk continue the last item's message (#77) — **a different stored number means a
 * different message.**
 *
 * The host groups a message's chunks into one row (#66) and carries that row's number on every
 * chunk. So chunks of the same message share a number, while a new reply with no human message in
 * between (a background task finished, a question card was answered) arrives under a new number.
 * While this only checked the kind and appended blindly, two such messages ran together into one
 * paragraph with no gap ("…still running.All six reviews are in."). History (`messagesToChat`) also
 * counts one row as one item — both paths draw the same screen this way.
 *
 * The unnumbered side is still appended: an unstored empty chunk (arrives with no number), and a
 * message that started with no number (its empty chunk arrived first).
 */
function continues<K extends 'assistant' | 'reasoning'>(
  last: ChatItem | undefined,
  kind: K,
  seq: number | undefined,
): last is Extract<ChatItem, { kind: K }> {
  return last?.kind === kind && (seq === undefined || last.storedSeq === undefined || last.storedSeq === seq)
}

/**
 * The conversation with one row replaced: one copy of the list, every other row the same object (#364).
 *
 * Streaming replaces a row per delta, and the focused conversation can hold thousands of rows after reading back
 * through history (2,200 in the spike, docs/spikes/2026-10-memory-heavy-store.md). The delta paths used to copy the
 * list twice (`slice(0, -1)` and a spread) or build it with `map` and a closure per row; a list has to be new for the
 * screen to see the change, but once is enough.
 */
function replaceAt(items: ChatItem[], index: number, item: ChatItem): ChatItem[] {
  const next = items.slice()
  next[index] = item
  return next
}

/** Converts an event to a conversation item (a streaming delta is appended to the same message's item — `continues`) */
function appendChat(items: ChatItem[], e: NormalizedEvent): ChatItem[] {
  switch (e.type) {
    case 'message_delta': {
      const last = items[items.length - 1]
      if (continues(last, 'assistant', e.seq)) {
        // A message that started with no number (its unstored empty chunk arrived first) receives the first number learned
        return replaceAt(items, items.length - 1, { ...last, text: last.text + e.text, ...(last.storedSeq === undefined ? stored(e.seq) : {}) })
      }
      return [...items, { kind: 'assistant', seq: ++chatSeq, ...stored(e.seq), text: e.text }]
    }
    case 'reasoning_delta': {
      // A chunk with no text (claude's token estimate) belongs to session state (`thinkingTokens`), not the conversation
      if (!e.text) return items
      const last = items[items.length - 1]
      if (continues(last, 'reasoning', e.seq)) {
        return replaceAt(items, items.length - 1, { ...last, text: last.text + e.text, ...(last.storedSeq === undefined ? stored(e.seq) : {}) })
      }
      return [...items, { kind: 'reasoning', seq: ++chatSeq, ...stored(e.seq), text: e.text }]
    }
    case 'tool_call':
      if (holds(items, e.seq)) return items
      return [
        ...items,
        {
          kind: 'tool',
          seq: ++chatSeq,
          ...stored(e.seq),
          tool: e.summary.tool,
          title: e.summary.title,
          readOnly: e.summary.readOnly,
          ...(e.callId ? { callId: e.callId } : {}),
        },
      ]
    case 'message_image':
      return [
        ...items,
        { kind: 'image', seq: ++chatSeq, mime: e.mime, data: e.data, path: e.path, note: e.note },
      ]
    case 'tool_result': {
      /*
       * A result attaches to **its own call's row** (#98 — `ownerOf`). Among rows with no `callId`,
       * that is the longest-open row (2026-09-12): last-wins had swapped the results of two calls
       * opened back to back. Restoration (`messagesToChat`) uses the same rule — the same screen must
       * never end up pairing things differently across the two paths.
       */
      const real = ownerOf(items, e.callId, 'oldest')
      if (real === -1) return items
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      // `live` is discarded here — the full completed output has already arrived as `result`, so the chunk's job is done
      return replaceAt(items, real, { ...target, result: e.summary, ok: e.ok, live: undefined })
    }
    /*
     * Live output while running (#58). Attaches to its own call's row (`ownerOf`) — having several
     * calls open at once actually happens: a background agent's card stays open the whole time its
     * parent uses a different tool, and that agent's own steps arrive through this same path (#98).
     * Never attached to an already-closed row — its result already carries the whole output. Only the
     * tail is kept: what needs showing is "what is coming out right now," not the full text.
     */
    case 'tool_output_delta': {
      const real = ownerOf(items, e.callId, 'latest')
      if (real === -1) return items
      const target = items[real] as Extract<ChatItem, { kind: 'tool' }>
      if (target.result !== undefined) return items
      const live = ((target.live ?? '') + e.text).slice(-4000)
      return replaceAt(items, real, { ...target, live })
    }
    case 'approval_request':
      /*
       * The same card stands again — when the host re-raises a capability question's card (M4 D-4)
       * after whatever other card was covering it closes. The conversation already has one row for
       * it: this never draws a second one.
       */
      if (items.some((it) => it.kind === 'approval' && it.requestId === e.requestId && it.decision === undefined)) return items
      if (holds(items, e.seq)) return items
      return [
        ...items,
        {
          kind: 'approval',
          seq: ++chatSeq,
          ...stored(e.seq),
          requestId: e.requestId,
          summary:
            e.detail.kind === 'command'
              ? e.detail.command
              : e.detail.kind === 'file_edit'
                ? e.detail.path
                : e.detail.kind === 'capability'
                  ? `${e.detail.app.name} wants to ${e.detail.text}`
                  : e.detail.kind === 'project_access'
                    ? projectAccessQuestion(e.detail)
                    : e.detail.raw,
        },
      ]
    case 'approval_resolved':
      return items.map((it) =>
        it.kind === 'approval' && it.requestId === e.requestId ? { ...it, decision: e.decision } : it,
      )
    case 'user_message': {
      /*
       * If I sent it, it is already drawn — this only confirms it.
       * If someone else sent it (the orchestrator's `send_to_session`), this is the only path by
       * which it appears on screen at all. Before this branch existed, an injected message was only
       * stored, never shown.
       *
       * A message carrying `from` is excluded from confirmation matching (FR-11) — if the person
       * happened to have the same sentence sitting pending, the orchestrator's instruction would be
       * absorbed into that bubble and its origin marker would quietly disappear. Matching by text is
       * an assumption that only holds among my own messages.
       */
      /*
       * The match is made against **the text as sent** (#75). Back when attachments were mixed into
       * `text` as a 📎 label, what was drawn and what was sent differed, so confirmation never lined
       * up and a second bubble was appended (discovered on codex). Now that attachments are a
       * separate field, `text` is exactly the text sent — this identity is what this match relies on.
       */
      // A message sent by an app (M4 B-1) is also excluded from the human message's confirmation match — its origin marker must never be absorbed into a human bubble
      // Already confirmed by the merge with history (#79) — a history page arrived before this event
      if (holds(items, e.seq)) return items
      const idx = e.from || e.fromApp ? -1 : items.findIndex((i) => i.kind === 'user' && i.pending && i.text === e.text)
      if (idx === -1)
        return [
          ...items,
          {
            kind: 'user',
            seq: ++chatSeq,
            storedSeq: e.seq,
            text: e.text,
            ...(e.from ? { from: e.from } : {}),
            ...(e.fromApp ? { fromApp: e.fromApp } : {}),
            // Attachments of a message inserted by the host (M4 C-5) — only a path and a name. Image bytes come when history is re-read
            ...(e.attachments?.length ? { attachments: e.attachments } : {}),
          },
        ]
      return items.map((it, i) =>
        i === idx ? { ...(it as Extract<ChatItem, { kind: 'user' }>), pending: false, storedSeq: e.seq } : it,
      )
    }
    case 'history_synced':
      // The actual content already went into the store — the screen re-reads it outside `dispatchEvent`
      return items
    case 'compaction':
      // Only the model's own context was folded — our record stays intact. Where it was folded must
      // be shown so someone can read back past that point
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), text: compactionText(e) }]
    case 'handoff':
      // Where this session came from (#102). The note's full text lives only in the stored payload — this is a single line
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), text: handoffText(e) }]
    // A fresh conversation inside the session (#304) and what the tool wanted read (#304): one quiet line each
    case 'conversation_reset':
    case 'notice':
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), ...markerParts(e) }]
    /*
     * A failed turn is also kept in the conversation (#107).
     *
     * An error used to only change state and pass through. So a turn that died with a 400 was
     * indistinguishable on screen from **nothing having happened at all** — an empty reply, and
     * "waiting for a human." What happened must be visible in the transcript: the session badge
     * recovers once the next turn starts, but even then the person still has no idea why.
     */
    case 'error':
      // A session's error is recorded as a marker row and carries its number (#161) — matched by number like every other stored row
      if (holds(items, e.seq)) return items
      return [...items, { kind: 'mark', seq: ++chatSeq, ...stored(e.seq), text: errorText(e) }]
    default:
      return items
  }
}

/**
 * What to write on the compaction marker.
 *
 * "Compacted" alone is not enough. The worst case is a failure that looks like a success, and
 * how much it shrank tells someone roughly when the next compaction might come (only when the tool
 * reports it).
 */
export function compactionText(e: Extract<NormalizedEvent, { type: 'compaction' }>): string {
  if (e.failed) return `Compaction failed — ${e.reason ?? 'unknown reason'}`
  if (e.before != null && e.after != null) {
    return `Context compacted here · ${fmtTokens(e.before)} → ${fmtTokens(e.after)}`
  }
  return 'Earlier messages were compacted here'
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/**
 * What to write on the handoff marker (#102).
 *
 * The note's full text is never drawn here — it can run to megabytes, and the successor's first
 * message already carries a preview. What this states is the single fact that "this session
 * continues that one," and the full text is kept in the record alongside that fact.
 */
export function handoffText(e: Extract<NormalizedEvent, { type: 'handoff' }>): string {
  return `Handed off from "${e.from}" — the note is kept with this session`
}

/**
 * The line a fresh conversation leaves (#304). What matters is that the model no longer knows anything above it — the
 * record does, which is why the line exists at all.
 */
export function resetText(e: Extract<NormalizedEvent, { type: 'conversation_reset' }>): string {
  return e.trigger === 'clear'
    ? 'Conversation cleared — the agent remembers nothing above this line'
    : 'The agent started a new conversation here — it remembers nothing above this line'
}

/** The stored marker kinds this build can word (`markerText`) */
const KNOWN_MARKERS: ReadonlySet<string> = new Set(['compaction', 'handoff', 'error', 'conversation_reset', 'notice'])

/** One stored or live marker's line — the live and restored paths must never word the same marker differently */
export function markerText(e: Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>): string {
  switch (e.type) {
    case 'handoff':
      return handoffText(e)
    case 'error':
      return errorText(e)
    case 'conversation_reset':
      return resetText(e)
    // The tool's own sentence, as is (#304) — the same rule as an error's. A readable notice leads with who and what (#342)
    case 'notice': {
      const line = noticeLine(e)
      if (!line) return e.text
      return [line.head, line.audience && audienceText(line.audience)].filter(Boolean).join(' · ') + ` — ${line.body}`
    }
    default:
      return compactionText(e)
  }
}

/**
 * The readable parts of a tool's notice (#342), for the line that draws it. The owner saw two Codex notices in a row
 * that read like the same kind of problem: one about the person's own `config.toml`, one about how Centralu loads
 * history, which they can do nothing about. So the line says who is speaking and what kind of notice it is
 * (`head`), whose it is to act on (`audience`), and for a notice the host recognized, a plain explanation (`summary`,
 * `items`, `hint`) with the tool's own words (`original`) one click away.
 */
export type NoticeLine = {
  /** "Codex · config warning" */
  head: string
  audience?: 'you' | 'centralu'
  /** What the line says after who and what: the plain explanation, or the tool's own text when there is none */
  body: string
  summary?: string
  items?: string[]
  hint?: string
  /** The tool's own words, shown on demand when there is a summary; absent when they are the line itself */
  original?: string
  /** Who said `original`, for the control that shows it */
  from: string
}

/** A notice's readable parts, or null for one the host did not place (stored before #342): it reads as its text alone */
export function noticeLine(e: Extract<NormalizedEvent, { type: 'notice' }>): NoticeLine | null {
  if (!e.from) return null
  return {
    head: e.label ? `${e.from} · ${e.label}` : e.from,
    from: e.from,
    body: e.summary ?? e.text,
    ...(e.audience ? { audience: e.audience } : {}),
    ...(e.summary ? { summary: e.summary, original: e.text } : {}),
    ...(e.items?.length ? { items: e.items } : {}),
    ...(e.hint ? { hint: e.hint } : {}),
  }
}

/** Whose notice it is to act on, in the words the line uses (#342) */
export function audienceText(a: 'you' | 'centralu'): string {
  return a === 'you' ? 'for you' : 'for Centralu'
}

/** A marker's text, and for a readable notice its parts — the live and restored paths build the row the same way */
function markerParts(e: Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>): {
  text: string
  notice?: NoticeLine
} {
  const notice = e.type === 'notice' ? noticeLine(e) : null
  return notice ? { text: markerText(e), notice } : { text: markerText(e) }
}

/** A failed turn's one line (#107) — carries the tool's own sentence as is. Rewording it into our own words would erase the cause */
export function errorText(e: Extract<NormalizedEvent, { type: 'error' }>): string {
  // No turn was running — the conversation could not be opened at all (#168, item 5)
  if (e.error.code === 'conversation_locked') return `Could not open this conversation — ${e.error.message}`
  return `The agent could not finish this turn — ${e.error.message}`
}

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
function mergeInlineHistory(
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
async function syncInlineViews(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void, sessionId: string): Promise<void> {
  const platform = get().platform
  if (!platform) return
  let kept: Awaited<ReturnType<typeof platform.apps.inlineViews>>
  try {
    kept = await platform.apps.inlineViews(sessionId)
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
    if (cur && cur.state !== 'parked' && cur.instanceId === k.instanceId) continue
    // Between two reads of history (before an earlier close has reached the host), the same instance is never closed twice — an instance id is never reused
    releasedOrphans.add(k.instanceId)
    void platform.apps.closeView(k.instanceId).catch(() => {})
  }
}

/** An instance left open that a reopened UI has closed (`syncInlineViews`) */
const releasedOrphans = new Set<string>()

/** A launch card's steps before the first read (#222) */
const SUBAGENT_STEPS_UNREAD: SubagentSteps = { open: false, rows: [], more: false, loading: false, error: null }

function putSubagentSteps(
  all: AppState['subagentSteps'],
  sessionId: string,
  callId: string,
  next: SubagentSteps,
): Pick<AppState, 'subagentSteps'> {
  return { subagentSteps: { ...all, [sessionId]: { ...all[sessionId], [callId]: next } } }
}

/** A live subagent step as the stored row the host would read back (#222) — the same shape `messagesToChat` draws */
function subagentRow(sessionId: string, seq: number, step: SubagentStep): StoredMessage {
  const kind = step.type === 'message_delta' ? 'text' : step.type === 'reasoning_delta' ? 'reasoning' : step.type
  return { sessionId, seq, role: kind === 'text' || kind === 'reasoning' ? 'assistant' : 'system', kind, payload: step, ts: Date.now() }
}

/** Message restoration (on restart, or switching sessions) */
export function messagesToChat(msgs: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of msgs) {
    if (m.kind === 'text' && m.role === 'user') {
      const p = m.payload as {
        text?: string
        from?: { sessionId: string; name: string }
        fromApp?: { appId: string; projectId: string | null; name: string }
        attachments?: ChatAttachment[]
      }
      items.push({
        kind: 'user',
        seq: m.seq,
        storedSeq: m.seq,
        text: String(p?.text ?? ''),
        ...(p?.from ? { from: p.from } : {}),
        ...(p?.fromApp ? { fromApp: p.fromApp } : {}),
        // Attachment restoration — image bytes (`data`) come from the host reading the file inside `loadMessages`
        ...(p?.attachments?.length ? { attachments: p.attachments } : {}),
      })
    } else if (m.kind === 'text' || m.kind === 'reasoning') {
      // One row is one message (#77) — neighboring rows are different replies and are never merged (the same rule as live's `continues`)
      const e = m.payload as { text?: string }
      items.push({ kind: m.kind === 'text' ? 'assistant' : 'reasoning', seq: m.seq, storedSeq: m.seq, text: e.text ?? '' })
    } else if (m.kind === 'marker') {
      // The stored payload is the event itself — live and restored paths must never produce different wording
      const e = m.payload as Extract<NormalizedEvent, { type: 'compaction' | 'handoff' | 'error' | 'conversation_reset' | 'notice' }>
      /*
       * A marker kind this build does not know (one a newer host stored) is left out. It used to be drawn as a
       * compaction, the only marker there was at first — so a #304 notice read back by an older window would have said
       * "Earlier messages were compacted here".
       */
      if (typeof e.type === 'string' && !KNOWN_MARKERS.has(e.type)) continue
      items.push({ kind: 'mark', seq: m.seq, storedSeq: m.seq, ...markerParts(e) })
    } else if (m.kind === 'tool_call') {
      const e = m.payload as { callId?: string; summary?: { tool: string; title: string; readOnly: boolean } }
      if (e.summary)
        items.push({
          kind: 'tool',
          seq: m.seq,
          storedSeq: m.seq,
          tool: e.summary.tool,
          title: e.summary.title,
          readOnly: e.summary.readOnly,
          ...(e.callId ? { callId: e.callId } : {}),
        })
    } else if (m.kind === 'tool_result') {
      /*
       * A restored tool card also **carries its output** (2026-09-12, surfaced in a demo scene).
       *
       * The host keeps `tool_call` and `tool_result` as separate rows, but only the `tool_call` branch
       * existed here. So reopening a session left the card with only its title, its output gone
       * completely — a screen that had only ever been visible to whoever watched it live. The
       * attachment rule is the same as live's (`appendChat`): **its own call's row** (`ownerOf`, #98)
       * — among old-shaped rows with no `callId`, the longest-open row with no result yet.
       *
       * If no match is found (a page boundary put its `tool_call` outside this batch), it is silently
       * dropped — attaching an ownerless output to the conversation as a new row would invent a
       * message that never existed. Attaching it to someone else's open card would also invent one:
       * the positional rule would grab whatever background agent card happened to occupy that spot.
       */
      const e = m.payload as { callId?: string; summary?: string; ok?: boolean }
      const i = ownerOf(items, e.callId ?? '', 'oldest')
      const it = items[i]
      if (it?.kind === 'tool') items[i] = { ...it, result: e.summary ?? '', ok: e.ok }
    } else if (m.kind === 'image') {
      // An image is persisted (#40, second pass) — the host resends the bytes by reading the file again
      const e = m.payload as { mime?: string; data?: string; path?: string; note?: string }
      items.push({
        kind: 'image',
        seq: m.seq,
        storedSeq: m.seq,
        mime: e.mime ?? '',
        data: e.data ?? '',
        path: e.path,
        note: e.note,
      })
    }
  }
  return items
}

/** The last clean read of each theme file: a clean entry replaces it, a broken one leaves it (see `lastGoodThemes`) */
function goodThemes(prev: Record<string, ThemeFileEntry>, files: readonly ThemeFileEntry[]): Record<string, ThemeFileEntry> {
  const next: Record<string, ThemeFileEntry> = {}
  for (const f of files) {
    const good = f.broken ? prev[f.id] : f
    if (good) next[f.id] = good
  }
  return next
}

/** The theme files to apply: a broken one stands in as its last clean version, if it ever had one */
export function usableThemeFiles(s: { themeFiles: ThemeFileEntry[]; lastGoodThemes: Record<string, ThemeFileEntry> }): ThemeFileEntry[] {
  return s.themeFiles.map((f) => (f.broken ? (s.lastGoodThemes[f.id] ?? f) : f))
}

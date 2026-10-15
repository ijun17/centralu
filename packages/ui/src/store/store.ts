import { create } from 'zustand'
import { DEFAULT_UI_PREFERENCES, TEXT_SIZES, parseUiPreferences } from '@cc/protocol'
import type {
  AppQuestion,
  ToolStatus,
  CommandRunInfo,
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  ToolName,
  ThemeFileEntry,
  AgentVersions,
  MachineInfo,
} from '@cc/protocol'
import {
  DEFAULT_NOTIFY_POLICY,
  initialSession,
  appKeyOf,
  gridPanelKey,
  withPanelSpan,
  gridSessionIds,
  sanitizeGridPanels,
  type ProjectArrangement,
} from '@cc/core'
import { activateTab, defaultLayout } from './panelLayout.js'
import { closeLayer, EMPTY_NAV, sameScreen, step, visit } from './navHistory.js'
import { FOLDED_GROUPS_MAX, deadFoldKeys, sameKeys } from './foldGroups.js'
export { audienceText, compactionText, errorText, handoffText, markerText, messagesToChat, noticeLine, resetText } from './transcript.js'
export type { ChatAttachment, ChatItem, NoticeLine } from './transcript.js'
import { type AppState, type InlineView, type Notice, type Overlay, type PinnedView } from './state.js'
export { EMPTY_DRAFT } from './state.js'
export type { AppState, Draft, InlineView, Notice, Overlay, PinnedView, SubagentSteps } from './state.js'
import { gridAppViewKey } from './appKeys.js'
export { externalAppKey, gridAppViewKey, isApp } from './appKeys.js'
import { screenExists, screenOf } from './screens.js'
export {
  gridScreenAppKeys,
  newSessionProjectOf,
  openProjectOf,
  projectScreenAppKeys,
  projectScreenOf,
  projectScreenSessions,
  returnsToPanel,
  screenExists,
  screenOf,
} from './screens.js'
import {
  replayPendingEvents,
} from './sessionList.js'
export { PENDING_EVENTS_MAX, PENDING_EVENTS_MAX_AGE_MS } from './sessionList.js'
import {
  appActions,
  inlineFrameKey,
  inlineFrames,
  type InlineFrame,
} from './apps.js'
export {
  applyAppView,
  AUTO_RELOAD_WINDOW_MS,
  AUTO_RELOADS,
  inlineFrameShown,
  inlineViewsFromHistory,
  registerPinnedFrame,
} from './apps.js'
export type { InlineFrame } from './apps.js'
import { eventActions } from './events/index.js'
import { machineActions } from './machines.js'
import { updateActions } from './updates.js'
export { appliedVersionsText } from './updates.js'
import { historyActions } from './history.js'
import { connectionActions, goodThemes, restoringWorkspace } from './connection.js'
import { syncBadge } from './events/notices.js'
import { projectActions } from './projects.js'
import { omitKey } from './patch.js'
import { lifecycleActions } from './sessions/lifecycle.js'
import { processActions } from './sessions/process.js'
import { answerActions } from './sessions/answers.js'
export { inFlightKey } from './sessions/answers.js'
import { handoffActions } from './sessions/handoff.js'
export { handoffBlockedBy, handoffPrompt } from './sessions/handoff.js'
import { sendActions } from './sessions/send.js'
export { composerTarget, droppedQuestionsText } from './sessions/send.js'
import { focusActions } from './sessions/focus.js'

/**
 * The store only does the wiring — all state-change logic lives in core (docs/state-management.md
 * §2). Commands go out through ports, and state updates come in only as events routed through the
 * core reducer (CQRS-lite: no optimistic updates).
 */

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

/** Registers a drawn frame in `inlineFrames` (apps.ts, with the reason it exists); here because each change bumps the store's counter */
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

/** The current scale (a `TEXT_SCALES` value). Used to convert between real pixels and zoom coordinates */
export function useTextZoom(): number {
  return useStore((s) => s.prefs.textSize)
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

/** The newest save of the folded groups (#666): an older one that fails must not undo what a later one is saving */
let foldSaveSeq = 0

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
  searchTargets: {},
  workingSince: {},
  expandedDirs: {},
  showIgnored: true,
  // Defaults to folded — the reason this feature exists at all is that a two-row grid leaves little room to read
  foldComposer: true,
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
  focusedApp: null as { projectId: string | null; appId: string; machine?: string | null } | null,
  nav: EMPTY_NAV,
  pinnedViews: [] as PinnedView[],
  inlineViews: {} as Record<string, Record<string, InlineView>>,
  inlineFramesVersion: 0,
  gridPanels: [] as GridPanel[],
  builderPaneSessionId: null,
  builderPaneFor: null as string | null,
  orchestratorId: null as string | null,
  orchestratorWaking: false,
  introSeen: false,
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
  composerFocusFor: null as string | null,
  usageOpen: false,
  settingsOpen: false,
  notifyPolicy: DEFAULT_NOTIFY_POLICY,
  importDialog: null as { source: string; fromLink: boolean; at: number } | null,
  update: null,
  agentVersions: null,
  sleepPolicy: null,
  machines: {} as Record<string, MachineInfo>,
  machineAgentVersions: {} as Record<string, AgentVersions>,
  settingsRequest: null as { category: string; at: number } | null,
  prefs: DEFAULT_UI_PREFERENCES,

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
    // The file manager is this computer's; a file on a linked machine is not in it (#82)
    const machine = s.projects[projectId]?.machine
    if (machine) {
      set({ toast: `${path} is on ${s.machines[machine]?.name ?? machine}, not on this computer` })
      return
    }
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
  askComposerFocus(sessionId) {
    set({ composerFocusFor: sessionId })
  },
  toggleUsage(open) {
    set((s) => ({ usageOpen: open ?? !s.usageOpen }))
  },
  toggleSettings(open) {
    set((s) => ({ settingsOpen: open ?? !s.settingsOpen }))
  },
  openSettingsAt(category) {
    set({ settingsOpen: true, settingsRequest: { category, at: Date.now() } })
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

  async loadSleepPolicy() {
    const platform = get().platform
    if (!platform) return
    try {
      set({ sleepPolicy: await platform.agents.sleepPolicy() })
    } catch {
      // An older host does not put sessions to sleep: the setting stays hidden
    }
  },

  async setSleepAfter(afterMinutes) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ sleepPolicy: await platform.agents.setSleepPolicy(afterMinutes) })
    } catch (e) {
      set({ toast: `Could not save that: ${(e as Error).message}` })
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
      const saved = parseUiPreferences(await platform.prefs.save(patch))
      /*
       * Only what this patch wrote is taken from the answer (#666). The answer is the host's whole record at that
       * moment: a host from before a field answers without it (so reading it whole would reset the field to its default
       * on every unrelated save), and a fold saved meanwhile may not be in it yet.
       */
      set((s) => ({
        prefs: {
          ...s.prefs,
          ...Object.fromEntries(Object.keys(patch).filter((k) => k in saved).map((k) => [k, saved[k as keyof typeof saved]])),
        },
      }))
    } catch (e) {
      // The screen is left as is — leaving a failed setting turned on means it quietly reverts the next time it is turned on
      set({ toast: `Could not save that: ${(e as Error).message}` })
    }
  },

  setNotifyPolicy(notifyPolicy) {
    set({ notifyPolicy })
    // The policy is carried in the workspace snapshot too (E-5) — saving goes through the single writer
    get().saveWorkspace()
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
  setGroupsFolded(keys, folded) {
    const before = get().prefs.foldedGroups
    const next = folded
      ? [...before, ...keys.filter((k, i) => !before.includes(k) && keys.indexOf(k) === i)].slice(-FOLDED_GROUPS_MAX)
      : before.filter((k) => !keys.includes(k))
    if (sameKeys(next, before)) return
    set((s) => ({ prefs: { ...s.prefs, foldedGroups: next } }))
    const platform = get().platform
    if (!platform) return
    const mine = ++foldSaveSeq
    platform.prefs.save({ foldedGroups: next }).catch((e: unknown) => {
      /*
       * Undone only when this is still the newest save and the list is still what it wrote: a later fold has its own
       * save in flight, and its state must not be rolled back by this one's failure. Compared by value, not identity:
       * a reconnect reads the preferences again and hands the screen a new array with the same keys.
       */
      if (mine === foldSaveSeq && sameKeys(get().prefs.foldedGroups, next)) {
        set((s) => ({ prefs: { ...s.prefs, foldedGroups: before } }))
      }
      set({ toast: `Could not save that: ${(e as Error).message}` })
    })
  },
  pruneFoldedGroups() {
    const s = get()
    // An empty app list may be a read that failed; it names no app, so it must not condemn every app's fold
    const apps = s.externalApps.length > 0 ? new Set(s.externalApps.map((a) => appKeyOf(a.projectId, a.appId, a.machine))) : null
    const dead = deadFoldKeys(s.prefs.foldedGroups, s.sessions, apps)
    if (dead.length > 0) get().setGroupsFolded(dead, false)
  },
  foldOtherProjects(projectId) {
    set((s) => ({ foldedProjects: Object.keys(s.projects).filter((id) => id !== projectId) }))
    get().saveWorkspace()
  },
  arrangeProject(projectId, next) {
    set((s) => ({ projectPanels: { ...s.projectPanels, [projectId]: next } }))
    get().saveWorkspace()
  },
  setAppSpan(projectId, appId, span, machine) {
    const key = appKeyOf(projectId, appId, machine)
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

  setToast(toast) {
    set({ toast })
  },

  async refreshMcpProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.mcpProposals()
      set({ mcpProposals: r.proposals })
      syncBadge(get)
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
      syncBadge(get)
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


  goBack() {
    navigate(get, set, -1)
  },

  goForward() {
    navigate(get, set, 1)
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
      if (p.kind === 'app' && !kept.has(gridPanelKey(p))) void get().dismissPinnedView(gridAppViewKey(p.projectId, p.appId, p.machine))
    }
    set({ gridPanels: panels })
    try {
      set({ gridPanels: sanitizeGridPanels(await platform.agents.setGridView(panels)) })
    } catch (e) {
      set({ gridPanels: before, toast: `Could not save layout: ${(e as Error).message}` })
    }
  },

  ...connectionActions(set, get),
  ...eventActions(set, get),
  ...focusActions(set, get),
  ...historyActions(set, get),
  ...sendActions(set, get),
  ...answerActions(set, get),
  ...processActions(set, get),
  ...lifecycleActions(set, get),
  ...handoffActions(set, get),
  ...projectActions(set, get),
  ...appActions(set, get),
  ...updateActions(set, get),
  ...machineActions(set, get),
}))

/** The theme files to apply: a broken one stands in as its last clean version, if it ever had one */
export function usableThemeFiles(s: { themeFiles: ThemeFileEntry[]; lastGoodThemes: Record<string, ThemeFileEntry> }): ThemeFileEntry[] {
  return s.themeFiles.map((f) => (f.broken ? (s.lastGoodThemes[f.id] ?? f) : f))
}

/** True while `navigate` puts a recorded screen back, so `recordScreen` does not record it as a new visit */
let navigating = false

function navigate(get: () => AppState, set: (partial: Partial<AppState>) => void, dir: -1 | 1): void {
  const st = get()
  const { history, screen } = step(st.nav, dir, (x) => screenExists(st, x))
  navigating = true
  try {
    if (history !== st.nav) set({ nav: history })
    if (!screen) return
    /*
     * Through the same doors a click uses, so a screen comes back exactly as it opens: a session unfolds its
     * project, an app gets its pinned view, Settings opens on the category it was left on.
     */
    if (screen.kind === 'settings') {
      st.toggleSettings(true)
      return
    }
    if (get().settingsOpen) st.toggleSettings(false)
    switch (screen.kind) {
      case 'session':
        st.focusSession(screen.id)
        break
      case 'project':
        st.focusProject(screen.id)
        break
      case 'app':
        st.openApp(screen.projectId, screen.appId, { machine: screen.machine })
        break
      case 'grid':
      case 'orchestrator':
        st.setView(screen.kind)
        break
    }
  } finally {
    navigating = false
  }
}

/**
 * Records every screen change (#374), from whatever action made it — the one place history is written. A change
 * inside a screen (a keystroke, a session picked inside the grid, a panel moved) leaves the screen the same and adds
 * nothing (`visit` folds a repeat). Closing Settings steps back over it (`closeLayer`).
 */
function recordScreen(next: AppState, prev: AppState): void {
  if (navigating || restoringWorkspace) return
  const now = screenOf(next)
  if (!now || sameScreen(now, screenOf(prev) ?? undefined)) return
  const nav = prev.settingsOpen && !next.settingsOpen ? closeLayer(next.nav, now) : visit(next.nav, now)
  if (nav !== next.nav) useStore.setState({ nav })
}

useStore.subscribe(recordScreen)

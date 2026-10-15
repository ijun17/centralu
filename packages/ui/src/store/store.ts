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
  gridSessionIds,
  type ProjectArrangement,
} from '@cc/core'
import { defaultLayout } from './panelLayout.js'
import { closeLayer, EMPTY_NAV, sameScreen, visit } from './navHistory.js'
export { audienceText, compactionText, errorText, handoffText, markerText, messagesToChat, noticeLine, resetText } from './transcript.js'
export type { ChatAttachment, ChatItem, NoticeLine } from './transcript.js'
import { type AppState, type InlineView, type Notice, type PinnedView } from './state.js'
export { EMPTY_DRAFT } from './state.js'
export type { AppState, Draft, InlineView, Notice, Overlay, PinnedView, SubagentSteps } from './state.js'
export { externalAppKey, gridAppViewKey, isApp } from './appKeys.js'
import { screenOf } from './screens.js'
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
import { layoutActions } from './layout.js'
export { CENTER_MIN, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './layout.js'
import { PANEL_DEFAULT, SIDEBAR_DEFAULT } from './layout.js'
import { navigationActions, navigating } from './navigation.js'
import { orchestratorActions } from './orchestrator.js'
import { machineActions } from './machines.js'
import { updateActions } from './updates.js'
export { appliedVersionsText } from './updates.js'
import { historyActions } from './history.js'
import { connectionActions, goodThemes, restoringWorkspace } from './connection.js'
import { projectActions } from './projects.js'
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
 * The tab set and arrangement live in panelLayout.ts (#20) — the single `panelTab`
 * value became a group structure when the panel learned to split, and the reasoning
 * for what the tabs *are* (e.g. why `history` sits beside `git` rather than inside it,
 * #21) moved with the type. Re-exported so screens keep one import site for the store.
 */
export type { PanelGroup, PanelTab } from './panelLayout.js'

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
  ...orchestratorActions(set, get),
  ...navigationActions(set, get),
  ...layoutActions(set, get),
}))

/** The theme files to apply: a broken one stands in as its last clean version, if it ever had one */
export function usableThemeFiles(s: { themeFiles: ThemeFileEntry[]; lastGoodThemes: Record<string, ThemeFileEntry> }): ThemeFileEntry[] {
  return s.themeFiles.map((f) => (f.broken ? (s.lastGoodThemes[f.id] ?? f) : f))
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

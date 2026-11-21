import { create } from 'zustand'
import { isolatedListeners } from './isolated-listeners.js'
import { errorMessage, DEFAULT_UI_PREFERENCES, notifyPolicyOf, parseUiPreferences } from '@cc/protocol/client'
import type {
  AppQuestion,
  ToolStatus,
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  ToolName,
  ThemeFileEntry,
  AgentVersions,
  MachineInfo,
} from '@cc/protocol/client'
import { gridSessionIds, type ProjectArrangement } from '@cc/core'
import { defaultLayout } from './panelLayout.js'
import { closeLayer, EMPTY_NAV, sameScreen, visit } from './navHistory.js'
export { audienceShown, audienceText, messagesToChat } from './transcript.js'
export type { ChatAttachment, ChatItem, NoticeLine } from './transcript.js'
import { type AppState, type InlineView, type Notice, type PinnedView, type StoreSet } from './state.js'
export { EMPTY_DRAFT } from './state.js'
import type { CommandRun } from './state/projects.js'
export type { CommandRun } from './state/projects.js'
export type { AppState, Draft, InlineView, PinnedView } from './state.js'
export { gridAppViewKey, isApp } from './appKeys.js'
import { screenOf } from './screens.js'
import { cachedThemeFiles } from '../app/theme.js'
export {
  evidenceProjectOf,
  gridScreenAppKeys,
  newSessionProjectOf,
  openProjectOf,
  projectScreenAppKeys,
  projectScreenOf,
  projectScreenSessions,
  returnsToPanel,
  screenExists,
} from './screens.js'
export { PENDING_EVENTS_MAX, PENDING_EVENTS_MAX_AGE_MS } from './sessionList.js'
import { appActions, inlineFrameKey, inlineFrames, type InlineFrame } from './apps.js'
export { inlineFrameShown, inlineViewsFromHistory, registerPinnedFrame } from './apps.js'
import { eventActions } from './events/index.js'
import { layoutActions } from './layout.js'
export {
  CENTER_FLOOR,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  sidebarFloor,
} from './layout.js'
import { PANEL_DEFAULT, SIDEBAR_DEFAULT } from './layout.js'
import { navigationActions, navigating } from './navigation.js'
import { assistantActions } from './assistant.js'
import { machineActions } from './machines.js'
import { updateActions } from './updates.js'
import { mailActions } from './mail.js'
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

// The store only wires; state changes come back as events through the core reducer (docs/state-management.md §1, §2).

export type { PanelTab } from './panelLayout.js'

/** Here because each change bumps the store's counter; why `inlineFrames` exists is in apps.ts */
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

/**
 * The root's CSS zoom (a protocol `TEXT_SIZES` value). A zoom, not a text-only scale: all text is fixed in px, and text
 * that grows alone breaks wrapping in a narrow grid panel first. It scales as the OS's display scaling does.
 */
export function useTextZoom(): number {
  return useStore((s) => s.prefs.textSize)
}

/**
 * The tools on screen, deduplicated (#26): usage belongs to the account, so two Claude panels share one budget. Empty is
 * a real answer: a fallback tool would be the wrong one, and the modal says it does not know.
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

  const session = s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined
  if (session) return [session.tool]
  add(s.focusedProjectId ? (s.projects[s.focusedProjectId]?.defaultTool ?? undefined) : undefined)
  return out
}

/** Raises `toastAt` with every write that says a toast (#842): over a hundred places write `toast` directly */
export function stampToasts(set: StoreSet): StoreSet {
  return ((partial: Parameters<StoreSet>[0], replace?: boolean) =>
    (set as (p: unknown, r?: boolean) => void)((st: AppState) => {
      const next = typeof partial === 'function' ? partial(st) : partial
      if (!next || typeof next.toast !== 'string') return next
      // A toast says its own action or none: the previous one's Undo does not carry over to this one
      return { ...next, toastAt: st.toastAt + 1, ...('toastAction' in next ? {} : { toastAction: null }) }
    }, replace)) as StoreSet
}

/**
 * This window's preference saves in flight (#1306). Its own `prefs_changed` comes back too, and a read during a save
 * could put an older record over the change (#666), so the read waits for the saves.
 */
let prefsSaves = 0
let prefsRefreshWaiting = false

function prefsSaved(get: () => { refreshPrefs(): Promise<void> }): void {
  prefsSaves--
  if (prefsSaves === 0 && prefsRefreshWaiting) {
    prefsRefreshWaiting = false
    void get().refreshPrefs()
  }
}

export const useStore = create<AppState>()(isolatedListeners((rawSet, get) => {
  const set = stampToasts(rawSet)
  return {
    platform: null,
    connection: 'connecting',
    workspaceReady: false,
    hostResyncs: 0,
    machineResyncs: {},
    projects: {},
    gitEpoch: {},
    sessions: {},
    tools: [] as ToolStatus[],
    chat: {},
    drafts: {},
    keptDrafts: [],
    stickToBottom: {},
    scrollAnchor: {},
    searchTargets: {},
    workingSince: {},
    stopping: {},
    expandedDirs: {},
    showIgnored: true,
    focusedSessionId: null,
    focusedProjectId: null,
    newSessionFor: null,
    newSessionWorktree: false,
    newSessionBranch: '',
    worktreeProposals: [],
    mcpProposals: [] as { name: string; command: string; args: string[]; why?: string; at?: number }[],
    externalAppChanges: {},
    externalAppRunChanges: {},
    externalAppChangedBy: {},
    externalApps: [] as ExternalAppInfo[],
    appArrivals: [],
    appsSeen: {},
    themeFiles: [] as ThemeFileEntry[],
    // What the last run showed stands in for a custom theme whose file is broken when the window starts (`cachedThemeFiles`)
    lastGoodThemes: cachedThemeFiles(),
    appQuestions: [] as AppQuestion[],
    appQuestionsVersion: 0,
    projectConsentsVersion: 0,
    skillProposals: [] as { name: string; content: string; why?: string; at?: number }[],
    history: {},
    subagentSteps: {},
    foldOpen: {},
    resuming: {},
    wakeError: {},
    wakeLocked: {},
    panelOpen: true,
    panelLayout: defaultLayout(),
    view: 'focus' as 'focus' | 'grid' | 'assistant' | 'app',
    focusedApp: null as { projectId: string | null; appId: string; machine?: string | null } | null,
    nav: EMPTY_NAV,
    pinnedViews: [] as PinnedView[],
    inlineViews: {} as Record<string, Record<string, InlineView>>,
    inlineFramesVersion: 0,
    gridPanels: [] as GridPanel[],
    builderPaneSessionId: null,
    builderPaneFor: null as string | null,
    runsPanelFor: null as string | null,
    assistantId: null as string | null,
    assistantWaking: false,
    assistantTool: null as ToolName | null,
    introSeen: false,
    trustAsk: null as string | null,
    panelSplit: 0.5,
    panelWidth: PANEL_DEFAULT,
    sidebarWidth: SIDEBAR_DEFAULT,
    foldedProjects: [],
    projectPanels: {} as Record<string, ProjectArrangement>,
    appSpans: {} as Record<string, GridSpan>,
    commandRuns: {} as Record<string, Record<string, CommandRun>>,
    overlay: null,
    inboxOpen: false,
    toast: null,
    toastAction: null,
    toastAt: 0,
    appFocused: true,
    completion: null as { sessionId: string; at: number } | null,
    notices: [] as Notice[],
    viewerPath: null,
    viewerProjectId: null,
    viewerSessionId: null,
    paletteOpen: false,
    openLayers: 0,
    approvalsInFlight: {} as Record<string, true>,
    uploading: {} as Record<string, number>,
    settingsMenuRequest: null as { sessionId: string; at: number } | null,
    composerFocusFor: null as string | null,
    usageOpen: false,
    settingsOpen: false,
    importDialog: null as { source: string; fromLink: boolean; at: number } | null,
    update: null,
    hostRequests: [],
    hostRequestsHeard: 0,
    agentVersions: null,
    toolSetups: {},
    mail: null,
    mailThread: null,
    mailTasks: null,
    watches: {},
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
        // The setting stays hidden until the host answers
      }
    },

    async setSleepAfter(afterMinutes) {
      const platform = get().platform
      if (!platform) return
      try {
        set({ sleepPolicy: await platform.agents.setSleepPolicy(afterMinutes) })
      } catch (e) {
        set({ toast: `Could not save that: ${errorMessage(e)}` })
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

    async refreshPrefs() {
      const platform = get().platform
      if (!platform) return
      // A save of this window's is on its way: the read waits for it
      if (prefsSaves > 0) {
        prefsRefreshWaiting = true
        return
      }
      try {
        const prefs = parseUiPreferences(await platform.prefs.load())
        // A save started meanwhile: this read may be older, so it is read again after
        if (prefsSaves > 0) {
          prefsRefreshWaiting = true
          return
        }
        // A host from before the switches answers without them: the window keeps the ones it has (the snapshot's, #2168)
        set((s) => ({ prefs: { ...prefs, notifyPolicy: prefs.notifyPolicy ?? s.prefs.notifyPolicy } }))
      } catch {
        /* the host did not answer this time — the screen keeps what it has */
      }
    },

    async setPrefs(patch) {
      const platform = get().platform
      if (!platform) return
      prefsSaves++
      try {
        const saved = parseUiPreferences(await platform.prefs.save(patch))
        // Only what this patch wrote (#666): a host from before a field answers without it, and a fold saved meanwhile
        // may be missing from its record
        set((s) => ({
          prefs: {
            ...s.prefs,
            ...Object.fromEntries(
              Object.keys(patch)
                .filter((k) => k in saved)
                .map((k) => [k, saved[k as keyof typeof saved]]),
            ),
          },
        }))
      } catch (e) {
        // The screen is left as is — leaving a failed setting turned on means it quietly reverts the next time it is turned on
        set({ toast: `Could not save that: ${errorMessage(e)}` })
      } finally {
        prefsSaved(get)
      }
    },

    setNotifyPolicy(notifyPolicy) {
      const before = notifyPolicyOf(get().prefs)
      set((s) => ({ prefs: { ...s.prefs, notifyPolicy } }))
      // The host keeps them (#1306): only the switches that changed
      const changed = Object.fromEntries(Object.entries(notifyPolicy).filter(([k, v]) => before[k as keyof typeof before] !== v))
      const platform = get().platform
      if (!platform || Object.keys(changed).length === 0) return
      prefsSaves++
      platform.prefs
        .save({ notifyPolicy: changed })
        .catch((e: unknown) => set({ toast: `Could not save that: ${errorMessage(e)}` }))
        .finally(() => prefsSaved(get))
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
    ...mailActions(set, get),
    ...assistantActions(set, get),
    ...navigationActions(set, get),
    ...layoutActions(set, get),
  }
}))

/** The theme files to apply: a broken one stands in as its last clean version, if it ever had one */
export function usableThemeFiles(s: {
  themeFiles: ThemeFileEntry[]
  lastGoodThemes: Record<string, ThemeFileEntry>
}): ThemeFileEntry[] {
  return s.themeFiles.map((f) => (f.broken ? (s.lastGoodThemes[f.id] ?? f) : f))
}

/** The one place history is written (docs/state-management.md §5a) */
function recordScreen(next: AppState, prev: AppState): void {
  if (navigating || restoringWorkspace) return
  const now = screenOf(next)
  if (!now || sameScreen(now, screenOf(prev) ?? undefined)) return
  // Closing Settings, a file or the git screen (Esc, its close button) steps back over it, as back would
  const closed = (prev.settingsOpen && !next.settingsOpen) || (prev.overlay !== null && next.overlay === null)
  const nav = closed ? closeLayer(next.nav, now) : visit(next.nav, now)
  if (nav !== next.nav) useStore.setState({ nav })
}

useStore.subscribe(recordScreen)

import { create } from 'zustand'
import { DEFAULT_UI_PREFERENCES, SessionInfo, SUBAGENT_STEPS_PAGE, TEXT_SIZES, parseUiPreferences } from '@cc/protocol'
import type {
  AppQuestion,
  ToolStatus,
  CommandRunInfo,
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  StoredMessage,
  ToolName,
  ThemeFileEntry,
  AgentVersions,
  MachineInfo,
} from '@cc/protocol'
import {
  DEFAULT_NOTIFY_POLICY,
  readNotifyPolicy,
  initialSession,
  appPanelId,
  appKeyOf,
  gridPanelKey,
  sanitizeGridSpan,
  withPanelSpan,
  gridSessionIds,
  sanitizeGridPanels,
  sanitizeArrangements,
  migrateArrangement,
  sessionPanelId,
  isAway,
  type ProjectArrangement,
  type SessionSummary,
} from '@cc/core'
import type { WorkspaceSnapshot } from '@cc/platform/ports'
import { activateTab, defaultLayout, sanitizeLayout } from './panelLayout.js'
import { closeLayer, EMPTY_NAV, sameScreen, step, visit } from './navHistory.js'
import { agentApplyVerdict } from '../features/settings/apply-offer.js'
import { FOLDED_GROUPS_MAX, deadFoldKeys, sameKeys } from './foldGroups.js'
import { bumpChatKeysAbove, messagesToChat } from './transcript.js'
export { audienceText, compactionText, errorText, handoffText, markerText, messagesToChat, noticeLine, resetText } from './transcript.js'
export type { ChatAttachment, ChatItem, NoticeLine } from './transcript.js'
import { type AppState, type InlineView, type Notice, type Overlay, type PinnedView } from './state.js'
export { EMPTY_DRAFT } from './state.js'
export type { AppState, Draft, InlineView, Notice, Overlay, PinnedView, SubagentSteps } from './state.js'
import { HISTORY_PAGE, SUBAGENT_STEPS_UNREAD, mergePage, prependPage, putSubagentSteps, readBack } from './historyPages.js'
import { gridAppViewKey, isApp } from './appKeys.js'
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
  forgetSessions,
  mergeListedSince,
  replayPendingEvents,
  trackWorkingSince,
  watchLiveEvents,
} from './sessionList.js'
export { PENDING_EVENTS_MAX, PENDING_EVENTS_MAX_AGE_MS } from './sessionList.js'
import {
  appActions,
  holdPinnedViews,
  inlineFrameKey,
  inlineFrames,
  inlineViewsFromHistory,
  mergeInlineHistory,
  syncInlineViews,
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
import { syncBadge } from './events/notices.js'
import { projectActions } from './projects.js'
import { omitKey } from './patch.js'
import { lifecycleActions } from './sessions/lifecycle.js'
import { processActions } from './sessions/process.js'
import { answerActions } from './sessions/answers.js'
export { inFlightKey } from './sessions/answers.js'
import { handoffActions } from './sessions/handoff.js'
export { handoffBlockedBy, handoffPrompt } from './sessions/handoff.js'
import { sendActions, settleUnsureSends } from './sessions/send.js'
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

/**
 * The tickets the host gave this window for an agent's "Apply now" (#665), by request: the go names one of these. Kept
 * as the answer's promise, since the host may send the go before the answer's reply has reached this window. A ticket
 * no go came for is forgotten after a while: the host asks again after its card, so the first is never used.
 */
const applyTickets = new Map<string, Promise<string | null>>()
const APPLY_TICKET_MS = 5 * 60_000

/** What the header's "Update idle sessions" did (#297), in one line: how many moved, and how many were busy */
export function appliedVersionsText(restarted: number, busy: number): string {
  const sessions = (n: number) => (n === 1 ? '1 session' : `${n} sessions`)
  const keep = busy === 1 ? 'keeps its version' : 'keep their version'
  if (restarted === 0 && busy === 0) return 'Every session already runs the installed version'
  if (restarted === 0) return `Nothing restarted: ${sessions(busy)} busy ${keep} for now`
  const moved = `Restarted ${sessions(restarted)} on the installed version`
  return busy === 0 ? moved : `${moved}; ${busy} busy ${keep} for now`
}

/**
 * A machine row from the answer to `machines.add/reconnect/acceptVersions`, kept only when no `machine_status` got there
 * first (#82). The link moves on its own before the answer leaves the hub: `add` answers `connecting` while the version
 * check has already broadcast `versions_differ` (measured in e2e, the event arrived first). Writing the answer over the
 * event would leave the row saying connecting until the next change, which for a held link never comes.
 */
function withAnswered(machines: Record<string, MachineInfo>, m: MachineInfo): Record<string, MachineInfo> {
  return machines[m.id] ? machines : { ...machines, [m.id]: m }
}

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
 * The waits before reading again what a reconnect has to re-read (the session list, a conversation page) when the
 * read fails. Same steps as a failed workspace save: a host that fails every read is not helped by being asked
 * forever, and the next reconnect or opening the conversation reads again.
 */
const RECOVERY_RETRY_MS = [1_000, 5_000, 30_000] as const

/** Bumped by every reconnect recovery, so the retries of an older one stop once a newer one runs */
let recoveryGeneration = 0

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
        const resync = connection === 'resync_required'
        if (resync) set({ connection: 'connected', hostResyncs: get().hostResyncs + 1 })
        else set({ connection })
        /*
         * Disconnected and came back. The web client says `connected` before `resync_required`, but the port does
         * not promise that order: a resync that is the first word after a drop is a reconnect too, and must not
         * skip what a reconnect does.
         */
        if ((connection === 'connected' || resync) && was !== 'connected') {
          // A save that failed while the host was away goes out now, with a fresh set of retries
          workspaceSave.attempt = 0
          flushWorkspace(get)
          // A new host (a restart, a switched build) read the installed CLIs before this window was back (#297)
          void get().checkAgentVersions(false)
          // Revive sessions that were running; a resync's own recovery below does that and more
          if (!resync) void get().recoverAfterReconnect()
        }
        if (resync) void get().recoverAfterReconnect(true)
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

    const asked = get().sessions
    const watch = watchLiveEvents()
    const [projects, sessions, gridPanels, tools, prefs, externalApps, themeFiles, machines] = await Promise.all([
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
      // The linked machines (#82) name the sidebar's groups, so they come with the lists they group. A host from before them has none
      platform.machines.list().catch(() => [] as MachineInfo[]),
    ]).finally(watch.stop)
    set((st) => {
      // Recovery or re-attachment may have updated the window while startup reads were pending (#640).
      const { sessions: known } = mergeListedSince(asked, st.sessions, sessions, watch.touched)
      return {
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
        machines: Object.fromEntries(machines.map((m) => [m.id, m])),
        connection: 'connected',
      }
    })

    // Replay events that arrived before the list was registered — the first output of a session that
    // was already running before the app was even opened is held here
    replayPendingEvents(get)
    get().pruneFoldedGroups()

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
    let migratedProjectPanels = false
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
        const arrangements = sanitizeArrangements((snap as { projectPanels?: unknown }).projectPanels)
        set({
          projectPanels: Object.fromEntries(Object.entries(arrangements).map(([pid, saved]) => {
            const present = [
              ...Object.values(get().sessions).filter((s) => s.projectId === pid).map((s) => sessionPanelId(s.id)),
              ...get().externalApps.filter((a) => a.projectId === pid)
                .sort((a, b) => (a.name ?? a.appId).localeCompare(b.name ?? b.appId) || a.appId.localeCompare(b.appId))
                .map((a) => appPanelId(a.appId)),
            ]
            return [pid, migrateArrangement(present, saved)]
          })),
        })
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
          if (app && get().externalApps.some((a) => isApp(a, app.projectId, app.appId, app.machine))) {
            get().openApp(app.projectId, app.appId, { machine: app.machine })
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
        const savedPolicy = (snap as { notifyPolicy?: unknown }).notifyPolicy
        if (savedPolicy != null) set({ notifyPolicy: readNotifyPolicy(savedPolicy) })
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
        migratedProjectPanels = Object.values(arrangements).some((saved) => saved.panels === undefined)
      }
    } catch {
      /* The app works normally even with no snapshot */
    } finally {
      restoringWorkspace = false
    }
    // Persist migration only after the whole restore succeeds, so a restart cannot migrate newly created sessions again.
    if (migratedProjectPanels) get().saveWorkspace()
    // History starts at the screen the restore left (#374): the steps it took to get there are not the person's
    const restored = screenOf(get())
    set({ nav: restored ? { entries: [restored], index: 0 } : EMPTY_NAV })

    /*
     * The grid's sessions are not woken at startup any more (#568). They used to be, one by one, to move a slow Codex
     * resume (7-13 s for a large thread) to a moment nobody waited on; but every panel then held its process from the
     * first second, and the host puts idle sessions to sleep after 15 minutes anyway. A panel wakes when it is used:
     * its composer taking the keyboard, or a message sent to it.
     */
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

  async loadHistory(sessionId) {
    const platform = get().platform
    if (!platform) return
    /*
     * A page that fails to arrive is asked for again (`RECOVERY_RETRY_MS`), and meanwhile the cursor is dropped.
     * Swallowing the failure left a re-read's gap for good: a resync re-reads sessions that already hold a cursor,
     * and a cursor is what tells the screen and `focusSession` the conversation was read, so nothing read it again
     * until the app was reopened. Without the cursor, opening the conversation reads it again too.
     */
    let msgs: StoredMessage[]
    for (let attempt = 0; ; attempt++) {
      const held = get().history[sessionId]
      try {
        msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE)
        break
      } catch {
        // A cursor some other read set meanwhile is a successful read, and stays
        set((s) => {
          if (!held || s.history[sessionId] !== held) return {}
          const { [sessionId]: _dropped, ...history } = s.history
          return { history }
        })
        const wait = RECOVERY_RETRY_MS[attempt]
        // Even if history fails to load, a new conversation is still possible, so the last failure is not shown
        if (wait === undefined) return
        await new Promise((r) => setTimeout(r, wait))
        if (get().platform !== platform || !get().sessions[sessionId]) return
      }
    }
    try {
      const items = messagesToChat(msgs)
      bumpChatKeysAbove(items)
      set((s) => {
        /*
         * Screen rows are merged with history, never discarded (#79, `mergePage`). This used to
         * discard the page whenever rows existed on screen — setting the cursor from the discarded
         * page. Re-reads (catching up on a conversation continued elsewhere, filling a gap) go
         * through the same path: within the page's range, history is the source of truth, and only
         * whatever streams after it belongs to the screen.
         * The cursor is the stored number of the top row of the merged result: the page's first
         * row, or the cursor the person had already read back to when those rows are kept (`readBack`).
         */
        const have = s.chat[sessionId] ?? []
        const held = s.history[sessionId]
        const read = readBack(have, held, msgs)
        const merged = mergePage(have, items, msgs)
        return {
          chat: { ...s.chat, [sessionId]: read.length ? prependPage(merged, read) : merged },
          // Slots for past cards' app views (M4 B-1) — a view this UI already knows about (a live one) is left as is
          inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
          history: {
            ...s.history,
            [sessionId]:
              read.length && held
                ? { oldestSeq: held.oldestSeq, more: held.more, loading: false }
                : { oldestSeq: msgs[0]?.seq ?? 0, more: msgs.length >= HISTORY_PAGE, loading: false },
          },
        }
      })
    } catch {
      // A page that cannot be turned into rows is not worth taking the screen down for; the conversation goes on
      return
    }
    await syncInlineViews(get, set, sessionId)
  },

  async loadHistoryAt(sessionId, seq) {
    const platform = get().platform
    if (!platform) return
    try {
      // `beforeSeq` is exclusive. The first page ends on the row search named; the second
      // extends the window past it. Together they avoid walking every page from a long
      // conversation's newest message while still leaving context after the matched line.
      const [before, after] = await Promise.all([
        platform.agents.loadMessages(sessionId, HISTORY_PAGE, seq + 1),
        platform.agents.loadMessages(sessionId, HISTORY_PAGE, seq + HISTORY_PAGE + 1),
      ])
      const msgs = [...new Map([...before, ...after].map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq)
      if (get().searchTargets[sessionId]?.seq !== seq) return
      const items = messagesToChat(msgs)
      bumpChatKeysAbove(items)
      set((s) => {
        const merged = mergePage(s.chat[sessionId] ?? [], items, msgs)
        return {
          chat: { ...s.chat, [sessionId]: merged },
          inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
          history: {
            ...s.history,
            [sessionId]: { oldestSeq: msgs[0]?.seq ?? 0, more: msgs.length >= HISTORY_PAGE, loading: false },
          },
        }
      })
      await syncInlineViews(get, set, sessionId)
    } catch {
      // Remove the temporary cursor so the ordinary first-open read can recover the view.
      set((s) => ({ history: omitKey(s.history, sessionId) }))
    }
  },

  async loadOlder(sessionId) {
    const platform = get().platform
    const cur = get().history[sessionId]
    if (!platform || !cur?.more || cur.loading || cur.oldestSeq <= 1) return
    const asked = { ...cur, loading: true }
    set((s) => ({ history: { ...s.history, [sessionId]: asked } }))
    /*
     * The page is only good for the cursor it was asked from (#79). A re-read that lands while this
     * one is out (`loadHistory`: a catch-up, a resync) or a trim on leaving the session moves the
     * cursor and the rows under it; prepending the page then left the rows between it and the new
     * cursor out for good, since the cursor was set below them. Such a page is dropped: the cursor
     * that replaced it is right, and the next scroll asks again from there.
     */
    const stale = () => get().history[sessionId] !== asked
    try {
      const msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE, cur.oldestSeq)
      if (stale()) return
      const older = messagesToChat(msgs)
      bumpChatKeysAbove(older)
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
      // Putting the old cursor back over one a re-read set meanwhile would undo the re-read
      if (stale()) return
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
    const hostResyncs = get().hostResyncs
    try {
      const update = await platform.updates.status(force)
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
      set({ update })
    } catch (e) {
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
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

  async checkAgentVersions(force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.versions(force) })
    } catch {
      // An older host does not know it: the headers stay quiet rather than the screen breaking
    }
  },

  async checkMachineAgentVersions(machineId, force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      const v = await platform.agents.versions(force, machineId)
      set((s) => ({ machineAgentVersions: { ...s.machineAgentVersions, [machineId]: v } }))
    } catch {
      // Away, or a host that does not know the machine parameter: the header stays quiet, as for this computer
    }
  },

  async refreshMachines() {
    const platform = get().platform
    if (!platform) return
    try {
      const list = await platform.machines.list()
      set({ machines: Object.fromEntries(list.map((m) => [m.id, m])) })
    } catch {
      /* a host from before linked machines: none */
    }
  },

  async addMachine(spec) {
    const m = await get().platform!.machines.add(spec)
    set((s) => ({ machines: withAnswered(s.machines, m) }))
    return m
  },

  async machineSshHosts() {
    try {
      return await get().platform!.machines.sshHosts()
    } catch {
      return null
    }
  },

  async probeMachine(sshTarget) {
    try {
      return await get().platform!.machines.probe(sshTarget)
    } catch {
      return null
    }
  },

  async removeMachine(machineId) {
    await get().platform!.machines.remove(machineId)
    // Its sessions and projects leave with its own resync; the row goes now
    set((s) => ({ machines: omitKey(s.machines, machineId), machineAgentVersions: omitKey(s.machineAgentVersions, machineId) }))
  },

  async reconnectMachine(machineId) {
    try {
      const m = await get().platform!.machines.reconnect(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not reconnect: ${(e as Error).message}` })
    }
  },

  async changeMachineInstall(machineId, kind) {
    const port = get().platform!.machines
    try {
      const r = await port[kind](machineId)
      set((s) => ({ machines: withAnswered(s.machines, r.machine) }))
      return true
    } catch (e) {
      const what = { install: 'Install', update: 'Update', rollback: 'Rollback', uninstall: 'Uninstall' }[kind]
      set({ toast: `${what} failed: ${(e as Error).message}` })
      return false
    }
  },

  async setMachineAutostart(machineId, on) {
    try {
      const r = await get().platform!.machines.autostart(machineId, on)
      set((s) => ({ machines: withAnswered(s.machines, r.machine) }))
      return true
    } catch (e) {
      set({ toast: `Could not turn ${on ? 'on' : 'off'} starting at boot: ${(e as Error).message}` })
      return false
    }
  },

  async machineActivity(machineId) {
    try {
      return await get().platform!.machines.activity(machineId)
    } catch {
      return null
    }
  },

  async acceptMachineVersions(machineId) {
    try {
      const m = await get().platform!.machines.acceptVersions(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not connect: ${(e as Error).message}` })
    }
  },

  async recoverMachine(machineId) {
    const s = get()
    if (!s.platform) return
    const ofMachine = (x: { machine?: string | null }) => (x.machine ?? null) === machineId
    // Held live before: the candidates to wake, once the fresh list says they are not
    const wasLive = Object.values(s.sessions).filter((x) => ofMachine(x) && x.live)
    const asked = s.sessions
    const watch = watchLiveEvents()
    const [fresh, projects] = await Promise.all([
      s.platform.agents.listSessions().catch(() => null),
      s.platform.projects.list().catch(() => null),
    ]).finally(watch.stop)
    if (!fresh) return
    set((st) => {
      /*
       * Only this machine's rows move. Every other row keeps its object, so nothing about this computer's sessions or
       * another machine's re-renders or loses what the reducer derived. A row of this machine the fresh list no
       * longer has (deleted there, or the machine was unlinked) leaves; a new one joins at the end. What changed
       * while the list was out is kept over its older rows, as in the reconnect recovery (`mergeListedSince`).
       * What a session that left kept is cleared as `session_deleted` clears it (#163).
       */
      const { sessions, gone } = mergeListedSince(asked, st.sessions, fresh.filter(ofMachine), watch.touched, ofMachine)
      let nextProjects = st.projects
      if (projects) {
        const theirs = new Map(projects.filter(ofMachine).map((p) => [p.id, p]))
        nextProjects = {}
        for (const [id, p] of Object.entries(st.projects)) {
          if (!ofMachine(p)) nextProjects[id] = p
          else if (theirs.has(id)) nextProjects[id] = theirs.get(id)!
        }
        for (const [id, p] of theirs) if (!nextProjects[id]) nextProjects[id] = p
      }
      return {
        sessions,
        ...forgetSessions(st, gone),
        projects: nextProjects,
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })
    replayPendingEvents(get)
    get().pruneFoldedGroups()
    // A remote's user-folder and project apps come and go with it
    void get().refreshExternalApps()
    // Its agent CLIs may have moved while it was away
    if (get().machineAgentVersions[machineId]) void get().checkMachineAgentVersions(machineId)

    /*
     * The events of the gap are not replayed through the hub (protocol.md, `machine_resync`): every conversation of
     * this machine that is open is read again, the same way a host resync reads every one held (#173).
     */
    const holding = new Set(Object.keys(get().chat))
    const focused = get().focusedSessionId
    if (focused) holding.add(focused)
    for (const id of holding) {
      const cur = get().sessions[id]
      if (cur && ofMachine(cur)) void get().loadHistory(id)
    }

    const toWake = wasLive.filter((x) => {
      const now = get().sessions[x.id]
      return now && !now.live && !isAway(now, get().machines)
    })
    if (toWake.length === 0) return
    const name = get().machines[machineId]?.name ?? machineId
    set({ toast: `${name} is back — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    for (const x of toWake) await get().wake(x.id)
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

  async applyAgentVersions(machine) {
    const platform = get().platform
    if (!platform) return
    try {
      const { restarted, busy } = await platform.agents.applyVersions(machine)
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

  async applyUpdate() {
    const platform = get().platform
    if (!platform) return
    const hostResyncs = get().hostResyncs
    try {
      const update = await platform.updates.apply()
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
      set({ update })
    } catch (e) {
      if (get().platform !== platform || get().hostResyncs !== hostResyncs) return
      set({ toast: `Could not update: ${(e as Error).message}` })
    }
  },

  async applyUpdateNow() {
    const relaunch = get().platform?.relaunch
    if (!relaunch) return 'This window cannot relaunch itself.'
    try {
      await relaunch.relaunch()
      return null
    } catch (e) {
      set({ toast: `Could not apply the update: ${(e as Error).message}` })
      return (e as Error).message
    }
  },
  async answerApplyRequest(requestId) {
    const platform = get().platform
    if (!platform) return
    // A replayed request this window already answered is not answered twice
    if (applyTickets.has(requestId)) return
    const answer = (async () => {
      const verdict = await agentApplyVerdict(platform.relaunch, get().update)
      // A host mid-swap that still wants it asks again; this one's request is gone either way
      return (await platform.updates.answerApply({ requestId, ...verdict }).catch(() => ({ ticket: null }))).ticket
    })()
    applyTickets.set(requestId, answer)
    const ticket = await answer
    if (ticket === null) applyTickets.delete(requestId)
    else setTimeout(() => applyTickets.get(requestId) === answer && applyTickets.delete(requestId), APPLY_TICKET_MS)
  },
  async runApplyRequest(requestId, ticket) {
    // Only the window holding this ticket relaunches, and only once: a replayed go finds it gone (#665)
    const mine = applyTickets.get(requestId)
    if (!mine || (await mine) !== ticket || applyTickets.get(requestId) !== mine) return
    applyTickets.delete(requestId)
    const platform = get().platform
    if (!platform) return
    // Checked again at the go, as the shell checks again when the button is pressed: the bundle may have changed since
    const verdict = await agentApplyVerdict(platform.relaunch, get().update)
    if (!verdict.ready) return void (await platform.updates.reportApply({ requestId, ticket, error: verdict.reason }).catch(() => {}))
    /*
     * Said, and heard, before the relaunch: the host counts this window closing as the relaunch only after it (#665
     * review). Not heard (the host gone mid-swap), the relaunch goes ahead anyway, as the button's would.
     */
    await platform.updates.reportApply({ requestId, ticket, started: true }).catch(() => {})
    const error = await get().applyUpdateNow()
    await platform.updates.reportApply({ requestId, ticket, ...(error ? { error } : {}) }).catch(() => {})
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
  async recoverAfterReconnect(resync = false) {
    const s = get()
    if (!s.platform) return
    // An install/check can end on the outgoing host without its final event reaching this window.
    // Re-read only: replaying an install after a swap could run it twice.
    void get().checkUpdate(false)
    // Resolves whether a message being sent at the moment of disconnect reached the host (#173)
    void settleUnsureSends(get, set)
    // Broadcasts from the gap while disconnected never come again — the app list (A-8) is also aligned to whatever the host currently knows
    void get().refreshExternalApps()
    void get().refreshAppQuestions()
    // So is a proposal list change (#703): a missed `orchestrator_proposals_changed` leaves a card, the count and the badge stale
    void get().refreshMcpProposals()
    void get().refreshSkillProposals()
    // So are the links' states (#82): a machine that went away or came back during the gap
    void get().refreshMachines()
    // The pinned views this window shows are leased to its connection, which just ended (#392)
    void holdPinnedViews(get, set)

    const wasLive = Object.values(s.sessions).filter((x) => x.live)
    const platform = s.platform
    const generation = ++recoveryGeneration

    /*
     * A failed read is tried again while this connection lasts (`RECOVERY_RETRY_MS`). Giving up at once left the
     * gap unrecovered until the next reconnect: no session created or deleted meanwhile, no conversation re-read.
     * A newer recovery, a drop (the reconnect recovers again) or a new platform ends the retries.
     */
    let fresh: SessionInfo[] | null = null
    let asked: Record<string, SessionSummary> = {}
    const watch = watchLiveEvents()
    try {
      for (let attempt = 0; ; attempt++) {
        asked = get().sessions
        watch.touched.clear()
        fresh = await platform.agents.listSessions().catch(() => null)
        if (fresh) break
        const wait = RECOVERY_RETRY_MS[attempt]
        if (wait === undefined) return
        await new Promise((r) => setTimeout(r, wait))
        if (generation !== recoveryGeneration || get().platform !== platform || get().connection !== 'connected') return
      }
    } finally {
      watch.stop()
    }
    const listed = fresh

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
      /*
       * The remains of a session deleted while disconnected are cleared the way `session_deleted` clears them: that
       * event fell into the gap and is never replayed, so this is the only place they can go (#163). What changed
       * while the list was out is kept over the list's older rows (`mergeListedSince`).
       */
      const { sessions, gone } = mergeListedSince(asked, st.sessions, listed, watch.touched)
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
    get().pruneFoldedGroups()

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
    const alive = new Set(listed.filter((x) => x.live).map((x) => x.id))
    /*
     * Never one on a machine that is away (#82): the hub listed it from its mirror, and waking it would only fail there.
     * That machine's own `machine_resync` wakes what has to be woken once it is back (`recoverMachine`).
     */
    const toWake = wasLive.filter(
      (x) => !alive.has(x.id) && get().sessions[x.id] && !isAway(get().sessions[x.id], get().machines),
    )
    if (toWake.length === 0) return

    set({ toast: `Reconnected — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    // The merge already reflects the host's `live: false`, so `wake` never mistakenly thinks it is already alive
    for (const x of toWake) await get().wake(x.id)
  },

  ...eventActions(set, get),
  ...focusActions(set, get),
  ...sendActions(set, get),
  ...answerActions(set, get),
  ...processActions(set, get),
  ...lifecycleActions(set, get),
  ...handoffActions(set, get),
  ...projectActions(set, get),
  ...appActions(set, get),
}))

/**
 * Live subscriptions. Kept at module scope rather than in the store's state — a value the screen has
 * no reason to re-render on, so putting it in state would only add unnecessary renders.
 */
const subscriptions: (() => void)[] = []

function detachAll(): void {
  for (const off of subscriptions.splice(0)) off()
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

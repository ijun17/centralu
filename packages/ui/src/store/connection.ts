import type { AppArrival } from '@cc/core'
import { errorMessage, DEFAULT_UI_PREFERENCES, parseUiPreferences, type SessionInfo } from '@cc/protocol/client'
import type {
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  MachineInfo,
  ThemeFileEntry,
  ToolStatus,
} from '@cc/protocol/client'
import {
  readNotifyPolicy,
  sanitizeArrangements,
  sanitizeGridPanels,
  sanitizeGridSpan,
  type SessionSummary,
} from '@cc/core'
import type { WorkspaceSnapshot } from '@cc/platform/ports'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { sanitizeLayout } from './panelLayout.js'
import { EMPTY_NAV } from './navHistory.js'
import { isApp } from './appKeys.js'
import { screenOf, showsIntro } from './screens.js'
import {
  forgetSessions,
  mergeListedSince,
  replayPendingEvents,
  trackWorkingSince,
  watchLiveEvents,
} from './sessionList.js'
import { holdPinnedViews } from './apps.js'
import { machinesHoldingMirror, reloadCommandRuns } from './machines.js'
import { settleUnsureSends } from './sessions/send.js'
import { rereadAll } from './events/rereads.js'
import { RETRY_MS, retryLadder, type RetrySteps } from './retry.js'

/**
 * Holds `saveWorkspace` while `attach` restores: the restore goes through the person's setters, which save, and a save
 * midway writes the half-restored state over the snapshot being read (#205, #63).
 */
export let restoringWorkspace = false

// Holds `saveWorkspace` too: docs/state-management.md §5 (#384, #2220). A layout changed meanwhile is not kept.
let workspaceUnread = false

/** Bumped by every reconnect recovery, so the retries of an older one stop once a newer one runs */
let recoveryGeneration = 0

/**
 * The latest snapshot the host has not confirmed, sent again on reconnect and after a backoff: an RPC gives up after
 * 30 s, so a stalled host times every save out. Only the latest goes, one at a time, so a retry never writes an older
 * arrangement over a newer one.
 */
const workspaceSave = {
  pending: null as WorkspaceSnapshot | null,
  sending: false,
  /** Bumped by every flush and every reset: a sender that is not the latest stops once its wait is over */
  run: 0,
  /** Which `RETRY_MS` wait the next failure takes. Kept across a newer save; reset by a stored save, a reconnect and a reset */
  steps: { at: 0 },
}

/** Forgets any pending save. A new platform starts from its own stored snapshot, not the last one's leftovers */
function resetWorkspaceSave(): void {
  workspaceSave.pending = null
  workspaceSave.sending = false
  workspaceSave.steps.at = 0
  workspaceSave.run++
}

/**
 * A failed save waits the `RETRY_MS` steps; a new save or a reconnect sends at once. Past the last step the pending
 * snapshot waits for the next reconnect or save: a host that fails every save is not helped by asking every 30 s.
 */
async function flushWorkspace(get: () => AppState, set: StoreSet): Promise<void> {
  if (restoringWorkspace || workspaceSave.sending) return
  const platform = get().platform
  if (!platform || !workspaceSave.pending) return
  const run = ++workspaceSave.run
  const mine = () => workspaceSave.run === run
  const send = async (first: WorkspaceSnapshot): Promise<{ snap: WorkspaceSnapshot; stored: boolean }> => {
    // The latest pending: a retry never sends the older snapshot over a newer one
    const snap = workspaceSave.pending ?? first
    workspaceSave.sending = true
    try {
      await platform.workspace.save(snap)
      return { snap, stored: true }
    } catch (e) {
      // A newer save supersedes this one and goes now; disconnected, the reconnect sends it
      if (workspaceSave.pending !== snap || get().connection !== 'connected') return { snap, stored: false }
      throw e
    } finally {
      if (mine()) workspaceSave.sending = false
    }
  }
  for (;;) {
    const start: WorkspaceSnapshot | null = workspaceSave.pending
    if (!start || !mine()) return
    const sent: Awaited<ReturnType<typeof send>> | null = await retryLadder(
      () => send(start),
      () => mine() && workspaceSave.pending !== null && !restoringWorkspace,
      undefined,
      // Said once the retries run out (#841 item 9): otherwise a layout that did not stick is found only after a restart
      () => {
        if (mine()) set({ toast: 'Could not save the window layout; it is tried again on the next change or reconnect' })
      },
      { steps: workspaceSave.steps },
    )
    if (!sent || !mine()) return
    if (workspaceSave.pending === sent.snap) {
      if (!sent.stored) return
      workspaceSave.pending = null
      workspaceSave.steps.at = 0
    }
  }
}

// Module scope, not state: the screen has no reason to re-render on it
const subscriptions: (() => void)[] = []

function detachAll(): void {
  for (const off of subscriptions.splice(0)) off()
}

/** The last clean read of each theme file: a clean entry replaces it, a broken one leaves it (see `lastGoodThemes`) */
export function goodThemes(
  prev: Record<string, ThemeFileEntry>,
  files: readonly ThemeFileEntry[],
): Record<string, ThemeFileEntry> {
  const next: Record<string, ThemeFileEntry> = {}
  for (const f of files) {
    const good = f.broken ? prev[f.id] : f
    if (good) next[f.id] = good
  }
  return next
}

/**
 * Without `screen` (a late read, #384) only settings and layout come back: the person is on a screen already. Answers
 * whether the named screen came back (docs/state-management.md §5, #2220).
 */
function applyWorkspaceSnapshot(snap: WorkspaceSnapshot, get: () => AppState, set: StoreSet, screen: boolean): boolean {
  let screenBack = true
  // Folds first (#205): `focusSession` below saves, and a save while this is `[]` would erase them
  const savedFolds = (snap as { foldedProjects?: unknown }).foldedProjects
  if (Array.isArray(savedFolds)) {
    set({ foldedProjects: savedFolds.filter((id): id is string => typeof id === 'string') })
  }
  // The project screens' arrangements (#203), first for the same reason as the fold above
  set({ projectPanels: sanitizeArrangements((snap as { projectPanels?: unknown }).projectPanels) })
  // What this window saw of trusted projects' apps, and the notices not yet read (#1141)
  const savedSeen = (snap as { appsSeen?: unknown }).appsSeen
  if (savedSeen && typeof savedSeen === 'object' && !Array.isArray(savedSeen)) {
    const seen: Record<string, string[]> = { ...get().appsSeen }
    for (const [pid, keys] of Object.entries(savedSeen)) {
      if (Array.isArray(keys)) seen[pid] = [...new Set([...(seen[pid] ?? []), ...keys.filter((k): k is string => typeof k === 'string')])].sort()
    }
    set({ appsSeen: seen })
  }
  const savedArrivals = (snap as { appArrivals?: unknown }).appArrivals
  if (Array.isArray(savedArrivals)) {
    const ok = savedArrivals
      .filter(
        (a): a is Omit<AppArrival, 'at'> & { at?: unknown } =>
          !!a && typeof a === 'object' && typeof a.key === 'string' && typeof a.projectId === 'string' && typeof a.appId === 'string' && typeof a.title === 'string' && Array.isArray(a.asks),
      )
      // An entry without a time takes the time it was read
      .map((a): AppArrival => ({ ...a, at: typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : Date.now() }))
    const held = new Set(get().appArrivals.map((a) => a.key))
    set({ appArrivals: [...get().appArrivals, ...ok.filter((a) => !held.has(a.key))] })
  }
  // The person's span per app (#306); an entry that is not a span is dropped
  const savedSpans = (snap as { appSpans?: unknown }).appSpans
  if (savedSpans && typeof savedSpans === 'object' && !Array.isArray(savedSpans)) {
    const spans: Record<string, GridSpan> = {}
    for (const [key, raw] of Object.entries(savedSpans)) {
      const span = sanitizeGridSpan(raw)
      if (span) spans[key] = span
    }
    set({ appSpans: spans })
  }
  if (screen && snap.focusedSessionId && get().sessions[snap.focusedSessionId]) {
    // Never unfolds (#205): a fold left at closing is the person's too
    get().focusSession(snap.focusedSessionId, { reveal: false })
  }
  const sessionGone = screen && !!snap.focusedSessionId && !get().sessions[snap.focusedSessionId]
  /*
   * The view after the session, which forces 'focus'; `introSeen` before `openAssistant`, which saves (#63). A bare
   * 'assistant' view would say "Waking the Assistant…" with nothing waking it.
   */
  if ((snap as { introSeen?: boolean }).introSeen === true) set({ introSeen: true })
  const savedView = screen ? (snap as { view?: unknown }).view : undefined
  // A session that is gone leaves nothing to show in the focus view; the grid and the Assistant do not need it
  if (sessionGone && savedView !== 'grid' && savedView !== 'assistant' && savedView !== 'orchestrator' && savedView !== 'app') screenBack = false
  if (savedView === 'grid') set({ view: 'grid' })
  // 'orchestrator': a workspace a build before #2133 saved
  else if (savedView === 'assistant' || savedView === 'orchestrator') void get().openAssistant()
  else if (savedView === 'app') {
    // A pinned view (B-2), of an app still listed; opening it has the host call `home`
    const app = snap.focusedApp
    if (app && get().externalApps.some((a) => isApp(a, app.projectId, app.appId, app.machine))) {
      get().openApp(app.projectId, app.appId, { machine: app.machine })
    } else screenBack = false
  }
  // The panel's layout comes back even when the session is gone, globally (#20): it is about the person
  if (typeof snap.panelOpen === 'boolean') set({ panelOpen: snap.panelOpen })
  const savedLayout = (snap as { panelLayout?: unknown }).panelLayout
  if (savedLayout != null) {
    set({ panelLayout: sanitizeLayout(savedLayout) })
    const savedSplit = (snap as { panelSplit?: unknown }).panelSplit
    if (typeof savedSplit === 'number' && Number.isFinite(savedSplit)) {
      get().setPanelSplit(savedSplit)
    }
  }
  if (typeof snap.panelWidth === 'number') get().setPanelWidth(snap.panelWidth)
  if (typeof snap.sidebarWidth === 'number') get().setSidebarWidth(snap.sidebarWidth)
  const savedPolicy = (snap as { notifyPolicy?: unknown }).notifyPolicy
  // docs/state-management.md §5: read only from a host whose preferences have none (#1306, #2168)
  if (savedPolicy != null && get().prefs.notifyPolicy === undefined) set((s) => ({ prefs: { ...s.prefs, notifyPolicy: readNotifyPolicy(savedPolicy) } }))
  // Comes back with the panel's layout (#17); a stored `false` outranks the default, also when the default changes
  const savedIgnored = (snap as { showIgnored?: boolean }).showIgnored
  if (typeof savedIgnored === 'boolean') set({ showIgnored: savedIgnored })
  // An older `foldComposer` is not read (owner, 2026-10-20): a panel folds by its own height (`foldWhenShort`)
  return screenBack
}

/** Bumped by every attach and every new read, so an older one stops once its wait is over */
let workspaceReadRun = 0
/** Which `RETRY_MS` wait the next failed read takes: kept across reconnects, reset by a read that worked and by `attach` */
const workspaceReadSteps: RetrySteps = { at: 0 }
/** A read is on its way: a reconnect does not start another beside it (it does cut a wait short) */
let workspaceReading = false

/**
 * docs/state-management.md §5 (#384): `attach` runs once per window, so without this one startup timeout would hold
 * every save until the window is opened again.
 *
 * @param afterFailure the read `attach` already tried and lost: it counts as the first try, so the first wait comes next
 */
async function readWorkspaceAgain(get: () => AppState, set: StoreSet, afterFailure = false): Promise<void> {
  const platform = get().platform
  if (!workspaceUnread || !platform || workspaceReading) return
  const run = ++workspaceReadRun
  const current = () => run === workspaceReadRun && workspaceUnread
  let gaveUp = false
  await retryLadder(
    async () => {
      workspaceReading = true
      try {
        const snap = await platform.workspace.load()
        if (!current()) return
        restoringWorkspace = true
        try {
          if (snap) applyWorkspaceSnapshot(snap, get, set, false)
        } finally {
          restoringWorkspace = false
        }
        workspaceUnread = false
        workspaceReadSteps.at = 0
      } finally {
        // A read from before an `attach` or a newer read settles without touching theirs
        if (run === workspaceReadRun) workspaceReading = false
      }
    },
    current,
    undefined,
    () => (gaveUp = true),
    { steps: workspaceReadSteps, afterFailure },
  )
  if (!gaveUp || !current()) return
  workspaceUnread = false
  set({ toast: `Could not read the window layout after ${RETRY_MS.length + 1} tries; the one on screen is saved in its place` })
  get().saveWorkspace()
}

type ConnectionActions = Pick<AppState, 'attach' | 'saveWorkspace' | 'recoverAfterReconnect'>

export const connectionActions = (set: StoreSet, get: StoreGet): ConnectionActions => ({
  async attach(platform) {
    /*
     * Detach first, so attach is idempotent: each subscription is a fresh closure, so a second attach applies every
     * event twice, and cumulative deltas duplicate the streamed letters.
     */
    detachAll()
    resetWorkspaceSave()
    workspaceReadRun++
    workspaceReadSteps.at = 0
    // The reconnect after the host's first word must not read beside the restore, clearing `workspaceUnread` (#2220)
    workspaceReading = true
    // docs/state-management.md §5: unread from the start of `attach` (#2220)
    workspaceUnread = true
    set({ platform })
    subscriptions.push(
      platform.agents.subscribe((e, id) => get().dispatchEvent(e, id)),
      platform.agents.onConnectionChange((connection) => {
        const was = get().connection
        /*
         * resync_required: alive, but the gap's events fell outside the resend buffer. The label stays `connected`
         * (anything else draws as Disconnected), and a full resync fills the gap.
         */
        const resync = connection === 'resync_required'
        if (resync) {
          set({ connection: 'connected', hostResyncs: get().hostResyncs + 1 })
          // A host that was updated starts its Run commands again with new run ids (#1902)
          reloadCommandRuns(get)
        }
        // A host that comes back may be another process (a restart, a swap): what its install and sign-in said before is not its word now
        else set(connection === 'connected' ? { connection } : { connection, toolSetups: {} })
        // The port does not promise `connected` before `resync_required`: a resync first after a drop is a reconnect too
        if ((connection === 'connected' || resync) && was !== 'connected') {
          // A save that failed while the host was away goes out now, with a fresh set of retries (also one still waiting on its answer)
          workspaceSave.steps.at = 0
          void flushWorkspace(get, set)
          // A new host (a restart, a switched build) read the installed CLIs before this window was back (#297)
          void get().checkAgentVersions(false)
          // Mail posted while the window was away sent its news to nobody, nor did a watch that was set, fired or ended
          void get().loadMail()
          // And the Inbox's Tasks: what it listed may be another host's, and what moved while away came with no news either (#1577)
          set({ mailTasks: null })
          if (get().inboxOpen) void get().loadTasks()
          for (const sessionId of Object.keys(get().watches)) void get().loadWatches(sessionId)
          // Revive sessions that were running; a resync's own recovery below does that and more
          if (!resync) void get().recoverAfterReconnect()
        }
        if (resync) void get().recoverAfterReconnect(true)
      }),
      /*
       * A command run's exit (#60), its `runId` in `terminalId`; a shell's exit matches none. Here, not in a view, so the
       * badge turns off with the log's window closed.
       */
      platform.terminal.onExit((e) => {
        set((s) => {
          for (const [pid, runs] of Object.entries(s.commandRuns)) {
            for (const [cmd, r] of Object.entries(runs)) {
              if (r.runId !== e.terminalId || !r.running) continue
              return {
                commandRuns: {
                  ...s.commandRuns,
                  // When it ended, as seen here: the commands list says how long ago (`CommandRun.endedAt`)
                  [pid]: { ...runs, [cmd]: { ...r, running: false, exitCode: e.exitCode, endedAt: Date.now() } },
                },
              }
            }
          }
          return {}
        })
      }),
    )

    const asked = get().sessions
    const askedMachines = get().machines
    const watch = watchLiveEvents()
    // Said in one toast (#841 item 10): an empty list with no word reads as "there is none", and the person rebuilds it
    const unread: string[] = []
    const orEmpty =
      <T>(what: string, empty: T) =>
      (): T => {
        unread.push(what)
        return empty
      }
    const [projects, sessions, gridPanels, tools, prefs, externalApps, themeFiles, machines] =
      await Promise.all([
        platform.projects.list(),
        platform.agents.listSessions(),
        // The app must come up even if the layout cannot be read — the grid just looks empty
        platform.agents
          .grid()
          .then(sanitizeGridPanels)
          .catch(orEmpty('the grid layout', [] as GridPanel[])),
        // Nor the tool list: unread, only names show
        platform.agents.detect().catch(orEmpty('the installed agent CLIs', [] as ToolStatus[])),
        /*
         * The settings decide how Enter sends, so they come with the first screen, never later (a send key that changes
         * mid-typing sends the message), yet never block: unread, the defaults. Read field by field: an older host lacks some.
         */
        platform.prefs
          .load()
          .then(parseUiPreferences, orEmpty('the screen settings', DEFAULT_UI_PREFERENCES)),
        // With the first screen too, so the app rows do not pop in late
        platform.apps.list().catch(orEmpty('the app list', [] as ExternalAppInfo[])),
        // With the preferences that choose among them; an unreadable folder means the presets
        platform.themes.list().catch(orEmpty('the theme files', [] as ThemeFileEntry[])),
        // The linked machines (#82) name the sidebar's groups, so they come with the lists they group
        platform.machines.list().catch(orEmpty('the linked machines', [] as MachineInfo[])),
      ])
        .finally(watch.stop)
        // An attach that fails before its read leaves the snapshot unread, and the next reconnect reads it
        .catch((e: unknown) => {
          workspaceReading = false
          throw e
        })
    set((st) => {
      // Recovery or re-attachment may have updated the window while startup reads were pending (#640).
      const { sessions: known } = mergeListedSince(asked, st.sessions, sessions, watch.touched)
      return {
        projects: Object.fromEntries(projects.map((p) => [p.id, p])),
        sessions: known,
        // A session already mid-turn gets its start instant now, not at its row's mount (#23)
        workingSince: trackWorkingSince(st.workingSince, known, Date.now()),
        gridPanels,
        tools,
        // The notification switches are the host's (#1306); an older host's come from the snapshot
        prefs,
        externalApps,
        themeFiles,
        lastGoodThemes: goodThemes(st.lastGoodThemes, themeFiles),
        // A `machine_status` that came while these reads were out is newer than the list read at their start (#1611)
        machines: {
          ...Object.fromEntries(machines.map((m) => [m.id, m])),
          ...Object.fromEntries(Object.entries(st.machines).filter(([id, m]) => m !== askedMachines[id])),
        },
        connection: 'connected',
      }
    })

    if (unread.length)
      set({ toast: `Could not read ${unread.join(', ')}; shown empty or as defaults until read again` })

    // Events penned before the list registered their session, such as a running session's first output
    replayPendingEvents(get)
    get().pruneFoldedGroups()
    // A machine that connected while these lists were out: they were read from the hub's mirror, and its own resync may have come before them (#1611)
    for (const id of machinesHoldingMirror(get())) void get().recoverMachine(id)

    // What waits for an answer survives on the host across a reopen: proposals, app questions (M4 D-4), requests (#1405)
    void get().refreshMcpProposals()
    void get().refreshAppQuestions()
    void get().refreshHostRequests()
    void get().refreshSkillProposals()

    /*
     * Asked once (#43): the host's first check broadcast before this window attached. Not awaited: with nothing cached
     * it waits on the network, which must not hold the screen.
     */
    void get().checkUpdate(false)
    // The installed agent CLIs (#297), for the same reason: the host read them before this window attached
    void get().checkAgentVersions(false)
    // The person's mailbox (#1347), for the count on the inbox and its list; a host from before it answers nothing
    void get().loadMail()

    restoringWorkspace = true
    // docs/state-management.md §5: a screen that cannot come back opens the Assistant (#2220)
    let screenLost = false
    try {
      const snap = await platform.workspace.load()
      workspaceUnread = false
      if (snap) screenLost = !applyWorkspaceSnapshot(snap, get, set, true)
    } catch (e) {
      // The intro is the screen of a window with nothing yet, not an empty one
      screenLost = screenOf(get()) === null && !showsIntro(get())
      workspaceReading = false
      // Said, not saved over, and read again
      workspaceUnread = true
      set({ toast: `Could not read the window layout (${errorMessage(e)}); it is shown as the defaults, and not saved over until it is read again` })
      void readWorkspaceAgain(get, set, true)
    } finally {
      restoringWorkspace = false
      workspaceReading = false
    }
    // The view changes before the screen is first shown (`workspaceReady` below), so it is not a visible switch
    if (screenLost) void get().openAssistant()
    // History starts at the screen the restore left (#374): the steps it took to get there are not the person's
    const restored = screenOf(get())
    set({ nav: restored ? { entries: [restored], index: 0 } : EMPTY_NAV, workspaceReady: true })

    /*
     * The grid's sessions are not woken here (#568), slow as a Codex resume is (7-13 s for a large thread): each panel
     * would hold its process, and the host sleeps idle ones after 15 minutes. A panel wakes when used.
     */
  },

  /**
   * The only writer of the snapshot: the host replaces it whole, so a second writer's partial snapshot erases the
   * other's fields. A new field goes here.
   */
  saveWorkspace() {
    if (restoringWorkspace || workspaceUnread) return
    const s = get()
    if (!s.platform) return
    workspaceSave.pending = {
      focusedSessionId: s.focusedSessionId,
      view: s.view,
      focusedApp: s.focusedApp,
      // Apps trusted projects gained, and what was seen (#1141): a notice is said once, also across a reload
      appsSeen: s.appsSeen,
      appArrivals: s.appArrivals,
      panelOpen: s.panelOpen,
      panelLayout: s.panelLayout,
      panelSplit: s.panelSplit,
      panelWidth: s.panelWidth,
      sidebarWidth: s.sidebarWidth,
      foldedProjects: s.foldedProjects,
      projectPanels: s.projectPanels,
      appSpans: s.appSpans,
      showIgnored: s.showIgnored,
      introSeen: s.introSeen,
    } as never
    void flushWorkspace(get, set)
  },

  /**
   * A restarted host knows none of the agent processes that died with the last one; the UI knows what was live and
   * wakes those, never one that was asleep or archived before the drop.
   */
  async recoverAfterReconnect(resync = false) {
    const s = get()
    if (!s.platform) return
    // A snapshot the window could not read is read again: a reconnect is when a host that timed out answers (#384)
    void readWorkspaceAgain(get, set)
    // An install/check can end on the outgoing host without its final event reaching this window.
    // Re-read only: replaying an install after a swap could run it twice.
    void get().checkUpdate(false)
    // Resolves whether a message being sent at the moment of disconnect reached the host (#173)
    void settleUnsureSends(get, set)
    // docs/state-management.md §7: a broadcast missed in the gap never comes again (#2163)
    const machinesRead = rereadAll(get, set)
    // The pinned views this window shows are leased to its connection, which just ended (#392)
    void holdPinnedViews(get, set)

    const platform = s.platform
    const generation = ++recoveryGeneration

    // Retried while this connection lasts (`RETRY_MS`): a newer recovery, a drop or a new platform ends the retries
    let asked: Record<string, SessionSummary> = {}
    const watch = watchLiveEvents()
    let listed: SessionInfo[] | null
    try {
      listed = await retryLadder(
        () => {
          asked = get().sessions
          watch.touched.clear()
          return platform.agents.listSessions()
        },
        () => generation === recoveryGeneration && get().platform === platform && get().connection === 'connected',
        undefined,
        () => {
          // Said, not dropped (#841 item 9): the sidebar may miss what changed while the host was away
          if (generation === recoveryGeneration && get().platform === platform) {
            set({ toast: 'Could not catch up after reconnecting: the session list may be out of date until the next reconnect' })
          }
        },
      )
    } finally {
      watch.stop()
    }
    if (!listed) return

    /*
     * Merged: the host's facts (name, state, read position, approvals, questions, limit) win, so no card is left for a
     * dead `requestId`; what the reducer derived (preview, `touchedPaths`) stays. A session deleted in the gap is
     * cleared as `session_deleted` would, which is never replayed (#163).
     */
    set((st) => {
      const { sessions, gone } = mergeListedSince(asked, st.sessions, listed, watch.touched)
      return {
        sessions,
        ...forgetSessions(st, gone),
        // As in attach (#23); a vanished session leaves no instant behind
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })
    // The merge may register a penned session for the first time
    replayPendingEvents(get)
    get().pruneFoldedGroups()
    // A machine already connected whose rows this list took from the hub's mirror: its resync came before the list, or never will (#1611)
    void machinesRead.then(() => {
      for (const id of machinesHoldingMirror(get())) void get().recoverMachine(id)
    })

    /*
     * A resync re-reads every session holding a conversation (#173): opening one later does not, its cursor being set.
     * A resync is rare, so a page each is affordable.
     */
    const focused = get().focusedSessionId
    if (resync) {
      const holding = new Set(Object.keys(get().chat))
      if (focused) holding.add(focused)
      for (const id of holding) if (get().sessions[id]) void get().loadHistory(id)
    }
  },
})

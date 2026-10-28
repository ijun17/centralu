import type { AppArrival } from '@cc/core'
import { DEFAULT_UI_PREFERENCES, parseUiPreferences, type SessionInfo } from '@cc/protocol/client'
import type {
  ExternalAppInfo,
  GridPanel,
  GridSpan,
  MachineInfo,
  ThemeFileEntry,
  ToolStatus,
} from '@cc/protocol/client'
import {
  appPanelId,
  isAway,
  migrateArrangement,
  readNotifyPolicy,
  sanitizeArrangements,
  sanitizeGridPanels,
  sanitizeGridSpan,
  sessionPanelId,
  type SessionSummary,
} from '@cc/core'
import type { WorkspaceSnapshot } from '@cc/platform/ports'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { activateTab, defaultLayout, sanitizeLayout } from './panelLayout.js'
import { EMPTY_NAV } from './navHistory.js'
import { isApp } from './appKeys.js'
import { screenOf } from './screens.js'
import {
  forgetSessions,
  mergeListedSince,
  replayPendingEvents,
  trackWorkingSince,
  watchLiveEvents,
} from './sessionList.js'
import { holdPinnedViews } from './apps.js'
import { machinesHoldingMirror } from './machines.js'
import { settleUnsureSends } from './sessions/send.js'

/**
 * The store's link to the host: attaching to a platform (its subscriptions, the first reads and the
 * restored workspace), recovering after a reconnect, and saving the workspace snapshot through one
 * writer that retries what failed.
 */

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
export let restoringWorkspace = false

/**
 * True when the last `attach` could not read the workspace snapshot, or its restore threw partway (#384).
 * `saveWorkspace` does nothing then, until an attach reads it: the screen is on its defaults, and a save would write
 * them over the stored snapshot, which holds settings as well as the layout (the notification switches, the app
 * spans, `introSeen`). A layout changed meanwhile is not kept; the stored one comes back with the next read.
 */
let workspaceUnread = false

/**
 * The waits before reading again what a reconnect has to re-read (the session list, a conversation page) when the
 * read fails. Same steps as a failed workspace save: a host that fails every read is not helped by being asked
 * forever, and the next reconnect or opening the conversation reads again.
 */
export const RECOVERY_RETRY_MS = [1_000, 5_000, 30_000] as const

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
function flushWorkspace(get: () => AppState, set: StoreSet): void {
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
      } else flushWorkspace(get, set) // A newer save came in meanwhile
    },
    () => {
      if (workspaceSave.epoch !== epoch) return
      workspaceSave.inFlight = false
      // A newer save came in meanwhile: it supersedes this one and goes now
      if (workspaceSave.pending !== snap) return flushWorkspace(get, set)
      // Disconnected: the reconnect sends it. Out of steps: the next reconnect or save does
      if (get().connection !== 'connected') return
      const wait = WORKSPACE_RETRY_MS[workspaceSave.attempt]
      if (wait === undefined) {
        // Said once the retries run out (#841 item 9): a layout that silently did not stick was found after a restart
        set({ toast: 'Could not save the window layout; it is tried again on the next change or reconnect' })
        return
      }
      workspaceSave.attempt++
      workspaceSave.retryTimer = setTimeout(() => {
        workspaceSave.retryTimer = null
        flushWorkspace(get, set)
      }, wait)
    },
  )
}

/**
 * Live subscriptions. Kept at module scope rather than in the store's state — a value the screen has
 * no reason to re-render on, so putting it in state would only add unnecessary renders.
 */
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

/** The store's actions for the connection to the host and the saved workspace */

/**
 * Lays a stored snapshot onto the window (C-3), field by field. With `screen`, it also goes back to the screen the
 * snapshot names (the focused session, the view, the pinned app); a snapshot read late (#384, `readWorkspaceAgain`)
 * brings back the settings and the layout only, because the person is already working on some screen. Returns whether
 * the project screens' arrangements came in an older shape and need saving once.
 */
function applyWorkspaceSnapshot(snap: WorkspaceSnapshot, get: () => AppState, set: StoreSet, screen: boolean): boolean {
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
    projectPanels: Object.fromEntries(
      Object.entries(arrangements).map(([pid, saved]) => {
        const present = [
          ...Object.values(get().sessions)
            .filter((s) => s.projectId === pid)
            .map((s) => sessionPanelId(s.id)),
          ...get()
            .externalApps.filter((a) => a.projectId === pid)
            .sort(
              (a, b) =>
                (a.name ?? a.appId).localeCompare(b.name ?? b.appId) || a.appId.localeCompare(b.appId),
            )
            .map((a) => appPanelId(a.appId)),
        ]
        return [pid, migrateArrangement(present, saved)]
      }),
    ),
  })
  // What this window had seen of trusted projects' apps, and the notices not yet read (#1141); a snapshot from before has none
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
    const ok = savedArrivals.filter(
      (a): a is AppArrival =>
        !!a && typeof a === 'object' && typeof a.key === 'string' && typeof a.projectId === 'string' && typeof a.appId === 'string' && typeof a.title === 'string' && Array.isArray(a.asks),
    )
    const held = new Set(get().appArrivals.map((a) => a.key))
    set({ appArrivals: [...get().appArrivals, ...ok.filter((a) => !held.has(a.key))] })
  }
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
  if (screen && snap.focusedSessionId && get().sessions[snap.focusedSessionId]) {
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
  const savedView = screen ? (snap as { view?: unknown }).view : undefined
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
  // The host's record is the one source (#1306); the snapshot's copy is read only from a host that has none, and it is not
  // read at all once the host answered (the preferences arrive before the snapshot is applied)
  if (savedPolicy != null && get().prefs.notifyPolicy === undefined) set({ notifyPolicy: readNotifyPolicy(savedPolicy) })
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
  /*
   * `foldComposer` (the "fold the message box" switch) is no longer read (owner, 2026-10-20): a grid or project panel
   * folds its composer by its own height now (SessionPane's `foldWhenShort`). A snapshot that still carries it is fine.
   */
  return Object.values(arrangements).some((saved) => saved.panels === undefined)
}

/**
 * Reading a snapshot again after a read that failed (#384). `attach` runs once per window, so without this one
 * timeout at startup held every save (`workspaceUnread`) until the window was opened again. It is read again on every
 * reconnect and on these waits while connected; read, it is brought back (`applyWorkspaceSnapshot`, without the screen)
 * and saving resumes. Past the last wait, the snapshot the window holds is saved in its place, said once: a row that
 * never reads must not stop the window saving for good.
 */
const WORKSPACE_READ_RETRY_MS = [1_000, 5_000, 30_000] as const
const workspaceRead = {
  timer: null as ReturnType<typeof setTimeout> | null,
  /** Which step of `WORKSPACE_READ_RETRY_MS` the next wait is */
  attempt: 0,
  inFlight: false,
  /** Bumped by every attach, so a read from before it does nothing after it */
  epoch: 0,
}

function resetWorkspaceRead(): void {
  if (workspaceRead.timer) clearTimeout(workspaceRead.timer)
  workspaceRead.timer = null
  workspaceRead.attempt = 0
  workspaceRead.inFlight = false
  workspaceRead.epoch++
}

function scheduleWorkspaceRead(get: () => AppState, set: StoreSet): void {
  const wait = WORKSPACE_READ_RETRY_MS[workspaceRead.attempt]
  if (wait === undefined) {
    workspaceUnread = false
    set({ toast: `Could not read the window layout after ${WORKSPACE_READ_RETRY_MS.length + 1} tries; the one on screen is saved in its place` })
    get().saveWorkspace()
    return
  }
  workspaceRead.attempt++
  workspaceRead.timer = setTimeout(() => {
    workspaceRead.timer = null
    void readWorkspaceAgain(get, set)
  }, wait)
}

async function readWorkspaceAgain(get: () => AppState, set: StoreSet): Promise<void> {
  const platform = get().platform
  if (!workspaceUnread || workspaceRead.inFlight || !platform) return
  if (workspaceRead.timer) clearTimeout(workspaceRead.timer)
  workspaceRead.timer = null
  const epoch = workspaceRead.epoch
  workspaceRead.inFlight = true
  try {
    const snap = await platform.workspace.load()
    if (epoch !== workspaceRead.epoch || !workspaceUnread) return
    restoringWorkspace = true
    try {
      if (snap) applyWorkspaceSnapshot(snap, get, set, false)
    } finally {
      restoringWorkspace = false
    }
    workspaceUnread = false
    workspaceRead.attempt = 0
  } catch {
    if (epoch !== workspaceRead.epoch || !workspaceUnread) return
    scheduleWorkspaceRead(get, set)
  } finally {
    if (epoch === workspaceRead.epoch) workspaceRead.inFlight = false
  }
}

type ConnectionActions = Pick<AppState, 'attach' | 'saveWorkspace' | 'recoverAfterReconnect'>

export const connectionActions = (set: StoreSet, get: StoreGet): ConnectionActions => ({
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
    resetWorkspaceRead()
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
        // A host that comes back may be another process (a restart, a swap): what its install and sign-in said before is not its word now
        else set(connection === 'connected' ? { connection } : { connection, toolSetups: {} })
        /*
         * Disconnected and came back. The web client says `connected` before `resync_required`, but the port does
         * not promise that order: a resync that is the first word after a drop is a reconnect too, and must not
         * skip what a reconnect does.
         */
        if ((connection === 'connected' || resync) && was !== 'connected') {
          // A save that failed while the host was away goes out now, with a fresh set of retries
          workspaceSave.attempt = 0
          flushWorkspace(get, set)
          // A new host (a restart, a switched build) read the installed CLIs before this window was back (#297)
          void get().checkAgentVersions(false)
          // Mail posted while the window was away sent its news to nobody
          void get().loadMail()
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
    /*
     * What could not be read and came up empty, said in one toast once the screen is up (#841 item 10): an empty grid
     * or app list with no word read as "there is none", and the person rebuilt what was only unread
     */
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
        // Sanitized: a host from before apps could stand on the grid answers bare session ids, which still read as sessions
        platform.agents
          .grid()
          .then(sanitizeGridPanels)
          .catch(orEmpty('the grid layout', [] as GridPanel[])),
        // Same reason: the tool list must not block the app either — if it cannot be read, only names show, with no label
        platform.agents.detect().catch(orEmpty('the installed agent CLIs', [] as ToolStatus[])),
        /*
        The screen settings must **never arrive later than the first screen.**

        Unlike something that is fine arriving late (like an update check), this value decides how
        the composer reads Enter. Arriving late means the send key changes while the person is
        already typing, and that mistake cannot be undone — the message is already gone.

        Even so, it must **never block**: if it cannot be read, use the default. An app that cannot
        come up because of one setting is far worse than whatever that setting does.
      */
        // Read through the schema, field by field: an older host answers without the fields it does not know
        platform.prefs
          .load()
          .then(parseUiPreferences, orEmpty('the screen settings', DEFAULT_UI_PREFERENCES)),
        // The external app list (A-8) also arrives with the first screen — so the sidebar's app rows
        // do not pop in late. The app still comes up if it cannot be read: the app rows just look
        // empty, and the next broadcast re-reads them
        platform.apps.list().catch(orEmpty('the app list', [] as ExternalAppInfo[])),
        // The theme files arrive with the preferences that choose among them, so the first screen
        // already has its theme — and a folder that cannot be read just means the presets
        platform.themes.list().catch(orEmpty('the theme files', [] as ThemeFileEntry[])),
        /*
         * The linked machines (#82) name the sidebar's groups, so they come with the lists they group. A host from before
         * them has none, and says it does not know the method: that is no machine, quietly. Any other failure is a list
         * that was not read, and is said (#841 item 10): the sidebar would show no machine where one is linked
         */
        platform.machines
          .list()
          .catch((e: unknown) =>
            e instanceof Error && e.message.startsWith('Unknown method: machines.list')
              ? ([] as MachineInfo[])
              : orEmpty('the linked machines', [] as MachineInfo[])(),
          ),
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
        // The switches are the host's (#1306); a host from before them answers without, and the snapshot's are read later
        ...(prefs.notifyPolicy ? { notifyPolicy: prefs.notifyPolicy } : {}),
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

    // Replay events that arrived before the list was registered — the first output of a session that
    // was already running before the app was even opened is held here
    replayPendingEvents(get)
    get().pruneFoldedGroups()
    // A machine that connected while these lists were out: they were read from the hub's mirror, and its own resync may have come before them (#1611)
    for (const id of machinesHoldingMirror(get())) void get().recoverMachine(id)

    // A suggestion awaiting approval stays on the host even across the app being closed and reopened
    // — its card must reappear
    void get().refreshMcpProposals()
    // Capability questions also survive on the host (M4 D-4) — an app's call waiting for an answer hangs there
    void get().refreshAppQuestions()
    // A program's call waiting for the person (#1405) waits on the host too
    void get().refreshHostRequests()
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
    // The person's mailbox (#1347), for the count on the inbox and its list; a host from before it answers nothing
    void get().loadMail()

    // Come back to where you were (C-3). A session that no longer exists is quietly skipped.
    restoringWorkspace = true
    let migratedProjectPanels = false
    try {
      const snap = await platform.workspace.load()
      workspaceUnread = false
      if (snap) migratedProjectPanels = applyWorkspaceSnapshot(snap, get, set, true)
    } catch (e) {
      // The app works normally even with no snapshot, but it is said, not saved over (`workspaceUnread`), and read again
      workspaceUnread = true
      set({ toast: `Could not read the window layout (${(e as Error).message}); it is shown as the defaults, and not saved over until it is read again` })
      scheduleWorkspaceRead(get, set)
    } finally {
      restoringWorkspace = false
    }
    // Persist migration only after the whole restore succeeds, so a restart cannot migrate newly created sessions again.
    if (migratedProjectPanels) get().saveWorkspace()
    // History starts at the screen the restore left (#374): the steps it took to get there are not the person's
    const restored = screenOf(get())
    set({ nav: restored ? { entries: [restored], index: 0 } : EMPTY_NAV, workspaceReady: true })

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
    // Nothing is saved while the snapshot is being restored, or when it could not be read: see `restoringWorkspace`, `workspaceUnread`
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
      introSeen: s.introSeen,
    } as never
    flushWorkspace(get, set)
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
    // A snapshot the window could not read is read again: a reconnect is when a host that timed out answers (#384)
    void readWorkspaceAgain(get, set)
    // An install/check can end on the outgoing host without its final event reaching this window.
    // Re-read only: replaying an install after a swap could run it twice.
    void get().checkUpdate(false)
    // Resolves whether a message being sent at the moment of disconnect reached the host (#173)
    void settleUnsureSends(get, set)
    // Broadcasts from the gap while disconnected never come again — the app list (A-8) is also aligned to whatever the host currently knows
    void get().refreshExternalApps()
    void get().refreshAppQuestions()
    // And the requests waiting for the person (#1405): a missed host_request would leave a program waiting unseen
    void get().refreshHostRequests()
    // So is a proposal list change (#703): a missed `orchestrator_proposals_changed` leaves a card, the count and the badge stale
    void get().refreshMcpProposals()
    void get().refreshSkillProposals()
    // So are the preferences (#1306): a missed `prefs_changed` leaves the orchestrator's change to a setting unseen
    void get().refreshPrefs()
    // So are the links' states (#82): a machine that went away or came back during the gap
    const machinesRead = get().refreshMachines()
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
        if (wait === undefined) {
          // Said, not dropped (#841 item 9): the sidebar may miss what changed while the host was away
          if (generation === recoveryGeneration && get().platform === platform) {
            set({
              toast:
                'Could not catch up after reconnecting: the session list may be out of date until the next reconnect',
            })
          }
          return
        }
        await new Promise((r) => setTimeout(r, wait))
        if (
          generation !== recoveryGeneration ||
          get().platform !== platform ||
          get().connection !== 'connected'
        )
          return
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
    // A machine already connected whose rows this list took from the hub's mirror: its resync came before the list, or never will (#1611)
    void machinesRead.then(() => {
      for (const id of machinesHoldingMirror(get())) void get().recoverMachine(id)
    })

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
     * That machine's own `machine_resync` wakes what has to be woken once it is back (`recoverMachine`). Judged against
     * the machine list read after the drop, not the one from before it, and never a row the hub still lists from its
     * mirror: its `live` is last heard, not a fact (#1611).
     */
    await machinesRead
    const toWake = wasLive.filter((x) => {
      const now = get().sessions[x.id]
      return !alive.has(x.id) && now && !now.unreachable && !isAway(now, get().machines)
    })
    if (toWake.length === 0) return

    set({ toast: `Reconnected — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    // The merge already reflects the host's `live: false`, so `wake` never mistakenly thinks it is already alive
    for (const x of toWake) await get().wake(x.id)
  },
})

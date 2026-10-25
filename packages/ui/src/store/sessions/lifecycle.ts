import { APP_ARRIVAL_ID_PREFIX, backgroundCount, defaultPresetFor, isAppArrivalId, isInTurn, sessionPanelId, withPanel, type SessionSummary } from '@cc/core'
import { errorMessage, type NormalizedEvent, type ToolDefaults, type ToolName } from '@cc/protocol'
import { initialSession, markRead as markReadPure, rename as renamePure } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { ifSessionStill, inOrder, stillInOrder } from '../patch.js'
import { writingProject } from '../projects.js'
import { liveFactsOf, replayPendingEvents } from '../sessionList.js'
import { bumpChatKeysAbove, messagesToChat, nextChatKey, type ChatItem } from '../transcript.js'
import type { Draft } from '../state/conversation.js'

/**
 * A session's place in the list: opening the new-session dialog or starting one at once, creating it,
 * moving it to the session archive and back, its name, its read position and its order.
 */

/**
 * Whether archiving a session asks without the host being consulted (#1512): a turn under way, a card waiting for the person,
 * or a background job running (moving it ends its process, and with it the job, which the archive does not bring back). This is
 * only what the window can see, and only to ask more, never less: a session that passes goes to the host's own check
 * (`archiveSession`), which knows what the window cannot (reports owed, waits and cards on it, mail threads).
 */
export function archiveNeedsAsk(s: Pick<SessionSummary, 'state' | 'pendingApproval' | 'pendingQuestions' | 'backgroundTasks'>): boolean {
  return isInTurn(s.state) || !!s.pendingApproval || s.pendingQuestions.length > 0 || backgroundCount(s.backgroundTasks) > 0
}

/** What the host said an archive would lose, for the dialog that opens next (read by it; one entry per session asked about) */
const archiveAsks = new Map<string, string[]>()
export const archiveAsksOf = (sessionId: string): string[] => archiveAsks.get(sessionId) ?? []

/**
 * Where a session sat in the window when it was archived: what the person had typed and not sent, and its place in each project's
 * grid. The archive clears both (`forgetSessions`), and Undo puts them back. Not kept: the scroll position and which panel had
 * the focus.
 */
type WindowPlace = { draft: Draft | null; grids: { projectId: string; at: number }[] }

function windowPlaceOf(s: AppState, sessionId: string): WindowPlace {
  const draft = s.drafts[sessionId]
  const panel = sessionPanelId(sessionId)
  return {
    draft: draft && (draft.text.trim() || draft.attachments.length > 0) ? draft : null,
    grids: Object.entries(s.projectPanels).flatMap(([projectId, saved]) => {
      const at = saved.panels?.indexOf(panel) ?? -1
      return at >= 0 ? [{ projectId, at }] : []
    }),
  }
}

function putWindowPlaceBack(set: StoreSet, get: StoreGet, sessionId: string, place: WindowPlace): void {
  const panel = sessionPanelId(sessionId)
  set((s) => ({
    // The unsent text is the composer's again, unless the person has typed something new since
    ...(place.draft && !s.drafts[sessionId]?.text.trim()
      ? { drafts: { ...s.drafts, [sessionId]: place.draft }, keptDrafts: s.keptDrafts.filter((d) => d.sessionId !== sessionId) }
      : {}),
    projectPanels: {
      ...s.projectPanels,
      ...Object.fromEntries(
        place.grids.flatMap(({ projectId, at }) => {
          const saved = s.projectPanels[projectId]
          if (!saved?.panels || saved.panels.includes(panel)) return []
          // Added at the end, then moved to the slot it left, so the panels around it keep their order
          const added = withPanel([panel, ...saved.panels], saved, panel, true)
          const panels = saved.panels.slice()
          panels.splice(Math.min(at, panels.length), 0, panel)
          return [[projectId, { ...added, panels, order: panels }] as const]
        }),
      ),
    },
  }))
  if (place.grids.length > 0) get().saveWorkspace()
}

/** The toast after a session went to the archive: Undo is the archive's own Restore, and the window's side of the session comes back with it */
function announceArchived(set: StoreSet, get: StoreGet, sessionId: string, name: string, place: WindowPlace): void {
  set({
    toast: `Archived ${name} · Settings → Archive keeps it`,
    toastAction: {
      label: 'Undo',
      run: () => {
        void get()
          .restoreFromTrash(sessionId)
          .then((error) => {
            if (error) set({ toast: `Could not undo: ${error}` })
            else putWindowPlaceBack(set, get, sessionId, place)
          })
      },
    },
  })
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
  /** The project's machine (#82): the models are the ones its own CLI offers */
  machine?: string | null,
): Promise<ToolDefaults> {
  const none: ToolDefaults = { model: null, effort: null }
  if (!saved?.model) return saved ?? none
  try {
    const { supported, models } = await platform.agents.models(tool, machine)
    if (!supported || models.length === 0) return saved
    return models.some((m) => m.id === saved.model) ? saved : none
  } catch {
    return saved // Same reason as above — failing to ask is not the same as "does not exist"
  }
}

/** Projects with a one-click start (`startSessionNow`) in flight: a re-entry guard, nothing to draw from it */
const startingNow = new Set<string>()

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
function withOpeningPrompt(
  chat: Record<string, ChatItem[]>,
  id: string,
  text: string,
): Record<string, ChatItem[]> {
  const have = chat[id] ?? []
  if (have.some((it) => it.kind === 'user' && it.text === text)) return chat
  return {
    ...chat,
    [id]: [...have, { kind: 'user', seq: nextChatKey(), text, pending: true, at: Date.now() }],
  }
}

/** The store's actions that create, list and remove sessions */
type LifecycleActions = Pick<
  AppState,
  | 'openNewSession'
  | 'startSessionNow'
  | 'createSession'
  | 'deleteSession'
  | 'archiveSession'
  | 'restoreFromTrash'
  | 'rename'
  | 'markRead'
  | 'markDone'
  | 'markOpened'
  | 'reorderSessions'
>

export const lifecycleActions = (set: StoreSet, get: StoreGet): LifecycleActions => ({
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

  async startSessionNow(projectId) {
    const project = get().projects[projectId]
    const platform = get().platform
    // A second click while the first is still starting would make a second session
    if (!project || !platform || startingNow.has(projectId)) return
    startingNow.add(projectId)
    try {
      let tool = project.defaultTool ?? get().tools[0]?.name ?? ''
      /*
       * The host does not check a login when it creates a session: a tool that is logged out would fail on the first
       * turn instead. So the same rule as the dialog's applies first: a remembered tool that cannot run gives way to
       * one that can, and when none can the dialog opens, which states why. Failing to ask is not "unusable".
       */
      const found = await platform.agents.detect(project.machine ?? null).catch(() => [])
      const usable = (t: string) => {
        const d = found.find((x) => x.name === t)
        return d?.installed === true && d.loggedIn
      }
      if (found.length > 0 && !usable(tool)) {
        const other = found.find((x) => x.installed && x.loggedIn)?.name
        if (!other) return get().openNewSession(projectId)
        tool = other
      }
      const created = await get().createSession(projectId, { tool })
      // What comes next is the first instruction (#528): the composer takes the keyboard, as it does after the dialog's Start
      get().askComposerFocus(created.id)
    } catch (e) {
      get().openNewSession(projectId)
      get().setToast(`Could not start a session: ${(e as Error).message}`)
    } finally {
      startingNow.delete(projectId)
    }
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
    const remembered = await usableDefaults(platform, tool, project.defaultModels?.[tool], project.machine)
    // The host records the tool as this project's default while it makes the session (#719): a list read must not undo it
    const info = await writingProject(
      projectId,
      () => void get().refreshProjects(),
      () =>
        platform.agents.createSession({
          projectId,
          cwd: project.path,
          // The chosen value travels straight to the host — the preset used to be pinned to 'normal' and the model was not even passed
          tool,
          model: opts?.model ?? remembered.model ?? undefined,
          // Effort follows the memory too (#69 ⑤) — remembering only the model meant Opus came back but high still had to be pressed again
          effort: opts?.effort ?? remembered.effort ?? undefined,
          verbosity: opts?.verbosity,
          serviceTier: opts?.serviceTier,
          permissionPreset: opts?.permissionPreset ?? defaultPresetFor(project),
          initialPrompt: opts?.initialPrompt,
          handoff: opts?.handoff,
          resumeExternalId: opts?.resumeExternalId,
          importHistory: opts?.importHistory,
          worktree: opts?.worktree,
          worktreeBranch: opts?.worktreeBranch,
          worktreeBase: opts?.worktreeBase,
        }),
    )
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
        bumpChatKeysAbove(restored)
        set((s) => ({ chat: { ...s.chat, [info.id]: restored } }))
      }
    }

    // Replays events held from before registration, in order
    replayPendingEvents(get)
    return info
  },

  /**
   * Archives a session (#204). The toast says where it went: a session that leaves the sidebar with no word
   * about where is the retired hide-a-session feature again (FR-20).
   */
  async deleteSession(sessionId, deleteWorktree, deleteExternal) {
    const platform = get().platform
    if (!platform) return
    const name = get().sessions[sessionId]?.name ?? 'Session'
    // Before the host moves it: its answer clears the window's side of the session
    const place = windowPlaceOf(get(), sessionId)
    archiveAsks.delete(sessionId)
    try {
      await platform.agents.deleteSession(sessionId, deleteWorktree, deleteExternal)
      announceArchived(set, get, sessionId, name, place)
    } catch (e) {
      set({ toast: `Could not delete: ${errorMessage(e)}` })
    }
  },

  /**
   * The archive of a session the menu offers, decided with the host (#1512). Null: it was archived (the toast offers Undo) or
   * failed (the toast says why). Lines: it was not, and the person is asked first; the lines are what the host said the archive
   * would lose (`archiveAsksOf`), empty when the window itself saw a reason to ask.
   */
  async archiveSession(sessionId) {
    const platform = get().platform
    const s = get().sessions[sessionId]
    if (!platform || !s) return null
    archiveAsks.delete(sessionId)
    const ask = (lines: string[]) => {
      archiveAsks.set(sessionId, lines)
      return lines
    }
    if (archiveNeedsAsk(s)) return ask([])
    try {
      // A worktree with uncommitted changes is said in the dialog, as it always was (the folder stays, but it is work the person may not remember)
      if (s.worktree && (await platform.agents.worktreeStatus(sessionId).catch(() => null))?.dirty) return ask([])
      const place = windowPlaceOf(get(), sessionId)
      // The tool's own conversation file goes when it is deleted for good, as the dialog's default has it; the archive itself keeps it
      const r = await platform.agents.archiveIfAtRest(sessionId, true)
      if (!r.archived) return ask(r.asks)
      announceArchived(set, get, sessionId, s.name, place)
      return null
    } catch (e) {
      // A host from before the check cannot tell what the archive would lose: ask first, as it always did
      if (/unknown method/i.test(errorMessage(e))) return ask([])
      set({ toast: `Could not archive: ${errorMessage(e)}` })
      return null
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
    set(
      ifSessionStill(sessionId, (s, cur) => ({
        sessions: { ...s.sessions, [sessionId]: renamePure(cur, next) },
      })),
    )
  },

  async markRead(sessionId) {
    // Done on an app's arrival notice (#1141) takes it off; it is not a session
    if (isAppArrivalId(sessionId)) return get().dismissAppArrival(sessionId.slice(APP_ARRIVAL_ID_PREFIX.length))
    const s = get().sessions[sessionId]
    if (!s || s.lastReadSeq >= s.lastSeq) return
    try {
      await get().platform!.agents.markRead(sessionId, s.lastSeq)
    } catch (e) {
      /*
       * Offline, or the host is being swapped (#842 item 14). Callers fire this and forget it (opening a session, Done in
       * the waiting list), so a rejection here was an unhandled one. Said, not thrown: the session stays unread, which is
       * what the host still holds, and Done that seemed to do nothing says why.
       */
      set({ toast: `Could not mark as read: ${(e as Error).message}` })
      return
    }
    set(
      ifSessionStill(sessionId, (st, cur) => ({
        sessions: { ...st.sessions, [sessionId]: markReadPure(cur, s.lastSeq) },
      })),
    )
  },

  async markDone(sessionId) {
    const s = get().sessions[sessionId]
    const platform = get().platform
    if (s?.state !== 'error' || !platform) return get().markRead(sessionId)
    let result: { cleared: boolean; newer: boolean; olderHost: boolean }
    try {
      result = await platform.agents.clearError(sessionId, s.lastSeq)
    } catch (e) {
      set({ toast: `Could not clear the error: ${(e as Error).message}` })
      return
    }
    /*
     * The state is the host's to say: it sends `idle` when it cleared the error, and sends nothing when something newer
     * happened (a Continue from another window that already failed again or is waiting on an approval). Forcing `idle` here
     * wiped such a card. Only the read mark is this window's to move.
     */
    set(ifSessionStill(sessionId, (st, cur) => ({ sessions: { ...st.sessions, [sessionId]: markReadPure(cur, s.lastSeq) } })))
    // Done that cleared nothing says why, instead of seeming to do nothing
    if (result.olderHost) set({ toast: 'Marked as read. This host is too old to clear an error: it stays until the host is updated' })
    else if (result.newer) set({ toast: 'A newer error arrived. It stays marked' })
  },

  /*
   * An app's agent session the person opened stays theirs (#378 review). The host hears "opened" through `markRead`
   * only, and `markRead` above sends nothing when nothing is unread, which is how an app-agent session usually opens:
   * the app's request is read as it arrives. A run that ended in the 3 seconds before the read mark then deleted the
   * session the person was looking at. The read position sent is the one the host already has (it keeps the larger),
   * so this moves nothing; it only says the session is on screen.
   */
  async markOpened(sessionId) {
    const s = get().sessions[sessionId]
    if (!s?.appId) return
    try {
      await get().platform!.agents.markRead(sessionId, s.lastReadSeq)
    } catch {
      // Offline or mid-swap: the 3-second read mark tries again, and a draft in a session deleted meanwhile is kept
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
      /*
       * Only the order goes back (#842 item 3): the sessions as they are now, in the order from before the drag. Putting
       * `before` back whole lost every session created and every state change made while the save was out. And only
       * while the order shown is still this drag's: a later drag that was saved is not undone by this one failing.
       */
      set((st) => ({
        ...(stillInOrder(st.sessions, orderedIds)
          ? { sessions: inOrder(st.sessions, Object.keys(before)) }
          : {}),
        toast: `Could not save order: ${(e as Error).message}`,
      }))
    }
  },
})

import { APP_ARRIVAL_ID_PREFIX, isAppArrivalId, sessionPanelId, withPanel } from '@cc/core'
import { defaultPresetFor, errorMessage, listedModel, type NormalizedEvent, type ToolDefaults, type ToolName } from '@cc/protocol/client'
import { markRead as markReadPure, rename as renamePure } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { ifSessionStill, inOrder, stillInOrder } from '../patch.js'
import { writingProject } from '../projects.js'
import { replayPendingEvents, sessionFromInfo } from '../sessionList.js'
import { bumpChatKeysAbove, messagesToChat, nextChatKey, type ChatItem } from '../transcript.js'
import type { Draft } from '../state/conversation.js'

/** What the archive clears (`forgetSessions`) and Undo puts back; the scroll position and panel focus are not kept */
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

/** Undo is the archive's own Restore, and the window's side of the session comes back with it */
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
 * The remembered model only if the tool still offers it (#107): a retired one kills the session with a 400. An unread
 * list (`supported: false`) drops nothing. Effort goes with its model, a handle on it (`ModelOption.efforts`).
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
    return listedModel(models, saved.model) ? saved : none
  } catch {
    return saved // Same reason as above — failing to ask is not the same as "does not exist"
  }
}

/** Projects with a one-click start (`startSessionNow`) in flight: a re-entry guard, nothing to draw from it */
const startingNow = new Set<string>()

/**
 * Never overwrites (#172): the host broadcasts `session_created`, `handoff` and `user_message` before the response, so
 * they are drawn already, and an overwrite would drop the handoff marker and draw the prompt twice.
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
  | 'stopContinue'
  | 'markOpened'
  | 'reorderSessions'
>

export const lifecycleActions = (set: StoreSet, get: StoreGet): LifecycleActions => ({
  openNewSession(projectId, opts) {
    // A suggestion (#69) is consumed when any door opens it, or it would leak into the next dialog
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
      // The host checks no login when it creates a session, so the dialog's rule applies here: a tool that cannot run
      // gives way, and with none the dialog says why. Failing to ask is not "unusable".
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
      get().setToast(`Could not start a session: ${errorMessage(e)}`)
    } finally {
      startingNow.delete(projectId)
    }
  },

  async createSession(projectId, opts) {
    const platform = get().platform!
    const project = get().projects[projectId]!
    const tool = opts?.tool ?? project.defaultTool ?? get().tools[0]?.name ?? ''
    // Only this tool's memory (#107): one model per project would refill what a tool-switching handoff clears
    const remembered = await usableDefaults(platform, tool, project.defaultModels?.[tool], project.machine)
    // The host records the tool as this project's default while it makes the session (#719): a list read must not undo it
    const info = await writingProject(
      projectId,
      () => void get().refreshProjects(),
      () =>
        platform.agents.createSession({
          projectId,
          cwd: project.path,
          tool,
          model: opts?.model ?? remembered.model ?? undefined,
          // Effort follows the memory too (#69)
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
    // Over the row `session_created` may have registered: replacing it would wind `lastSeq` back (#2171)
    set((s) => ({
      sessions: { ...s.sessions, [info.id]: sessionFromInfo(info, s.sessions[info.id]) },
      // The pick becomes the project's default, as the host decides (`personsPick`, #2350); shown at once
      projects:
        opts?.tool && s.projects[projectId]
          ? { ...s.projects, [projectId]: { ...s.projects[projectId], defaultTool: opts.tool } }
          : s.projects,
      // `pending`, so the host's `user_message` for it confirms the row rather than drawing it twice, as in `send()`
      chat: opts?.initialPrompt ? withOpeningPrompt(s.chat, info.id, opts.initialPrompt) : s.chat,
    }))
    // Through `focusSession`, which shows it: onboarding opens the Assistant first (#63)
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

    replayPendingEvents(get)
    return info
  },

  /** The toast says where it went (#204): leaving the sidebar unannounced is the retired hide-a-session again (FR-20) */
  async deleteSession(sessionId, deleteWorktree, deleteExternal) {
    const platform = get().platform
    if (!platform) return
    const name = get().sessions[sessionId]?.name ?? 'Session'
    // Before the host moves it: its answer clears the window's side of the session
    const place = windowPlaceOf(get(), sessionId)
    try {
      await platform.agents.deleteSession(sessionId, deleteWorktree, deleteExternal)
      announceArchived(set, get, sessionId, name, place)
    } catch (e) {
      set({ toast: `Could not delete: ${errorMessage(e)}` })
    }
  },

  /**
   * The dialog's Archive before the person has seen the host's losses (#1512, #1589, #1595). Null: done (archived, or
   * failed and said). Lines: not moved, what the archive would lose. No lines: not at rest; the dialog moves it with
   * `deleteSession` if still open. With the worktree deleted the host's at-rest check cannot run (it never removes one),
   * so only the losses are read.
   */
  async archiveSession(sessionId, deleteWorktree, deleteExternal) {
    const platform = get().platform
    const s = get().sessions[sessionId]
    if (!platform || !s) return null
    const place = windowPlaceOf(get(), sessionId)
    try {
      if (deleteWorktree) return await platform.agents.archiveLosses(sessionId)
      const r = await platform.agents.archiveIfAtRest(sessionId, deleteExternal)
      if (r.archived) {
        announceArchived(set, get, sessionId, s.name, place)
        return null
      }
      if (r.asks.length > 0) return r.asks
    } catch (e) {
      set({ toast: `Could not archive: ${errorMessage(e)}` })
      return null
    }
    return []
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
      return errorMessage(e)
    }
  },

  /** The host first, the screen after (#5): a failed optimistic name would revert unexplained at the next list read */
  async rename(sessionId, name) {
    const next = name.trim()
    if (!next) {
      set({ toast: 'Session name cannot be empty' })
      return
    }
    try {
      await get().platform!.agents.rename(sessionId, next)
    } catch (e) {
      set({ toast: `Could not rename: ${errorMessage(e)}` })
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
      // Offline or mid-swap (#842). Callers fire and forget, so said, not thrown; the session stays unread, as the host holds it
      set({ toast: `Could not mark as read: ${errorMessage(e)}` })
      return
    }
    set(
      ifSessionStill(sessionId, (st, cur) => ({
        sessions: { ...st.sessions, [sessionId]: markReadPure(cur, s.lastSeq) },
      })),
    )
  },

  async stopContinue(sessionId) {
    const platform = get().platform
    if (!platform) return
    // The wait goes when the host says so (its `interruption` event): every window hears the same
    await platform.agents.stopContinue(sessionId).catch((e: unknown) => set({ toast: `Could not stop the continue: ${errorMessage(e)}` }))
  },

  async markDone(sessionId) {
    const s = get().sessions[sessionId]
    const platform = get().platform
    if (s?.state !== 'error' || !platform) return get().markRead(sessionId)
    let result: { cleared: boolean; newer: boolean }
    try {
      result = await platform.agents.clearError(sessionId, s.lastSeq)
    } catch (e) {
      set({ toast: `Could not clear the error: ${errorMessage(e)}` })
      return
    }
    // The state is the host's to say: forcing `idle` would wipe a newer card from another window. Only the read mark is ours.
    set(ifSessionStill(sessionId, (st, cur) => ({ sessions: { ...st.sessions, [sessionId]: markReadPure(cur, s.lastSeq) } })))
    // Done that cleared nothing says why, instead of seeming to do nothing
    if (result.newer) set({ toast: 'A newer error arrived. It stays marked' })
  },

  /*
   * An opened app-agent session stays the person's (#378): `markRead` sends nothing when nothing is unread, usual for
   * these, and a run ending before the 3-second read mark would delete it. It sends the host's own position: moves nothing.
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
      // Only the order goes back (#842, `inOrder`), and only while the order shown is still this drag's
      set((st) => ({
        ...(stillInOrder(st.sessions, orderedIds)
          ? { sessions: inOrder(st.sessions, Object.keys(before)) }
          : {}),
        toast: `Could not save order: ${errorMessage(e)}`,
      }))
    }
  },
})

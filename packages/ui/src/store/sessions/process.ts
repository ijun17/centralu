import { errorMessage } from '@cc/protocol/client'
import { isAway } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { ifSessionStill, omitKey } from '../patch.js'
import { trackWorkingSince } from '../sessionList.js'

type ProcessActions = Pick<
  AppState,
  | 'resumeSession'
  | 'wake'
  | 'forkConversation'
  | 'restartSession'
  | 'interrupt'
  | 'stopBackgroundTask'
  | 'clearBackgroundTasks'
  | 'switchTool'
  | 'updateSessionSettings'
>

/** Holds the `resuming` lock on a session while `run` is in flight, however it ends */
async function withResuming(set: StoreSet, sessionId: string, run: () => Promise<void>): Promise<void> {
  set((st) => ({ resuming: { ...st.resuming, [sessionId]: true } }))
  try {
    await run()
  } finally {
    set((st) => ({ resuming: omitKey(st.resuming, sessionId) }))
  }
}

export const processActions = (set: StoreSet, get: StoreGet): ProcessActions => ({
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
      set({ toast: `Could not resume: ${errorMessage(err)}` })
      return false
    }
  },

  /** A failure goes on the session's hint line, not a toast, which would be noise while scanning the list */
  async wake(sessionId) {
    const s = get()
    const session = s.sessions[sessionId]
    const platform = s.platform
    if (!platform || !session || session.live || s.resuming[sessionId]) return
    // A session on a machine that is away is never woken (#82): only its machine's resync does that, once it is back
    if (isAway(session, s.machines)) return

    await withResuming(set, sessionId, async () => {
      try {
        const res = await platform.agents.resumeSession(sessionId)
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
            // A wake's answer writes no line, so its reason is the note's to say
            wakeErrorSaid: omitKey(st.wakeErrorSaid, sessionId),
          })),
        )
      } catch (e) {
        set(
          ifSessionStill(sessionId, (st) => ({
            wakeError: { ...st.wakeError, [sessionId]: errorMessage(e) },
            wakeLocked: omitKey(st.wakeLocked, sessionId),
            wakeErrorSaid: omitKey(st.wakeErrorSaid, sessionId),
          })),
        )
      }
    })
  },

  async forkConversation(sessionId) {
    const s = get()
    const platform = s.platform
    if (!platform || s.resuming[sessionId]) return
    await withResuming(set, sessionId, async () => {
      try {
        const res = await platform.agents.forkConversation(sessionId)
        set(ifSessionStill(sessionId, (st, cur) => ({
          sessions: { ...st.sessions, [sessionId]: { ...cur, live: res.resumed } },
          wakeError: res.resumed
            ? omitKey(st.wakeError, sessionId)
            : { ...st.wakeError, [sessionId]: res.reason ?? '' },
          wakeErrorSaid: omitKey(st.wakeErrorSaid, sessionId),
          // Once forked, it is no longer locked — if it failed, the fork option is left standing
          wakeLocked: res.resumed ? omitKey(st.wakeLocked, sessionId) : st.wakeLocked,
          toast: res.resumed
            ? 'Continuing in a forked conversation — the original is untouched'
            : `Could not fork: ${res.reason ?? 'unknown reason'}`,
        })))
      } catch (e) {
        set({ toast: `Could not fork: ${errorMessage(e)}` })
      }
    })
  },

  /** Replaces only the process: a new session for an unresponsive tool would cut off the context */
  async restartSession(sessionId) {
    const platform = get().platform
    // A second press would kill the process just brought up. One `resuming` lock with `wake` and `fork`: all three say
    // the process is being replaced, so no button looks free while another is mid-flight.
    if (!platform || get().resuming[sessionId]) return false
    set((s) => {
      const sessions = { ...s.sessions, [sessionId]: { ...s.sessions[sessionId]!, state: 'idle' as const } }
      // Restarting ends the running turn, and its clock (#23)
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
          wakeErrorSaid: omitKey(s.wakeErrorSaid, sessionId),
          toast: r.resumed ? 'Agent restarted' : `Could not restart: ${r.reason ?? ''}`,
        })),
      )
      return r.resumed
    } catch (e) {
      // Not thrown: the lock would stay stuck and the button dead
      set({ toast: `Could not restart: ${errorMessage(e)}` })
      return false
    } finally {
      set((s) => ({ resuming: omitKey(s.resuming, sessionId) }))
    }
  },

  async interrupt(sessionId) {
    // "Stopping…" until the session leaves working, or the tool says the Stop has not taken effect (`stopping`)
    set((s) => ({ stopping: { ...s.stopping, [sessionId]: { turn: s.workingSince[sessionId] } } }))
    try {
      await get().platform!.agents.interrupt(sessionId)
    } catch (err) {
      // Said: silence would leave someone believing it stopped
      set((s) => ({ toast: `Could not stop: ${errorMessage(err)}`, stopping: omitKey(s.stopping, sessionId) }))
    }
  },

  async stopBackgroundTask(sessionId, taskId) {
    try {
      await get().platform!.agents.stopBackgroundTask(sessionId, taskId)
    } catch (err) {
      // The same rule as interrupt: a task that did not stop must not look stopped
      set({ toast: `Could not stop the task: ${errorMessage(err)}` })
    }
  },

  async clearBackgroundTasks(sessionId) {
    try {
      await get().platform!.agents.clearBackgroundTasks(sessionId)
    } catch (err) {
      set({ toast: `Could not clear the list: ${errorMessage(err)}` })
    }
  },

  async switchTool(sessionId, tool) {
    const platform = get().platform
    if (!platform) return false
    try {
      const info = await platform.agents.switchTool(sessionId, tool)
      set((s) => ({
        sessions: s.sessions[sessionId]
          ? {
              ...s.sessions,
              [sessionId]: {
                ...s.sessions[sessionId]!,
                tool: info.tool,
                // The host decides the model and its settings (`manager.switchTool`); the menu follows it
                model: info.model,
                effort: info.effort,
                verbosity: info.verbosity,
                serviceTier: info.serviceTier,
                live: false,
              },
            }
          : s.sessions,
      }))
      return true
    } catch (e) {
      set({ toast: `Could not switch the agent: ${errorMessage(e)}` })
      return false
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
      // One wording per setting (#54): a single "Perms:" would say "Perms: normal" after an effort change
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
      // As it happened (#164): a process replaced mid-turn is not announced as "(from next turn)"
      const when =
        info.applied === 'restarted' ? 'agent restarted'
        : info.applied === 'after_turn' ? 'applies when this turn ends'
        : 'from next turn'
      set({ toast: `${changed} (${when})` })
    } catch (e) {
      set({ toast: `Could not change settings: ${errorMessage(e)}` })
    }
  },
})

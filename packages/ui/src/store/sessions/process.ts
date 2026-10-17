import { isAway } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { ifSessionStill, omitKey } from '../patch.js'
import { trackWorkingSince } from '../sessionList.js'

/**
 * A session's agent process: resuming, waking, forking or restarting it, stopping its turn or its
 * background tasks, and switching its tool or settings.
 */

/** The store's actions for a session's agent process */
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
      set({ toast: `Could not resume: ${(err as Error).message}` })
      return false
    }
  },

  /**
   * Wakes a sleeping session ahead of time (the instant it is picked).
   *
   * **A failure leaves its reason behind.** It is not raised as a toast — that would make the screen
   * noisy while someone is scanning through the list. Instead it is written onto that session's own
   * hint line, so whoever is looking can see why it is not resuming.
   */
  async wake(sessionId) {
    const s = get()
    const session = s.sessions[sessionId]
    if (!s.platform || !session || session.live || s.resuming[sessionId]) return
    // A session on a machine that is away is never woken (#82): only its machine's resync does that, once it is back
    if (isAway(session, s.machines)) return

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

  /**
   * Restarts only the agent. The conversation record is left as is; only the process is replaced —
   * creating a new session when a tool goes unresponsive would cut off the context.
   */
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

  async interrupt(sessionId) {
    // "Stopping…" until the session leaves working, or the tool says the Stop has not taken effect (`stopping`)
    set((s) => ({ stopping: { ...s.stopping, [sessionId]: { turn: s.workingSince[sessionId] } } }))
    try {
      await get().platform!.agents.interrupt(sessionId)
    } catch (err) {
      // Silence after failing to stop would leave someone believing it stopped and waiting — the exact kind of failure this project forbids
      set((s) => ({ toast: `Could not stop: ${(err as Error).message}`, stopping: omitKey(s.stopping, sessionId) }))
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
})

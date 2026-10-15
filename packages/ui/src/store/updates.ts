import type { AppState, StoreGet, StoreSet } from './state.js'
import { agentApplyVerdict } from '../features/settings/apply-offer.js'

/**
 * What the host installs and runs: Centralu's own update (checked, applied, and applied at an agent's
 * request, #665) and the agent CLIs' versions (#297).
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

/** The store's actions for updates and the agent CLIs' versions */
type UpdateActions = Pick<
  AppState,
  | 'checkUpdate'
  | 'setUpdateAuto'
  | 'setUpdateAutoApply'
  | 'applyUpdate'
  | 'applyUpdateNow'
  | 'answerApplyRequest'
  | 'runApplyRequest'
  | 'checkAgentVersions'
  | 'setAgentAutoApply'
  | 'applyAgentVersions'
>

export const updateActions = (set: StoreSet, get: StoreGet): UpdateActions => ({
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

  async checkAgentVersions(force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.versions(force) })
    } catch {
      // An older host does not know it: the headers stay quiet rather than the screen breaking
    }
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
})

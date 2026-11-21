import { errorMessage } from '@cc/protocol/client'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { agentApplyVerdict } from '../features/settings/apply-offer.js'
import { typedWithin, TYPING_QUIET_MS } from '../features/settings/typing.js'

/**
 * Tickets for an agent's "Apply now" (#665), by request, kept as the answer's promise: the go can arrive before the
 * reply. One no go came for is forgotten after a while.
 */
const applyTickets = new Map<string, Promise<string | null>>()
const APPLY_TICKET_MS = 5 * 60_000

/** What "Update idle sessions" did (#297) */
export function appliedVersionsText(restarted: number, busy: number): string {
  const sessions = (n: number) => (n === 1 ? '1 session' : `${n} sessions`)
  const keep = busy === 1 ? 'keeps its version' : 'keep their version'
  if (restarted === 0 && busy === 0) return 'Every session already runs the installed version'
  if (restarted === 0) return `Nothing restarted: ${sessions(busy)} busy ${keep} for now`
  const moved = `Restarted ${sessions(restarted)} on the installed version`
  return busy === 0 ? moved : `${moved}; ${busy} busy ${keep} for now`
}

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
  | 'refreshHostRequests'
  | 'answerHostRequest'
  | 'setAgentAutoApply'
  | 'applyAgentVersions'
>

/**
 * Seats an `update` answer only while its host connection stands and no later request's answer is seated (#2155): the
 * checks, an install and the switches ask on their own, and answers come back in any order. `update_status` events
 * need no seat: they are the newest state, ordered with the answers on one connection.
 */
function answerSeat(set: StoreSet, get: StoreGet): () => { stale: () => boolean; seat: (update: AppState['update']) => void } {
  let asked = 0
  let seated = 0
  return () => {
    const { platform, hostResyncs } = get()
    const n = ++asked
    const stale = () => get().platform !== platform || get().hostResyncs !== hostResyncs || n < seated
    return {
      stale,
      seat: (update) => {
        if (stale()) return
        seated = n
        set({ update })
      },
    }
  }
}

/** `ask` numbers each request's answer for this store (`answerSeat`) */
export const updateActions = (set: StoreSet, get: StoreGet, ask = answerSeat(set, get)): UpdateActions => ({
  // Never drawn ahead of the host: "installing" while nothing happens is the worst lie about what cannot be undone.
  // Progress comes as events.
  async checkUpdate(force = true) {
    const platform = get().platform
    if (!platform) return
    const answer = ask()
    try {
      answer.seat(await platform.updates.status(force))
    } catch (e) {
      if (answer.stale()) return
      // A failed check must never break the screen
      set({ toast: `Could not check for updates: ${errorMessage(e)}` })
    }
  },

  async setUpdateAuto(enabled) {
    const platform = get().platform
    if (!platform) return
    const answer = ask()
    try {
      answer.seat(await platform.updates.setAuto(enabled))
    } catch (e) {
      set({ toast: `Could not save that: ${errorMessage(e)}` })
    }
  },

  async setUpdateAutoApply(enabled) {
    const platform = get().platform
    if (!platform) return
    const answer = ask()
    try {
      answer.seat(await platform.updates.setAutoApply(enabled))
    } catch (e) {
      // Say so rather than leave the box ticked
      set({ toast: `Could not save that: ${errorMessage(e)}` })
    }
  },

  async applyUpdate() {
    const platform = get().platform
    if (!platform) return
    const answer = ask()
    try {
      answer.seat(await platform.updates.apply())
    } catch (e) {
      if (answer.stale()) return
      set({ toast: `Could not update: ${errorMessage(e)}` })
    }
  },

  async applyUpdateNow() {
    const relaunch = get().platform?.relaunch
    if (!relaunch) return 'This window cannot relaunch itself.'
    try {
      await relaunch.relaunch()
      return null
    } catch (e) {
      set({ toast: `Could not apply the update: ${errorMessage(e)}` })
      return errorMessage(e)
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

  async runApplyRequest(requestId, ticket, unasked) {
    // Only the window holding this ticket relaunches, and only once: a replayed go finds it gone (#665)
    const mine = applyTickets.get(requestId)
    if (!mine || (await mine) !== ticket || applyTickets.get(requestId) !== mine) return
    applyTickets.delete(requestId)
    const platform = get().platform
    if (!platform) return
    // Checked again at the go, as the shell checks again when the button is pressed: the bundle may have changed since
    const verdict = await agentApplyVerdict(platform.relaunch, get().update)
    if (!verdict.ready) return void (await platform.updates.reportApply({ requestId, ticket, error: verdict.reason }).catch(() => {}))
    // No card stood between the agent and this relaunch (#1509): the window waits out someone typing, as its own automatic apply does
    if (unasked && typedWithin(TYPING_QUIET_MS)) {
      return void (await platform.updates.reportApply({ requestId, ticket, error: 'Someone is typing in Centralu, so nothing was relaunched. Try again in a minute.' }).catch(() => {}))
    }
    // Said and heard first: the host counts this window closing as the relaunch only after it (#665). Unheard (the
    // host mid-swap), the relaunch goes ahead, as the button's would.
    await platform.updates.reportApply({ requestId, ticket, started: true }).catch(() => {})
    const error = await get().applyUpdateNow()
    await platform.updates.reportApply({ requestId, ticket, ...(error ? { error } : {}) }).catch(() => {})
  },

  async refreshHostRequests() {
    const platform = get().platform
    if (!platform) return
    const heard = get().hostRequestsHeard
    try {
      const hostRequests = await platform.requests.list()
      // An event that arrived while the list was on its way is newer than the list: the events have kept it current
      if (get().hostRequestsHeard === heard) set({ hostRequests })
    } catch {
      // A host that did not answer is read again on the next reconnect
    }
  },

  async answerHostRequest(requestId, decision) {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.requests.answer(requestId, decision)
      if (!r.ok) set({ toast: 'That request no longer waits: it was answered in another window, withdrawn by the program, or it expired' })
    } catch (e) {
      set({ toast: errorMessage(e) || 'Could not answer the request' })
    }
    // Whether it landed or not, the list follows the host's
    await get().refreshHostRequests()
  },

  async checkAgentVersions(force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.versions(force) })
    } catch {
      // The headers stay quiet rather than the screen breaking
    }
  },

  async setAgentAutoApply(enabled) {
    const platform = get().platform
    if (!platform) return
    try {
      set({ agentVersions: await platform.agents.setAutoApplyVersions(enabled) })
    } catch (e) {
      set({ toast: `Could not save that: ${errorMessage(e)}` })
    }
  },

  async applyAgentVersions(machine) {
    const platform = get().platform
    if (!platform) return
    try {
      const { restarted, busy } = await platform.agents.applyVersions(machine)
      set({ toast: appliedVersionsText(restarted.length, busy.length) })
    } catch (e) {
      set({ toast: `Could not restart the sessions: ${errorMessage(e)}` })
    }
  },
})

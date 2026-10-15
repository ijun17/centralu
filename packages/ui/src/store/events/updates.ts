import type { NormalizedEvent } from '@cc/protocol'
import type { StoreGet, StoreSet } from '../state.js'

/**
 * The host's updates and the installed agent CLIs: app-wide events, handled before the session
 * guard (`dispatchEvent`). True when the event was one of these.
 */
export function updateEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  if (e.type === 'update_status') {
    set({ update: e.status })
    return true
  }
  // An agent's "Apply now" (#665): app-wide like update_status, so before the session guard too
  if (e.type === 'update_apply_request') {
    void get().answerApplyRequest(e.requestId)
    return true
  }
  if (e.type === 'update_apply_go') {
    void get().runApplyRequest(e.requestId, e.ticket)
    return true
  }
  // App-wide like update_status (#297): the installed agent CLIs, read on the host's own schedule
  if (e.type === 'agent_versions') {
    set({ agentVersions: e.status })
    return true
  }
  return false
}

import type { NormalizedEvent } from '@cc/protocol/client'
import type { StoreGet, StoreSet } from '../state.js'

export function updateEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  if (e.type === 'update_status') {
    set({ update: e.status })
    return true
  }
  // An agent's "Apply now" (#665)
  if (e.type === 'update_apply_request') {
    void get().answerApplyRequest(e.requestId)
    return true
  }
  if (e.type === 'update_apply_go') {
    void get().runApplyRequest(e.requestId, e.ticket, e.unasked === true)
    return true
  }
  // A program's call waiting for the person (#1405)
  if (e.type === 'host_request') {
    const request = e.request
    set((s) => ({ hostRequests: [...s.hostRequests.filter((r) => r.requestId !== request.requestId), request], hostRequestsHeard: s.hostRequestsHeard + 1 }))
    return true
  }
  if (e.type === 'host_request_resolved') {
    set((s) => ({ hostRequests: s.hostRequests.filter((r) => r.requestId !== e.requestId), hostRequestsHeard: s.hostRequestsHeard + 1 }))
    return true
  }
  // The installed agent CLIs, read on the host's own schedule (#297)
  if (e.type === 'agent_versions') {
    set({ agentVersions: e.status })
    return true
  }
  // A tool's install and sign-in, read without asking detect again (#59)
  if (e.type === 'tool_setup') {
    set((s) => ({ toolSetups: { ...s.toolSetups, [e.tool]: e.setup } }))
    return true
  }
  return false
}

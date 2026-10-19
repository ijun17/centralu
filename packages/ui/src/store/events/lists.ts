import type { NormalizedEvent } from '@cc/protocol'
import type { StoreGet, StoreSet } from '../state.js'

/**
 * App-wide lists the host changed (themes, projects, cross-project consents, the orchestrator's
 * proposals): each is read again, or its version bumped for the screen that reads it. Handled before
 * the session guard (`dispatchEvent`). True when the event was one of these.
 */
export function listEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  if (e.type === 'themes_changed') {
    void get().refreshThemes()
    return true
  }

  // The host made a project (#515): the orchestrator's, once approved, or another window's
  if (e.type === 'projects_changed') {
    const refreshed = get().refreshProjects()
    // A folder the person allowed the orchestrator to add (#1220): asked about its trust once, as Add project asks
    const added = e.added
    if (added) {
      void refreshed.then(() => {
        const p = get().projects[added]
        if (p && !p.trusted) set({ trustAsk: added })
      })
    }
    return true
  }

  // A cross-project consent was remembered or revoked (#371) — Settings' list re-reads on the version
  if (e.type === 'project_consents_changed') {
    set((s) => ({ projectConsentsVersion: s.projectConsentsVersion + 1 }))
    return true
  }

  // The host saved a change to a proposal list (#703): both lists are read after the write, whichever tool made it
  if (e.type === 'orchestrator_proposals_changed') {
    void get().refreshMcpProposals()
    void get().refreshSkillProposals()
    return true
  }
  return false
}

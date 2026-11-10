import type { NormalizedEvent } from '@cc/protocol/client'
import type { StoreGet, StoreSet } from '../state.js'
import { rereadFor } from './rereads.js'

/**
 * App-wide lists the host changed (themes, projects, cross-project consents, the Assistant's
 * proposals): each is read again, or its version bumped for the screen that reads it. Handled before
 * the session guard (`dispatchEvent`). True when the event was one of these.
 */
export function listEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  // A list the broadcast says changed is read again (`rereads.ts`): themes, settings, external apps and their questions, proposals
  if (rereadFor(e, get)) return true

  // The host made a project (#515): the Assistant's, once approved, or another window's
  if (e.type === 'projects_changed') {
    const refreshed = get().refreshProjects()
    // A folder the person allowed the Assistant to add (#1220): asked about its trust once, as Add project asks
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
  return false
}

import type { NormalizedEvent } from '@cc/protocol/client'
import type { StoreGet, StoreSet } from '../state.js'

/** A list's read; `e` is the broadcast that asked for it, absent after a gap */
type Read = (get: StoreGet, set: StoreSet, e?: NormalizedEvent) => unknown

// A proposal list saved (#703): both are read, whichever tool made it. A later release names it after the role (#2133)
const proposals = (get: StoreGet) => Promise.all([get().refreshMcpProposals(), get().refreshSkillProposals()])

/**
 * The app-wide lists a broadcast keeps up to date, each with the read that brings it back (#2163). The event's handler runs
 * the read (`rereadFor`), and a reconnect runs every read here (`recoverAfterReconnect`): a broadcast missed while the window
 * was away never comes again, and each list used to join the reconnect by hand after its own missed-broadcast bug (#173,
 * #392, #703, #1306, #1405). A list a new broadcast keeps joins this table once, and both follow.
 */
const READS: Partial<Record<NormalizedEvent['type'], Read>> = {
  themes_changed: (get) => get().refreshThemes(),
  // A setting another window or the Assistant saved (#1306)
  prefs_changed: (get) => get().refreshPrefs(),
  // An external app's slot or state (M4 A-8); what changed is not carried, so the whole list is read
  external_apps_changed: (get) => get().refreshExternalApps(),
  // A capability question created or closed (M4 D-4)
  external_app_questions_changed: (get) => get().refreshAppQuestions(),
  orchestrator_proposals_changed: proposals,
  assistant_proposals_changed: proposals,
  // The host made a project (#515): the Assistant's, once approved, or another window's
  projects_changed: async (get, set, e) => {
    await get().refreshProjects()
    // A folder the person allowed the Assistant to add (#1220): asked about its trust once, as Add project asks
    const added = e?.type === 'projects_changed' ? e.added : undefined
    const p = added ? get().projects[added] : undefined
    if (p && !p.trusted) set({ trustAsk: p.id })
  },
  // A cross-project consent remembered or revoked (#371): Settings' list re-reads on the version
  project_consents_changed: (_get, set) => set((s) => ({ projectConsentsVersion: s.projectConsentsVersion + 1 })),
}

/** Runs the read of a broadcast that names one; true when it did */
export function rereadFor(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  const read = READS[e.type]
  if (!read) return false
  void read(get, set, e)
  return true
}

/**
 * Every list's read once, after a gap in which a broadcast may have been missed. Resolves when the machine list is read:
 * which sessions a reconnect may wake is judged against it (`wakeable`)
 */
export function rereadAll(get: StoreGet, set: StoreSet): Promise<void> {
  for (const read of new Set(Object.values(READS))) void read(get, set)
  // Two lists whose broadcasts carry the change itself, so their handlers read nothing: the requests waiting for the
  // person (`host_request`, #1405), and the links' states (`machine_status`, #82)
  void get().refreshHostRequests()
  return get().refreshMachines()
}

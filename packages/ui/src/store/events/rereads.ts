import type { NormalizedEvent } from '@cc/protocol/client'
import type { StoreGet, StoreSet } from '../state.js'

/** A list's read; `e` is the broadcast that asked for it, absent after a gap */
type Read = (get: StoreGet, set: StoreSet, e?: NormalizedEvent) => unknown

// Both lists, whichever tool saved; a host before #2532 sends `orchestrator_proposals_changed`
const proposals = (get: StoreGet) => Promise.all([get().refreshMcpProposals(), get().refreshSkillProposals()])

/**
 * Each broadcast list's read (#2163): its event runs it (`rereadFor`), and a reconnect runs them all, since a missed
 * broadcast never comes again (docs/state-management.md §7).
 */
const READS: Partial<Record<NormalizedEvent['type'], Read>> = {
  themes_changed: (get) => get().refreshThemes(),
  prefs_changed: (get) => get().refreshPrefs(),
  // What changed is not carried, so the whole list is read
  external_apps_changed: (get) => get().refreshExternalApps(),
  external_app_questions_changed: (get) => get().refreshAppQuestions(),
  orchestrator_proposals_changed: proposals,
  assistant_proposals_changed: proposals,
  projects_changed: async (get, set, e) => {
    await get().refreshProjects()
    // A folder the person let the Assistant add is asked about its trust once, as Add project asks (#1220)
    const added = e?.type === 'projects_changed' ? e.added : undefined
    const p = added ? get().projects[added] : undefined
    if (p && !p.trusted) set({ trustAsk: p.id })
  },
  // Settings' list re-reads on the version
  project_consents_changed: (_get, set) => set((s) => ({ projectConsentsVersion: s.projectConsentsVersion + 1 })),
}

export function rereadFor(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  const read = READS[e.type]
  if (!read) return false
  void read(get, set, e)
  return true
}

// Resolves when the machine list is read: the rows a hub listed from a machine's mirror are recovered against it
export function rereadAll(get: StoreGet, set: StoreSet): Promise<void> {
  for (const read of new Set(Object.values(READS))) void read(get, set)
  // These two broadcasts carry the change itself, so their handlers read nothing
  void get().refreshHostRequests()
  return get().refreshMachines()
}

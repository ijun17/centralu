import type { NormalizedEvent } from '@cc/protocol/client'
import type { StoreGet } from '../state.js'

/**
 * The app-wide lists a broadcast keeps up to date, each with the read that brings it back (#2163). The event's handler runs
 * the read (`listEvent`), and a reconnect runs every read here (`recoverAfterReconnect`): a broadcast missed while the window
 * was away never comes again, and each list used to join the reconnect by hand after its own missed-broadcast bug (#173,
 * #392, #703, #1306, #1405). A list a new broadcast keeps joins this table once, and both follow.
 */
// A proposal list saved (#703): both are read, whichever tool made it. A later release names it after the role (#2133)
const proposals = (get: StoreGet) => Promise.all([get().refreshMcpProposals(), get().refreshSkillProposals()])

const READS = {
  themes_changed: (get: StoreGet) => get().refreshThemes(),
  // A setting another window or the Assistant saved (#1306)
  prefs_changed: (get: StoreGet) => get().refreshPrefs(),
  // An external app's slot or state (M4 A-8); what changed is not carried, so the whole list is read
  external_apps_changed: (get: StoreGet) => get().refreshExternalApps(),
  // A capability question created or closed (M4 D-4)
  external_app_questions_changed: (get: StoreGet) => get().refreshAppQuestions(),
  orchestrator_proposals_changed: proposals,
  assistant_proposals_changed: proposals,
} satisfies Partial<Record<NormalizedEvent['type'], (get: StoreGet) => Promise<unknown>>>

/** Runs the read of a broadcast that names one; true when it did */
export function rereadFor(e: NormalizedEvent, get: StoreGet): boolean {
  const read = (READS as Partial<Record<string, (get: StoreGet) => Promise<unknown>>>)[e.type]
  if (!read) return false
  void read(get)
  return true
}

/** Every list's read once, after a gap in which a broadcast may have been missed */
export function rereadAll(get: StoreGet): void {
  for (const read of new Set(Object.values(READS))) void read(get)
}

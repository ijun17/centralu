import { errorMessage } from '@cc/protocol'

/**
 * The turns a linked hub's update of this machine ended (#1618, docs/agent-host.md §4.8 "Continuing the turns an update
 * cut"). Before it stops this machine's host to update it, the hub reads which sessions are in a turn (`host.activity`'s
 * `inTurn`), and the step that writes the version pointers (`remote-install.mjs`, action `pointers`) writes their ids to
 * this file in the data folder. The next host to start in the folder takes it (`takeUpdateResume`, stopped-mark.ts, which
 * reads the folder's marks): each listed session its start finds cut is continued once, rather than left stopped for
 * someone to continue by hand. A host from before this file ignores it, as today.
 */
export const UPDATE_RESUME_FILE = 'update-resume.json'

/**
 * How old the file may be: an update writes it seconds before the start that reads it. One left by an update whose new
 * host never started (the machine was switched off) names turns long over, which nobody expects to come back.
 */
export const UPDATE_RESUME_MAX_AGE_MS = 10 * 60_000

/** The file, as the start reaches it: its text (null when there is none), and its removal (throws when it cannot) */
export type UpdateResumeFile = { read(): string | null; remove(): void }

/**
 * The ids the file names, read once: the file goes before anything is sent, so a host that starts again after this one
 * continues nothing a second time. Empty when there is none, when it is too old or from a newer format, or unreadable.
 * Never fatal: a file this host cannot read or remove only means no turn is continued for it.
 */
export function takeUpdateResumeFrom(file: UpdateResumeFile, now: number): ReadonlySet<string> {
  const text = file.read()
  if (text === null) return new Set()
  try {
    file.remove()
  } catch (err) {
    // Left there, the next start would continue the same turns again: none is continued
    console.error(`[agent-host] ${UPDATE_RESUME_FILE} could not be removed (${errorMessage(err)}); no turn the update ended is continued`)
    return new Set()
  }
  return parseUpdateResume(text, now)
}

/** The ids of a file's text, by the rules of `takeUpdateResumeFrom` */
export function parseUpdateResume(text: string, now: number): ReadonlySet<string> {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return new Set()
  }
  if (typeof o !== 'object' || o === null) return new Set()
  const at = 'at' in o ? o.at : undefined
  const ids = 'ids' in o ? o.ids : undefined
  if (!('v' in o) || o.v !== 1 || typeof at !== 'number' || !Array.isArray(ids)) return new Set()
  // A clock that went back a little between the write and this start is not a reason to drop it
  if (Math.abs(now - at) > UPDATE_RESUME_MAX_AGE_MS) {
    console.error(`[agent-host] ${UPDATE_RESUME_FILE} was written ${Math.round((now - at) / 60_000)} min from now; the turns it names are not continued`)
    return new Set()
  }
  return new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))
}

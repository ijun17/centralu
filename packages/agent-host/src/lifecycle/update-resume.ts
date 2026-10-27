import { errorMessage } from '@cc/protocol'

/**
 * The turns an update of this machine cut (#1618, docs/agent-host.md §4.8 "Continuing the turns an update cut"). A linked
 * hub that stops this machine's host to update it, roll it back or put the previous version back says so in its stop
 * (`centralu serve --stop` with `CENTRALU_STOP_FOR=update`, `host.stop { forUpdate }`). The stopping host then writes, as it
 * lets its sessions go, the ids of those in a turn (`cutTurns`, idle.ts) into this file in the data folder: the turns it
 * ends itself, on its own clock, with nothing between the reading and the stop, and no link that could drop between them.
 *
 * The next host to start in the folder reads it (`readUpdateResume`): each listed session its start finds cut is kept in
 * its turn and continued once, and its id leaves the file only once that Continue was sent or the turn was reported as
 * lost (`dropFromUpdateResume`). A host that stops before then (a failed check, a rollback, a second update) leaves the
 * rest listed, and adds what it cuts itself. Nothing expires: the file is the next start's, whenever it comes. A host from
 * before this file never writes it and ignores it, as before.
 */
export const UPDATE_RESUME_FILE = 'update-resume.json'

/** At most this many ids are kept: more sessions than this in a turn at once is no machine this was built for */
const MAX_IDS = 1000
const ID = /^[0-9A-Za-z_.:-]{1,200}$/

/** The file, as the hosts reach it: its text (null when there is none), a write that replaces it whole, and its removal */
export type UpdateResumeFile = { read(): string | null; write(text: string): void; remove(): void }

/** The ids a file's text names; none when it is unreadable or from a newer format */
export function parseUpdateResume(text: string | null): string[] {
  if (text === null) return []
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof o !== 'object' || o === null || !('v' in o) || o.v !== 1 || !('ids' in o) || !Array.isArray(o.ids)) return []
  return [...new Set(o.ids.filter((id): id is string => typeof id === 'string' && ID.test(id)))].slice(0, MAX_IDS)
}

const textOf = (ids: readonly string[]) => `${JSON.stringify({ v: 1, ids })}\n`

/**
 * Adds the turns this stop cuts to what the file already lists (#1618): a host that stopped again before it continued the
 * turns an earlier stop cut leaves those listed too, so none is continued zero times. Never fatal: a stop goes on whatever
 * the folder says, and a turn not written here ends as a stop's always did
 */
export function recordUpdateCut(file: UpdateResumeFile, cut: readonly string[]): void {
  try {
    const ids = [...new Set([...parseUpdateResume(file.read()), ...cut.filter((id) => ID.test(id))])].slice(0, MAX_IDS)
    if (ids.length) file.write(textOf(ids))
  } catch (err) {
    console.error(`[agent-host] ${UPDATE_RESUME_FILE} could not be written (${errorMessage(err)}); the turns this update ends are not continued`)
  }
}

/** The ids the next start continues, read without taking them: each leaves the file once it is dealt with */
export function readUpdateResume(file: UpdateResumeFile): ReadonlySet<string> {
  try {
    return new Set(parseUpdateResume(file.read()))
  } catch {
    return new Set()
  }
}

/**
 * One listed turn dealt with: continued, reported as lost, or not found cut. Its id leaves the file, and the file goes with
 * the last one, so a later start continues it no second time. A file this host cannot change is said once, in the log: the
 * next start would find that session at rest, or in a turn of its own, and leaves it alone either way
 */
export function dropFromUpdateResume(file: UpdateResumeFile, id: string): void {
  try {
    const ids = parseUpdateResume(file.read())
    if (!ids.includes(id)) return
    const rest = ids.filter((x) => x !== id)
    if (rest.length) file.write(textOf(rest))
    else file.remove()
  } catch (err) {
    console.error(`[agent-host] ${UPDATE_RESUME_FILE} could not be changed (${errorMessage(err)})`)
  }
}

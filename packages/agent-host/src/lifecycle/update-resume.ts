import { errorMessage } from '@cc/protocol'

/**
 * The turns an update of this machine cut (#1618, docs/agent-host.md §4.8 "Continuing the turns an update cut"). A linked
 * hub that stops this machine's host to update it, roll it back or put the previous version back says so in its stop
 * (`centralu serve --stop` with `CENTRALU_STOP_FOR=update`, `host.stop { forUpdate }`). The stopping host then writes, as it
 * lets its sessions go, the turns it ends (`cutTurns`, idle.ts) into a list of its own in the data folder: on its own
 * clock, with nothing between the reading and the stop, and no link that could drop between them.
 *
 * **Each turn is the one that stop cut, by a mark, not by its session alone** (#1626 review): with each session goes the
 * last row of its conversation as it stood when the stop was done (`seq`). The next host continues a listed session only
 * when its conversation still ends there. Every turn that begins after, under any version, records its input first, so
 * a list left behind (a file a virus scanner held when it was to be removed, a rollback to a host from before this, which
 * never reads it) names a turn long over and continues nothing: a later stop of the person's that cuts a new turn there
 * is told as a quit's, as it always was.
 *
 * **Each stop writes its own list** under a name no other has (`add`), never replacing another's: no rename over a file
 * another process may hold, and no list one stop wrote that a second one could take away. The next host reads all of
 * them (`UpdateResumeLists`) and removes each once every turn it names was dealt with (continued, reported as lost, or
 * not found cut). One it could not remove stays harmless and goes at a later start. A list a host killed mid-write left
 * is not JSON and goes at the next start; one of another format (a newer host's) is left to it. Nothing expires.
 */
export const UPDATE_RESUME_PREFIX = 'update-resume.'

/** At most this many turns are kept from one list: more sessions than this in a turn at once is no machine this was built for */
const MAX_TURNS = 1000
const ID = /^[0-9A-Za-z_.:-]{1,200}$/

/** A turn an update's stop cut: the session, and the last row of its conversation as it stood when the stop was done */
export type CutTurn = { id: string; seq: number }

/** The data folder, as the hosts reach the lists in it: their names, each one's text (null once gone), a new one, a removal */
export type UpdateResumeFolder = {
  names(): string[]
  read(name: string): string | null
  /** Writes a new list under a name no other list has */
  add(text: string): void
  remove(name: string): void
}

/** The turns a list's text names; `torn` when it is not JSON (a host killed while it wrote), `other` for another format */
export function parseUpdateResume(text: string): CutTurn[] | 'torn' | 'other' {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return 'torn'
  }
  if (typeof o !== 'object' || o === null || !('v' in o) || o.v !== 1 || !('turns' in o) || !Array.isArray(o.turns)) return 'other'
  const turns: CutTurn[] = []
  for (const t of o.turns as unknown[]) {
    if (typeof t !== 'object' || t === null || !('id' in t) || !('seq' in t)) continue
    if (typeof t.id === 'string' && ID.test(t.id) && typeof t.seq === 'number' && Number.isSafeInteger(t.seq) && t.seq >= 0) turns.push({ id: t.id, seq: t.seq })
  }
  return turns.slice(0, MAX_TURNS)
}

/**
 * Writes the turns this stop cut, as a list of its own (#1618). Never fatal: a stop goes on whatever the folder says. A
 * list that cannot be written is said in the log with the folder's own error, and those turns end as a stop's always did:
 * the next start marks them stopped, with their Continue, and tells whoever waits on them
 */
export function recordUpdateCut(folder: UpdateResumeFolder, cut: readonly CutTurn[]): void {
  const turns = cut.filter((t) => ID.test(t.id)).slice(0, MAX_TURNS)
  if (!turns.length) return
  try {
    folder.add(`${JSON.stringify({ v: 1, turns })}\n`)
  } catch (err) {
    console.error(`[agent-host] the turns this update ends could not be listed for the next start (${errorMessage(err)}); they end as a stop's do`)
  }
}

/**
 * The lists the stops before this start left, read once at the start (#1618), without taking them: each goes once every
 * turn it names was dealt with (`done`), so a host stopped before then leaves the rest for the next
 */
export class UpdateResumeLists {
  /** Each list's name and the turns it names, as read at the start */
  private readonly lists = new Map<string, CutTurn[]>()
  private readonly dealt = new Set<string>()

  constructor(private readonly folder: UpdateResumeFolder) {
    let names: string[]
    try {
      names = folder.names()
    } catch (err) {
      console.error(`[agent-host] the turns an update ended could not be read (${errorMessage(err)}); none is continued`)
      return
    }
    for (const name of names) {
      let text: string | null
      try {
        text = folder.read(name)
      } catch (err) {
        console.error(`[agent-host] ${name} could not be read (${errorMessage(err)}); the turns it names are not continued`)
        continue
      }
      if (text === null) continue
      const turns = parseUpdateResume(text)
      if (turns === 'other') continue
      if (turns === 'torn') this.removeList(name)
      else this.lists.set(name, turns)
    }
  }

  /** The sessions the lists name */
  ids(): Set<string> {
    return new Set([...this.lists.values()].flat().map((t) => t.id))
  }

  /** Whether a stop listed this session's turn as the one it cut: its conversation still ends where it ended then */
  cut(id: string, lastSeq: number): boolean {
    return [...this.lists.values()].some((turns) => turns.some((t) => t.id === id && t.seq === lastSeq))
  }

  /**
   * One listed session dealt with: continued, reported as lost, or not found cut. Each list all of whose sessions are
   * dealt with goes. One that cannot be removed is said in the log and stays harmless: the turn it names is over, so
   * its mark no longer matches, and a later start removes it
   */
  done(id: string): void {
    this.dealt.add(id)
    for (const [name, turns] of this.lists) {
      if (!turns.some((t) => t.id === id) || !turns.every((t) => this.dealt.has(t.id))) continue
      this.lists.delete(name)
      this.removeList(name)
    }
  }

  private removeList(name: string): void {
    try {
      this.folder.remove(name)
    } catch (err) {
      console.error(`[agent-host] ${name} could not be removed (${errorMessage(err)}); the turns it names are over, and a later start removes it`)
    }
  }
}

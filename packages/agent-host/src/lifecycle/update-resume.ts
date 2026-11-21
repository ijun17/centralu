import { errorMessage } from '@cc/protocol'
import { sleepSync } from '../timing.js'
import { held } from '../os/real.js'
import { ENDED_MAX_AGE_MS, readEnded, type Ended } from './update-ended.js'
import { readStopped, type Stopped } from './update-stopped.js'

/**
 * The turns an update of this machine cut (docs/agent-host/lifecycle/continue-after-update.md "Continuing the turns an update
 * cut"). A linked hub that stops this host for an update, a rollback or the previous version says so (`CENTRALU_STOP_FOR=update`); the stopping host writes the
 * turns it ends (`cutTurns`) into a list of its own in the data folder, on its own clock: no link can drop between the reading
 * and the stop. **Each turn is the one that stop cut, by a mark:** with each session goes the last row of its conversation
 * (`seq`), and the next host continues a listed session only when its conversation still ends there. The mark is safe because
 * every next start writes a row for a listed session (the Continue's line or the stopped mark, an older host's too), not
 * because a turn records its input first (a CLI turn after a background task, and a compaction, begin with none), so a list
 * left behind (held by a scanner, or a rollback's) names a turn long over: nothing continues; turn lists never expire by age.
 * `stopped` rides under the same mark; an older host reads `turns` only. **Each stop writes its own list** under a name no
 * other has (`add`), so no rename goes over a file another process may hold and no list can be taken away by a second stop.
 */
export const UPDATE_RESUME_PREFIX = 'update-resume.'

/** At most this many turns are kept from one list: more sessions than this in a turn at once is no machine this was built for */
const MAX_TURNS = 1000
const ID = /^[0-9A-Za-z_.:-]{1,200}$/

/**
 * A turn an update's stop cut: the session, and the last row of its conversation when the stop was done. `woken`: a turn an
 * update's start continued that had not answered yet, which may read at rest (`cutTurns`); an older build reads `id` and `seq`
 * alone and does not continue it
 */
export type CutTurn = { id: string; seq: number; woken?: true }

/** What one stop lists: the turns it cut, and what else it ended in sessions (#1902) */
export type UpdateStop = { turns: CutTurn[]; stopped: Stopped[]; ended: Ended; /** When the stop wrote it (ms), 0 when the list does not say */ at: number }

/** The data folder, as the hosts reach the lists in it: their names, each one's text (null once gone), a new one, a removal */
export type UpdateResumeFolder = {
  names(): string[]
  read(name: string): string | null
  /** Writes a new list under a name no other list has */
  add(text: string): void
  /** Writes a list again under its own name in one step: a host killed meanwhile leaves the old text or the new, never neither. Throws when it could not, the old text left */
  replace(name: string, text: string): void
  remove(name: string): void
}

/** The turns a list's text names; `torn` when it is not JSON (a host killed while it wrote), `other` for another format */
export function parseUpdateResume(text: string): UpdateStop | 'torn' | 'other' {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return 'torn'
  }
  if (typeof o !== 'object' || o === null || !('v' in o) || o.v !== 1 || !('turns' in o) || !Array.isArray(o.turns)) return 'other'
  const turns: CutTurn[] = []
  const listed: unknown[] = o.turns
  for (const t of listed) {
    if (typeof t !== 'object' || t === null || !('id' in t) || !('seq' in t)) continue
    if (typeof t.id === 'string' && ID.test(t.id) && typeof t.seq === 'number' && Number.isSafeInteger(t.seq) && t.seq >= 0) {
      turns.push({ id: t.id, seq: t.seq, ...('woken' in t && t.woken === true ? { woken: true as const } : {}) })
    }
  }
  const listedStopped: unknown[] = 'stopped' in o && Array.isArray(o.stopped) ? o.stopped : []
  const stopped = listedStopped.map(readStopped).filter((x): x is Stopped => x !== null && ID.test(x.id))
  return { turns: turns.slice(0, MAX_TURNS), stopped: stopped.slice(0, MAX_TURNS), ended: readEnded(o), at: 'at' in o && typeof o.at === 'number' ? o.at : 0 }
}

/**
 * Writes the turns this stop cut, as a list of its own. Never fatal: a stop goes on whatever the folder says. One that cannot
 * be written is said in the log with the folder's own error, and those turns end as a quit's do: the next start marks them
 * stopped, with their Continue, and tells whoever waits on them
 */
export function recordUpdateCut(folder: UpdateResumeFolder, cut: readonly CutTurn[], ended: readonly Stopped[] = []): void {
  const turns = cut.filter((t) => ID.test(t.id)).slice(0, MAX_TURNS)
  const stopped = ended.filter((x) => ID.test(x.id)).slice(0, MAX_TURNS)
  if (!turns.length && !stopped.length) return
  try {
    folder.add(listText(turns, stopped))
  } catch (err) {
    console.error(`[agent-host] the turns this update ends could not be listed for the next start (${errorMessage(err)}); they end as a stop's do`)
  }
}

/** A list of turns and what else a stop ended, as written */
const listText = (turns: readonly CutTurn[], stopped: readonly Stopped[]): string => `${JSON.stringify({ v: 1, turns, stopped })}\n`

/**
 * Writes the terminals and Run commands this stop ends, as a list of its own. Never fatal, as `recordUpdateCut` is: they are
 * then simply lost
 */
export function recordUpdateEnded(folder: UpdateResumeFolder, ended: Ended, now = Date.now()): void {
  if (!ended.terminals.length && !ended.runs.length) return
  try {
    folder.add(`${JSON.stringify({ v: 1, turns: [], stopped: [], at: now, ...ended })}
`)
  } catch (err) {
    console.error(`[agent-host] the terminals and commands this update ends could not be listed for the next start (${errorMessage(err)}); they end as a stop's do`)
  }
}

/**
 * The lists the stops before this start left, read once at the start without taking them: each goes once every turn it names
 * was dealt with (`done`), so a host stopped before then leaves the rest for the next
 */
export class UpdateResumeLists {
  /** Each list's name and the turns it names, as read at the start */
  private readonly lists = new Map<string, UpdateStop>()
  private readonly dealt = new Set<string>()

  /**
   * `wait` sleeps between the tries at a list a scanner holds on Windows (`os/held.ts`); the host's own start is one thread
   * with nothing yet to serve, so it blocks. Tests pass their own
   */
  constructor(
    private readonly folder: UpdateResumeFolder,
    wait: (ms: number) => void = sleepSync,
  ) {
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
        text = held(() => folder.read(name), wait, (err) => console.error(`[agent-host] ${name} is held by another process (${errorMessage(err)}); reading it again`))
      } catch (err) {
        /*
         * Still held after the tries, or unreadable otherwise: the list stays for a later start. The host cannot tell which
         * sessions it names, so a session it finds cut now is marked stopped like any a quit cut, and its Continue is the
         * person's button
         */
        console.error(`[agent-host] ${name} could not be read (${errorMessage(err)}); the list is kept for a later start, and the turns it names end as a quit's do`)
        continue
      }
      if (text === null) continue
      const turns = parseUpdateResume(text)
      // Another format is a newer host's list: left for it
      if (turns === 'other') continue
      if (turns === 'torn') this.removeList(name, 'it is not read, and a later start removes it')
      // One written empty because it could not be removed (`done`) goes now
      else if (!turns.turns.length && !turns.stopped.length && !turns.ended.terminals.length && !turns.ended.runs.length) this.removeList(name, 'it names nothing, and a later start removes it')
      else this.lists.set(name, turns)
    }
  }

  /** The sessions the lists name */
  ids(): Set<string> {
    return new Set([...this.lists.values()].flatMap((l) => [...l.turns, ...l.stopped]).map((t) => t.id))
  }

  /**
   * Whether a stop listed this session's turn as the one it cut: its conversation still ends where it did then. A session at
   * rest (`atRest`) counts only by a `woken` entry: any other was stopped by the person after that stop listed it (a Stop
   * writes no row)
   */
  cut(id: string, lastSeq: number, atRest = false): boolean {
    return [...this.lists.values()].some((l) => l.turns.some((t) => t.id === id && t.seq === lastSeq && (!atRest || t.woken === true)))
  }

  /**
   * The terminals and Run commands the stops listed, once. Each list is removed before anything in it is brought back, and one
   * that cannot be removed is left alone: it would reopen them at every start. A list older than `ENDED_MAX_AGE_MS` is removed
   * unused: a rollback to an older host never removes it, and a start days later must not open terminals and run commands
   * nobody expects
   */
  takeEnded(now = Date.now()): Ended {
    const taken: Ended = { terminals: [], runs: [] }
    for (const [name, l] of [...this.lists]) {
      if (!l.ended.terminals.length && !l.ended.runs.length) continue
      this.lists.delete(name)
      if (!this.removeList(name, 'it is not used at this start, and a later start tries again')) continue
      if (now - l.at > ENDED_MAX_AGE_MS) {
        console.error(`[agent-host] ${name}: the terminals and commands an update ended are not brought back, the list is too old`)
        continue
      }
      taken.terminals.push(...l.ended.terminals)
      taken.runs.push(...l.ended.runs)
    }
    return taken
  }

  /** What a stop ended in this session besides a turn (#1902), when its conversation still ends where it did then: the same mark */
  stoppedOf(id: string, lastSeq: number): Stopped | null {
    for (const l of this.lists.values()) {
      const x = l.stopped.find((s) => s.id === id && s.seq === lastSeq)
      if (x) return x
    }
    return null
  }

  /**
   * One listed session dealt with: continued, reported as lost, dropped (the person's Stop, gone) or not found cut. It leaves
   * every list that names it, on disk too: a mark alone does not make a dealt entry harmless, since the person's Stop writes no
   * row and a `woken` entry would still match a session at rest. The list is rewritten without it in one step (`replace`); a
   * host killed before that step is like a Stop still on its way: not taken; one naming nothing more goes, or is written empty
   * if it cannot be removed. A list that cannot be rewritten keeps its old text, said in the log, unless the entry is `strict`
   * (it no longer stands): then the whole list goes, its other entries ending as a quit's do, since a Stop already taken must
   * not be undone by the next start
   */
  done(id: string, strict = false): void {
    this.dealt.add(id)
    for (const [name, l] of [...this.lists]) {
      if (![...l.turns, ...l.stopped].some((t) => t.id === id)) continue
      const turns = l.turns.filter((t) => !this.dealt.has(t.id))
      const stopped = l.stopped.filter((t) => !this.dealt.has(t.id))
      if (!turns.length && !stopped.length && this.removeList(name, 'it is written empty instead')) {
        this.lists.delete(name)
        continue
      }
      try {
        this.folder.replace(name, listText(turns, stopped))
        this.lists.set(name, { ...l, turns, stopped })
      } catch (err) {
        if (!strict) {
          console.error(`[agent-host] ${name} could not be written again without ${id.slice(0, 8)} (${errorMessage(err)}); it still names it, for a later start`)
          continue
        }
        console.error(`[agent-host] ${name} could not be written again without ${id.slice(0, 8)} (${errorMessage(err)}); it goes whole, and the turns it names end as a quit's do`)
        this.lists.delete(name)
        this.removeList(name, `a later start may continue ${id.slice(0, 8)}, which was stopped`)
      }
    }
  }

  /** Whether the list is gone; one that is not is said in the log with what that means */
  private removeList(name: string, then: string): boolean {
    try {
      this.folder.remove(name)
      return true
    } catch (err) {
      console.error(`[agent-host] ${name} could not be removed (${errorMessage(err)}); ${then}`)
      return false
    }
  }
}

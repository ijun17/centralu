import { isAssistantKind, isInTurn, oneLineText, pausedOnBackground, type BackgroundTask, type DirectoryEntry } from '@cc/protocol'

/**
 * Finding the recipient across machines (#2067 item 3, docs/plans/linked-mail.md §8): one directory of sessions, this
 * host's and those it reaches over its links, searched by words and answered in few lines a model reads cheaply.
 *
 * The directory is what the host already lists, never a second record: its own sessions (`listSessions`), on a hub each
 * linked machine's from the mirror it keeps (`LinkedMachine.lastKnown`), and on a machine each hub's answer to
 * `hub.find`. The ranking is one function, so every side ranks alike and a machine merges a hub's answer with its own.
 */

/** The most sessions one answer lists: the answer's size stays the same however many sessions there are */
export const FIND_LIMIT = 8

/** The most computers an answer names one by one as not searched; the rest are counted on one line */
export const AWAY_LIMIT = 3

/** A directory entry with the machine it came from on a hub (its link's id), which a hub leaves out of that machine's own search */
export type FoundEntry = DirectoryEntry & { machineId?: string }

/** What a session of a host is to a sender, in one word a search can name */
export function roleOf(s: { kind: string; askedBy?: string | null | undefined; startedFromHub?: boolean | undefined }): string {
  if (isAssistantKind(s.kind)) return 'assistant'
  if (s.kind === 'coordinator') return 'coordinator'
  return s.askedBy || s.startedFromHub ? 'child' : 'session'
}

/**
 * A session as the directory lists it. One paused on its own background work (#2146) is busy, and says `paused`: its
 * turn ended, but it is not at rest
 */
export function entryOf(
  s: {
    id: string
    name: string
    kind: string
    state: string
    askedBy?: string | null | undefined
    startedFromHub?: boolean | undefined
    waitingSince?: number | null | undefined
    createdAt: number
    backgroundTasks?: readonly BackgroundTask[] | undefined
    interruption?: unknown
  },
  o: { address: string; project: string | null; machine: string | null; machineId?: string },
): FoundEntry {
  return {
    address: o.address,
    name: oneLineText(s.name, 120),
    project: o.project === null ? null : oneLineText(o.project, 80),
    machine: o.machine === null ? null : oneLineText(o.machine, 80),
    role: roleOf(s),
    state: pausedOnBackground(s) ? 'paused' : oneLineText(s.state, 30),
    busy: isInTurn(s.state) || pausedOnBackground(s),
    at: Math.max(s.waitingSince ?? 0, s.createdAt),
    ...(o.machineId ? { machineId: o.machineId } : {}),
  }
}

const wordsOf = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * How well an entry matches the words, or null when one word matches nothing: a word in the name counts most, then in the
 * project, the machine, and the role or state. The whole query as the exact name counts above all
 */
export function scoreOf(e: DirectoryEntry, query: string): number | null {
  const words = wordsOf(query)
  const name = e.name.toLowerCase()
  let score = name === query.trim().toLowerCase() && words.length > 0 ? 100 : 0
  for (const w of words) {
    const s = name.includes(w) ? 8 : (e.project ?? '').toLowerCase().includes(w) ? 4 : (e.machine ?? '').toLowerCase().includes(w) ? 3 : e.role === w || e.state.toLowerCase().includes(w) ? 2 : 0
    if (s === 0) return null
    score += s
  }
  return score
}

/** The entries that match, best first: by score, then at work now, then the most recently waiting or started */
export function ranked(entries: readonly FoundEntry[], query: string): FoundEntry[] {
  return entries
    .flatMap((e) => {
      const score = scoreOf(e, query)
      return score === null ? [] : [{ e, score }]
    })
    .sort((a, b) => b.score - a.score || Number(b.e.busy) - Number(a.e.busy) || b.e.at - a.e.at || a.e.address.localeCompare(b.e.address))
    .map((x) => x.e)
}

/** The entries whose name is `name` exactly, in any case: what `mail send` with a name resolves across machines */
export function named(entries: readonly FoundEntry[], name: string): FoundEntry[] {
  const n = name.trim().toLowerCase()
  return entries.filter((e) => e.name.trim().toLowerCase() === n)
}

/**
 * One entry on one line: the address to mail, the name, and what tells it apart. Each part is cut short, so a line stays
 * the same size whatever a session or project is called: the address, which is what a sender mails, is never cut
 */
export function entryLine(e: DirectoryEntry): string {
  return [`${oneLineText(e.address, 120)} ${JSON.stringify(oneLineText(e.name, 40))}`, e.project === null ? 'no project' : oneLineText(e.project, 30), ...(e.machine ? [`on ${oneLineText(e.machine, 30)}`] : []), oneLineText(e.role, 12), oneLineText(e.state, 20)].join(' · ')
}

/**
 * The answer to `mail find`: at most `FIND_LIMIT` lines, how many matched of how many, a hint to narrow when there are
 * more, and the computers that could not be searched with why, at most `AWAY_LIMIT` and a count of the rest
 */
export function findAnswer(o: { query: string; found: readonly DirectoryEntry[]; matched: number; total: number; away: readonly { name: string; why: string }[] }): string {
  const q = oneLineText(o.query, 80)
  const shown = o.found.slice(0, FIND_LIMIT)
  const head =
    o.matched === 0
      ? `No session matches ${JSON.stringify(q)} among ${o.total}.${o.total > 0 ? ' Try fewer words, or a project, a machine or a role.' : ''}`
      : q === ''
        ? `The ${shown.length} most recently active of ${o.total} sessions. Mail one by its address.`
        : `${o.matched} of ${o.total} sessions match ${JSON.stringify(q)}. Mail one by its address.`
  const more = o.matched - shown.length
  return [
    head,
    ...shown.map(entryLine),
    ...(more > 0 ? [`${more} more: add a word (a project, a machine or a role) to narrow it.`] : []),
    ...o.away.slice(0, AWAY_LIMIT).map((a) => `Not searched: ${oneLineText(a.name, 30)} (${oneLineText(a.why, 60)}).`),
    ...(o.away.length > AWAY_LIMIT ? [`Not searched either: ${o.away.length - AWAY_LIMIT} more computers.`] : []),
  ].join('\n')
}

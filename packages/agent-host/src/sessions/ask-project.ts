import { frameField, oneLineText } from '@cc/protocol'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { canonicalPath, isInside } from '../dev-services/path-guard.js'
import type { MessageReader } from './transcript-view.js'
import { turnAnswer, turnAnswerSeq } from './turn-answer.js'

/**
 * ask_project (#371 part B) — what a session in one project gets back when it asks another project to do something.
 *
 * Selecting the existing session, the consent and the wait are the manager's (`SessionManager.askProject`). What
 * lives here is the pure part around it: the frame the task travels in, the cut of a long answer, which paths the
 * answer names and which of them the caller may read.
 */

/**
 * How long one ask_project call waits for the delegated turn before it answers "still working".
 *
 * Under Codex's own ceiling for an MCP call (`tool_timeout_sec`, 300 s, set by the adapter) with the same margin as
 * an app's long call (`APP_CALL_WAIT_MS`), so "still working" reaches the model before Codex cuts the call. Claude
 * uses the same bound: one rule for both callers, and a model that calls again every four minutes costs a few
 * tokens, while a call that hangs past an unknown ceiling costs the answer.
 */
export const ASK_WAIT_MS = 240_000

/** How much of a linked machine's last message is read for an answer (#700, #1038); `clipAnswer` then cuts it to the usual size */
export const ANSWER_READ_MAX_CHARS = 100_000

/** The longest answer handed back whole. Past it, the head and the tail are kept: a report puts its findings first and the paths last */
export const ANSWER_MAX_CHARS = 6000
const ANSWER_HEAD_CHARS = 4500
const ANSWER_TAIL_CHARS = 1200

/**
 * The task as one line on the consent card: the card asks "Let A ask B to <this>?". Past `max` characters it says how
 * much there is in all (#838), as `handoff_session`'s card does: a card that showed 160 characters of a longer task
 * looked like the whole of it, and what followed went unread.
 */
export function taskLine(task: string, max = 160): string {
  const flat = oneLineText(task)
  return flat.length > max ? `${flat.slice(0, max)}… (cut here; ${flat.length} characters in all)` : flat
}

/**
 * The message the delegated session receives. It says who asks and how the answer travels back, because the
 * delegated session cannot see the caller: its final text is all the caller will read, and a file it does not name
 * by its absolute path is a file the caller cannot find.
 *
 * `asker` (#1186): which session asks, by its name and id, so the receiver can tell two asks from one project apart and
 * name the asker to the person. It said the project only, though the store and the screen had the session all along.
 * A name is one line (`frameField`) written as a JSON string (#1186 review), so a `"` or a `\` in it cannot close the
 * quote and go on as Centralu's words on the frame's line.
 */
export function askFrame(callerProject: string, task: string, asker?: { name: string; sessionId?: string }): string {
  const who = asker ? ` It is the session ${JSON.stringify(frameField(asker.name))}${asker.sessionId ? ` [${asker.sessionId}]` : ''}.` : ''
  return [
    `[A session in the project "${frameField(callerProject)}" asks this project, through Centralu's ask_project.${who} ` +
      'Your final message goes back to it as the answer: keep it short, and name every file it should read by its absolute path.]',
    '',
    task,
  ].join('\n')
}

/**
 * A project ask_project may name: one of this computer's (`machine` null) or one on a linked machine (#700), whose `id`
 * is machine-qualified (`<machine id>.<project id>`) as everywhere the hub names a remote id.
 */
export type AskableProject = { id: string; name: string; machine: string | null; machineId: string | null }

/** How a project is told apart from one of the same name, in a refusal: `cc [m1.p-1] on Remote box` */
export function projectChoice(p: AskableProject): string {
  return `${p.name} [${p.id}] on ${p.machine ?? 'this computer'}`
}

/**
 * The projects a name, an id or a machine-qualified name points at (#700). The first of these that finds anything wins:
 *
 *   1. the id (a qualified id for a linked machine's project, which is always unambiguous)
 *   2. the name as written
 *   3. `<machine>/<name>`, the machine by its id or the name the person gave it, case aside
 *   4. the name, case aside
 *
 * One project per machine counts (unless `everyOne`, for the caller that refuses two of one name on this computer): two projects of one name on this computer were never refused (the first is taken), and
 * a machine's two are no different. What is left is more than one only when the same name is on two machines, and the
 * caller then refuses and lists them, because guessing would send the work to the wrong disk.
 */
export function matchProjects(asked: string, projects: readonly AskableProject[], o: { everyOne?: boolean } = {}): AskableProject[] {
  const wanted = asked.trim()
  const firstPerMachine = (found: AskableProject[]): AskableProject[] => {
    if (o.everyOne) return found
    const seen = new Set<string | null>()
    return found.filter((p) => !seen.has(p.machineId) && !!seen.add(p.machineId))
  }
  const tiers: (() => AskableProject[])[] = [
    () => projects.filter((p) => p.id === wanted),
    () => projects.filter((p) => p.name === wanted),
    () => {
      const slash = wanted.indexOf('/')
      if (slash <= 0) return []
      const machine = wanted.slice(0, slash).trim().toLowerCase()
      const name = wanted.slice(slash + 1).trim()
      const there = projects.filter((p) => p.machineId !== null && (p.machineId === machine || p.machine?.toLowerCase() === machine))
      return there.some((p) => p.name === name) ? there.filter((p) => p.name === name) : there.filter((p) => p.name.toLowerCase() === name.toLowerCase())
    },
    () => projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase()),
  ]
  for (const tier of tiers) {
    const found = firstPerMachine(tier())
    if (found.length) return found
  }
  return []
}

/** Where a turn's answer starts in its session (`answerAt`): the read that finds what a cut left out (#1186) */
export type AnswerAt = { sessionId: string; seq: number }

/**
 * A long answer cut in the middle, with where the whole of it is. With `at`, the cut names the read that shows what it
 * left out (#1186): read_session from the answer's first message, at the character the cut starts. It used to send
 * the caller to the session by name only, and read_session cut the same answer again at 2,000 characters, so the
 * middle could not be read back at all. Without `at` (a session this caller cannot read, such as a hub's), the session
 * is named as before.
 */
export function clipAnswer(answer: string, sessionName: string, at?: AnswerAt): string {
  if (answer.length <= ANSWER_MAX_CHARS) return answer
  const cut = answer.length - ANSWER_HEAD_CHARS - ANSWER_TAIL_CHARS
  const where = at
    ? `read them with read_session(sessionId="${at.sessionId}", around=${at.seq}, offset=${ANSWER_HEAD_CHARS})`
    : `the whole answer is in the session "${sessionName}"`
  return answer.slice(0, ANSWER_HEAD_CHARS) + `
…[${cut} characters cut here; ${where}]…
` + answer.slice(-ANSWER_TAIL_CHARS)
}

/**
 * Where `answer` starts in the session's record, when it is that session's last answer (`turnAnswer` over the same
 * rows); undefined otherwise, as when a later turn has answered since
 */
export function answerAt(reader: MessageReader, sessionId: string, answer: string): AnswerAt | undefined {
  const rows = reader.loadMessages(sessionId, 50)
  const seq = turnAnswerSeq(rows)
  return seq !== null && answer && turnAnswer(rows) === answer ? { sessionId, seq } : undefined
}

/**
 * The absolute paths an answer names — POSIX (`/a/b`, `~/a` is not one: the caller would have to guess whose home)
 * and Windows (`C:\a\b`). Quotes, backticks, brackets and trailing punctuation around a path are not part of it.
 * Duplicates are dropped, first mention first.
 */
export function pathsIn(answer: string): string[] {
  const found: string[] = []
  const re = /(?:^|[\s"'`(<[])((?:\/|[A-Za-z]:\\)[^\s"'`)>\]]+)/g
  for (const m of answer.matchAll(re)) {
    const p = m[1]!.replace(/[.,;:!?]+$/, '')
    // A lone "/" or a drive root names nothing to read
    if (p === '/' || /^[A-Za-z]:\\?$/.test(p)) continue
    if (!found.includes(p)) found.push(p)
  }
  return found
}

/** The real path of what exists, in its real spelling (`realpathSync.native`, as `canonicalPath`), or null */
function real(p: string): string | null {
  try {
    return realpathSync.native(p)
  } catch {
    return null
  }
}

/**
 * Which of the named paths the caller may read: each one that exists **inside the target project's folder**, resolved
 * through symlinks on both sides, so a link in the project cannot open a folder outside it.
 *
 *   a file       that file only
 *   a folder     that folder (an output folder the delegated session names as a whole)
 *   outside      not granted — still listed to the caller, whose own permissions then decide (Claude asks the
 *                person before reading outside its folder; Codex does not restrict reads)
 *
 * The project's own root is never granted as a folder: naming it would open the whole project, which is broader
 * than any output. A file directly in the root is still granted as that file.
 */
export function readableGrants(paths: readonly string[], projectRoot: string): { granted: string[]; outside: string[] } {
  const root = real(projectRoot)
  const granted: string[] = []
  const outside: string[] = []
  for (const p of paths) {
    const r = real(p)
    if (!root || !r || !isInside(root, r)) {
      outside.push(p)
      continue
    }
    let dir = false
    try {
      dir = statSync(r).isDirectory()
    } catch {
      outside.push(p)
      continue
    }
    if (dir && r === root) {
      outside.push(p)
      continue
    }
    if (!granted.includes(r)) granted.push(r)
  }
  return { granted, outside }
}

/**
 * Whether a path falls under one of the grants — a granted file exactly, or anything under a granted folder. The
 * path is resolved through symlinks first (when it exists), the same as the grants were.
 */
export function underGrant(path: string, grants: Iterable<string>, cwd: string): boolean {
  // Canonical as the grants are, so a short name, another case or a link to the root reads the same path (#428)
  const r = canonicalPath(resolve(cwd, path))
  /*
   * A grant is compared as it was made: canonical then (`readableGrants`), never resolved again here. Resolved at read
   * time it would follow a link the target put in its place since, and open wherever that link points
   */
  for (const g of grants) if (isInside(g, r)) return true
  return false
}

/**
 * Of the machines a lookup could not ask, those a missing `wanted` may be on: all, for a bare name, but only the machine
 * a qualified name (`<machine>/<name>`, or an id that starts with a machine's) is qualified with, so that a name for a
 * machine that is up does not talk of another that is down. `known`: every machine the lookup saw, up or not
 */
export function awayFor<A extends { machine: string; machineId: string }>(wanted: string, away: readonly A[], known: readonly string[]): A[] {
  const slash = wanted.indexOf('/')
  const prefix = slash > 0 ? wanted.slice(0, slash).trim().toLowerCase() : null
  const byId = [...known, ...away.map((a) => a.machineId)].some((id) => wanted.startsWith(`${id}.`))
  if (prefix === null && !byId) return [...away]
  return away.filter((a) => a.machineId === prefix || a.machine.toLowerCase() === prefix || wanted.startsWith(`${a.machineId}.`))
}

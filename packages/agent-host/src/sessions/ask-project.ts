import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * ask_project (#371 part B) — what a session in one project gets back when it asks another project to do something.
 *
 * Standing the delegated session up, the consent and the wait are the manager's (`SessionManager.askProject`). What
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

/** The longest answer handed back whole. Past it, the head and the tail are kept: a report puts its findings first and the paths last */
export const ANSWER_MAX_CHARS = 6000
const ANSWER_HEAD_CHARS = 4500
const ANSWER_TAIL_CHARS = 1200

/** The task as one line on the consent card: the card asks "Let A ask B to <this>?" */
export function taskLine(task: string, max = 160): string {
  const one = task.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * The message the delegated session receives. It says who asks and how the answer travels back, because the
 * delegated session cannot see the caller: its final text is all the caller will read, and a file it does not name
 * by its absolute path is a file the caller cannot find.
 */
export function askFrame(callerProject: string, task: string): string {
  return [
    `[A session in the project "${callerProject}" asks this project, through Centralu's ask_project. ` +
      'Your final message goes back to it as the answer: keep it short, and name every file it should read by its absolute path.]',
    '',
    task,
  ].join('\n')
}

/** A long answer cut in the middle, with the session that holds the whole of it */
export function clipAnswer(answer: string, sessionName: string): string {
  if (answer.length <= ANSWER_MAX_CHARS) return answer
  return (
    answer.slice(0, ANSWER_HEAD_CHARS) +
    `\n…[${answer.length - ANSWER_HEAD_CHARS - ANSWER_TAIL_CHARS} characters cut; the whole answer is in the session "${sessionName}"]…\n` +
    answer.slice(-ANSWER_TAIL_CHARS)
  )
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

function real(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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
    if (!root || !r || !within(root, r)) {
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
  const abs = resolve(cwd, path)
  const r = real(abs) ?? abs
  for (const g of grants) {
    if (r === g || r.startsWith(g.endsWith(sep) ? g : g + sep)) return true
  }
  return false
}

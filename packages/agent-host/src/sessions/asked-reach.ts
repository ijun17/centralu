import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { oneLineText } from '@cc/protocol'

/**
 * What a request's turn reads that the asking session could not read itself (docs/plans/mailbox.md §9.7, #1447).
 *
 * Reading needs no card, but what the orchestrator reads it can also write back: it answers in the asking session's thread, and the session reads
 * the answer. So a turn that read a file outside the asker's folders, or the conversations of another project, must not hand the asker that in a
 * reply without the person's say: `AskedGate` remembers it for the turn and puts the reply to the person (`askedAct`). Reads themselves stay free.
 *
 * Fail closed: a path that is not absolute, or that cannot be told, is out of reach; so is a session that cannot be found.
 */

/** What a read looks at */
export type ReadScope =
  /** Files or folders by path; `''` stands for the orchestrator's own working folder (a path left out), which is nobody's request */
  | { paths: readonly string[] }
  /** One session's conversation, or null when the call does not say which */
  | { session: string | null }
  /** Conversations across projects, whichever they are (`recall`, the list of sessions, the archive) */
  | { everywhere: true }

/** What the asking session reaches itself */
export type Reach = { folders: readonly string[]; project: string | null }

/** The CLI's reads of files, and the host's reads of conversations; null for any other tool or command */
export function readScope(name: string, args: Record<string, unknown>): ReadScope | null {
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  switch (name) {
    case 'Read':
      return { paths: [text(args.file_path) ?? ''] }
    case 'Grep':
      return { paths: [text(args.path) ?? ''] }
    case 'Glob':
      return { paths: globPaths(text(args.path), text(args.pattern)) }
    case 'read_session':
      return { session: text(args.sessionId) }
    case 'agent_session':
      return args.action === 'status' || args.action === 'wait' || args.action === 'list' ? { session: text(args.sessionId) } : null
    case 'recall':
    case 'list_sessions':
    case 'list_archive':
      return { everywhere: true }
    default:
      return null
  }
}

/** The folder a Glob looks in, and the fixed start of its pattern (`/tmp/x/*.txt` looks under `/tmp/x`, whatever the folder says) */
function globPaths(path: string | null, pattern: string | null): string[] {
  const out: string[] = []
  if (path !== null) out.push(path)
  if (pattern !== null) {
    const fixed: string[] = []
    for (const segment of pattern.split(/[\\/]/)) {
      if (/[*?[\]{}!]/.test(segment)) break
      fixed.push(segment)
    }
    const start = fixed.join('/')
    if (start !== '') out.push(isAbsolute(start) || path === null ? start : join(path, start))
  }
  return out.length > 0 ? out : ['']
}

/** A path as the file system has it: `..` and links followed as far as the path exists, so a link inside a folder does not stand for the folder */
function real(path: string): string {
  const full = resolve(path)
  let existing = full
  const rest: string[] = []
  for (let i = 0; i < 64; i++) {
    try {
      return join(realpathSync.native(existing), ...rest)
    } catch {
      const up = dirname(existing)
      if (up === existing) return full
      rest.unshift(existing.slice(up.length).replace(/^[\\/]+/, ''))
      existing = up
    }
  }
  return full
}

const inside = (folder: string, path: string): boolean => {
  const rel = relative(folder, path)
  return rel === '' || (!/^\.\.([\\/]|$)/.test(rel) && !isAbsolute(rel))
}

/**
 * What of this read the asking session could not reach itself, in words for the card, or null when all of it is in reach. `projectOf` gives a
 * session's project (null for none, undefined for a session that is not there)
 */
export function outOfReach(name: string, scope: ReadScope, reach: Reach, projectOf: (sessionId: string) => string | null | undefined): string | null {
  const named = (target: string): string => `${name} of ${JSON.stringify(oneLineText(target, 120))}`
  if ('everywhere' in scope) return name
  if ('session' in scope) {
    if (scope.session === null) return name
    const project = projectOf(scope.session)
    return project !== undefined && project !== null && project === reach.project ? null : named(scope.session)
  }
  const folders = reach.folders.filter((f) => isAbsolute(f)).map(real)
  for (const path of scope.paths) {
    if (!isAbsolute(path)) return path === '' ? name : named(path)
    const there = real(path)
    if (!folders.some((f) => inside(f, there))) return named(path)
  }
  return null
}

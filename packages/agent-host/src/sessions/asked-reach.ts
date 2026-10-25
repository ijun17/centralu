import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { oneLineText, wireJoin, wireSegments } from '@cc/protocol'

/**
 * What a request's turn reads that the asking session could not read itself (docs/plans/mailbox.md §9.7, #1447).
 *
 * Reading needs no card, but what the orchestrator reads it can also write back: it answers in the asking session's thread, and the session reads
 * the answer. So a turn that read a file outside the asker's folders, or the conversations of another project, must not hand the asker that in a
 * reply without the person's say: `AskedGate` remembers the read for the orchestrator's whole conversation and puts the words that go back to a
 * session to the person (`askedAct`). Reads themselves stay free. What is remembered is the scope of the read, judged against the reach of whoever asks
 * when the words are written: the conversation keeps what it read across turns, requests and compaction.
 *
 * Fail closed: a path that is not absolute, or that cannot be told, is out of reach; so is a session that cannot be found.
 */

/** What a read looks at */
export type ReadScope =
  /**
   * Files or folders by path; `''` stands for the orchestrator's own working folder (a path left out), which is nobody's request. `real` is each
   * path as the file system had it when it was read (`pinned`): a link swapped afterwards does not change what was read
   */
  | { paths: readonly string[]; real?: readonly string[] }
  /** One session's conversation, or null when the call does not say which */
  | { session: string | null }
  /** A project's own state (its branch, an app's runs and errors), or null when the call names none */
  | { project: string | null }
  /** A mail thread, or null when the call names none */
  | { thread: string | null }
  /** Conversations across projects, whichever they are (`recall`, the list of sessions, the archive) */
  | { everywhere: true }

/** What the asking session reaches itself: its folders, its project (id and name) and the thread of its request */
export type Reach = { folders: readonly string[]; project: string | null; projectName?: string | null; thread: string }

/**
 * Tools that return nothing anybody read: the CLI's writes and plans, and the Centralu tools that only list their own commands or move the
 * orchestrator's own turn. Everything else gives back data, and counts as reading everything unless `readScope` can judge its scope exactly
 */
const GIVES_NOTHING: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'TodoWrite',
  'ToolSearch',
  'compact_self',
  // The three tools that list and run commands: the command that is run is noted by its own name
  'centralu_commands',
  'centralu_help',
  'centralu_run',
])

/** The `mail` actions that put words out and give back only that they were put */
const MAIL_WRITES: ReadonlySet<string> = new Set(['handled', 'send', 'reply', 'close'])

/**
 * What a call reads, as an allowlist (fail closed): a scope only where it is provable from the call (a path, a named session, a named project, a
 * mail thread), nothing for a call that gives back nothing, and every other tool or command, a name not known included, reads everything: a
 * command, a fetch, an app's or another MCP server's data, the reply of a worker or another project, a search. A Centralu tool the CLI's hook sees
 * as `mcp__centralu__…` is noted in its own call (`runParsed`), so the hook's sight of it is nothing
 */
export function readScope(name: string, args: Record<string, unknown>): ReadScope | null {
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  if (GIVES_NOTHING.has(name) || name.startsWith('mcp__centralu__')) return null
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
      // Only `status` and `wait` are judged by the session looked at. `list` ignores the session and gives every worker of every project, and a
      // message to a worker gives back its reply, which is anything
      return args.action === 'status' || args.action === 'wait' ? { session: text(args.sessionId) } : { everywhere: true }
    case 'ask_project':
      // The answer is the other project's own agent's, which reads what that project reaches
      return { project: text(args.project) }
    case 'mail':
      // The inbox lists subjects other sessions wrote; a thread read other than the request's own is some other session's words (the one thread that
      // is the asker's own is judged at reply time). An `update` gives back the thread's state and what it was last told to do next, which another
      // session may have written, so it is judged by its thread as a read is
      if (typeof args.action === 'string' && MAIL_WRITES.has(args.action)) return null
      return args.action === 'read' || args.action === 'update' ? { thread: text(args.thread)?.trim() || null } : { everywhere: true }
    case 'project_git_status':
    case 'list_app_runs':
    case 'list_app_errors':
    case 'app_usage':
      return { project: text(args.project) }
    default:
      return { everywhere: true }
  }
}

/** The folder a Glob looks in, and the fixed start of its pattern (`/tmp/x/*.txt` looks under `/tmp/x`, whatever the folder says) */
function globPaths(path: string | null, pattern: string | null): string[] {
  const out: string[] = []
  if (path !== null) out.push(path)
  if (pattern !== null) {
    const fixed: string[] = []
    // Either separator ends a segment (the pattern may be a Windows one); the segments are the wire's
    for (const segment of wireSegments(pattern.replace(/\\/g, '/'))) {
      if (/[*?[\]{}!]/.test(segment)) break
      fixed.push(segment)
    }
    // A first segment that is empty is a root (`/tmp/x`); two of them start a network path, which is not told here: out of reach
    const rooted = fixed[0] === ''
    if (rooted && fixed[1] === '') out.push('')
    else {
      const start = rooted ? `/${wireJoin(...fixed)}` : wireJoin(...fixed)
      if (start !== '') out.push(isAbsolute(start) || path === null ? start : join(path, start))
    }
  }
  return out.length > 0 ? out : ['']
}

/** The read as it was when it was made: a path scope with each path's real place noted now, any other scope as it is */
export function pinned(scope: ReadScope): ReadScope {
  return 'paths' in scope ? { paths: scope.paths, real: scope.paths.map((p) => (isAbsolute(p) ? real(p) : p)) } : scope
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
  if ('thread' in scope) return scope.thread !== null && scope.thread === reach.thread ? null : scope.thread === null ? name : named(scope.thread)
  if ('project' in scope) {
    const asked = scope.project?.trim().toLowerCase()
    if (!asked) return name
    const mine = [reach.project, reach.projectName].filter((p): p is string => typeof p === 'string' && p !== '')
    return mine.some((p) => p.toLowerCase() === asked) ? null : named(scope.project ?? '')
  }
  const folders = reach.folders.filter((f) => isAbsolute(f)).map(real)
  for (const [i, path] of scope.paths.entries()) {
    if (!isAbsolute(path)) return path === '' ? name : named(path)
    const there = scope.real?.[i] ?? real(path)
    if (!folders.some((f) => inside(f, there))) return named(path)
  }
  return null
}

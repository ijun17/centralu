/**
 * Deciding which of an agent's words is a file you can open (issue #39).
 *
 * Opening the file was never the hard part — `openFile(path)` already exists. The hard
 * part is that this runs over **every inline-code span of every message**, and the text
 * came out of a model. Match too eagerly and ordinary prose (`and/or`, `node:fs/promises`,
 * `v1.2.0`) turns into a wall of links that mostly lead nowhere; match too shyly and
 * nobody ever finds out that paths are clickable at all.
 *
 * So the floor is deliberately narrow, and each narrowing is a sentence:
 *
 *   - **Backticks only.** In running prose a path is indistinguishable from a word with a
 *     slash in it. Backticks are the agent saying "this is a token", not a sentence. The
 *     caller supplies the backticked text; this function never sees prose.
 *   - **No whitespace anywhere.** This is also what keeps fenced code blocks out: a fence
 *     always hands its content over with the closing newline attached, so a block can
 *     never look like a path even when it holds one.
 *   - **It must end in a file extension.** The viewer cannot show a directory at all
 *     (`readTextFile` refuses one), and `packages/ui/src` is a far more common thing to
 *     write than an extensionless file. `Makefile` loses; that is the price of the rule.
 *   - **Nothing outside the project.** The viewer reads through `fs.readFile(projectId, …)`
 *     which refuses anything above the root, so an absolute path elsewhere could only ever
 *     produce an error — plain text is the more honest rendering of it.
 *
 * What is deliberately *not* here is an existence check. Asking the host "is this real"
 * for every span of every message would cost an RPC per render to answer a question only a
 * click ever asks. The link is therefore a guess, and the cost of that decision is paid on
 * the other side: a guess that turns out wrong has to say so out loud rather than open an
 * empty window (see `viewer-error` in CodeViewer).
 */

export type FileRef = {
  /** Project-relative path, as `openFile` wants it */
  path: string
  /** 1-based line the reference pointed at, or null when it named no line */
  line: number | null
}

/**
 * Every character a path is allowed to contain. The exclusions carry the weight: no
 * spaces, no quotes, no parentheses, and above all no `:` — which is what rules out
 * `https://…` and `node:fs/promises` once the trailing `:line` has been taken off.
 */
const PATH_CHARS = /^[A-Za-z0-9._@+/-]+$/

/**
 * The last segment has to end in `.ext`, and `ext` has to start with a letter. That last
 * detail is what keeps version numbers (`1.2.3`, `v0.1.0`) from reading as filenames.
 */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

/** `path:12` and `path:12:34` — how every tool in the world prints a location */
const LOCATION = /^(.*?):(\d+)(?::\d+)?$/

/**
 * Read a backticked chunk of agent text as a file the viewer could open, or null for
 * "leave this as text".
 *
 * `projectRoot` is the session's project directory, and null means the session has no
 * project — which is the orchestrator's case, since its sessions carry `projectId: null`.
 * There is then no root for a relative path to be relative *to*, and no file tree beside
 * the conversation to open one in, so nothing in an orchestrator message becomes a link.
 * Guessing a root from whichever project happens to be selected would open a file from
 * some other repository under the same name, which is worse than not linking.
 */
export function parseFileRef(raw: string, projectRoot: string | null): FileRef | null {
  if (!projectRoot) return null

  let body = raw
  let line: number | null = null
  const loc = LOCATION.exec(raw)
  if (loc) {
    body = loc[1]!
    // Line 0 does not exist; treat it as "no line asked for" rather than scrolling to -1
    line = Number(loc[2]) || null
  }

  if (!PATH_CHARS.test(body)) return null
  if (!EXTENSION.test(body)) return null
  // `../shared/a.ts` is relative to the file being discussed, which we do not know. We
  // only know the project root, so resolving it here would be a guess dressed as a fact.
  if (body.split('/').includes('..')) return null

  const root = projectRoot.replace(/\/+$/, '')
  let path = body
  if (path.startsWith('/')) {
    if (!path.startsWith(`${root}/`)) return null
    path = path.slice(root.length + 1)
  }
  if (path.startsWith('./')) path = path.slice(2)
  if (!path) return null

  /*
   * A dotfile with no directory in front of it is exactly what prose about a file *type*
   * looks like — `.ts`, `.env`, `.json` are written far more often as categories than as
   * files. With a directory there is no ambiguity, so `src/.gitignore` links and a bare
   * `.gitignore` does not.
   */
  if (!path.includes('/') && path.startsWith('.')) return null

  return { path, line }
}

import type { CommandInfo } from '@cc/protocol'
import type { Loaded } from '../../app/useLoad.js'

/**
 * What the composer's lists know about what they were asked, kept apart from the hook so it is tested on its own.
 *
 * Both lists are read with `useLoad`, which says "loading", "answered" or "failed". The three ways a list can be
 * empty must not look alike: it is still being read, the host said there is nothing, or the read did not work. A
 * failure that looked like "none" was the bug (#1143 U14), and a failure that looked like "still loading" was the
 * other one (U13): the menu said "Loading skills…" until the person retyped the `/`.
 */

/** The `/` list as the host answered it, with the session it answers (the pane is reused for another session) */
export type Skills = { sessionId: string; ready: boolean; commands: CommandInfo[] }

export type SkillsView = {
  commands: CommandInfo[]
  /** Not answered yet: say "Loading skills…" */
  loading: boolean
  /** The reason the list is not there, when it is not and nothing is on its way */
  note: string | null
}

/** Said when the host answered `ready: false`: the tool is not up yet and nothing is cached */
export const SKILLS_NOT_READY = 'Skills are not ready yet'

/**
 * What the `/` list shows for `sessionId`.
 *
 * An answer for another session is no answer: the focus view swaps sessions without a key change, and the load only
 * resets in an effect, so for one frame the old session's list is still what `loaded` holds.
 */
export function skillsView(sessionId: string, loaded: Loaded<Skills>): SkillsView {
  const answer = loaded.data?.sessionId === sessionId ? loaded.data : null
  if (answer?.ready) return { commands: answer.commands, loading: false, note: null }
  const commands = answer?.commands ?? []
  // A read that failed or found the tool not ready ends here, so the menu does not wait for something that is not coming
  if (loaded.error !== null && !loaded.loading) return { commands, loading: false, note: `Could not load skills: ${loaded.error}` }
  if (loaded.loading || !answer) return { commands, loading: true, note: null }
  return { commands, loading: false, note: SKILLS_NOT_READY }
}

/** One `@` file search and the answer to it (`key` says which search, see `searchKey`) */
export type FileAnswer = {
  key: string
  projectId: string
  query: string
  list: { path: string; name: string }[]
  /** Why the search failed; null when it found files or found none */
  error: string | null
}

export type FilesView = {
  list: { path: string; name: string }[]
  /** The list answers an earlier search: Enter and Tab wait for the answer instead of picking (#842 item 13) */
  stale: boolean
  note: string | null
}

/**
 * The `@` file list for the search on screen (`fileKey`, null when none is wanted).
 *
 * The results on screen answer an earlier search: shown until the answer comes, never picked by a key, and Enter and
 * Tab wait for the answer. Not while the earlier search found nothing and this one only narrows it (it cannot find
 * more, so the menu does not come back on every keystroke) — a search that *failed* found nothing out, so the next
 * one waits — and not once the wait gave up: then the list is empty, the menu closes, and Enter sends.
 */
export function filesView(input: {
  fileKey: string | null
  projectId: string
  query: string | null
  answer: FileAnswer | undefined
  gaveUp: string | null
}): FilesView {
  const { fileKey, projectId, query, answer, gaveUp } = input
  const sameProject = answer !== undefined && answer.projectId === projectId
  const narrowsNothing =
    sameProject && answer.error === null && answer.list.length === 0 && query !== null && query.startsWith(answer.query)
  const stale = fileKey !== null && answer?.key !== fileKey && !narrowsNothing && gaveUp !== fileKey
  // Another project's results are never shown, not even while this project's are on their way, nor once the wait gave up
  const list = sameProject && fileKey !== null && (answer.key === fileKey || stale) ? answer.list : []
  const failed = sameProject && fileKey !== null && answer.key === fileKey && answer.error !== null
  return { list, stale, note: failed ? `Could not search files: ${answer.error}` : null }
}

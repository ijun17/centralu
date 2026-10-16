// How the board app's tools answer: the text and the same words in structuredContent, and failures.
import { GitHubError } from './github.mjs'

/**
 * One answer: the text, and the same words first in structuredContent (`summary`). A session's
 * client may hand the model the structured part instead of the text (Claude Code does, seen in a
 * live session), and what a write changed must reach the model either way.
 */
export const answer = (t, structured, summary = t) => ({ content: [{ type: 'text', text: t }], structuredContent: { summary, ...structured } })

/**
 * An answer made of a summary and lists of lines. The text is the summary, then each list's lines
 * (under its heading, if it has one; an `inline` list is one line after its heading), so it says
 * exactly what the structured part says.
 */
export function linesAnswer(summary, lists, extra = {}) {
  const structured = {}
  const text = [summary]
  for (const [key, heading, lines, inline] of lists) {
    if (!lines.length) continue
    structured[key] = lines
    if (inline) text.push(`${heading} ${lines.join(', ')}.`)
    else text.push(...(heading ? [heading] : []), ...lines)
  }
  return answer(text.join('\n'), { ...structured, ...extra }, summary)
}

/** The same answer marked as a failure. */
export const asError = (a) => ({ isError: true, ...a })

/** A failure as an answer: the message says what happened and what to do, and nothing changed. */
export function failure(e, prefix = '') {
  const message = `${prefix}${reason(e)}`
  return asError(answer(message, { error: { kind: e instanceof GitHubError ? e.kind : 'internal', message } }))
}
export function reason(e) {
  if (e instanceof GitHubError) return e.message
  console.error(e)
  return `Unexpected error: ${e?.message ?? e}`
}

/** Failures the view shows in place of the item: as data, like `show`, so it can say why. */
export function viewFailure(e) {
  const f = failure(e)
  return { content: f.content, structuredContent: { ok: false, ...f.structuredContent } }
}

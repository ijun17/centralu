import type { StoredMessage } from '@cc/protocol'

/**
 * The final answer of a turn — the agent's text standing after the last tool call at the end of
 * the conversation record.
 *
 * Why it is "the text after the last tool call" and not simply "the last piece of text": an agent
 * writes text, calls a tool, and writes again. Text before a tool call is a plan, not an answer.
 * A reasoning summary (`reasoning`) is skipped since it is not an answer, and the scan stops the
 * moment it meets a tool call, a tool result, an approval, a marker or something a person said.
 * If there is no text at the end (the turn ended on a tool call), the answer is empty — an
 * earlier plan is never handed back pretending to be the answer.
 *
 * `afterSeq`: only rows after it are this turn's (#428). A queued turn has no user row of its own between it and the
 * turn before (its input was recorded before that answer), so without it two turns' texts read as one answer.
 *
 * `acrossNotes` (#1604): a message a caller sent into the turn (a note) is a row among the turn's text and does not end the
 * answer, so the text before the note and the text after it are one answer. Only for the rows of one turn that is a caller's
 * alone (`afterSeq`): a person's message in it would have made it theirs.
 *
 * The one rule for "the turn's answer" (#428): a delegation's and a child's answer, an app's agent's, the report's
 * preview (`lastResponse`) and the session list's (`previewOf`) all read it here; they used to keep four.
 */
export function turnAnswer(messages: readonly StoredMessage[], opts: { afterSeq?: number; acrossNotes?: boolean } = {}): string {
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (opts.afterSeq !== undefined && m.seq <= opts.afterSeq) break
    if (m.role === 'assistant' && m.kind === 'reasoning') continue
    if (m.role === 'assistant' && m.kind === 'text') {
      parts.unshift(String((m.payload as { text?: unknown }).text ?? ''))
      continue
    }
    if (opts.acrossNotes && m.role === 'user' && m.kind === 'text') continue
    break
  }
  return parts.join('\n\n').trim()
}

/**
 * The seq of the first message of `turnAnswer`'s answer in the same rows, or null when the turn has no final text
 * (#1186): read_session finds the answer there (`around`), read from an offset to its end
 */
export function turnAnswerSeq(messages: readonly StoredMessage[], opts: { afterSeq?: number; acrossNotes?: boolean } = {}): number | null {
  let first: number | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (opts.afterSeq !== undefined && m.seq <= opts.afterSeq) break
    if (m.role === 'assistant' && m.kind === 'reasoning') continue
    if (m.role === 'assistant' && m.kind === 'text') {
      first = m.seq
      continue
    }
    if (opts.acrossNotes && m.role === 'user' && m.kind === 'text') continue
    break
  }
  return first
}

/** The rows `lastResponse` reads: all of them, or the one turn's after `turnAfter` (#1604) */
function responseRows(messages: readonly StoredMessage[], turnAfter: number | undefined): readonly StoredMessage[] {
  const rows = turnAfter === undefined ? messages : messages.filter((m) => m.seq > turnAfter)
  let end = rows.length
  while (end > 0 && !(rows[end - 1]!.role === 'assistant' && rows[end - 1]!.kind === 'text')) end--
  return rows.slice(0, end)
}

/**
 * Where `lastResponse` starts (#1186): the seq of its first message, or null when the session has said nothing.
 * `turnAfter`: the same for the turn that began after that row (#1604)
 */
export function lastResponseSeq(messages: readonly StoredMessage[], turnAfter?: number): number | null {
  return turnAnswerSeq(responseRows(messages, turnAfter), turnAfter === undefined ? {} : { acrossNotes: true })
}

/**
 * The session's last response, as a preview reads it: `turnAnswer` at the last text the agent wrote, past whatever came
 * after it (a tool call still running, the person's next message). Not an answer to hand a caller: it can be a plan.
 *
 * `turnAfter` (#1604): the response of the turn that began after that row, and of no turn before it: a turn that has said
 * nothing yet has no response, where it would have read the one before. A caller's note in the turn is a row among its
 * text (`acrossNotes`), so a turn the notes split reads whole
 */
export function lastResponse(messages: readonly StoredMessage[], turnAfter?: number): string {
  return turnAnswer(responseRows(messages, turnAfter), turnAfter === undefined ? {} : { acrossNotes: true })
}

/** A preview of `text` in at most `max` characters and an ellipsis: its head, where an answer says what it did */
export function clipPreview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

import type { StoredMessage } from '@cc/protocol'
import { asObj } from '../json-value.js'

/** A message someone else sent into the conversation (a session, an app, a script): its row says who; the person's own says nothing */
function isNote(m: StoredMessage): boolean {
  if (m.role !== 'user' || m.kind !== 'text') return false
  const p = asObj(m.payload)
  return !!(p.from || p.fromApp || p.fromScript)
}

/**
 * The final answer of a turn, its one rule (#428, docs/agent-host/delegation/start-agent.md): the agent's text after the last tool call at
 * the end of the record. Text before a tool call is a plan, not an answer, so a turn that ended on a tool call answers empty rather than hand
 * back an earlier plan. Skipped: a reasoning summary, and a tool's result after the answer's last text (some tools say a call finished after
 * the text that ended the turn: Antigravity 1.4.3's recordings; an ACP turn's end closes the calls still open, #2351). The scan stops at a tool
 * call, a tool's result before that text, an approval, a marker or something a person said.
 * `afterSeq`: only rows after it are this turn's (#428): a queued turn has no user row between it and the turn before (its input
 * was recorded before that answer), so without it two turns' texts would read as one. `acrossNotes` (#1604): a message a sender sent into the turn (its
 * row says who) is a row among the turn's text, not its end; one with no sender is the person's and ends it: what came before was another exchange.
 */
export function turnAnswer(messages: readonly StoredMessage[], opts: AnswerOpts = {}): string {
  return answerRows(messages, opts)
    .map((m) => String((m.payload as { text?: unknown }).text ?? ''))
    .join('\n\n')
    .trim()
}

/** The seq of the first message of `turnAnswer`'s answer in the same rows, or null when the turn has no final text (#1186): read_session
 * finds the answer there (`around`), read from an offset to its end */
export function turnAnswerSeq(messages: readonly StoredMessage[], opts: AnswerOpts = {}): number | null {
  return answerRows(messages, opts)[0]?.seq ?? null
}

type AnswerOpts = { afterSeq?: number; acrossNotes?: boolean }

/** The text rows of `turnAnswer`'s answer, oldest first */
function answerRows(messages: readonly StoredMessage[], opts: AnswerOpts): StoredMessage[] {
  const rows: StoredMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (opts.afterSeq !== undefined && m.seq <= opts.afterSeq) break
    if ((m.role === 'assistant' && m.kind === 'reasoning') || (m.kind === 'tool_result' && rows.length === 0)) continue
    if (m.role === 'assistant' && m.kind === 'text') {
      rows.unshift(m)
      continue
    }
    if (opts.acrossNotes && isNote(m)) continue
    break
  }
  return rows
}

/** The rows of one turn (#1604): those after the row it began after, and up to the row the next turn began after when it has been left */
export type TurnRows = { after: number; through?: number }

/** The rows `lastResponse` reads: all of them, or the one turn's */
function responseRows(messages: readonly StoredMessage[], turn: TurnRows | undefined): readonly StoredMessage[] {
  const rows = turn === undefined ? messages : messages.filter((m) => m.seq > turn.after && (turn.through === undefined || m.seq <= turn.through))
  let end = rows.length
  while (end > 0 && !(rows[end - 1]!.role === 'assistant' && rows[end - 1]!.kind === 'text')) end--
  return rows.slice(0, end)
}

/** Where `lastResponse` starts (#1186): the seq of its first message, or null when the session has said nothing. `turn`: in one turn's rows (#1604) */
export function lastResponseSeq(messages: readonly StoredMessage[], turn?: TurnRows): number | null {
  return turnAnswerSeq(responseRows(messages, turn), turn === undefined ? {} : { acrossNotes: true })
}

/**
 * The session's last response, as a preview reads it: `turnAnswer` at the last text the agent wrote, past whatever came after it (a tool
 * call still running, the person's next message). Not an answer to hand a caller: it can be a plan. `turn` (#1604): that turn's rows and no
 * turn before it, so a turn that said nothing has no response rather than the one before's. A caller's note in the turn is a row among its
 * text (`acrossNotes`), so a turn the notes split reads whole
 */
export function lastResponse(messages: readonly StoredMessage[], turn?: TurnRows): string {
  return turnAnswer(responseRows(messages, turn), turn === undefined ? {} : { acrossNotes: true })
}

/** A preview of `text` in at most `max` characters and an ellipsis: its head, where an answer says what it did */
export function clipPreview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

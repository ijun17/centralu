import { createHash } from 'node:crypto'
import type { ApprovalDecision, Question, QuestionAnswer } from '@cc/protocol'
import type { ToolProfile } from '../apps/contract.js'

/**
 * Cards in a delegated turn (#676): a session P gave another session A a turn (ask_project, start_agent,
 * agent_session send, send_to_session), and A raised a card during it. P is told, reads the card through a tool and
 * may answer a question; the person may answer too, and the first answer wins. The rules live in
 * `SessionManager.routeCard` / `answerRoutedCard`; this module holds the pure parts: how P's answer is read, and the
 * words P is told with.
 */

/**
 * The questions' answers from the text the caller gave (agent_session `answer`, answer_question). One question: the
 * whole text is its answer. Several: one line each, in order. Or a JSON array with one entry per question, a string
 * or an array of strings. A multi-select answer given as one string takes `;` between its choices. A choice that
 * names an option, case aside, is that option's own label; anything else is a typed answer, as the card's free input.
 */
export function answersFrom(questions: readonly Question[], text: string): QuestionAnswer[] | { error: string } {
  let parts: unknown[] | undefined
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) parts = parsed
    } catch {
      // Not JSON: read as lines
    }
  }
  parts ??= questions.length === 1 ? [trimmed] : trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
  if (parts.length !== questions.length) {
    return { error: `The card asks ${questions.length} questions; give ${questions.length} answers, one line each, in order.` }
  }
  const out: QuestionAnswer[] = []
  for (const [i, q] of questions.entries()) {
    const part = parts[i]
    const raw = Array.isArray(part) ? part : typeof part === 'string' ? (q.multiSelect ? part.split(';') : [part]) : undefined
    const picked = raw?.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean)
    if (!picked?.length) return { error: `No answer for question ${i + 1}.` }
    if (!q.multiSelect && picked.length > 1) return { error: `Question ${i + 1} takes one answer.` }
    out.push({
      question: q.question,
      answers: picked.map((a) => q.options.find((o) => o.label.toLowerCase() === a.toLowerCase())?.label ?? a),
    })
  }
  return out
}

/**
 * The handle a delegated turn's owner reads a card by and answers it with: the request id, and a digest of the turn
 * and of what the card asks. An adapter's request ids start again in a new process, so the same id can name a new card
 * in the same session; its handle differs, and an answer meant for the earlier card finds nothing (#676 review).
 */
export function cardHandle(turnId: string, requestId: string, content: unknown): string {
  const digest = createHash('sha256').update(`${turnId}\0${requestId}\0${JSON.stringify(content)}`).digest('hex').slice(0, 8)
  return `${requestId}.${digest}`
}

/** An approval's answer from the caller's text: allow or deny, nothing remembered ("always" stays the person's) */
export function decisionFrom(text: string): ApprovalDecision | null {
  const t = text.trim().toLowerCase()
  if (t === 'allow' || t === 'yes' || t === 'approve') return 'allow'
  if (t === 'deny' || t === 'no' || t === 'reject') return 'deny'
  return null
}

/**
 * The call that reads and answers a card, as the caller's seat has it: an ordinary session through agent_session, the
 * orchestrator through answer_question (a rare command, so through centralu_run in that tier). A coordinator (#80),
 * which nothing makes any more, only reads it: `canAnswer` is false.
 */
export function cardCall(profile: ToolProfile | null, sessionId: string, how: 'tool' | 'command' | 'none'): { call: string; canAnswer: boolean } {
  if (profile === 'reader') return { call: `agent_session(sessionId="${sessionId}", action="status") shows it; action="answer" answers it`, canAnswer: true }
  const read = `read_session(sessionId="${sessionId}") shows it`
  if (how === 'none') return { call: read, canAnswer: false }
  const answer = how === 'command'
    ? `centralu_run(command="answer_question", args={sessionId: "${sessionId}", text: …})`
    : `answer_question(sessionId="${sessionId}", text=…)`
  return { call: `${read}; ${answer} answers it`, canAnswer: true }
}

/**
 * What the caller is told when a card comes up in the turn it gave (#676), as the completion report is: one message in
 * its conversation, marked as from the target session. Never the card's text: that is the target's, and the caller
 * reads it as a tool result (`cardCall`), not in the person's seat.
 */
export function cardNotice(kind: 'question' | 'approval', sessionId: string, how: { call: string; canAnswer: boolean }, answerable: boolean): string {
  const head = kind === 'question'
    ? '[Centralu] The session you gave work to is asking a question in that turn.'
    : '[Centralu] The session you gave work to is waiting on an approval in that turn.'
  const { call } = how
  const who = !how.canAnswer
    ? 'Only the person can answer it here; tell them if it matters for your work.'
    : kind === 'question'
    ? 'You may answer it; the person may too, and the first answer counts.'
    : answerable
      ? 'Your permission preset is auto, so you may allow or deny it; the person may too, and the first answer counts.'
      : 'Only the person can answer it; tell them if it matters for your work.'
  return `${head}\nsourceSessionId: ${sessionId}\n${call}. ${who}`
}

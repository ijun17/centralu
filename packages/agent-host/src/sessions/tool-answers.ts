import { frameField } from '@cc/protocol'
import type { BusyChoice, ChildRunResult, AskProjectResult, OrchestratorTools, RoutedCard } from '../adapters/contract.js'
import type { ToolCaller, ToolOutput } from '../apps/contract.js'
import { interruptionWords } from './interruptions.js'

/**
 * Someone else's text as one JSON string on one line (#121). JSON.stringify escapes every control character but
 * leaves U+2028 and U+2029, which a reader may take for line breaks; they are escaped too.
 */
export function trustedJsonText(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export async function listSessionsText(tools: OrchestratorTools, caller: ToolCaller): Promise<ToolOutput> {
  const list = await tools.listSessions()
  if (list.length === 0) {
    return { text: caller.profile === 'reader' ? 'There are no other sessions in this project.' : 'There are no sessions under management.' }
  }
  return {
    text: list
      .map(
        (s) =>
          // A linked machine's session says where it runs (#82 phase 4), and why the row is only what was last known
          // Names on one line (#838): a session's name is set by rename or an auto-name, and a line break in it made a row of its own
          `- ${frameField(s.name)} [${s.sessionId}] · project ${frameField(s.project)}${s.machine ? ` on ${frameField(s.machine)}` : ''} · ${s.tool} · ${s.waitingOn === 'question' ? 'waiting on a question' : s.state}` +
          (s.away ? ` · ${s.away}` : '') +
          // A turn cut short by the network or a quit looks like any session at rest (#698)
          (s.interruption ? ` · ${interruptionWords(s.interruption)}` : '') +
          // If merge status is not shown, the manager keeps assigning work to a finished branch (#69, dogfooding)
          (s.merged ? ' · merged' : '') +
          // PR status (#76 stage 3) — assigning new work to a branch awaiting review pollutes the PR
          (s.pr ? ` · PR #${s.pr.number}(${s.pr.state})` : '') +
          (s.lastActive ? ` · last ${s.lastActive}` : '') +
          (s.preview ? `\n    recent (JSON): ${trustedJsonText(s.preview)}` : ''),
      )
      .join('\n'),
  }
}

/**
 * The cards of a delegated turn as the caller reads them (#676). The questions, options and approval detail are the
 * target's words: each card is one JSON line, as an answer is, so nothing in it can pose as a line of ours.
 */
export function cardsText(cards: readonly RoutedCard[]): string {
  return cards
    .map((c) =>
      c.kind === 'question'
        ? `card ${c.card} (question), as JSON: ${trustedJsonText(JSON.stringify(c.questions.map((q) => ({ question: q.question, header: q.header, options: q.options.map((o) => o.label), ...(q.options.some((o) => o.description) ? { descriptions: q.options.map((o) => o.description) } : {}), multiSelect: q.multiSelect }))))}`
        : `card ${c.card} (approval${c.answerable ? ', yours to allow or deny' : ', only the person can answer it'}), as JSON: ${trustedJsonText(JSON.stringify(c.detail))}`,
    )
    .join('\n')
}

/**
 * A busy session's choices (#677), as the requester reads them: each with whether it can be taken now, and the call
 * that takes it. Nothing was sent; the requester decides.
 */
export function busyText(b: { sessionName: string; sessionId: string; sessionState: string; choices: readonly BusyChoice[] }, call: (choice: string) => string): string {
  const what: Record<BusyChoice['choice'], string> = {
    note: 'add it to the running turn as a note; that turn\'s answer stays its owner\'s, and you read the reply to your note',
    queue: 'hold it and deliver it as a new turn when the running one ends; you are told when that turn ends',
    fork: 'start a sub-session from a copy of its conversation now, linked to you, in a worktree of its own (fork_read: read-only work in its folder)',
  }
  const lines = b.choices.map((c) => `- ${c.choice}: ${c.available ? `${what[c.choice]}. ${call(c.choice === 'fork' ? 'fork' : c.choice)}` : `not available: ${c.why}`}`)
  return `"${b.sessionName}" [${b.sessionId}] is busy (${b.sessionState}) with a turn that is not yours, so nothing was sent. Choose:\n${lines.join('\n')}`
}

export function queuedText(q: { sessionName: string; sessionId: string; queueId: string; position: number; lowMemory?: string }): string {
  // A fork turned into a place in the queue (#686): said first, so the caller does not wait for a fork that never came
  const instead = q.lowMemory ? `Not forked: memory is low (${q.lowMemory}), so it was queued instead, which starts no new process. ` : ''
  return `${instead}Queued for "${q.sessionName}" [${q.sessionId}] as ${q.queueId}, number ${q.position} in its queue: it goes in as a new turn when the running one ends, and you are told when that turn ends.`
}

export const ANSWER_FORM = 'Answer a question with its option label, or your own words; one line per question; several choices of one question separated by ";". The person may answer first; the first answer counts.'

/**
 * What the model reads back from ask_project (#371). The delegated session's answer is someone else's words, so it
 * is fenced the way a worker's preview is (JSON-quoted, one line): a line in it cannot pose as a line of ours. The
 * session is named so the person can be pointed at it; the paths come last, as a list the model can act on.
 */
export function askProjectText(r: AskProjectResult): ToolOutput {
  if (!r.ok) return { text: r.error, isError: true }
  const where = `the session "${r.sessionName}" [${r.sessionId}] in ${r.project}`
  if (r.state === 'busy') return { text: busyText(r, (c) => `ask_project with the same task and ifBusy "${c}".`) }
  if (r.state === 'queued') return { text: `${queuedText(r)} Call ask_project with project "${r.project}", session "${r.sessionId}" and no task to see where it stands.` }
  if (r.state === 'asking') {
    return {
      text:
        `${where} is waiting on you in the task you gave it:\n${cardsText(r.cards)}\n` +
        `Answer with agent_session(sessionId="${r.sessionId}", action="answer", card=…, text=…). ${ANSWER_FORM} ` +
        `Then call ask_project with project "${r.project}", session "${r.sessionId}" and no task to wait for the answer.`,
    }
  }
  if (r.state === 'working') {
    return {
      text:
        `${r.project} is still working on it in ${where}${r.notice ? ` — ${r.notice}` : ''}. ` +
        `To keep waiting, call ask_project again with project "${r.project}", session "${r.sessionId}" and no task; the work goes on meanwhile.`,
    }
  }
  const lines = [`${r.project} answered (from ${where}), as JSON:`, trustedJsonText(r.answer || '(no final text)')]
  if (r.readable.length) lines.push(`You can read these now: ${r.readable.join(', ')}`)
  if (r.outside.length) lines.push(`Named outside ${r.project}'s folder (not opened for you): ${r.outside.join(', ')}`)
  return { text: lines.join('\n') }
}

/**
 * Said wherever the caller will be told of the end (#747). A parent seen on 2026-10-15 called `status` more than ten
 * times in a row while its child worked, though the end is announced on its own. Here rather than in agent_session's
 * description: an answer costs nothing until it is shown, and the description rides in every request.
 */
const NO_POLLING = 'Do not check on it with status meanwhile. With nothing else to do, wait is the one call that blocks until the end:'

/**
 * Said wherever an answer names `send` (#747). The same parent gave two children it had started for read-only research
 * the editing work as well: their names, set from the first task, no longer said what they did in the person's list.
 */
const NEW_ROLE_NEW_AGENT =
  "For another kind of work (say, editing files after read-only research), start a new agent instead, with the task written in full: it starts without this one's context, and this one's name and role came from its first task."

/**
 * What the model reads back from start_agent and agent_session (#561). The child's answer is fenced like ask_project's
 * (JSON-quoted, one line): it is another session's words. Each state names the next call, which is how a model that
 * has only start_agent loaded finds agent_session.
 */
export function agentRunText(r: ChildRunResult): ToolOutput {
  if (!r.ok) return { text: r.error, isError: true }
  // No session yet (#673): the handle is the request's, and the card stays up for the person
  if (r.state === 'pending' && r.lowMemory) {
    // Allowed, but queued until memory recovers (#686): the caller is told the start is coming, not refused
    return {
      text:
        `queued: low memory. No session yet: starting ${r.tool} is allowed and waits for memory (${r.lowMemory.available} free, ` +
        `${r.lowMemory.floor} needed; request ${r.sessionId}). It starts when memory frees up, and you will be told when its turn ends; ` +
        `if memory stays low for ${r.lowMemory.maxWaitMinutes} minutes it gives up and you will be told. Carry on with other work, and do not ` +
        `do this with your own subagents instead. ${NO_POLLING} ` +
        `agent_session(sessionId="${r.sessionId}", action="wait") waits, action="stop" withdraws it.`,
    }
  }
  if (r.state === 'pending') {
    return {
      text:
        `No session yet: starting ${r.tool} is waiting for the person's answer on the card in your session (request ${r.sessionId}). ` +
        'Carry on with other work, and do not do this with your own subagents instead. If they allow it, the session starts and ' +
        `you will be told when its turn ends; if they refuse or it is withdrawn, you will be told. ${NO_POLLING} ` +
        `agent_session(sessionId="${r.sessionId}", action="wait") waits for the answer, action="stop" withdraws the request.`,
    }
  }
  const who = `the ${r.tool} session "${r.sessionName}" [${r.sessionId}]` + (r.via === 'fork' ? `, a fork of [${r.forkedFrom}]` : '')
  const out = agentStateText(r, who)
  // Which busy choice ran (#677), said first
  return r.via === 'note' ? { ...out, text: `Added as a note to the running turn. ${out.text}` } : out
}

function agentStateText(r: Exclude<Extract<ChildRunResult, { ok: true }>, { state: 'pending' }>, who: string): ToolOutput {
  switch (r.state) {
    case 'working':
      return {
        text:
          `${who} is working on it${r.notice ? ` — ${r.notice}` : ''}. ` +
          (r.reported ? `You will be told when it ends. ${NO_POLLING} ` : '') +
          `agent_session(sessionId="${r.sessionId}", action="wait") waits for its answer, action="stop" stops it.`,
      }
    case 'asking':
      return {
        text:
          `${who} is waiting on you in the turn you gave it:\n${cardsText(r.cards)}\n` +
          `agent_session(sessionId="${r.sessionId}", action="answer", card=…, text=…) answers it. ${ANSWER_FORM}`,
      }
    case 'busy':
      return { text: busyText(r, (c) => `agent_session(sessionId="${r.sessionId}", action="send", text=…, ifBusy="${c}").`) }
    case 'queued':
      return { text: `${queuedText(r)} agent_session(sessionId="${r.sessionId}", action="stop") withdraws it.` }
    case 'answered':
      return { text: `Answered card ${r.card} in ${who}; it goes on. agent_session(sessionId="${r.sessionId}", action="wait") waits for its answer.` }
    case 'stopped':
      // A request withdrawn before the person answered has no session to name (#673)
      if (!r.sessionName) return { text: `Withdrew request ${r.sessionId}: its card is gone and no session was started.` }
      return { text: `Stopped ${who}.${r.notice ? ` ${r.notice}` : ''}` }
    case 'deleted':
      if (r.branch === undefined) return { text: `Moved ${who} to the trash. Tell the person in one line.` }
      // The worktree folder was already gone (#715): nothing was lost, and the answer says what became of the branch
      if (r.note) return { text: `Moved ${who} to the trash. ${r.note} Tell the person in one line.` }
      return {
        text:
          (r.warning ? `Moved ${who} to the trash. Warning: ${r.warning} ` : `Cleaned up ${who}: its worktree and branch "${r.branch}" were removed and the session went to the trash. `) +
          (r.setAside.changedFiles || r.setAside.commits
            ? `${r.setAside.changedFiles} uncommitted files, ${r.setAside.commits} commits not on the trunk, kept in the trash. `
            : 'Nothing needed setting aside. ') +
          'Tell the person in one line.',
      }
    case 'at_rest':
      return {
        text:
          `${who} is not working on anything you gave it (${r.sessionState}${r.interruption ? `, ${interruptionWords(r.interruption)}` : ''}). Its last answer, as JSON:\n${trustedJsonText(r.answer || '(no final text)')}\n` +
          (r.notice ? `${r.notice}\n` : '') +
          `agent_session(sessionId="${r.sessionId}", action="send", text=…) gives it more. ${NEW_ROLE_NEW_AGENT}`,
      }
    case 'done': {
      const lines = [`${who} answered, as JSON:`, trustedJsonText(r.answer || '(no final text)')]
      if (r.notice) lines.push(r.notice)
      if (r.readable.length) lines.push(`You can read these now: ${r.readable.join(', ')}`)
      if (r.outside.length) lines.push(`Named outside its folder (not opened for you): ${r.outside.join(', ')}`)
      lines.push(`agent_session(sessionId="${r.sessionId}", action="send", text=…) continues with it. ${NEW_ROLE_NEW_AGENT}`)
      return { text: lines.join('\n') }
    }
  }
}

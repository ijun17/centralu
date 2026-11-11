import { BackgroundTaskKind, liveBackgroundTasks, type SessionInfo } from '@cc/protocol'
import { UPDATE_CONTINUE_TEXT, UPDATE_NOTE_HEAD } from '../adapters/input-receipts.js'
import { isObj } from '../json-value.js'

/**
 * What an update's stop ends in a session besides its turn, told to the agent when the next host starts (#1902,
 * docs/agent-host/lifecycle/continue-after-update.md): the background tasks its process held and the cards that waited for the person. All of it dies
 * with the process, and none of it is anything the person chose, so the agent is told which, in Centralu's own note, and
 * decides what to start or ask again. Kept in the update-resume list beside the turns (`update-resume.ts`).
 */
export type StoppedTask = { kind: BackgroundTaskKind; description: string; command?: string }

/** One session as the stop left it: `seq` is the last row of its conversation then, the mark the turns are continued by */
export type Stopped = { id: string; seq: number; tasks: StoppedTask[]; approvals: boolean; questions: string[] }

const MAX_TASKS = 20
const MAX_QUESTIONS = 5
const MAX_COMMAND = 1000
const MAX_TEXT = 500

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * What this stop ends in each live session: its running tasks (a timer too: it dies with the process; ambient housekeeping is
 * not work) with the command of the tool call that started each (`inputOf`, the stored call), and its open cards. A session
 * with neither is not listed. The mark (`seq`) is not known yet: it is the end of the conversation once the processes are down,
 * the same instant the turns are marked at, and the caller puts it on.
 */
export function stoppedAtUpdate(sessions: readonly SessionInfo[], inputOf: (sessionId: string, callId: string) => unknown): Omit<Stopped, 'seq'>[] {
  const out: Omit<Stopped, 'seq'>[] = []
  for (const s of sessions) {
    if (!s.live) continue
    const tasks = liveBackgroundTasks(s.backgroundTasks).slice(0, MAX_TASKS).map((t): StoppedTask => {
      const input = t.parentCallId ? inputOf(s.id, t.parentCallId) : undefined
      const command = isObj(input) && typeof input.command === 'string' && input.command.trim() ? clip(input.command.trim(), MAX_COMMAND) : undefined
      return { kind: t.kind, description: clip(t.description, MAX_TEXT), ...(command ? { command } : {}) }
    })
    const questions = s.pendingQuestions.flatMap((p) => p.questions.map((q) => clip(q.question, MAX_TEXT))).slice(0, MAX_QUESTIONS)
    const approvals = !!s.pendingApproval
    if (tasks.length || questions.length || approvals) out.push({ id: s.id, tasks, approvals, questions })
  }
  return out
}

/** One entry as a list holds it, or null when it is not one this build can read (another build's shape is left to it) */
export function readStopped(o: unknown): Stopped | null {
  if (!isObj(o) || typeof o.id !== 'string' || typeof o.seq !== 'number' || !Number.isSafeInteger(o.seq) || o.seq < 0) return null
  const tasks: StoppedTask[] = []
  for (const t of Array.isArray(o.tasks) ? (o.tasks as unknown[]).slice(0, MAX_TASKS) : []) {
    const kind = isObj(t) ? BackgroundTaskKind.safeParse(t.kind) : null
    if (!isObj(t) || !kind?.success || typeof t.description !== 'string') continue
    tasks.push({
      kind: kind.data,
      description: clip(t.description, MAX_TEXT),
      ...(typeof t.command === 'string' && t.command ? { command: clip(t.command, MAX_COMMAND) } : {}),
    })
  }
  const questions = Array.isArray(o.questions) ? (o.questions as unknown[]).filter((q): q is string => typeof q === 'string').slice(0, MAX_QUESTIONS).map((q) => clip(q, MAX_TEXT)) : []
  const approvals = o.approvals === true
  return { id: o.id, seq: o.seq, tasks, approvals, questions }
}

/** The line a task has in the note: one line, whatever the command holds */
function taskLine(t: StoppedTask): string {
  const what = t.command ? `${JSON.stringify(t.command)}${t.description ? ` (${t.description})` : ''}` : t.description
  return `- ${t.kind === 'agent' ? 'background agent' : t.kind === 'shell' ? 'shell command' : t.kind === 'mcp' ? 'MCP task' : 'task'}: ${what}`
}

/**
 * Centralu's note to the agent after an update stopped it (#1902), through Centralu's channel: for a turn the update cut
 * (`turn`), the Continue of #1618 with what else the stop ended; for a session at rest, only the tasks. Every card text is
 * here: its words are the owner's to approve.
 */
export function updateNote(turn: boolean, stopped: Stopped | null): string {
  const head = turn
    ? UPDATE_CONTINUE_TEXT
    : `${UPDATE_NOTE_HEAD}. Your turn had ended, but the update stopped the background work your session was running.`
  if (!stopped) return head
  const parts = [head]
  if (stopped.tasks.length) {
    parts.push(
      'The update stopped these background tasks. None of them is running now:\n' +
        `${stopped.tasks.map(taskLine).join('\n')}\n` +
        'Decide which you still need, check whether their effect is already there, and start those again.',
    )
  }
  if (stopped.approvals) {
    parts.push(
      'The update closed the permission card of your pending tool call. The person did not refuse it, whatever its result says. ' +
        'Call the tool again if you still need it.',
    )
  }
  if (stopped.questions.length) {
    parts.push(
      `The update closed ${stopped.questions.length === 1 ? 'a question' : 'these questions'} before the person answered. ` +
        `The person did not refuse ${stopped.questions.length === 1 ? 'it' : 'them'}, whatever the result says. ` +
        `Ask again if you still need the answer:\n${stopped.questions.map((q) => `- ${JSON.stringify(q)}`).join('\n')}`,
    )
  }
  return parts.join('\n\n')
}

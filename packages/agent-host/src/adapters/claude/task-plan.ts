import type { NormalizedEvent } from '@cc/protocol'
import { planUpdate } from '../plan.js'
import { asObj } from '../../json-value.js'
import { str, type Json } from './json.js'

/**
 * Claude Code's task list as the session's plan (#843), for a CLI whose plan tools are `TaskCreate`, `TaskUpdate` and
 * `TaskList` rather than `TodoWrite`. The bundled CLI turns `TodoWrite` off unless `CLAUDE_CODE_ENABLE_TASKS` is false,
 * so these are what a Centralu session gets. Unlike `TodoWrite` they carry one task per call, so the list is kept here:
 *
 *   TaskCreate {subject, description}   the task's id is only in its result: `tool_use_result.task.id`, and the text
 *                                       "Task #<id> created successfully: <subject>" (measured, CLI 2.1.223 transcripts)
 *   TaskUpdate {taskId, status?, subject?}   status `deleted` removes it
 *   TaskList {}                         its result lists every task (`tool_use_result.tasks`), which replaces the list
 *
 * A task changes the list when its call went through (an ok result), as the files a call touches do. A task the list
 * does not know (one from before this process) is added when a call names its subject, and left out otherwise.
 */
export class ClaudeTaskPlan {
  /** Task id to its step, in the order the tasks were created */
  private readonly tasks = new Map<string, { text: string; status: string }>()
  /** Calls whose result has not come yet, with what they asked */
  private readonly open = new Map<string, { name: string; input: Json }>()

  constructor(private readonly sessionId: string) {}

  /** A call was made; the plan tools are remembered until their result */
  call(callId: string, name: string, input: unknown): void {
    if (name !== 'TaskCreate' && name !== 'TaskUpdate' && name !== 'TaskList') return
    this.open.set(callId, { name, input: asObj(input) })
    if (this.open.size > 64) this.open.delete(this.open.keys().next().value!)
  }

  /**
   * A call's result: the plan, when a plan tool went through. `record` is the message's `tool_use_result` when the
   * message carries this result alone (a message has one, so with several results it names none of them for sure).
   */
  result(callId: string, ok: boolean, output: string, record: Json | undefined): NormalizedEvent[] {
    const call = this.open.get(callId)
    if (!call) return []
    this.open.delete(callId)
    if (!ok) return []
    if (call.name === 'TaskCreate') {
      const task = (record?.task ?? {}) as Json
      const id = str(task.id) || /^Task #(\S+) created/.exec(output)?.[1] || ''
      if (!id) return []
      this.tasks.set(id, { text: str(call.input.subject) || str(task.subject), status: 'pending' })
    } else if (call.name === 'TaskUpdate') {
      const id = str(call.input.taskId)
      const status = str(call.input.status)
      const known = this.tasks.get(id)
      if (status === 'deleted') this.tasks.delete(id)
      else if (known) this.tasks.set(id, { text: str(call.input.subject) || known.text, status: status || known.status })
      else if (str(call.input.subject)) this.tasks.set(id, { text: str(call.input.subject), status: status || 'pending' })
      else return []
    } else {
      if (!Array.isArray(record?.tasks)) return []
      this.tasks.clear()
      for (const t of record.tasks as Json[]) if (str(t.id)) this.tasks.set(str(t.id), { text: str(t.subject), status: str(t.status) })
    }
    return [planUpdate(this.sessionId, [...this.tasks.values()], 'text')]
  }
}

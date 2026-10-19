// The ledger's tools. Agents and the panel call the same ones (one code path); four are for agents and the panel, the
// rest only for the panel (visibility ['app']). The panel's state is `show`.
import { z } from './runtime/centralu-app-runtime.mjs'
import { BLOCKER_KINDS, LIMITS, STATES } from './model.mjs'
import { titleLine } from './triggers.mjs'

export const UI = 'ui://task-ledger/index.html'

const say = (text, structured) => ({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })

const blocker = z.object({
  kind: z.enum(BLOCKER_KINDS).describe('issue and pr: resolved when closed or merged; decision: an issue that has a "Decision (owner" comment or is closed; text: a person clears it'),
  ref: z.number().int().positive().optional().describe('The issue, pull request or decision issue number (not for text)'),
  text: z.string().max(LIMITS.blockerText).optional().describe('Words, for kind text ("Mac only")'),
})

/** One task as a line an agent reads */
export function line(t, ledger) {
  const row = t.assignee ? ledger.sessions.get(t.assignee.sessionId) : null
  const who = t.assignee ? ` · ${t.assignee.name}${row ? ` (${row.state})` : ''}` : ''
  const issue = t.issue ? ` · #${t.issue}` : ''
  const open = t.blockedBy.length ? ` · blocked by ${t.blockedBy.map((b) => (b.kind === 'text' ? `"${b.text}"` : `${b.kind} #${b.ref}`)).join(', ')}` : ''
  return `${t.id} [${t.state}] ${titleLine(t.title, 120)}${issue}${who}${open}${t.next ? ` — next: ${titleLine(t.next, 120)}` : ''}`
}

/**
 * `ledger` is the engine; `caller` gives the address of the session whose call this is (null from the panel).
 * Every tool a session calls leaves its address, so the person can make that session the responsible one.
 */
export function makeTools(ledger, { caller }) {
  const heard = (fn) => async (args) => {
    const address = caller()
    if (address) await ledger.hearAddress(address, '')
    return fn(args, address)
  }
  const failure = (r) => (r?.error ? fail(r.error) : null)

  return {
    show: {
      config: {
        title: 'Show the ledger',
        description: "Open the task ledger panel and return its state: the tasks, what needs the responsible session, who it is, and whether it is watching the project's sessions.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: { ui: { resourceUri: UI, visibility: ['app'] } },
      },
      handler: async () => {
        const v = ledger.view()
        return say(`${v.tasks.length} tasks, ${v.attention.length} need attention.`, v)
      },
    },

    ledger_list: {
      config: {
        title: 'List the tasks',
        description:
          'List this project\'s tasks with their state, assignee (and what its session is doing), blockers and next step. `attention: true` lists only what needs the responsible session now. Read this before assigning or changing a task.',
        inputSchema: z.object({ state: z.enum(STATES).optional(), attention: z.boolean().optional() }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      handler: heard(async ({ state, attention }) => {
        const v = ledger.view()
        const needing = new Set(v.attention.map((a) => a.taskId))
        // Done tasks are listed only when asked for
        const tasks = v.tasks.filter((t) => (state ? t.state === state : t.state !== 'done') && (!attention || needing.has(t.id)))
        const text = [
          v.responsible ? `Responsible: ${v.responsible.label || v.responsible.sessionId.slice(0, 8)}` : 'Nobody is responsible yet (a session takes charge with ledger_take_charge).',
          ...v.attention.map((a) => `NEEDS YOU ${a.taskId}: ${a.detail}`),
          ...(tasks.length ? tasks.map((t) => line(ledger.get(t.id), ledger)) : ['No tasks.']),
        ].join('\n')
        return say(text, {
          responsible: v.responsible,
          attention: v.attention,
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, state: t.state, issue: t.issue, next: t.next, assignee: t.assignee, assigneeState: t.assigneeState, blockers: t.blockers })),
        })
      }),
    },

    ledger_add: {
      config: {
        title: 'Add a task',
        description:
          'Add a task: a title, optionally its state (ready by default, blocked when it has blockers), next step, notes, the GitHub issue it is, blockers, and the session doing it. A task linked to an issue takes its title from the issue.',
        inputSchema: z.object({
          title: z.string().max(LIMITS.title * 2),
          state: z.enum(STATES).optional(),
          next: z.string().optional(),
          notes: z.string().optional(),
          issue: z.number().int().positive().optional(),
          blockedBy: z.array(blocker).max(LIMITS.blockers).optional(),
          assignee: z.string().optional().describe('The id of the session doing it, or "me"'),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      handler: heard(async (args, address) => {
        const assignee = resolveAssignee(ledger, args.assignee, address)
        if (assignee?.error) return fail(assignee.error)
        const r = await ledger.add({ ...args, assignee: assignee ?? null })
        return failure(r) ?? say(`Added ${line(r.task, ledger)}`, { task: r.task })
      }),
    },

    ledger_update: {
      config: {
        title: 'Change a task',
        description:
          'Change a task: any of title, state, next, notes, issue (null unlinks), blockedBy (the whole list), assignee (a session id, "me", or null). Changing a task also marks it seen, so what was waiting on the responsible session (a new answer, "unblocked") stops being listed. `seen: true` alone marks it seen. `remove: true` deletes the task. A linked task\'s title follows its issue.',
        inputSchema: z.object({
          id: z.string().describe('The task id, like T12'),
          title: z.string().optional(),
          state: z.enum(STATES).optional(),
          next: z.string().optional(),
          notes: z.string().optional(),
          issue: z.number().int().positive().nullable().optional(),
          blockedBy: z.array(blocker).max(LIMITS.blockers).optional(),
          assignee: z.string().nullable().optional(),
          seen: z.boolean().optional(),
          remove: z.boolean().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      // `seen` is the same as a change that changes nothing: whoever changes a task has looked at it
      handler: heard(async ({ id, seen: _seen, remove, ...patch }, address) => {
        if (remove) {
          const r = await ledger.remove(id)
          return failure(r) ?? say(`Removed ${r.task.id} ${titleLine(r.task.title)}.`)
        }
        const assignee = patch.assignee === undefined ? undefined : resolveAssignee(ledger, patch.assignee, address)
        if (assignee?.error) return fail(assignee.error)
        const given = { ...patch }
        if (assignee !== undefined) given.assignee = assignee
        for (const k of Object.keys(given)) if (given[k] === undefined) delete given[k]
        const r = await ledger.update(id, given)
        return failure(r) ?? say(`${line(r.task, ledger)}${r.changed ? '' : ' (nothing changed)'}`, { task: r.task })
      }),
    },

    ledger_take_charge: {
      config: {
        title: 'Take charge of the ledger',
        description:
          'Become the session the ledger tells: it posts one message here when a ready task has no assignee, an assignee finished or stopped to ask, what blocked a task is resolved, or an assignee has been quiet too long. One session is responsible per project. Call it from the session that should hear (usually the orchestrator).',
        inputSchema: z.object({ label: z.string().max(LIMITS.label).optional().describe('How the panel names this session, like "orchestrator"') }),
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      handler: async ({ label }) => {
        const address = caller()
        if (!address) return fail('Only a session can take charge: call this from a session, not from the panel.')
        const r = await ledger.takeCharge(address, label ?? '')
        return failure(r) ?? say(`This session is now responsible for the ledger${label ? ` (${label})` : ''}. It will be told once per change.`)
      },
    },

    ledger_settings: {
      config: {
        title: 'Ledger settings',
        description: 'The panel\'s settings: quietMinutes, sweepMinutes, github { on, repo }, and responsible (a session id that has used the ledger, or null for nobody).',
        inputSchema: z.object({
          quietMinutes: z.number().optional(),
          sweepMinutes: z.number().optional(),
          github: z.object({ on: z.boolean().optional(), repo: z.string().nullable().optional() }).optional(),
          responsible: z.string().nullable().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false },
        _meta: { ui: { visibility: ['app'] } },
      },
      handler: async ({ responsible, ...rest }) => {
        if (typeof responsible === 'string') {
          const r = await ledger.chooseResponsible(responsible)
          if (r.error) return fail(r.error)
        }
        const patch = { ...rest, ...(responsible === null ? { responsible: null } : {}) }
        if (Object.keys(patch).length) {
          const r = await ledger.settings(patch)
          if (r.error) return fail(r.error)
        }
        return say('Saved.')
      },
    },

    ledger_adopt: {
      config: {
        title: 'Add tasks from issues',
        description: 'Add a task for each of these open GitHub issues the panel offered.',
        inputSchema: z.object({ issues: z.array(z.number().int().positive()).max(100) }),
        annotations: { readOnlyHint: false, destructiveHint: false },
        _meta: { ui: { visibility: ['app'] } },
      },
      handler: async ({ issues }) => {
        const r = await ledger.adopt(issues)
        return say(`Added ${r.added.length}: ${r.added.join(', ') || 'none'}.`, r)
      },
    },

    ledger_sweep: {
      config: {
        title: 'Check now',
        description: 'Read GitHub and the sessions now, move what they settle, and tell the responsible session what is due.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        _meta: { ui: { visibility: ['app'] } },
      },
      handler: async () => {
        const swept = await ledger.sweep()
        const told = await ledger.flush({ force: true })
        return say(swept.ok ? `Checked. ${told.sent ? `Told the responsible session of ${told.sent}.` : ''}` : `GitHub could not be read: ${swept.error}`, { ...swept, told })
      },
    },
  }
}

/** "me" is the calling session; a session id stays; null is nobody. A name is the one the session has, or its id */
function resolveAssignee(ledger, given, address) {
  if (given === undefined || given === null) return given === null ? null : undefined
  let sessionId = given
  if (given === 'me') {
    if (!address) return { error: '"me" is the calling session, and this call is not from a session.' }
    sessionId = address.slice(0, address.lastIndexOf('.'))
  }
  const row = ledger.sessions.get(sessionId)
  if (!row && ledger.complete && given !== 'me') return { error: `There is no session ${sessionId} in this project (ledger_list shows the assignees it knows).` }
  return { sessionId, name: row?.name ?? ledger.ledger.addresses[sessionId]?.label ?? sessionId.slice(0, 8) }
}

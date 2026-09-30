import { z } from 'zod'
import { randomUUID } from 'node:crypto'
// The document's shape is one shared set with the UI's half (M4 P-5) — it used to be defined
// separately here, with `notifies` required. Trusting that and reading a document the UI had written
// without a notifies field crashed. Every field is now optional.
import type { ControlDoc, ControlNotify, ControlTask } from '@cc/protocol'
import type { HostAppModule, HostAppContext, AppToolCaller, ToolOutput } from './contract.js'

/**
 * The host half of the control app (#80, #81) — the rail's notifications, declarative watches, and
 * **tasks**.
 *
 * The entire concept of "task and foreman" lives in this one file (the app). What the core provides
 * is exactly two nameless physical primitives (a scope allowlist, pinning a role text), and this file
 * gives them their meaning — turning the app off degrades an already-created coordination session
 * gracefully into a plain, consistent core object, "a coordination session with its scope cut off"
 * (#81's ownership boundary).
 */

/** The cap on stored notifications — an old notification the person never dismissed must not grow the document without bound */
const NOTIFY_CAP = 50

/**
 * The foreman's role text — pinned to a session's row at creation time (core handle ②).
 *
 * Two core requirements (specified by the user): **filtering what it hears** — forwarding a member's
 * report verbatim makes the foreman a megaphone, not a foreman — and **the board is its memory** — a
 * conversation disappears once compacted, so state is materialized through board_update instead
 * (mirrors the manager guideline's "only an assignment written to a file survives").
 */
export function taskRole(taskId: string, title: string, goal: string): string {
  return [
    `You are the foreman of the task "${title}". Goal: ${goal}`,
    `Task id: ${taskId} — this is the taskId for board_read/board_update.`,
    '',
    'Rules:',
    '- Split the work among the member sessions (send_to_session, reportBack recommended), and **filter what you hear** —',
    '  if you trust a member\'s "done" without checking and pass it along, you are a megaphone, not a foreman.',
    '  When in doubt, check the actual work with read_session, and have it redone if needed.',
    '- **The board is your memory.** Materialize stages, assignments, decisions, and outputs through board_update as they happen —',
    '  your conversation disappears once compacted, but the board remains. When you wake up, start with board_read.',
    '- Put anything the person needs to see (a block, a scope decision, completion) on the rail with control_notify.',
    '- When the task is done, close it with control_task_done — after leaving a final summary on the board.',
    '- Your view extends only to the members assigned to you. If you need anything beyond that, report it to the person.',
    '- Answer in the language the person writes in.',
  ].join('\n')
}

const BOARD_TEMPLATE = (title: string, goal: string, members: string[]) =>
  [
    `# Task board: ${title}`,
    '',
    `## Goal`,
    goal,
    '',
    `## Members`,
    ...members.map((m) => `- ${m}`),
    '',
    '## Stages',
    '(filled in by the foreman)',
    '',
    '## Decisions and outputs',
    '(filled in by the foreman)',
  ].join('\n')

function readDoc(ctx: HostAppContext): ControlDoc {
  return ctx.kv.get<ControlDoc>('doc') ?? { notifies: [] }
}

/** Also works on a document with no notifies field (one the UI wrote first) — an absent field means zero notifications */
function pushNotify(doc: ControlDoc, n: Omit<ControlNotify, 'id' | 'ts'>): void {
  const all = [...(doc.notifies ?? []), { id: randomUUID(), ts: Date.now(), ...n }]
  doc.notifies = all.length > NOTIFY_CAP ? all.slice(-NOTIFY_CAP) : all
}

/** Validates access to the board — only that task's foreman or a person (null). Someone else's task board belongs to them */
function boardDenied(task: ControlTask | undefined, caller: AppToolCaller): ToolOutput | null {
  if (!task) return { text: 'No such task exists', isError: true }
  if (caller.sessionId !== null && caller.sessionId !== task.coordinatorId && caller.profile !== 'orchestrator') {
    return { text: 'Only this task\'s foreman can touch the board', isError: true }
  }
  return null
}

export const controlHostApp: HostAppModule = {
  id: 'control',
  /** The foreman sessions of the tasks in our document belong to us (rows created before the appId column existed) */
  claimSessions: (ctx) => readDoc(ctx).tasks?.map((t) => t.coordinatorId).filter(Boolean) ?? [],
  tools: {
    // scoped (the foreman) also uses notify and the board — calling out to a person and remembering are half of what being a foreman is
    profiles: ['orchestrator', 'manager', 'scoped'],
    defs: [
      {
        name: 'control_notify',
        description:
          'Puts a notification on the person\'s control rail (the my-turn queue) — for when something needs the person\'s attention but it does not show up in session state (approval, question). ' +
          'For example: a session is blocked on an external condition, or a decision spanning multiple sessions is needed. A person reads and dismisses the notification — you can only put it there.',
        schema: z.object({
          text: z.string().describe('One line for the person to read — what it is, and why it needs a person'),
          sessionId: z.string().optional().describe('The related session id — if given, the rail can jump straight to that session'),
          priority: z.enum(['high', 'normal']).optional().describe('high goes to the top of the line. Defaults to normal'),
        }),
      },
      {
        name: 'control_create_task',
        description:
          'Creates a task: bundles member sessions together, and a foreman (a coordinating session) that sees only that task stands up. ' +
          'Use this when work spanning multiple sessions should be handed to a foreman instead of relayed by a person. The foreman writes status to the board, and calls the person to the rail when needed.',
        schema: z.object({
          title: z.string().describe('The task name — becomes the foreman session\'s name'),
          goal: z.string().describe('The task\'s goal — baked into the foreman\'s role text'),
          memberSessionIds: z.array(z.string()).min(1).describe('The member worker session ids (the [id] from list_sessions)'),
        }),
        // Never even exposed to a foreman (scoped) — a structural guarantee that depth stays at 1 (doubled up with the check on the execution side)
        profiles: ['orchestrator'],
      },
      {
        name: 'board_read',
        description: 'Reads the task board — the foreman\'s memory and the person\'s status board. A foreman that just woke up starts with this.',
        schema: z.object({ taskId: z.string().describe('The task id (written in the role text)') }),
        profiles: ['orchestrator', 'scoped'],
      },
      {
        name: 'board_update',
        description:
          'Replaces the task board wholesale — materialize stages, assignments, decisions, and outputs as they happen. The conversation disappears once compacted, but the board remains.',
        schema: z.object({
          taskId: z.string().describe('The task id'),
          content: z.string().describe('The full board text (markdown) — a full replacement, not a partial edit'),
        }),
        profiles: ['scoped'],
      },
      {
        name: 'control_task_done',
        description: 'Closes the task — call this after leaving a final summary on the board. A completion notification goes up on the person\'s rail.',
        schema: z.object({
          taskId: z.string().describe('The task id'),
          summary: z.string().optional().describe('A one-line closing report — carried in the rail notification'),
        }),
        profiles: ['scoped'],
      },
    ],

    async run(ctx, name, args, caller) {
      const doc = readDoc(ctx)

      if (name === 'control_notify') {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined
        if (sessionId && !ctx.sessionSummary(sessionId)) {
          return { text: `No such session: ${sessionId}`, isError: true }
        }
        pushNotify(doc, {
          text: String(args.text ?? ''),
          ...(sessionId ? { sessionId } : {}),
          ...(args.priority === 'high' ? { priority: 'high' as const } : {}),
        })
        ctx.kv.set('doc', doc)
        ctx.emitChanged()
        return { text: 'Put the notification on the control rail. Only a person dismisses it.' }
      }

      if (name === 'control_create_task') {
        // A foreman is something created, not a creator — if scoped could call this tool, depth would grow.
        // This is already filtered out at profile exposure, but the execution side repeats the same check (the #69 rule).
        if (caller.profile === 'scoped') return { text: 'A foreman cannot create a task', isError: true }
        const members = args.memberSessionIds as string[]
        for (const id of members) {
          if (!ctx.sessionSummary(id)) return { text: `No such member session: ${id}`, isError: true }
        }
        const taskId = randomUUID().slice(0, 8)
        const title = String(args.title ?? '').trim() || 'Untitled task'
        const goal = String(args.goal ?? '').trim()
        const foreman = doc.foreman ?? { tool: 'claude' as const, effort: 'high' }
        const coordinator = await ctx.sessions.createCoordinator({
          name: title,
          memberSessionIds: members,
          roleAppend: taskRole(taskId, title, goal),
          tool: foreman.tool,
          model: foreman.model,
          effort: foreman.effort ?? 'high',
        })
        ctx.kv.set(`board:${taskId}`, BOARD_TEMPLATE(title, goal, members.map((m) => ctx.sessionSummary(m)?.name ?? m)))
        /*
         * The document is re-read **after** waiting (#178). The await for starting the foreman session
         * runs into the seconds, since it waits for Codex's app-server to become ready. In that window,
         * another session's notification, a watch hit, a notification a person dismissed, or another
         * task created concurrently can all land in the document — and overwriting it wholesale with the
         * copy read above would revert every one of those. Since this tool only ever adds one task to
         * the document, only that one line is layered on top of the current document instead.
         */
        const fresh = readDoc(ctx)
        fresh.tasks = [
          ...(fresh.tasks ?? []),
          { id: taskId, title, goal, members, coordinatorId: coordinator.id, status: 'active', createdAt: Date.now() },
        ]
        ctx.kv.set('doc', fresh)
        ctx.emitChanged()
        return {
          text:
            `Created the task "${title}" (id: ${taskId}). Foreman session [${coordinator.id}] is coordinating ${members.length} member(s). ` +
            'Send the foreman its first instruction to get things started.',
        }
      }

      if (name === 'board_read') {
        const task = (doc.tasks ?? []).find((t) => t.id === args.taskId)
        const denied = boardDenied(task, caller)
        if (denied) return denied
        const board = ctx.kv.get<string>(`board:${task!.id}`) ?? '(The board is empty)'
        return { text: board }
      }

      if (name === 'board_update') {
        const task = (doc.tasks ?? []).find((t) => t.id === args.taskId)
        const denied = boardDenied(task, caller)
        if (denied) return denied
        ctx.kv.set(`board:${task!.id}`, String(args.content ?? ''))
        ctx.emitChanged()
        return { text: 'Updated the board.' }
      }

      if (name === 'control_task_done') {
        const task = (doc.tasks ?? []).find((t) => t.id === args.taskId)
        const denied = boardDenied(task, caller)
        if (denied) return denied
        task!.status = 'done'
        pushNotify(doc, {
          text: `✅ Task done: ${task!.title}${args.summary ? ` — ${String(args.summary)}` : ''}`,
          sessionId: task!.coordinatorId,
          priority: 'high',
        })
        ctx.kv.set('doc', doc)
        ctx.emitChanged()
        return { text: 'Closed the task. A completion notification is up on the person\'s rail.' }
      }

      return { text: `Unknown tool: ${name}`, isError: true }
    },
  },

  observe(ctx, e) {
    if (e.type !== 'tool_call' || !e.sessionId) return
    const doc = ctx.kv.get<ControlDoc>('doc')
    const watches = doc?.watches ?? []
    if (watches.length === 0) return // With no watches, this hook must cost nothing — it ends after a single kv read
    const line = `${e.summary.tool}: ${e.summary.title} ${(e.summary.paths ?? []).join(' ')}`.toLowerCase()
    const hits = watches.filter(
      (w) =>
        w.pattern.trim() &&
        (!w.sessionId || w.sessionId === e.sessionId) &&
        line.includes(w.pattern.trim().toLowerCase()),
    )
    if (hits.length === 0) return
    const name = ctx.sessionSummary(e.sessionId)?.name ?? e.sessionId
    const next: ControlDoc = doc ?? { notifies: [] }
    for (const w of hits) {
      pushNotify(next, { text: `⏱ ${w.pattern} — ${name}: ${e.summary.title}`, sessionId: e.sessionId, priority: 'high' })
    }
    ctx.kv.set('doc', next)
    ctx.emitChanged()
  },
}

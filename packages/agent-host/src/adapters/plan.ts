import type { NormalizedEvent } from '@cc/protocol'
import { asObj } from '../json-value.js'

type PlanStep = { text: string; status: 'pending' | 'inProgress' | 'completed' }

/**
 * A step's status in the protocol's words. Codex says `inProgress` (generated v2 `TurnPlanStepStatus`), Claude's
 * TodoWrite `in_progress`. An unknown status falls back to pending — progress display must not die outright over one
 * new status value.
 */
function stepStatus(raw: unknown): PlanStep['status'] {
  if (raw === 'inProgress' || raw === 'in_progress') return 'inProgress'
  return raw === 'completed' ? 'completed' : 'pending'
}

/**
 * The agent's plan as the screen's checklist (#58, #843): a whole snapshot each time, from the raw steps a tool sends
 * and the field each names its step by. Both adapters build it here, so a status means the same on both.
 */
export function planUpdate(sessionId: string, raw: unknown, textField: string): NormalizedEvent {
  const steps = (Array.isArray(raw) ? raw : []).map((s): PlanStep => {
    const it = asObj(s)
    const text = it[textField]
    return { text: typeof text === 'string' ? text : '', status: stepStatus(it.status) }
  })
  return { type: 'plan_update', sessionId, steps }
}

/**
 * Claude Code's plan: its `TodoWrite` call, whose input is the whole list (`{todos: [{content, status, activeForm}]}`,
 * measured in transcripts of CLI 2.1.233 to 2.1.289). Codex's `turn/plan/updated` was the only plan the panel ever
 * showed; a Claude session's todo list stayed a tool card. An emptied list clears the panel.
 */
export function todoWritePlan(sessionId: string, name: string, input: unknown): NormalizedEvent[] {
  if (name !== 'TodoWrite') return []
  const todos = asObj(input).todos
  return Array.isArray(todos) ? [planUpdate(sessionId, todos, 'content')] : []
}

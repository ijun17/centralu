import { expect, test, type Page } from '@playwright/test'
import { analyse, budgetBreaches, type Budget, type Hand, type PendingTask, type Point, type TaskResult } from './klm.js'
import { Recorder } from './recorder.js'

/**
 * What a task is (#518, docs/ux-metrics.md "Writing a task"): a start state, the operations a
 * person does, and a checked goal.
 *
 * - `start` brings the app to the state the task begins in. It is not measured, so it may use any
 *   shortcut (the mock's handles, the store).
 * - `run` is the task. Everything in it goes through the recorder.
 * - `goal` checks that the task got where it was going: "the session is running", "the approval
 *   is answered". Its wait is the task's last R.
 * - `budget` is optional: upper bounds that fail the run when exceeded.
 */
export type UxTask = {
  /** `<task>.<path>`, e.g. `switch-session.keyboard` */
  id: string
  /** The task in a person's words */
  task: string
  path: TaskResult['path']
  /** Where the hand is when the task starts. Keyboard unless the task says otherwise: see docs/ux-metrics.md */
  hand?: Hand
  /** Where the pointer is when the task starts. The middle of the window unless the task says otherwise */
  pointer?: Point
  start: (page: Page) => Promise<void>
  run: (u: Recorder, page: Page) => Promise<void>
  goal: (page: Page) => Promise<void>
  budget?: Budget
  /** Anything a reader of the numbers needs to know (what the path leaves out, what it assumes) */
  notes?: string[]
}

/** The name the result travels under, from the test to the reporter (reporter.ts) */
export const UX_ATTACHMENT = 'ux-task'
export const UX_PENDING = 'ux-pending'

export function uxTask(t: UxTask): void {
  test(`${t.id}: ${t.task}`, async ({ page }, info) => {
    await t.start(page)
    const u = new Recorder(page)
    await u.begin(t.pointer)
    await t.run(u, page)
    await u.until('goal', () => t.goal(page))
    const base = analyse({ id: t.id, task: t.task, path: t.path, notes: t.notes }, u.steps(), t.hand ?? 'keyboard')
    const result: TaskResult = { ...base, notes: [...base.notes, ...u.warnings], breaches: budgetBreaches(base, t.budget) }
    await info.attach(UX_ATTACHMENT, { body: JSON.stringify(result), contentType: 'application/json' })
    expect(result.breaches, `${t.id} went over its budget; the operators were \`${result.operators}\``).toEqual([])
  })
}

/**
 * A task whose feature is not merged yet: listed in the report as pending, so the baseline says
 * what it does not cover. Replace it with a `uxTask` in the pull request that lands the feature.
 */
export function uxPending(p: PendingTask): void {
  test(`${p.id}: ${p.task}`, { annotation: { type: UX_PENDING, description: JSON.stringify(p) } }, () => {
    test.skip(true, `waiting on ${p.waitingOn}: ${p.reason}`)
  })
}

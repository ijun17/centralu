import type { Page } from '@playwright/test'
import { newSession as sharedNewSession, setup as sharedSetup } from './control.js'

/**
 * Shared helpers of the panel-*.spec.ts scenarios: the right-hand panel and the usage modal —
 * "what does the screen show when several things are up at once."
 *
 * panel.spec.ts was split from control-loop.spec.ts by subject. That file watched whether one lap
 * of the control loop runs; this one watched **what the screen picks when several things exist at
 * the same time** (#26, #21). It was then split again by subject into panel-*.spec.ts.
 */

/** The first run with one project registered (control.ts's `setup`) */
export const setup = (page: Page, path = '/tmp/alpha') => sharedSetup(page, { projects: [path] })

/** Creates a session with `tool` and sends `prompt` (control.ts's `newSession`); resolves to its id */
export const newSession = (page: Page, project: string, tool: 'claude' | 'codex', prompt: string): Promise<string> =>
  sharedNewSession(page, project, prompt, { tool })

export async function openGrid(page: Page, ids: string[]) {
  await page.evaluate(
    (l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))),
    ids,
  )
  await page.getByTestId('grid-button').click()
}

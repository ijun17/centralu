import { expect, type Page } from '@playwright/test'

/**
 * Shared helpers of the panel-*.spec.ts scenarios: the right-hand panel and the usage modal —
 * "what does the screen show when several things are up at once."
 *
 * panel.spec.ts was split from control-loop.spec.ts by subject. That file watched whether one lap
 * of the control loop runs; this one watched **what the screen picks when several things exist at
 * the same time** (#26, #21). It was then split again by subject into panel-*.spec.ts.
 */

export async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  // With zero projects there is no sidebar — the first project is registered from the startup guide
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  // Registering a project the first time leads straight into creating a session — this test
  // only needs the project, so close it
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

/** Creates a session and returns its id */
export async function newSession(
  page: Page,
  project: string,
  tool: 'claude' | 'codex',
  prompt: string,
): Promise<string> {
  await page.getByTestId(`project-menu-${project}`).click()
  await page.getByTestId(`new-session-${project}`).click()
  await page.getByTestId(`tool-option-${tool}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes through the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

export async function openGrid(page: Page, ids: string[]) {
  await page.evaluate(
    (l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))),
    ids,
  )
  await page.getByTestId('grid-button').click()
}

import type { Page } from '@playwright/test'

/**
 * Opens every folded run of thinking and tool calls on the page (#2007). A conversation folds them into one line a run,
 * so a scenario that reads a tool card or a reasoning row presses the line first, as a person does.
 */
export async function openFolds(page: Page): Promise<void> {
  const lines = page.locator('[data-testid=fold-line]')
  await lines.first().waitFor()
  const closed = page.locator('[data-testid=fold-line][aria-expanded=false]')
  // One at a time: opening a run can bring the next one's line into the window or push it out of it
  for (let guard = 0; guard < 50 && (await closed.count()) > 0; guard++) await closed.first().click()
}

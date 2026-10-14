import { expect, type Page } from '@playwright/test'
import { uxTask } from './task.js'

/**
 * Folding what stands under a session in the sidebar (#666): its chevron, in the gutter left of the row, is the
 * discoverable path (a visible control with a tooltip that says what it does). Left and Right on the focused row are
 * the shortcut for people who know them, and are not measured here: a shortcut is never the evidence that a task is
 * cheap (docs/usability.md).
 *
 * The `?demo` scene has no session that started others, so the start state gives one two children.
 */

const PARENT = 'Finish the collapsed composer'

async function parentWithKids(page: Page, folded: boolean): Promise<string> {
  await page.goto('/?demo')
  await expect(page.getByTestId('project-centralu')).toBeVisible()
  const id = await page.evaluate((name) => {
    const m = (window as any).__mock
    const parent = [...m.sessions.values()].find((s: any) => s.name === name)
    for (const i of [1, 2]) {
      m.emit({
        type: 'session_created',
        sessionId: `fold-kid-${i}`,
        session: { ...parent, id: `fold-kid-${i}`, name: `helper ${i}`, worktree: null, parentSessionId: parent.id, askedBy: parent.id },
      })
    }
    return parent.id as string
  }, PARENT)
  await expect(page.getByTestId('session-row-fold-kid-1')).toBeVisible()
  if (folded) {
    await page.evaluate((key) => (window as any).__store.getState().setGroupsFolded([key], true), `session:${id}`)
    await expect(page.getByTestId('session-row-fold-kid-1')).toHaveCount(0)
  }
  return id
}

uxTask({
  id: 'fold-children.mouse',
  task: 'Hide the sessions a session started, to shorten the sidebar',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The chevron is always visible on a row that has children; its tooltip names the count it hides'],
  start: async (page) => {
    await parentWithKids(page, false)
  },
  run: async (u, page) => {
    const id = await page.evaluate((name) => ([...(window as any).__mock.sessions.values()].find((s: any) => s.name === name) as any).id as string, PARENT)
    await u.click(page.getByTestId(`children-fold-${id}`), { label: 'fold-children' })
  },
  goal: async (page) => {
    await expect(page.getByTestId('session-row-fold-kid-1')).toHaveCount(0)
    await expect(page.getByTestId(/^children-folded-.*-count$/)).toHaveText('2')
  },
  budget: { operators: 7, M: 1, seconds: 3.7 },
})

uxTask({
  id: 'unfold-children.mouse',
  task: 'Show the sessions a folded session started',
  path: 'mouse',
  access: 'discoverable',
  notes: ['The folded row shows its count, so the person sees there is something to open'],
  start: async (page) => {
    await parentWithKids(page, true)
  },
  run: async (u, page) => {
    const id = await page.evaluate((name) => ([...(window as any).__mock.sessions.values()].find((s: any) => s.name === name) as any).id as string, PARENT)
    await u.click(page.getByTestId(`children-fold-${id}`), { label: 'unfold-children' })
  },
  goal: async (page) => expect(page.getByTestId('session-row-fold-kid-1')).toBeVisible(),
  budget: { operators: 7, M: 1, seconds: 3.7 },
})

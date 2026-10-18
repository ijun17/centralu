import { expect, type Page } from '@playwright/test'

/*
 * Starting a session (owner, 2026-10-18): the project's ⋯ menu has one New session, and it starts the session at once
 * with what the project remembers (`startSessionNow`); the sidebar's + is gone. The window with the options (the tool,
 * a past conversation, a worktree) opens from the palette's New session, a worktree proposal, or when no tool can run.
 */

const sessionIds = (page: Page) =>
  page.evaluate(() => Object.keys((window as any).__store.getState().sessions) as string[])

/** Starts a session in the project from its menu, as a person does, and returns it once it is on screen */
export async function startSession(page: Page, projectName: string): Promise<string> {
  const before = new Set(await sessionIds(page))
  await page.getByTestId(`project-menu-${projectName}`).click()
  await page.getByTestId(`new-session-${projectName}`).click()
  let made = ''
  await expect
    .poll(async () => {
      made = (await sessionIds(page)).find((id) => !before.has(id)) ?? ''
      return made
    })
    .not.toBe('')
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId as string | null))
    .toBe(made)
  return made
}

/**
 * Opens the new-session window for the project, for a test about what the window offers. It goes through the store's
 * `openNewSession`, the action behind each of the window's doors (the palette, a worktree proposal, a start that found
 * no tool to run); the palette's door is checked on its own in discoverable-entries.spec.ts.
 */
export async function openSessionDialog(page: Page, projectName: string): Promise<void> {
  await page.evaluate((name) => {
    const st = (window as any).__store.getState()
    const project = (Object.values(st.projects) as { id: string; name: string }[]).find((p) => p.name === name)
    if (!project) throw new Error(`no project named ${name}`)
    st.openNewSession(project.id)
  }, projectName)
  await expect(page.getByTestId('new-session-dialog')).toBeVisible()
}

import { expect } from '@playwright/test'
import { uxTask } from './task.js'

uxTask({
  id: 'project-panel.mouse',
  task: 'Add a session panel to an empty project screen',
  path: 'mouse',
  access: 'discoverable',
  notes: ["The empty state's sidebar-drag hint explains the gesture; the sidebar row is the visible source"],
  start: async (page) => {
    await page.goto('/?demo')
    await page.getByTestId('project-header-centralu').click()
    await expect(page.getByTestId('project-empty')).toContainText("Drag this project's sessions and apps here from the sidebar")
  },
  run: async (u, page) => {
    await u.drag(
      page.getByTestId('project-centralu').getByTestId(/^session-row-/).filter({ hasText: 'Finish the collapsed composer' }),
      page.getByTestId('project-empty'),
    )
  },
  goal: async (page) => expect(page.getByTestId(/^project-panel-session:/).filter({ hasText: 'Finish the collapsed composer' })).toBeVisible(),
  budget: { operators: 6, M: 1, seconds: 4.2 },
})

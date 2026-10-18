import { expect, test, type Page } from '@playwright/test'
import { setup } from './fixtures/project-screen.js'

async function workingCodex(page: Page) {
  await setup(page, ['/tmp/alpha', '/tmp/beta'])
  return page.evaluate(async () => {
    const { __mock: mock, __store: store } = window as any
    const project = Object.values(store.getState().projects).find((p: any) => p.name === 'alpha') as any
    const session = await mock.agents.createSession({ projectId: project.id, tool: 'codex', permissionPreset: 'normal' })
    mock.emit({ type: 'message_delta', sessionId: session.id, role: 'assistant', text: 'Still running' })
    return session.id as string
  })
}

test('a background Codex session keeps its answering look when re-attachment overtakes the host swap snapshot', async ({ page }) => {
  const id = await workingCodex(page)
  const mark = page.getByTestId(`session-row-${id}`).getByTestId('tool-mark-codex')
  await expect(mark).toHaveAttribute('data-look', 'answering')
  await page.evaluate(async (sessionId) => {
    const { __mock: mock, __store: store } = window as any
    mock.setConnectionState('disconnected')
    const session = mock.sessions.get(sessionId)
    session.state = 'idle'
    session.live = false
    const real = mock.agents.listSessions
    let release!: () => void
    let asked!: () => void
    const listed = new Promise<void>((resolve) => { asked = resolve })
    mock.agents.listSessions = async () => {
      mock.agents.listSessions = real
      const snapshot = await real()
      const gate = new Promise<void>((resolve) => { release = resolve })
      asked()
      await gate
      return snapshot
    }
    const recovery = store.getState().recoverAfterReconnect(true)
    await listed
    session.state = 'working'
    mock.emit({ type: 'session_live', sessionId, live: true })
    mock.emit({ type: 'state_change', sessionId, state: 'working', reason: 'reattached' })
    release()
    await recovery
  }, id)
  expect(await page.evaluate(() => (window as any).__mock.resumeCalls)).toEqual([])
  await expect(mark).toHaveAttribute('data-state', 'working')
  await expect(mark).toHaveAttribute('data-look', 'answering')
  await expect(mark).not.toHaveAttribute('data-asleep')
})

test('the tool mark explains its state with a rendered tooltip, and leaves sleep out', async ({ page }) => {
  const id = await workingCodex(page)
  const mark = page.getByTestId(`session-row-${id}`).getByTestId('tool-mark-codex')
  await mark.hover()
  const tip = page.getByTestId('tool-mark-tip-codex')
  await expect(tip).toBeVisible()
  await expect(tip).toHaveText('Codex · Working')
  await expect(mark).not.toHaveAttribute('title')
  // Read the new state in place without moving the pointer away and back.
  await page.evaluate((sessionId) => {
    const mock = (window as any).__mock
    mock.emit({ type: 'state_change', sessionId, state: 'idle' })
    mock.emit({ type: 'session_live', sessionId, live: false, reason: 'asleep' })
  }, id)
  // Sleep is not shown, not even here (owner, 2026-10-18)
  await expect(mark).toHaveAttribute('data-asleep', 'true')
  await expect(tip).toHaveText('Codex · Idle')
  await page.getByTestId('project-header-beta').hover()
  await expect(tip).toBeHidden()
})

test('a long session name leaves the tool mark and its hover area unobstructed', async ({ page }) => {
  const id = await workingCodex(page)
  const row = page.getByTestId(`session-row-${id}`)
  const mark = row.getByTestId('tool-mark-codex')
  for (const length of [40, 200, 2000]) {
    const name = 'Long session name '.repeat(Math.ceil(length / 18)).slice(0, length)
    await page.evaluate(({ sessionId, name }) => (window as any).__store.getState().rename(sessionId, name), { sessionId: id, name })
    const label = row.getByText(name, { exact: true })
    await expect(label).toBeVisible()
    const markBox = (await mark.boundingBox())!
    const labelBox = (await label.boundingBox())!
    expect(labelBox.x, `name length ${length}`).toBeGreaterThanOrEqual(markBox.x + markBox.width)
    // The right edge was covered by the name when the tooltip's flex item shrank.
    await page.mouse.move(markBox.x + markBox.width - 1, markBox.y + markBox.height / 2)
    await expect(page.getByTestId('tool-mark-tip-codex')).toBeVisible()
    await page.getByTestId('project-header-beta').hover()
  }
})

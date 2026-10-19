import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

/**
 * The task ledger's panel (.centralu/apps/task-ledger/ui/index.html, docs/plans/task-ledger.md §3), the real page with a
 * stand-in for the MCP App bridge Centralu inlines: the bridge answers the panel's tool calls from a small state held in
 * the page, and `window.__changed()` is Centralu's "a tool changed something" notification. What the panel does with that
 * state is what is tested: it must not take away what the person is writing, must show what they just did, and must work
 * at the width of a grid panel.
 */

const PAGE = readFileSync(fileURLToPath(new URL('../.centralu/apps/task-ledger/ui/index.html', import.meta.url)), 'utf8')

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  state: 'ready',
  stateSince: 1,
  blockedBy: [],
  blockers: [],
  next: '',
  notes: '',
  issue: null,
  assignee: null,
  assigneeState: null,
  attention: [],
  ...over,
})

const STATE = () => ({
  project: 'proj',
  now: Date.now(),
  tasks: [
    task('T1', { title: 'Fix login', attention: [{ kind: 'unassigned', detail: 'ready, nobody is assigned', told: 'sent' }] }),
    task('T2', {
      title: 'Mac checks',
      state: 'running',
      next: 'run the specs',
      assignee: { sessionId: 's1', name: 'a-session-with-a-very-long-name-that-has-no-break-points-at-all-xxxxxxxxxxxxxxxxxxxxxx' },
      assigneeState: { state: 'working', live: true, activeAt: 1, pending: { approvals: 0, questions: 0 } },
    }),
    task('T3', {
      title: 'Land the stack',
      state: 'blocked',
      blockedBy: [{ kind: 'text', ref: null, text: 'a reason that is long and has no spaces ' + 'x'.repeat(150) }],
      blockers: [{ kind: 'text', ref: null, text: 'a reason that is long and has no spaces ' + 'x'.repeat(150), open: true, why: 'waiting on a person' }],
    }),
    task('T4', { title: 'Docs', state: 'done' }),
  ],
  attention: [{ taskId: 'T1', kind: 'unassigned', detail: 'ready, nobody is assigned', told: 'sent' }],
  responsible: { sessionId: 'orch', label: 'orchestrator' },
  choices: [{ sessionId: 'orch', label: 'orchestrator' }],
  sessions: [{ id: 's1', name: 'a-session', state: 'working', kind: 'worker' }],
  observing: { ok: true, reason: null, at: 1 },
  github: { on: true, repo: null, ok: true, error: null, at: 1, offers: [{ number: 40, title: 'First open issue' }, { number: 41, title: 'Second open issue' }] },
  settings: { quietMinutes: 30, sweepMinutes: 10 },
  failedTold: 0,
  readOnly: false,
})

/** The stand-in for the bridge: the panel's tool calls change `window.__state`, and `show` returns it */
const BRIDGE = `<script>
window.__state = ${JSON.stringify(STATE())}
window.__calls = []
let handler = null
window.McpApp = { App: class {
  set fallbackNotificationHandler(fn) { handler = fn }
  connect() { return Promise.resolve() }
  getHostContext() { return {} }
  async callServerTool({ name, arguments: a }) {
    window.__calls.push({ name, a })
    const s = window.__state
    if (name === 'ledger_add') s.tasks.push({ id: 'T9', title: a.title, state: 'ready', stateSince: 1, blockedBy: [], blockers: [], next: '', notes: '', issue: null, assignee: null, assigneeState: null, attention: [] })
    if (name === 'ledger_update') Object.assign(s.tasks.find((t) => t.id === a.id), a.next !== undefined ? { next: a.next } : {})
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: name === 'show' ? JSON.parse(JSON.stringify(s)) : undefined }
  }
} }
window.__changed = () => handler({ method: 'centralu/notifications/changed' })
</script>`

async function open(page: Page, width = 360): Promise<void> {
  await page.setViewportSize({ width, height: 800 })
  await page.setContent(PAGE.replace('<script src="centralu:mcp-app.js"></script>', BRIDGE))
  await expect(page.locator('#lists .row').first()).toBeVisible()
}

const refresh = (page: Page) => page.evaluate(() => (window as unknown as { __changed: () => Promise<void> }).__changed())

test.describe('the task ledger panel', () => {
  test('shows a task added with Enter at once, while the add line still has the focus', async ({ page }) => {
    await open(page)
    await page.locator('#title').click()
    await page.keyboard.type('Write the release notes')
    await page.keyboard.press('Enter')
    await expect(page.locator('#lists')).toContainText('Write the release notes')
    await expect(page.locator('#title')).toHaveValue('')
    // And it keeps showing what changes afterwards: nothing is left waiting for the focus to go
    await refresh(page)
    await expect(page.locator('#notes')).not.toContainText('Something changed')
  })

  test('does not take Settings away from the person while they type in it, nor close it, nor un-tick an issue', async ({ page }) => {
    await open(page)
    await page.getByText('Settings', { exact: true }).click()
    await page.getByText(/open issues not in the ledger/).click()
    await page.getByRole('checkbox').first().check()
    const quiet = page.getByLabel('Quiet minutes')
    await quiet.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('45')
    await refresh(page)
    await expect(quiet).toHaveValue('45')
    await expect(quiet).toBeFocused()
    await expect(page.getByLabel('Quiet minutes')).toBeVisible()
    await expect(page.getByRole('checkbox').first()).toBeChecked()
    // Once they leave the field, what changed meanwhile is shown, and the sections are still as they left them
    await page.locator('#title').click()
    await page.locator('#title').blur()
    await refresh(page)
    await expect(page.getByLabel('Quiet minutes')).toBeVisible()
    await expect(page.getByRole('checkbox').first()).toBeChecked()
  })

  test('keeps an editor open and its text while the state is read again, and closes it on Save with the saved value shown', async ({ page }) => {
    await open(page)
    await page.getByText('Mac checks').click()
    const next = page.getByLabel('Next step')
    await next.fill('half written')
    await refresh(page)
    await expect(next).toHaveValue('half written')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('#lists .editor')).toHaveCount(0)
    await expect(page.locator('#lists')).toContainText('Next: half written')
    await expect(page.locator('#notes')).not.toContainText('Something changed')
  })

  test('opens a task from the keyboard', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Fix login' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Fix login')
  })

  test('does not overflow at the width of a grid panel, with a long name and a long blocker', async ({ page }) => {
    await open(page, 360)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.setViewportSize({ width: 900, height: 800 })
    await expect(page.locator('#lists')).toContainText('Mac checks')
  })
})

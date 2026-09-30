import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * Where capability approval shows up (M4 D-4) — real UI on a mock platform.
 *
 *   Chain started from a session   That session's approval card. The mock's `requestApproval`
 *                                  raises a `cap-` card the way the host would, and answering it
 *                                  continues the call it gated the way the host would (the mock's
 *                                  respondApproval stands in for this).
 *   Chain started from a view      The question on that app's pinned view, plus the indicator on
 *                                  the sidebar app row. The mock's `askAppQuestion` raises and
 *                                  broadcasts the question the way the host would, and once
 *                                  answered, the view call that was waiting (the appToolHandler
 *                                  this test wires up) resolves — this checks that the call from
 *                                  the real view (ViewHost and the ext-apps App) receives the
 *                                  answer and continues.
 */

type AppInfo = {
  appId: string
  projectId: string | null
  dir: string
  name: string | null
  version: string | null
  description: string | null
  home: string | null
  trusted: boolean
  status: 'invalid' | 'untrusted' | 'stopped' | 'starting' | 'running' | 'crashed' | 'failed'
  error: string | null
  warnings: string[]
}

const app = (appId: string, projectId: string | null, name: string): AppInfo => ({
  appId,
  projectId,
  dir: `/tmp/${projectId ?? 'user'}/.centralu/apps/${appId}`,
  name,
  version: '0.1.0',
  description: null,
  home: 'home',
  trusted: true,
  status: 'running',
  error: null,
  warnings: [],
})

const trustCalls = (page: Page) => page.evaluate(() => (window as any).__mock.trustCalls as { projectId: string; trusted: boolean }[])

async function trustedProject(page: Page, path: string): Promise<string> {
  await page.evaluate((p) => ((window as any).__mock.nextPickedDirectory = p), path)
  await page.getByTestId('add-project').click()
  const name = path.split('/').pop()!
  await expect(page.getByTestId(`project-${name}`)).toBeVisible()
  const pid = await page.evaluate(
    (p) => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === p)!.id,
    path,
  )
  await page.getByTestId(`trust-ask-yes-${name}`).click()
  await expect.poll(() => trustCalls(page)).toContainEqual({ projectId: pid, trusted: true })
  return pid
}

async function newSession(page: Page, project: string): Promise<string> {
  await page.getByTestId(`project-menu-${project}`).click()
  await page.getByTestId(`new-session-${project}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  return page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
}

test('chain started from a session: the question shows as that session\'s approval card (with no always-allow), and answering y continues the gated call', async ({ page }) => {
  await page.goto('/?mock=1')
  await trustedProject(page, '/tmp/alpha')
  const sessionId = await newSession(page, 'alpha')

  // The card the host raises — the app this session's agent called is trying to use an agent for the first time
  await page.evaluate(
    (sid) =>
      (window as any).__mock.requestApproval(
        sid,
        { kind: 'capability', app: { appId: 'notes', projectId: 'p1', name: 'Notes' }, capability: 'agent:claude', text: 'run an agent (Claude Code) in a new session' },
        'cap-1',
      ),
    sessionId,
  )
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveAttribute('data-kind', 'capability')
  await expect(card.getByTestId('approval-detail')).toHaveText('Notes wants to run an agent (Claude Code) in a new session.')
  await expect(card).toContainText('Centralu remembers your answer for this app')
  await expect(card.getByTestId('approve-allow')).toBeVisible()
  await expect(card.getByTestId('approve-deny')).toBeVisible()
  // The answer is remembered regardless — there is no "always allow", and a does nothing
  await expect(card.getByTestId('approve-always')).toHaveCount(0)
  await page.keyboard.press('a')
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([])

  await page.keyboard.press('y')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([{ sessionId, requestId: 'cap-1', decision: 'allow' }])
  await expect(card).toHaveCount(0)
  // The waiting app call continued — the agent receives the result and ends its turn
  await expect(page.getByTestId('session-view')).toContainText('The app went on and finished.')
})

test.describe('chain started from a view', () => {
  let fx: FixtureHost
  test.beforeAll(async () => {
    fx = await startFixtureHost({ 'slider ui://slider/main': { html: fixtureViewHtml() } })
  })
  test.afterAll(async () => {
    await fx?.close()
  })

  test.beforeEach(async ({ page }) => {
    await page.exposeFunction(
      '__viewFrame',
      (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
        fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
    )
    await page.exposeFunction('__openView', (appId: string, projectId: string | null) => {
      const instanceId = fx.open({ projectId, appId }, `ui://${appId}/main`)
      return {
        instanceId,
        tool: 'home',
        resourceUri: `ui://${appId}/main`,
        toolInput: {},
        toolResult: { content: [{ type: 'text', text: 'home' }], structuredContent: { home: appId } },
        runId: `run-${instanceId}`,
      }
    })
    await page.goto('/?mock=1')
    await page.evaluate(() => {
      const w = window as any
      w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
      w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
    })
  })

  const viewOf = (page: Page, key: string): FrameLocator =>
    page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
  const answered = (page: Page) => page.evaluate(() => (window as any).__mock.answeredQuestions)

  /**
   * The view's `increment` stalls the way the host would — the app is trying to use a capability
   * for the first time and waits for the person's answer. Once it arrives, the answer is returned
   * as the result (in the host, this would be the result of the app running an agent).
   */
  const holdOnQuestion = (page: Page, pid: string) =>
    page.evaluate((projectId) => {
      const w = window as any
      w.__mock.appToolHandler = async (_appId: string, tool: string) => {
        if (tool !== 'increment') return { content: [{ type: 'text', text: 'ok' }] }
        const now = Date.now()
        const d = await w.__mock.askAppQuestion({
          id: 'q-1',
          app: { appId: 'slider', projectId, name: 'Slider' },
          capability: 'agent:claude',
          text: 'run an agent (Claude Code) in a new session',
          origin: { appId: 'slider', projectId },
          askedAt: now,
          expiresAt: now + 300_000,
        })
        return { content: [{ type: 'text', text: d }], structuredContent: { answered: d } }
      }
    }, pid)

  test('the question shows on that app\'s pinned view and the sidebar app row gets an indicator — allowing it gives the stalled view call its answer', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await page.evaluate((l) => (window as any).__mock.setExternalApps(l), [app('slider', pid, 'Slider')])
    const row = page.getByTestId(`app-row-${pid}/slider`)
    await row.click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await holdOnQuestion(page, pid)

    const v = viewOf(page, `${pid}/slider`)
    await v.locator('#call').click()
    const ask = pinned.getByTestId('pinned-capability-ask')
    await expect(ask.getByTestId('approval-detail')).toHaveText('Slider wants to run an agent (Claude Code) in a new session.')
    await expect(ask.getByTestId('approve-always')).toHaveCount(0)
    await expect(row.getByTestId('app-row-hint')).toHaveText('asks you')
    // Not answered yet — the view's call is still waiting
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(0)

    await ask.getByTestId('approve-allow').click()
    await expect.poll(() => answered(page)).toEqual([{ questionId: 'q-1', decision: 'allow' }])
    await expect(v.locator('li[data-k="call-result"]')).toHaveText('call-result {"answered":"allow"}')
    await expect(ask).toHaveCount(0)
    await expect(row.getByTestId('app-row-hint')).toHaveCount(0)
  })

  test('the sidebar signals it even while not looking at the view — clicking it opens the pinned view with the question there, and n denies it', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await page.evaluate((l) => (window as any).__mock.setExternalApps(l), [app('slider', pid, 'Slider')])
    await newSession(page, 'alpha')
    // A question started from a view (e.g. clicked from a view inline in the conversation) — that app's pinned view is not open
    await page.evaluate((projectId) => {
      const now = Date.now()
      void (window as any).__mock.askAppQuestion({
        id: 'q-2',
        app: { appId: 'slider', projectId, name: 'Slider' },
        capability: 'host:git.status',
        text: "read this project's git branch and changed files",
        origin: { appId: 'slider', projectId },
        askedAt: now,
        expiresAt: now + 300_000,
      })
    }, pid)
    const row = page.getByTestId(`app-row-${pid}/slider`)
    await expect(row.getByTestId('app-row-hint')).toHaveText('asks you')
    await expect(row.getByTestId('app-row-hint')).toHaveAttribute('data-asking', 'true')

    await row.click()
    const ask = page.getByTestId(`pinned-app-${pid}/slider`).getByTestId('pinned-capability-ask')
    await expect(ask.getByTestId('approval-detail')).toHaveText("Slider wants to read this project's git branch and changed files.")
    await page.keyboard.press('n')
    await expect.poll(() => answered(page)).toEqual([{ questionId: 'q-2', decision: 'deny' }])
    await expect(ask).toHaveCount(0)
  })

  test('a remembered answer shows on the Permissions tab of the record panel, and forgetting it drops it from the list', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await page.evaluate(
      ({ l, key }) => {
        const w = window as any
        w.__mock.appPermissions.set(key, [
          { capability: 'agent:claude', text: 'run an agent (Claude Code) in a new session', decision: 'allow', decidedAt: 2, current: true },
          { capability: 'host:git.status', text: "read this project's git branch and changed files", decision: 'deny', decidedAt: 1, current: false },
        ])
        w.__mock.setExternalApps(l)
      },
      { l: [app('slider', pid, 'Slider')], key: `${pid}/slider` },
    )
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await pinned.getByTestId('pinned-runs-toggle').click()
    const rows = pinned.getByTestId('runs-permissions').getByTestId('permission-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByTestId('permission-decision')).toHaveText('allowed')
    // An old answer from before `uses` changed — no longer in effect
    await expect(rows.nth(1).getByTestId('permission-decision')).toHaveText('outdated')

    await rows.nth(0).getByTestId('permission-forget').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.forgottenPermissions))
      .toEqual([{ appId: 'slider', projectId: pid, capability: 'agent:claude' }])
    await expect(rows).toHaveCount(1)
  })
})

import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * 능력 승인이 서는 자리 (M4 D-4) — 목 플랫폼 위의 진짜 UI.
 *
 *   세션에서 시작된 사슬  그 세션의 승인 카드. 목의 `requestApproval`이 host처럼 `cap-` 카드를 세우고, 답하면 host처럼 부른
 *                       일이 이어진다(목의 respondApproval이 흉내 낸다)
 *   화면에서 시작된 사슬  그 앱의 고정 화면 위의 물음과 사이드바 앱 줄의 표시. 목의 `askAppQuestion`이 host처럼 물음을 세우고
 *                       방송하며, 답이 오면 기다리던 화면의 호출(시험이 꽂은 appToolHandler)이 풀린다 — 진짜 화면(ViewHost와
 *                       ext-apps App)의 호출이 답을 받고 이어지는지를 본다
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

test('세션에서 시작된 사슬: 물음은 그 세션의 승인 카드로 서고(항상 허용 없이), y로 답하면 부른 일이 이어진다', async ({ page }) => {
  await page.goto('/?mock=1')
  await trustedProject(page, '/tmp/alpha')
  const sessionId = await newSession(page, 'alpha')

  // host가 세우는 카드 — 이 세션의 에이전트가 부른 앱이 에이전트를 처음 쓰려 한다
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
  // 답은 어차피 기억된다 — "항상 허용"이 없고, a는 아무 일도 하지 않는다
  await expect(card.getByTestId('approve-always')).toHaveCount(0)
  await page.keyboard.press('a')
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([])

  await page.keyboard.press('y')
  await expect.poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers)).toEqual([{ sessionId, requestId: 'cap-1', decision: 'allow' }])
  await expect(card).toHaveCount(0)
  // 기다리던 앱의 호출이 이어졌다 — 에이전트가 그 결과를 받아 턴을 마친다
  await expect(page.getByTestId('session-view')).toContainText('The app went on and finished.')
})

test.describe('화면에서 시작된 사슬', () => {
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
   * 화면의 `increment`가 host처럼 멈춘다 — 앱이 능력을 처음 쓰려 하고, 사람의 답을 기다린다. 답이 오면 그 답을 결과로 돌려준다
   * (host에서는 앱이 에이전트를 돌린 결과다).
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

  test('물음은 그 앱의 고정 화면 위에 서고 사이드바의 앱 줄이 표시를 단다 — 허락하면 멈춰 있던 화면의 호출이 답을 받는다', async ({ page }) => {
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
    // 아직 답하지 않았다 — 화면의 호출은 기다리고 있다
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(0)

    await ask.getByTestId('approve-allow').click()
    await expect.poll(() => answered(page)).toEqual([{ questionId: 'q-1', decision: 'allow' }])
    await expect(v.locator('li[data-k="call-result"]')).toHaveText('call-result {"answered":"allow"}')
    await expect(ask).toHaveCount(0)
    await expect(row.getByTestId('app-row-hint')).toHaveCount(0)
  })

  test('화면을 보고 있지 않아도 사이드바가 알린다 — 누르면 고정 화면이 열리고 물음이 거기 있다, n으로 거절한다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await page.evaluate((l) => (window as any).__mock.setExternalApps(l), [app('slider', pid, 'Slider')])
    await newSession(page, 'alpha')
    // 화면에서 시작된 물음(예: 대화 안 화면에서 누른 것) — 그 앱의 고정 화면은 열려 있지 않다
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

  test('기억된 답은 기록 판의 Permissions에 서고, 잊으면 목록에서 빠진다', async ({ page }) => {
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
    // uses가 바뀐 뒤의 옛 답 — 더 쓰이지 않는다
    await expect(rows.nth(1).getByTestId('permission-decision')).toHaveText('outdated')

    await rows.nth(0).getByTestId('permission-forget').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.forgottenPermissions))
      .toEqual([{ appId: 'slider', projectId: pid, capability: 'agent:claude' }])
    await expect(rows).toHaveCount(1)
  })
})

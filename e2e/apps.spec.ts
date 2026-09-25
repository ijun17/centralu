import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * 외부 앱이 화면에 서는 자리 (M4 A-8, B-2, B-4, B-6, B-7) — 목 플랫폼 위의 진짜 UI.
 *
 * 목의 발견은 `__mock.setExternalApps`다. host처럼 목록을 바꾸고 `external_apps_changed`를 방송한다.
 * 그래서 여기서 보는 "방송을 따라간다"는 진짜 구독 길(스토어의 dispatchEvent → apps.list 다시 읽기)을
 * 지난다.
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

function app(appId: string, projectId: string | null, over: Partial<AppInfo> = {}): AppInfo {
  return {
    appId,
    projectId,
    dir: `/tmp/${projectId ?? 'user'}/.centralu/apps/${appId}`,
    name: `App ${appId}`,
    version: '0.1.0',
    description: null,
    home: 'home',
    trusted: true,
    status: 'stopped',
    error: null,
    warnings: [],
    ...over,
  }
}

async function setApps(page: Page, list: AppInfo[]) {
  await page.evaluate((l) => (window as any).__mock.setExternalApps(l), list)
}

/** 폴더를 골라 프로젝트를 등록하고, 목이 붙인 id를 돌려준다 */
async function addProject(page: Page, path: string): Promise<string> {
  await page.evaluate((p) => ((window as any).__mock.nextPickedDirectory = p), path)
  await page.getByTestId('add-project').click()
  const name = path.split('/').pop()!
  await expect(page.getByTestId(`project-${name}`)).toBeVisible()
  return page.evaluate(
    (p) => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === p)!.id,
    path,
  )
}

async function openAppsSettings(page: Page) {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-apps').click()
}

test('설정의 앱 목록: 내장 앱과 외부 앱이 한 목록에 서고, 상태와 이유가 방송을 따라간다', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  await setApps(page, [
    app('notes', pid, { status: 'running' }),
    app('broken', pid, { name: null, status: 'invalid', error: 'centralu.app.json is not JSON' }),
    app('timer', null),
  ])
  await openAppsSettings(page)

  // 내장 앱은 지금처럼 켜고 끄는 줄이다
  await expect(page.getByTestId('app-toggle-control')).toBeVisible()
  const list = page.getByTestId('settings-external-apps')
  // 프로젝트 이름 아래에 그 프로젝트의 앱, 사용자 폴더 앱은 자기 무리에
  await expect(list).toContainText('alpha')
  await expect(list).toContainText('Your apps')
  const notes = page.getByTestId(`external-app-${pid}/notes`)
  await expect(notes).toHaveAttribute('data-status', 'running')
  await expect(notes.getByTestId('external-app-status')).toHaveText('Running')
  // 깨진 앱도 숨기지 않는다 — 이름이 없으면 폴더 이름으로, 이유와 함께
  const broken = page.getByTestId(`external-app-${pid}/broken`)
  await expect(broken.getByTestId('external-app-status')).toHaveText('Invalid')
  await expect(broken.getByTestId('external-app-reason')).toHaveText('centralu.app.json is not JSON')
  await expect(page.getByTestId('external-app-_user/timer')).toBeVisible()

  // host가 "바뀌었다"를 방송한다 — 열린 목록이 다시 읽는다
  await setApps(page, [
    app('notes', pid, { status: 'failed', error: 'exited before it was ready (code 3)' }),
    app('timer', null),
  ])
  await expect(notes.getByTestId('external-app-status')).toHaveText('Failed')
  await expect(notes.getByTestId('external-app-reason')).toHaveText('exited before it was ready (code 3)')
  await expect(broken).toHaveCount(0)
})

const trustCalls = (page: Page) => page.evaluate(() => (window as any).__mock.trustCalls as { projectId: string; trusted: boolean }[])

test('프로젝트를 등록하면 신뢰를 한 번 묻는다 — "나중에"는 아무것도 보내지 않고, 프로젝트 메뉴에서 켜고 끈다', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  const ask = page.getByTestId('trust-ask-alpha')
  await expect(ask).toBeVisible()
  await expect(ask).toContainText("Trusting lets this project's apps run and its settings apply")

  await page.getByTestId('trust-ask-no-alpha').click()
  await expect(ask).toHaveCount(0)
  expect(await trustCalls(page)).toEqual([])

  // 한 번 물었으면 끝이다 — 그 뒤로는 메뉴에서
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('toggle-trust-alpha')).toHaveText('Trust this project')
  await page.getByTestId('toggle-trust-alpha').click()
  await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('toggle-trust-alpha')).toHaveText('Stop trusting this project')
  await page.getByTestId('toggle-trust-alpha').click()
  await expect.poll(() => trustCalls(page)).toEqual([
    { projectId: pid, trusted: true },
    { projectId: pid, trusted: false },
  ])

  // 돌고 있는 세션이 없으니 덧붙일 말도 없다
  await expect(page.getByTestId('toast')).toHaveCount(0)
  // 세션이 돌고 있으면: 바꾼 신뢰는 그 세션이 다시 시작하거나 이어질 때 적용된다고 한 줄로 말한다
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('toggle-trust-alpha').click()
  await expect(page.getByTestId('toast')).toHaveText('Running sessions here pick up the new trust when they restart or resume.')

  // 다른 프로젝트: 묻는 자리에서 곧바로 신뢰한다
  const beta = await addProject(page, '/tmp/beta')
  await page.getByTestId('trust-ask-yes-beta').click()
  await expect(page.getByTestId('trust-ask-beta')).toHaveCount(0)
  await expect.poll(async () => (await trustCalls(page)).at(-1)).toEqual({ projectId: beta, trusted: true })
})

test('신뢰하지 않은 프로젝트의 앱은 이유와 함께 서고, 그 자리에서 한 번에 신뢰할 수 있다', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  await page.getByTestId('trust-ask-no-alpha').click()
  await setApps(page, [app('notes', pid, { trusted: false, status: 'untrusted' })])
  await openAppsSettings(page)

  const row = page.getByTestId(`external-app-${pid}/notes`)
  await expect(row.getByTestId('external-app-status')).toHaveText('Not trusted')
  await expect(row.getByTestId('external-app-reason')).toHaveText("This project isn't trusted, so its apps don't run.")
  await row.getByTestId('external-app-trust').click()
  await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
  // host가 다시 훑고 방송한다 — 앱은 쉬는 앱(stopped)이 되고, 신뢰하기 단추는 사라진다
  await expect(row.getByTestId('external-app-status')).toHaveText('Stopped')
  await expect(row.getByTestId('external-app-trust')).toHaveCount(0)
})

test('사용자 폴더의 앱은 목록에서 한 번 물은 뒤 지운다 — 취소하면 아무것도 안 가고, 프로젝트 앱에는 지우기가 없다', async ({ page }) => {
  await page.goto('/?mock=1')
  const pid = await addProject(page, '/tmp/alpha')
  // 승인한 MCP 서버는 화면 없는 사용자 폴더 앱이 된다(A-7)
  await setApps(page, [app('notes', pid), app('github-mcp', null, { name: 'github-mcp', home: null, description: 'Approved MCP server' })])
  await openAppsSettings(page)
  const removed = () => page.evaluate(() => (window as any).__mock.removedApps as string[])

  await expect(page.getByTestId(`external-app-${pid}/notes`).getByTestId('external-app-remove')).toHaveCount(0)
  const row = page.getByTestId('external-app-_user/github-mcp')
  await row.getByTestId('external-app-remove').click()
  await expect(row.getByTestId('external-app-remove-confirm')).toContainText('Its folder moves to the app trash')
  await row.getByTestId('external-app-remove-cancel').click()
  await expect(row.getByTestId('external-app-remove-confirm')).toHaveCount(0)
  expect(await removed()).toEqual([])

  await row.getByTestId('external-app-remove').click()
  await row.getByTestId('external-app-remove-yes').click()
  await expect.poll(removed).toEqual(['github-mcp'])
  // host가 목록을 다시 방송한다 — 줄이 사라진다
  await expect(row).toHaveCount(0)
})

/*
 * 고정 화면 (M4 B-2). 목의 `apps.openView`에 진짜 ViewHost를 꽂는다(app-frame.spec.ts와 같은 시험대):
 * 여는 것은 이 워커가 띄운 HostServer·ViewHost의 인스턴스이고, 화면은 공식 ext-apps `App`으로 만든
 * 시험용 앱이다. host가 home을 부르는 일은 agent-host의 app-home-view.test.ts가 진짜 앱으로 본다.
 * 여기서는 그 답을 받은 UI가 무엇을 하는지를 본다.
 */
test.describe('고정 화면 (B-2, B-4, B-6, B-7)', () => {
  let fx: FixtureHost
  test.beforeAll(async () => {
    fx = await startFixtureHost({
      'slider ui://slider/main': { html: fixtureViewHtml() },
      'timer ui://timer/main': { html: fixtureViewHtml() },
    })
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
    // host가 home을 부르고 인스턴스를 연 것처럼 — 결과에는 어느 앱의 home인지를 싣는다
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

  /** 앱의 HTML이 도는 안쪽 프레임 (바깥은 프록시) */
  const viewOf = (page: Page, key: string): FrameLocator =>
    page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
  const opened = (page: Page) => page.evaluate(() => (window as any).__mock.openedViews as { appId: string; projectId: string | null }[])
  const closed = (page: Page) => page.evaluate(() => (window as any).__mock.closedViews as string[])
  /** 화면이 teardown을 받은 횟수 — 시험 앱은 받으면 저장 도구(`save-on-teardown`)를 부르고 답한다 */
  const teardowns = (page: Page) =>
    page.evaluate(() => ((window as any).__mock.appToolCalls as { tool: string }[]).filter((c) => c.tool === 'save-on-teardown').length)

  /** 신뢰한 프로젝트 하나 */
  async function trustedProject(page: Page, path: string): Promise<string> {
    const pid = await addProject(page, path)
    await page.getByTestId(`trust-ask-yes-${path.split('/').pop()}`).click()
    await expect.poll(() => trustCalls(page)).toContainEqual({ projectId: pid, trusted: true })
    return pid
  }

  test('앱이 프로젝트 아래에 서고, 누르면 메인 영역에 화면이 뜨며, 세션에 갔다 와도 같은 인스턴스다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider' })])

    // 사이드바의 그 프로젝트 블록 안, 세션 줄과 같은 목록 모양으로
    const row = page.getByTestId(`project-alpha`).getByTestId(`app-row-${pid}/slider`)
    await expect(row).toHaveText('Slider')
    await row.click()
    await expect(row).toHaveAttribute('aria-current', 'page')

    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned).toBeVisible()
    await expect(pinned.getByTestId('pinned-title')).toHaveText('Slider')
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const v = viewOf(page, `${pid}/slider`)
    // host가 부른 home의 결과가 규격의 tool-result로 화면에 닿는다
    await expect(v.locator('li[data-k="tool-result"]')).toHaveText('tool-result {"home":"slider"}')
    // 메인 영역을 채운다 — 대화 안 화면의 첫 높이(160px)가 아니다
    expect((await pinned.getByTestId('app-frame-iframe').boundingBox())!.height).toBeGreaterThan(400)
    // 화면에는 자리의 크기를 고정 크기로 알린다 — 제 키를 정하는 것은 화면이 아니라 자리다
    const connected = JSON.parse(((await v.locator('li[data-k="connected"]').textContent()) ?? '').slice('connected '.length))
    expect(connected.hostContext.containerDimensions).toEqual({ height: expect.any(Number), width: expect.any(Number) })
    expect(connected.hostContext.containerDimensions.height).toBeGreaterThan(400)
    // 증거 레인은 물러난다 — 앱이 그 자리 전체다
    await expect(page.getByTestId('evidence-panel')).toHaveCount(0)
    await expect(page.getByTestId('evidence-rail-shell')).toHaveCount(0)

    // 화면 안에서 무언가를 해 둔다 — 문서가 다시 읽히면 이 줄이 사라진다
    await v.locator('#call').click()
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)

    // 세션으로 간다 — 고정 화면은 숨을 뿐 내려가지 않는다
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    await expect(page.getByTestId('session-view')).toBeVisible()
    await expect(pinned).toBeHidden()
    await expect(row).not.toHaveAttribute('aria-current', 'page')

    // 돌아온다 — 키보드로도 같은 줄이다
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(pinned).toBeVisible()
    await expect(v.locator('li[data-k="call-result"]')).toHaveCount(1)
    await expect(v.locator('li[data-k="connected"]')).toHaveCount(1)
    expect(await opened(page)).toEqual([{ appId: 'slider', projectId: pid }])
    expect(await closed(page)).toEqual([])
  })

  test('닫으면 규격의 teardown을 보내고 인스턴스를 놓으며, 보던 세션 자리로 돌아간다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)

    await pinned.getByTestId('pinned-close').click()
    await expect(pinned).toHaveCount(0)
    // 시험 앱은 teardown을 받으면 저장 도구를 부르고 답한다 — 그 호출이 닿았으면 화면이 요청을 받은 것이다
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([instanceId])
    expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('focus')
  })

  test('화면이 없는 앱은 목록에 서고, 열면 "이 앱에는 화면이 없다"고 말한다 — 부르지도 않는다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('headless', pid, { home: null, description: 'Only tools for agents.' })])
    await page.getByTestId(`app-row-${pid}/headless`).click()
    const empty = page.getByTestId(`pinned-app-${pid}/headless`).getByTestId('pinned-no-screen')
    await expect(empty).toContainText('This app has no screen.')
    await expect(empty).toContainText('Only tools for agents.')
    expect(await opened(page)).toEqual([])
  })

  test('신뢰하지 않은 프로젝트의 앱: 줄에 이유가 서고, 열면 이유와 신뢰하기가 있으며, 누르면 그 자리에서 화면이 뜬다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await page.getByTestId('trust-ask-no-alpha').click()
    await setApps(page, [app('slider', pid, { trusted: false, status: 'untrusted' })])

    const row = page.getByTestId(`app-row-${pid}/slider`)
    await expect(row.getByTestId('app-row-hint')).toHaveText('not trusted')
    await row.click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    const blocked = pinned.getByTestId('pinned-untrusted')
    await expect(blocked).toContainText("This project isn't trusted, so its apps don't run.")
    expect(await opened(page)).toEqual([])

    await blocked.getByTestId('pinned-trust').click()
    await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(row.getByTestId('app-row-hint')).toHaveCount(0)
    expect(await opened(page)).toEqual([{ appId: 'slider', projectId: pid }])
  })

  test('신뢰를 끄면 열린 화면도 내려간다 — 화면의 HTML도 그 프로젝트의 코드다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)

    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('toggle-trust-alpha').click()
    await expect(pinned.getByTestId('pinned-untrusted')).toBeVisible()
    await expect(pinned.getByTestId('app-frame')).toHaveCount(0)
    // 떼기 전에 teardown이 화면에 닿았다(시험 앱은 받으면 저장 도구를 부른다)
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([instanceId])
  })

  test('앱이 사라지면 열린 화면을 내리고 인스턴스를 놓는다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)

    await setApps(page, [])
    await expect(pinned).toHaveCount(0)
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([instanceId])
    await expect(page.getByTestId('toast')).toContainText('is no longer available')
  })

  const restarts = (page: Page) => page.evaluate(() => (window as any).__mock.restarts as { appId: string; projectId: string | null }[])
  const instanceOf = (page: Page) => page.evaluate(() => (window as any).__store.getState().pinnedViews[0]?.instanceId as string | null)

  test('B-6: 앱이 뜨는 동안 스켈레톤이 서고, 화면이 뜨는 동안에도 덮고 있다가, 초기화되면 걷힌다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'stopped' })])
    // host가 home을 부르는 동안(앱 프로세스가 뜨는 시간), 그리고 프록시가 화면을 싣는 동안을 붙든다
    await page.evaluate(() => {
      const w = window as any
      w.__openGate = new Promise((r) => (w.__openRelease = r))
      w.__frameGate = new Promise((r) => (w.__frameRelease = r))
      const open = w.__mock.openViewProvider
      const frame = w.__mock.viewFrameProvider
      w.__mock.openViewProvider = async (a: string, p: string | null) => (await w.__openGate, open(a, p))
      w.__mock.viewFrameProvider = async (a: string, i: string, o: unknown) => (await w.__frameGate, frame(a, i, o))
    })
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('pinned-skeleton-label')).toHaveText('Starting Slider…')
    // host가 뜨는 중이라고 방송한다 — 같은 스켈레톤, 같은 말
    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'starting' })])
    await expect(pinned.getByTestId('pinned-skeleton')).toBeVisible()

    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'running' })])
    await page.evaluate(() => (window as any).__openRelease())
    // 인스턴스는 섰고 프레임이 뜨는 중이다 — 스켈레톤이 프레임을 덮는다
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'loading')
    await expect(pinned.getByTestId('app-frame-loading').getByTestId('pinned-skeleton-label')).toHaveText('Opening Slider…')

    await page.evaluate(() => (window as any).__frameRelease())
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(pinned.getByTestId('pinned-skeleton')).toHaveCount(0)
  })

  test('B-6: 연달아 못 뜬 앱은 이유와 Restart를 보이고, 누르면 다시 시작한 뒤에 화면을 연다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { status: 'failed', error: 'exited before it was ready (code 3)\nfixture: cannot open the thing it needs' })])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    const failed = pinned.getByTestId('pinned-failed')
    await expect(failed).toContainText('This app stopped after failing repeatedly.')
    await expect(failed.getByTestId('pinned-reason')).toContainText('fixture: cannot open the thing it needs')
    // 멈춘 앱은 스스로 다시 뜨지 않는다 — 누르기 전에는 부르지도 않는다
    expect(await opened(page)).toEqual([])

    await failed.getByTestId('pinned-restart').click()
    await expect.poll(() => restarts(page)).toEqual([{ appId: 'slider', projectId: pid }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    expect(await opened(page)).toEqual([{ appId: 'slider', projectId: pid }])
  })

  test('B-6: 떠 있던 앱이 죽으면 화면 위에 이유와 Restart가 서고, 누르면 teardown 뒤 새 인스턴스로 다시 연다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { status: 'running' })])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const first = await instanceOf(page)

    await setApps(page, [app('slider', pid, { status: 'crashed', error: 'exited (code 7)' })])
    const banner = pinned.getByTestId('pinned-crashed')
    await expect(banner).toContainText('This app stopped.')
    await expect(banner.getByTestId('pinned-reason')).toHaveText('exited (code 7)')
    // 화면은 남는다 — 사람이 보던 내용이 아직 거기 있다
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(page.getByTestId(`app-row-${pid}/slider`).getByTestId('app-row-hint')).toHaveText('crashed')

    await banner.getByTestId('pinned-restart').click()
    await expect.poll(() => teardowns(page)).toBe(1)
    await expect.poll(() => closed(page)).toEqual([first])
    await expect.poll(() => restarts(page)).toEqual([{ appId: 'slider', projectId: pid }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(pinned.getByTestId('pinned-crashed')).toHaveCount(0)
    expect(await opened(page)).toHaveLength(2)
    expect(await instanceOf(page)).not.toBe(first)
  })

  test('B-6: 화면을 열지 못하면 host가 말한 이유와 Restart가 선다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    await page.evaluate(() => {
      const w = window as any
      const open = w.__mock.openViewProvider
      let first = true
      w.__mock.openViewProvider = async (a: string, p: string | null) => {
        if (first) {
          first = false
          throw new Error('exited before it was ready (code 3)')
        }
        return open(a, p)
      }
    })
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    const failed = pinned.getByTestId('pinned-open-failed')
    await expect(failed.getByTestId('pinned-reason')).toContainText('exited before it was ready (code 3)')

    await failed.getByTestId('pinned-restart').click()
    await expect.poll(() => restarts(page)).toEqual([{ appId: 'slider', projectId: pid }])
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  })

  test('B-7: 기록 판은 최근 실행을 시간·도구·부른 쪽·결말·걸린 시간으로 보이고, 실패는 표시되며, 호출이 끝나면 다시 읽는다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid)])
    // 부른 세션의 이름이 줄에 서는지 보려고 세션 하나를 만든다
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    const session = await page.evaluate(() => {
      const st = (window as any).__store.getState()
      return { id: st.focusedSessionId as string, name: st.sessions[st.focusedSessionId].name as string }
    })
    const t0 = Date.UTC(2026, 8, 25, 3, 4, 5)
    const mk = (id: string, tool: string, callerKind: string, status: string, durationMs: number | null, error: string | null, at: number, sid: string | null = null) => ({
      id, projectId: pid, appId: 'slider', tool, callerKind, callerSessionId: sid, parentRunId: null, status, durationMs,
      argsDigest: 'd', argsSummary: '{}', error, createdAt: at, failure: null,
    })
    const runs = [
      mk('r4', 'agent_only', 'view', 'rejected', 0, 'agent_only is not open to views (visibility: ["model"])', t0),
      mk('r3', 'crash', 'session', 'error', 5, 'exited (code 7)', t0 - 1000, session.id),
      mk('r2', 'set_interval', 'app', 'ok', 1500, null, t0 - 2000),
      mk('r1', 'home', 'view', 'ok', 42, null, t0 - 3000),
    ]
    await page.evaluate(({ key, runs }) => (window as any).__mock.appRuns.set(key, runs), { key: `${pid}/slider`, runs })

    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await pinned.getByTestId('pinned-runs-toggle').click()
    await expect(pinned.getByTestId('pinned-runs-toggle')).toHaveAttribute('aria-pressed', 'true')
    const rows = pinned.getByTestId('runs-panel').getByTestId('run-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.getByTestId('run-tool')).toHaveText(['agent_only', 'crash', 'set_interval', 'home'])
    await expect(rows.getByTestId('run-status')).toHaveText(['refused', 'failed', 'ok', 'ok'])
    await expect(rows.getByTestId('run-caller')).toHaveText(['View', `Session · ${session.name}`, 'App', 'View'])
    await expect(rows.getByTestId('run-duration')).toHaveText(['0 ms', '5 ms', '1.5 s', '42 ms'])
    await expect(rows.nth(0).getByTestId('run-time')).toHaveAttribute('datetime', new Date(t0).toISOString())
    // 실패만 표시된다 — 이유 한 줄과 함께
    await expect(rows.nth(0)).toHaveAttribute('data-failed', 'true')
    await expect(rows.nth(1)).toHaveAttribute('data-failed', 'true')
    await expect(rows.nth(2)).not.toHaveAttribute('data-failed', 'true')
    await expect(rows.nth(1).getByTestId('run-error')).toHaveText('exited (code 7)')
    await expect(rows.nth(2).getByTestId('run-error')).toHaveCount(0)

    // 이 앱에 닿은 호출이 끝났다 — 판이 다시 읽는다
    await page.evaluate(
      ({ key, extra }) => {
        const m = (window as any).__mock
        m.appRuns.set(key, [extra, ...m.appRuns.get(key)])
        m.emit({ type: 'external_app_state_changed', appId: 'slider', projectId: extra.projectId })
      },
      { key: `${pid}/slider`, extra: mk('r5', 'get_interval', 'view', 'ok', 3, null, t0 + 1000) },
    )
    await expect(rows).toHaveCount(5)
    await expect(rows.nth(0).getByTestId('run-tool')).toHaveText('get_interval')

    // 판을 닫아도 화면은 그대로다 — 같은 문서
    await pinned.getByTestId('pinned-runs-toggle').click()
    await expect(pinned.getByTestId('runs-panel')).toHaveCount(0)
    await expect(viewOf(page, `${pid}/slider`).locator('li[data-k="connected"]')).toHaveCount(1)
  })

  /** 세션이 받은 사람의 말 — 목이 host처럼 적어 둔 것 */
  const sentTo = (page: Page, sid: string) =>
    page.evaluate(
      (id) =>
        (((window as any).__mock.messages.get(id) ?? []) as { role: string; payload: { text?: string } }[])
          .filter((m) => m.role === 'user')
          .map((m) => m.payload.text),
      sid,
    )
  /** 화면이 적은 줄 — n번째 */
  const logged = async (v: FrameLocator, k: string, nth = 0) => {
    const li = v.locator(`li[data-k="${k}"]`).nth(nth)
    await expect(li).toBeVisible()
    return JSON.parse(((await li.textContent()) ?? '').slice(k.length + 1))
  }

  test('B-4: 고정 화면의 ui/message는 어느 세션으로 보낼지 묻고, 고르기 전에는 아무것도 보내지 않으며, 취소하면 화면은 거절을 받는다', async ({ page }) => {
    const pid = await trustedProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider' })])
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
    const name = await page.evaluate((id) => (window as any).__store.getState().sessions[id].name as string, sid)

    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const v = viewOf(page, `${pid}/slider`)

    await v.locator('#msg').click()
    const ask = pinned.getByTestId('pinned-message-ask')
    await expect(ask).toContainText('Slider wants to send this to a session:')
    await expect(ask.getByTestId('pinned-message-text')).toHaveText('hello from the view')
    await expect(ask.getByTestId(`pinned-message-to-${sid}`)).toContainText(name)
    // 물었을 뿐이다 — 화면의 요청은 기다리고, 세션에는 아무것도 가지 않았다
    await expect(v.locator('li[data-k="msg-result"]')).toHaveCount(0)
    expect(await sentTo(page, sid)).toEqual([])

    await ask.getByTestId('pinned-message-cancel').click()
    await expect(ask).toHaveCount(0)
    expect(await logged(v, 'msg-result')).toEqual({ isError: true })
    expect(await sentTo(page, sid)).toEqual([])

    // 다시 — 이번에는 고른다
    await v.locator('#msg').click()
    await pinned.getByTestId(`pinned-message-to-${sid}`).click()
    await expect.poll(() => sentTo(page, sid)).toEqual(['hello from the view'])
    expect(await logged(v, 'msg-result', 1)).toEqual({})
    await expect(page.getByTestId('toast')).toContainText('Sent to')
    // 사람은 앱을 떠나지 않는다 — 보냈다고 세션으로 끌려가지 않는다
    await expect(pinned).toBeVisible()
  })

  test('사용자 폴더의 앱은 프로젝트 밖에 자기 무리가 있다', async ({ page }) => {
    await addProject(page, '/tmp/alpha')
    await setApps(page, [app('timer', null, { name: 'Timer' })])
    const group = page.getByTestId('user-apps')
    await expect(group).toContainText('Your apps')
    await group.getByTestId('app-row-_user/timer').click()
    const pinned = page.getByTestId('pinned-app-_user/timer')
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    expect(await opened(page)).toEqual([{ appId: 'timer', projectId: null }])
  })
})

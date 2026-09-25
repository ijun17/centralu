import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * 만들기 루프의 화면 쪽 (M4 C) — 목 플랫폼 위의 진짜 UI, 진짜 ViewHost, 공식 ext-apps `App`으로 만든 시험용 화면.
 *
 * host가 하는 일(템플릿 펼치기, 만드는 세션 세우기, 머리말 짓기, 오류 묶음, 다시 띄우기)은 agent-host의 시험들이 진짜
 * 앱으로 본다. 여기서는 그 문을 부르는 화면이 무엇을 하는지를 본다. 목은 host의 판정과 말을 그대로 흉내 낸다 —
 * 거절의 말은 host의 말 그대로이고, 머리말은 host가 쓰는 같은 함수(protocol)로 짓는다.
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
  codeStamp?: string
}

function app(appId: string, projectId: string | null, over: Partial<AppInfo> = {}): AppInfo {
  return {
    appId,
    projectId,
    dir: `/tmp/${projectId ?? 'user'}/.centralu/apps/${appId}`,
    name: `App ${appId}`,
    version: '0.1.0',
    description: null,
    home: 'show',
    trusted: true,
    status: 'stopped',
    error: null,
    warnings: [],
    ...over,
  }
}

const setApps = (page: Page, list: AppInfo[]) => page.evaluate((l) => (window as any).__mock.setExternalApps(l), list)
const trustCalls = (page: Page) => page.evaluate(() => (window as any).__mock.trustCalls as { projectId: string; trusted: boolean }[])

/** 폴더를 골라 프로젝트를 등록하고, 목이 붙인 id를 돌려준다. `trust`면 묻는 자리에서 곧바로 신뢰한다 */
async function addProject(page: Page, path: string, trust = true): Promise<string> {
  await page.evaluate((p) => ((window as any).__mock.nextPickedDirectory = p), path)
  await page.getByTestId('add-project').click()
  const name = path.split('/').pop()!
  await expect(page.getByTestId(`project-${name}`)).toBeVisible()
  const pid = await page.evaluate(
    (p) => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === p)!.id,
    path,
  )
  await page.getByTestId(`trust-ask-${trust ? 'yes' : 'no'}-${name}`).click()
  if (trust) await expect.poll(() => trustCalls(page)).toContainEqual({ projectId: pid, trusted: true })
  return pid
}

/** 앱의 HTML이 도는 안쪽 프레임 (바깥은 프록시) */
const viewOf = (page: Page, key: string): FrameLocator =>
  page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()

const createdApps = (page: Page) => page.evaluate(() => (window as any).__mock.createdApps as Record<string, unknown>[])
const sessionsOfApp = (page: Page, appId: string) =>
  page.evaluate(
    (id) =>
      (Object.values((window as any).__store.getState().sessions) as { id: string; appId: string | null; name: string; tool: string; projectId: string | null }[])
        .filter((s) => s.appId === id)
        .map(({ id: sid, name, tool, projectId }) => ({ id: sid, name, tool, projectId })),
    appId,
  )

/**
 * 진짜 ViewHost 한 벌 — 목의 `openView`(고정 화면)와 `viewFrame`(화면 주소)에 꽂는다. 새로 만든 앱의 화면도 여기서
 * 뜬다: host가 home을 부르고 인스턴스를 연 것처럼, 결과에는 어느 앱의 home인지를 싣는다.
 */
let fx: FixtureHost
const docs: Record<string, { html: string }> = {}
test.beforeAll(async () => {
  for (const id of ['team-notes', 'daily-log', 'notes', 'slider']) docs[`${id} ui://${id}/main`] = { html: fixtureViewHtml() }
  fx = await startFixtureHost(docs)
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
      tool: 'show',
      resourceUri: `ui://${appId}/main`,
      toolInput: {},
      toolResult: { content: [{ type: 'text', text: 'home' }], structuredContent: { home: appId } },
      runId: `run-${instanceId}`,
    }
  })
  await page.exposeFunction('__openInline', (appId: string, projectId: string | null) => fx.open({ projectId, appId }, `ui://${appId}/main`))
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const w = window as any
    w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
    w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
    w.__mock.inlineInstanceProvider = (a: string, p: string | null) => w.__openInline(a, p)
  })
})

test.describe('C-1: 새 앱', () => {
  test('프로젝트 메뉴의 New app: 이름에서 id를 짓고, 고른 에이전트로 만들면 앱이 서고, 화면이 열리고, 만드는 세션이 선다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')
    await expect(dialog).toContainText('New app · alpha')

    await dialog.getByTestId('new-app-name').fill('Team Notes')
    // 이름에서 지은 id — 사람이 고치지 않으면 이름을 따라간다
    await expect(dialog.getByTestId('new-app-id')).toHaveValue('team-notes')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveCount(0)
    // 기본은 프로젝트의 기본 도구다 — 여기서는 다른 쪽을 고른다
    await expect(dialog.getByTestId('new-app-tool-claude')).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('new-app-tool-codex').click()
    await dialog.getByTestId('new-app-create').click()
    await expect(dialog).toHaveCount(0)

    // host에 간 것: 이 프로젝트, 지은 id, 적은 이름, 고른 도구
    expect(await createdApps(page)).toEqual([{ projectId: pid, id: 'team-notes', name: 'Team Notes', tool: 'codex' }])
    // 앱이 그 프로젝트 아래에 서고, 고정 화면이 열려 home의 결과를 받는다
    const row = page.getByTestId('project-alpha').getByTestId(`app-row-${pid}/team-notes`)
    await expect(row).toHaveText('Team Notes')
    await expect(row).toHaveAttribute('aria-current', 'page')
    const pinned = page.getByTestId(`pinned-app-${pid}/team-notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(viewOf(page, `${pid}/team-notes`).locator('li[data-k="tool-result"]')).toHaveText('tool-result {"home":"team-notes"}')
    // 만드는 세션: 그 앱의 것, 고른 도구, 사람이 정한 이름 — 사이드바의 그 프로젝트 아래에 줄로 선다
    const builders = await sessionsOfApp(page, 'team-notes')
    expect(builders).toEqual([{ id: expect.any(String), name: 'Team Notes · builder', tool: 'codex', projectId: pid }])
    await expect(page.getByTestId('project-alpha').getByTestId(`session-row-${builders[0]!.id}`)).toContainText('Team Notes · builder')
  })

  test('host가 거절하면 그 말을 그대로 보이고 창은 남는다 — 모양이 틀린 id는 보내지도 않는다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await setApps(page, [app('notes', pid, { dir: '/tmp/alpha/.centralu/apps/notes' })])
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')

    // 모양은 창이 host와 같은 판정으로 먼저 막는다 — 보내지 않는다
    await dialog.getByTestId('new-app-name').fill('Store')
    await dialog.getByTestId('new-app-id').fill('app-store')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveText('Ids starting with "app-" are how apps attach to sessions. Pick another.')
    await expect(dialog.getByTestId('new-app-create')).toBeDisabled()
    await dialog.getByTestId('new-app-id').fill('')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveText('Give the app an id: lowercase letters, digits and hyphens.')
    expect(await createdApps(page)).toEqual([])

    // 이미 있는 id는 host가 안다 — 거절의 말을 그대로 보인다
    await dialog.getByTestId('new-app-id').fill('notes')
    await dialog.getByTestId('new-app-create').click()
    await expect(dialog.getByTestId('new-app-error')).toHaveText('"notes" 앱이 이미 있습니다 (/tmp/alpha/.centralu/apps/notes) — 다른 id를 쓰세요')
    await expect(dialog).toBeVisible()
    expect(await createdApps(page)).toEqual([{ projectId: pid, id: 'notes', name: 'Store', tool: 'claude' }])
    expect(await sessionsOfApp(page, 'notes')).toEqual([])
    await expect(page.getByTestId(`pinned-app-${pid}/notes`)).toHaveCount(0)
  })

  test('신뢰하지 않은 프로젝트: 창이 까닭을 말하고 그 자리에서 신뢰하게 한다 — 그 전에는 만들지 않는다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha', false)
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')
    await dialog.getByTestId('new-app-name').fill('Daily log')
    await expect(dialog.getByTestId('new-app-untrusted')).toContainText('Apps only run in projects you trust.')
    await expect(dialog.getByTestId('new-app-create')).toBeDisabled()

    await dialog.getByTestId('new-app-trust').click()
    await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
    await expect(dialog.getByTestId('new-app-untrusted')).toHaveCount(0)
    await dialog.getByTestId('new-app-create').click()
    await expect(page.getByTestId(`pinned-app-${pid}/daily-log`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  })

  test('사용자 폴더의 New app: 앱이 없어도 무리가 서고, 못 쓰는 에이전트는 까닭을 말하며, 만들면 그 무리에 선다', async ({ page }) => {
    await addProject(page, '/tmp/alpha')
    // Codex는 로그인 전이다
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.detected = m.detected.map((t: { name: string }) => (t.name === 'codex' ? { ...t, loggedIn: false } : t))
    })
    const group = page.getByTestId('user-apps')
    await expect(group).toContainText('Your apps')
    await expect(group.getByTestId('user-apps-list')).toHaveCount(0)
    await group.getByTestId('user-apps-new').click()
    const dialog = page.getByTestId('new-app-dialog')
    await expect(dialog).toContainText('New app · Your apps')
    await dialog.getByTestId('new-app-name').fill('Daily log')
    await dialog.getByTestId('new-app-tool-codex').click()
    await expect(dialog.getByTestId('new-app-tool-blocked')).toHaveText('Codex needs a login. Run codex login in a terminal, then open this again.')
    await expect(dialog.getByTestId('new-app-create')).toBeDisabled()

    await dialog.getByTestId('new-app-tool-claude').click()
    await expect(dialog.getByTestId('new-app-tool-blocked')).toHaveCount(0)
    await dialog.getByTestId('new-app-create').click()
    await expect(group.getByTestId('app-row-_user/daily-log')).toHaveText('Daily log')
    await expect(page.getByTestId('pinned-app-_user/daily-log').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    expect(await sessionsOfApp(page, 'daily-log')).toEqual([{ id: expect.any(String), name: 'Daily log · builder', tool: 'claude', projectId: null }])
    expect(await createdApps(page)).toEqual([{ projectId: null, id: 'daily-log', name: 'Daily log', tool: 'claude' }])
  })
})

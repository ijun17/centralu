import { expect, test, type Page } from '@playwright/test'

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

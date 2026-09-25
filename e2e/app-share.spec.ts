import { expect, test, type Page } from '@playwright/test'

/**
 * 건네기 (M4 E) — 목 플랫폼 위의 진짜 UI. 비밀 칸, 가져오기 확인, 이전 판으로 되돌리기, 딥링크.
 *
 * 목의 발견은 `__mock.setExternalApps`다(host처럼 목록을 바꾸고 `external_apps_changed`를 방송한다). host에 닿은 것(넣은 비밀,
 * 가져오기, 켜기, 되돌리기)은 목이 적어 둔 것으로 본다. 판정의 몸통(값이 새지 않는가, 가져온 앱이 확인 전에 뜨지 않는가,
 * 스냅샷)은 agent-host의 시험이 진짜 앱으로 본다. 여기서는 사람이 보는 것과 누르는 것을 본다.
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
  status: string
  error: string | null
  warnings: string[]
  secrets?: { name: string; set: boolean }[]
}

function app(appId: string, projectId: string | null, over: Partial<AppInfo> = {}): AppInfo {
  return {
    appId,
    projectId,
    dir: projectId ? `/tmp/${projectId}/.centralu/apps/${appId}` : `/mock/data/apps/${appId}`,
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

const secretWrites = (page: Page) =>
  page.evaluate(() => (window as any).__mock.secretWrites as { appId: string; projectId: string | null; name: string; value: string | null }[])

/** 화면에 남은 글자 전부 — DOM과, 속성으로는 보이지 않는 입력 칸의 값까지 */
const everythingOnScreen = (page: Page) =>
  page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input, textarea')].map((i) => (i as HTMLInputElement).value).join('\n'))

test.describe('비밀 칸 (E)', () => {
  const VALUE = 'sk-live-e2e-0123456789'

  test('빈 비밀은 고정 화면의 머리글이 수로 말하고, 판에서 넣으면 "있음"이 된다 — 넣은 값은 화면 어디에도 남지 않는다', async ({ page }) => {
    await page.goto('/?mock=1')
    await setApps(page, [
      app('keys', null, { name: 'Keys', secrets: [{ name: 'API_KEY', set: false }, { name: 'OTHER_TOKEN', set: true }] }),
      app('plain', null, { name: 'Plain' }),
    ])
    // 비밀을 선언하지 않은 앱에는 단추가 없다
    await page.getByTestId('app-row-_user/plain').click()
    await expect(page.getByTestId('pinned-app-_user/plain').getByTestId('pinned-title')).toHaveText('Plain')
    await expect(page.getByTestId('pinned-app-_user/plain').getByTestId('pinned-secrets-toggle')).toHaveCount(0)

    await page.getByTestId('app-row-_user/keys').click()
    const pinned = page.getByTestId('pinned-app-_user/keys')
    const toggle = pinned.getByTestId('pinned-secrets-toggle')
    await expect(toggle).toHaveText('Secrets · 1 missing')
    await toggle.click()
    const panel = pinned.getByTestId('secrets-panel')
    const apiKey = panel.getByTestId('secret-API_KEY')
    await expect(apiKey.getByTestId('secret-state')).toHaveText('Missing')
    await expect(panel.getByTestId('secret-OTHER_TOKEN').getByTestId('secret-state')).toHaveText('Set')
    // 들어 있는 비밀에는 값을 가리는 칸이 늘 서 있지 않다 — 바꾸기를 눌러야 빈 칸이 열린다
    await expect(panel.getByTestId('secret-OTHER_TOKEN').getByTestId('secret-input')).toHaveCount(0)

    // 칸은 비밀번호 칸이다 — 넣는 동안에도 글자가 보이지 않는다
    await expect(apiKey.getByTestId('secret-input')).toHaveAttribute('type', 'password')
    await expect(apiKey.getByTestId('secret-save')).toBeDisabled()
    await apiKey.getByTestId('secret-input').fill(VALUE)
    await apiKey.getByTestId('secret-save').click()

    await expect(apiKey.getByTestId('secret-state')).toHaveText('Set')
    await expect(toggle).toHaveText('Secrets')
    expect(await secretWrites(page)).toEqual([{ appId: 'keys', projectId: null, name: 'API_KEY', value: VALUE }])
    // 보낸 값은 잊는다 — DOM에도, 입력 칸에도 남지 않는다
    expect(await everythingOnScreen(page)).not.toContain(VALUE)

    // 바꾸기는 새 값을 받는 빈 칸이다(옛 값을 보여 주지 않는다)
    await apiKey.getByTestId('secret-replace').click()
    await expect(apiKey.getByTestId('secret-input')).toHaveValue('')
    await apiKey.getByTestId('secret-input').fill('sk-live-e2e-replaced')
    await apiKey.getByTestId('secret-save').click()
    await expect(apiKey.getByTestId('secret-input')).toHaveCount(0)
    // 지우기
    await apiKey.getByTestId('secret-clear').click()
    await expect(apiKey.getByTestId('secret-state')).toHaveText('Missing')
    await expect(toggle).toHaveText('Secrets · 1 missing')
    expect((await secretWrites(page)).map((w) => w.value)).toEqual([VALUE, 'sk-live-e2e-replaced', null])
    expect(await everythingOnScreen(page)).not.toContain('sk-live-e2e-replaced')
  })

  test('설정의 앱 줄도 빈 비밀의 수를 말하고, 펼치면 같은 칸이다 — host의 거절은 그 말 그대로 선다', async ({ page }) => {
    await page.goto('/?mock=1')
    await setApps(page, [app('keys', null, { name: 'Keys', secrets: [{ name: 'API_KEY', set: false }] })])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-apps').click()
    const row = page.getByTestId('external-app-_user/keys')
    const toggle = row.getByTestId('external-app-secrets-toggle')
    await expect(toggle).toHaveText('Secrets · 1 of 1 missing')
    await toggle.click()
    const slot = row.getByTestId('secret-API_KEY')
    // 목은 host처럼 선언이 사라진 이름을 거절한다 — 그 사이 매니페스트에서 이름이 빠진 경우
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.externalAppList[0].secrets = []
    })
    await slot.getByTestId('secret-input').fill(VALUE)
    await slot.getByTestId('secret-save').click()
    await expect(slot.getByTestId('secret-error')).toHaveText('This app does not declare a secret named API_KEY')
    expect(await secretWrites(page)).toEqual([])
    // 이름을 되돌리면 넣어진다
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.externalAppList[0].secrets = [{ name: 'API_KEY', set: false }]
    })
    await slot.getByTestId('secret-save').click()
    await expect(toggle).toHaveText('Secrets · 1 set')
    expect(await everythingOnScreen(page)).not.toContain(VALUE)
  })
})

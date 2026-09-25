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
  imported?: { source: string; at: number; confirmedAt: number | null }
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

/** host가 돌려줄 확인 창 — 목의 `importSources`에 꽂는다 */
function review(over: Record<string, unknown> = {}) {
  return {
    appId: 'notes',
    name: 'Notes',
    version: '1.2.0',
    description: 'Shared notes for the team.',
    server: { command: 'node', args: ['server.mjs', '--port', '3'] },
    uses: { agent: true, apps: ['other'] },
    secrets: ['API_KEY'],
    home: 'show',
    viewOrigin: 'opaque',
    files: [
      { path: 'centralu.app.json', bytes: 420 },
      { path: 'server.mjs', bytes: 2048 },
      { path: 'ui/index.html', bytes: 900 },
    ],
    totalBytes: 3368,
    skipped: [{ path: '.claude/', why: 'hidden' }],
    warnings: [],
    reviewKey: 'k'.repeat(64),
    source: '/tmp/notes.zip',
    changed: null,
    ...over,
  }
}

const mockList = <T,>(page: Page, name: string) => page.evaluate((n) => (window as any).__mock[n] as T, name)

test.describe('가져오기 (E-3)', () => {
  test('출처를 고르고 Review를 누르면 무엇을 돌리는지·무엇을 쓰는지·비밀·파일이 보이고, "Import and enable"은 들이며 켜서 앱을 연다', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.evaluate((r) => (window as any).__mock.importSources.set('/tmp/notes.zip', r), review())
    await page.getByTestId('user-apps-import').click()
    const dialog = page.getByTestId('import-app-dialog')
    await expect(dialog).toBeVisible()
    // Review를 누르기 전에는 host에 아무것도 가지 않는다
    await dialog.getByTestId('import-source').fill('/tmp/notes.zip')
    expect(await mockList<string[]>(page, 'importPrepares')).toEqual([])
    await dialog.getByTestId('import-review').click()

    const details = dialog.getByTestId('app-review')
    await expect(details.getByTestId('review-command')).toHaveText('node server.mjs --port 3')
    await expect(details.getByTestId('review-uses')).toContainText('Run your default agent in a new session')
    await expect(details.getByTestId('review-uses')).toContainText('Call other apps: other')
    await expect(details.getByTestId('review-secrets')).toContainText('API_KEY')
    await expect(details.getByTestId('review-file-list')).toContainText('server.mjs')
    await expect(details.getByTestId('review-file-list')).toContainText('ui/index.html')
    await expect(details.getByTestId('review-skipped')).toHaveText('Not copied: .claude/ (hidden)')
    await expect(details.getByTestId('review-source')).toHaveText('From /tmp/notes.zip')
    // 아직 들어온 것이 아니다
    expect(await mockList<unknown[]>(page, 'importCommits')).toEqual([])
    await expect(page.getByTestId('app-row-_user/notes')).toHaveCount(0)

    await dialog.getByTestId('import-enable').click()
    await expect(dialog).toHaveCount(0)
    expect(await mockList<unknown[]>(page, 'importCommits')).toEqual([{ token: expect.any(String), enable: true, appId: 'notes' }])
    // 켰으니 앱이 열린다 — host가 home을 부른다
    await expect(page.getByTestId('pinned-app-_user/notes')).toBeVisible()
    await expect.poll(() => mockList<unknown[]>(page, 'openedViews')).toEqual([{ appId: 'notes', projectId: null }])
  })

  test('"Import"는 꺼진 채 들인다 — 줄은 "not enabled"이고 고정 화면은 확인을 보이며, Enable을 누르면 그 자리에서 앱이 뜬다', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.evaluate((r) => (window as any).__mock.importSources.set('/tmp/notes.zip', r), review())
    await page.getByTestId('user-apps-import').click()
    const dialog = page.getByTestId('import-app-dialog')
    await dialog.getByTestId('import-source').fill('/tmp/notes.zip')
    await dialog.getByTestId('import-review').click()
    await dialog.getByTestId('import-commit').click()
    await expect(dialog).toHaveCount(0)

    await expect(page.getByTestId('app-row-_user/notes').getByTestId('app-row-hint')).toHaveText('not enabled')
    const pinned = page.getByTestId('pinned-app-_user/notes')
    const gate = pinned.getByTestId('pinned-review')
    await expect(gate.getByTestId('pinned-review-title')).toHaveText('This app was imported. Review it before it runs.')
    await expect(gate.getByTestId('review-command')).toHaveText('node server.mjs --port 3')
    // 켜기 전에는 부르지 않는다 — home도
    expect(await mockList<unknown[]>(page, 'openedViews')).toEqual([])

    await gate.getByTestId('pinned-enable').click()
    await expect.poll(() => mockList<string[]>(page, 'enabledApps')).toEqual(['notes'])
    await expect(pinned.getByTestId('pinned-review')).toHaveCount(0)
    await expect.poll(() => mockList<unknown[]>(page, 'openedViews')).toEqual([{ appId: 'notes', projectId: null }])
    await expect(page.getByTestId('app-row-_user/notes').getByTestId('app-row-hint')).toHaveCount(0)
  })

  test('host의 거절은 창에 그 말 그대로 서고 아무것도 들이지 않으며, 창을 닫으면 대기실을 치운다', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.importRefusals.set('/tmp/evil.zip', "An entry's path leaves the archive or is malformed: ../evil.txt")
    })
    await page.evaluate((r) => (window as any).__mock.importSources.set('/tmp/notes.zip', r), review())
    await page.getByTestId('user-apps-import').click()
    const dialog = page.getByTestId('import-app-dialog')
    await dialog.getByTestId('import-source').fill('/tmp/evil.zip')
    await dialog.getByTestId('import-review').click()
    await expect(dialog.getByTestId('import-error')).toHaveText("An entry's path leaves the archive or is malformed: ../evil.txt")
    await expect(dialog.getByTestId('app-review')).toHaveCount(0)

    // 준비까지 한 것을 닫으면 host의 대기실이 치워진다
    await dialog.getByTestId('import-source').fill('/tmp/notes.zip')
    await dialog.getByTestId('import-review').click()
    await expect(dialog.getByTestId('app-review')).toBeVisible()
    await dialog.getByTestId('import-cancel').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => mockList<string[]>(page, 'importCancels')).toHaveLength(1)
    expect(await mockList<unknown[]>(page, 'importCommits')).toEqual([])
  })

  test('켠 뒤 바뀐 앱은 다시 묻고, 무엇을 돌리던 앱이었는지를 보인다', async ({ page }) => {
    await page.goto('/?mock=1')
    const changed = review({
      server: { command: 'node', args: ['server.mjs', '--port', '4'] },
      changed: { server: true, uses: false, was: { server: { command: 'node', args: ['server.mjs', '--port', '3'] }, uses: { agent: true, apps: ['other'] } } },
    })
    await page.evaluate((r) => (window as any).__mock.appReviews.set('_user/notes', r), changed)
    await setApps(page, [
      app('notes', null, {
        name: 'Notes',
        status: 'unconfirmed',
        error: 'This app changed what it runs or what it uses since you enabled it. Review it and enable it again',
        imported: { source: '/tmp/notes.zip', at: 1, confirmedAt: 2 },
      } as Partial<AppInfo>),
    ])
    await page.getByTestId('app-row-_user/notes').click()
    const gate = page.getByTestId('pinned-app-_user/notes').getByTestId('pinned-review')
    await expect(gate.getByTestId('pinned-review-title')).toHaveText('This app changed. Review it before it runs again.')
    await expect(gate.getByTestId('review-changed')).toContainText('It used to run node server.mjs --port 3')
    await expect(gate.getByTestId('review-command')).toHaveText('node server.mjs --port 4')
    // 설정의 줄은 어디서 왔는지와 확인으로 가는 길을 준다
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-apps').click()
    const row = page.getByTestId('external-app-_user/notes')
    await expect(row.getByTestId('external-app-status')).toHaveText('Needs review')
    await expect(row.getByTestId('external-app-imported')).toHaveText('Imported from /tmp/notes.zip')
    await row.getByTestId('external-app-review').click()
    await expect(page.getByTestId('settings')).toHaveCount(0)
    await expect(gate).toBeVisible()
  })
})

test.describe('판 (E-1)', () => {
  const snap = (id: string, at: number, reason: string, current = false) => ({ id, at, files: 4, bytes: 2048, reason, current })

  test('사용자 폴더 앱: 떠 둔 판이 보이고, "Restore previous version"은 한 번 물은 뒤 지금 판의 바로 앞 판을 되돌린다', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.evaluate(
      (v) => (window as any).__mock.appVersions.set('_user/notes', v),
      { kind: 'snapshots', snapshots: [snap('s3', 3_000_000, 'started', true), snap('s2', 2_000_000, 'started'), snap('s1', 1_000_000, 'imported')] },
    )
    await setApps(page, [app('notes', null, { name: 'Notes' })])
    await page.getByTestId('app-row-_user/notes').click()
    const pinned = page.getByTestId('pinned-app-_user/notes')
    await pinned.getByTestId('pinned-versions-toggle').click()
    const panel = pinned.getByTestId('versions-panel')
    await expect(panel.getByTestId('version-row')).toHaveCount(3)
    await expect(panel.getByTestId('version-row').first().getByTestId('version-current')).toHaveText('current')
    await expect(panel.getByTestId('version-row').nth(2)).toContainText('As imported')

    const restored = () => page.evaluate(() => (window as any).__mock.restoredVersions as { appId: string; id: string }[])
    await panel.getByTestId('versions-restore-previous').click()
    await expect(panel.getByTestId('versions-confirm')).toContainText('The current files are kept as a version first')
    // 묻는 동안에는 아무것도 가지 않는다 — 취소하면 그대로다
    await panel.getByTestId('versions-confirm-cancel').click()
    expect(await restored()).toEqual([])

    await panel.getByTestId('versions-restore-previous').click()
    await panel.getByTestId('versions-confirm-yes').click()
    await expect.poll(restored).toEqual([{ appId: 'notes', id: 's2' }])
    // 되돌린 판이 지금 판이 된다
    await expect(panel.getByTestId('version-row').nth(1).getByTestId('version-current')).toHaveText('current')
    // 더 오래된 판도 줄마다 되돌릴 수 있다
    await panel.getByTestId('version-row').nth(2).getByTestId('version-restore').click()
    await panel.getByTestId('versions-confirm-yes').click()
    await expect.poll(restored).toEqual([
      { appId: 'notes', id: 's2' },
      { appId: 'notes', id: 's1' },
    ])
  })

  test('프로젝트 앱: git이 판이라 그 앱을 건드린 커밋만 읽기로 보이고, 되돌리는 단추가 없다', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.evaluate(() => ((window as any).__mock.nextPickedDirectory = '/tmp/alpha'))
    await page.getByTestId('add-project').click()
    const pid = await page.evaluate(() => (Object.values((window as any).__store.getState().projects) as { id: string }[])[0]!.id)
    await page.getByTestId('trust-ask-yes-alpha').click()
    await page.evaluate(
      ([p, v]) => (window as any).__mock.appVersions.set(`${p}/notes`, v),
      [
        pid,
        {
          kind: 'git',
          repo: true,
          commits: [{ sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'Tweak the notes app', author: 'Ann', when: 2_000_000, parents: ['a'.repeat(40)] }],
        },
      ] as const,
    )
    await setApps(page, [app('notes', pid, { name: 'Notes' })])
    await page.getByTestId(`app-row-${pid}/notes`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
    await pinned.getByTestId('pinned-versions-toggle').click()
    const history = pinned.getByTestId('versions-git')
    await expect(history).toContainText('git keeps its versions')
    await expect(history.getByTestId('version-commit')).toHaveCount(1)
    await expect(history.getByTestId('version-commit')).toContainText('Tweak the notes app')
    await expect(pinned.getByTestId('versions-restore-previous')).toHaveCount(0)
    await expect(pinned.getByTestId('version-restore')).toHaveCount(0)
  })
})

test.describe('앱 링크 (E-4)', () => {
  const openLink = (page: Page, link: string) => page.evaluate((l) => (window as any).__mock.openAppLink(l), link)

  test('OS가 건넨 centralu://app?url= 링크는 가져오기 창을 그 출처로 열고, Review를 누르기 전에는 host에 아무것도 가지 않는다', async ({ page }) => {
    await page.goto('/?mock=1')
    const source = 'https://example.com/team/notes.zip'
    await page.evaluate(([s, r]) => (window as any).__mock.importSources.set(s, r), [source, review({ source })] as const)
    await openLink(page, `centralu://app?url=${encodeURIComponent(source)}`)

    const dialog = page.getByTestId('import-app-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('import-from-link')).toContainText('Nothing is read or downloaded until you choose Review')
    await expect(dialog.getByTestId('import-source')).toHaveValue(source)
    // 링크가 창을 열었을 뿐이다 — 내려받기(준비)는 사람이 누른 뒤에만
    await page.waitForTimeout(300)
    expect(await mockList<string[]>(page, 'importPrepares')).toEqual([])

    await dialog.getByTestId('import-review').click()
    await expect(dialog.getByTestId('review-source')).toHaveText(`From ${source}`)
    expect(await mockList<string[]>(page, 'importPrepares')).toEqual([source])
    await dialog.getByTestId('import-enable').click()
    await expect(page.getByTestId('pinned-app-_user/notes')).toBeVisible()
  })

  test('모양이 틀린 링크는 창을 열지 않고 이유를 한 줄로 말한다 — http·경로·다른 자리', async ({ page }) => {
    await page.goto('/?mock=1')
    await openLink(page, `centralu://app?url=${encodeURIComponent('http://example.com/a.zip')}`)
    await expect(page.getByTestId('toast')).toHaveText(
      'Ignored a link Centralu cannot open: Only https links and files on this machine can be imported: http://example.com/a.zip',
    )
    await expect(page.getByTestId('import-app-dialog')).toHaveCount(0)
    await openLink(page, 'centralu://settings?url=https://example.com/a.zip')
    await expect(page.getByTestId('toast')).toHaveText('Ignored a link Centralu cannot open: Centralu links open apps: centralu://app?url=…')
    await expect(page.getByTestId('import-app-dialog')).toHaveCount(0)
    expect(await mockList<string[]>(page, 'importPrepares')).toEqual([])
  })
})

import { expect, test, type Page } from '@playwright/test'

/**
 * Sharing (M4 E) — real UI on a mock platform. Secret fields, import review, reverting to a
 * previous version, deep links.
 *
 * Discovery on the mock is `__mock.setExternalApps` (it changes the list and broadcasts
 * `external_apps_changed` the way the host would). Anything that reaches the host (a secret that
 * was entered, an import, enabling, reverting) is checked against what the mock recorded. The core
 * of the verdict (whether the value leaks, whether an imported app runs before review, the
 * snapshot logic) is covered with a real app by agent-host's tests. Here what is checked is what a
 * person sees and clicks.
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

/** Every character left on screen — the DOM plus the value of input fields, which attributes alone would not show */
const everythingOnScreen = (page: Page) =>
  page.evaluate(() => document.documentElement.outerHTML + [...document.querySelectorAll('input, textarea')].map((i) => (i as HTMLInputElement).value).join('\n'))

test.describe('secret fields (E)', () => {
  const VALUE = 'sk-live-e2e-0123456789'

  test('a missing secret is counted in the pinned view\'s header, and entering it in the panel makes it "Set" — the entered value never stays anywhere on screen', async ({ page }) => {
    await page.goto('/?mock=1')
    await setApps(page, [
      app('keys', null, { name: 'Keys', secrets: [{ name: 'API_KEY', set: false }, { name: 'OTHER_TOKEN', set: true }] }),
      app('plain', null, { name: 'Plain' }),
    ])
    // An app that declares no secrets gets no button
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
    // A secret that is already set does not permanently show a field masking its value — Replace has to be clicked to open an empty field
    await expect(panel.getByTestId('secret-OTHER_TOKEN').getByTestId('secret-input')).toHaveCount(0)

    // The field is a password field — the characters stay hidden while being entered too
    await expect(apiKey.getByTestId('secret-input')).toHaveAttribute('type', 'password')
    await expect(apiKey.getByTestId('secret-save')).toBeDisabled()
    await apiKey.getByTestId('secret-input').fill(VALUE)
    await apiKey.getByTestId('secret-save').click()

    await expect(apiKey.getByTestId('secret-state')).toHaveText('Set')
    await expect(toggle).toHaveText('Secrets')
    expect(await secretWrites(page)).toEqual([{ appId: 'keys', projectId: null, name: 'API_KEY', value: VALUE }])
    // The sent value is forgotten — it stays neither in the DOM nor in the input field
    expect(await everythingOnScreen(page)).not.toContain(VALUE)

    // Replace is an empty field waiting for a new value (it never shows the old one)
    await apiKey.getByTestId('secret-replace').click()
    await expect(apiKey.getByTestId('secret-input')).toHaveValue('')
    await apiKey.getByTestId('secret-input').fill('sk-live-e2e-replaced')
    await apiKey.getByTestId('secret-save').click()
    await expect(apiKey.getByTestId('secret-input')).toHaveCount(0)
    // Clear
    await apiKey.getByTestId('secret-clear').click()
    await expect(apiKey.getByTestId('secret-state')).toHaveText('Missing')
    await expect(toggle).toHaveText('Secrets · 1 missing')
    expect((await secretWrites(page)).map((w) => w.value)).toEqual([VALUE, 'sk-live-e2e-replaced', null])
    expect(await everythingOnScreen(page)).not.toContain('sk-live-e2e-replaced')
  })

  test('the app row in settings also counts missing secrets, and expanding it shows the same fields — a host refusal is shown verbatim', async ({ page }) => {
    await page.goto('/?mock=1')
    await setApps(page, [app('keys', null, { name: 'Keys', secrets: [{ name: 'API_KEY', set: false }] })])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-apps').click()
    const row = page.getByTestId('external-app-_user/keys')
    const toggle = row.getByTestId('external-app-secrets-toggle')
    await expect(toggle).toHaveText('Secrets · 1 of 1 missing')
    await toggle.click()
    const slot = row.getByTestId('secret-API_KEY')
    // The mock refuses a name whose declaration is gone, the way the host would — as when the name is dropped from the manifest in the meantime
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.externalAppList[0].secrets = []
    })
    await slot.getByTestId('secret-input').fill(VALUE)
    await slot.getByTestId('secret-save').click()
    await expect(slot.getByTestId('secret-error')).toHaveText('This app does not declare a secret named API_KEY')
    expect(await secretWrites(page)).toEqual([])
    // Restoring the name lets it be entered
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.externalAppList[0].secrets = [{ name: 'API_KEY', set: false }]
    })
    await slot.getByTestId('secret-save').click()
    await expect(toggle).toHaveText('Secrets · 1 set')
    expect(await everythingOnScreen(page)).not.toContain(VALUE)
  })
})

/** The review the host would return — planted into the mock's `importSources` */
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

test.describe('import (E-3)', () => {
  test('picking a source and clicking Review shows what it runs, what it uses, its secrets, and its files, and "Import and enable" brings it in, enables it, and opens the app', async ({ page }) => {
    await page.goto('/?mock=1')
    await page.evaluate((r) => (window as any).__mock.importSources.set('/tmp/notes.zip', r), review())
    await page.getByTestId('user-apps-import').click()
    const dialog = page.getByTestId('import-app-dialog')
    await expect(dialog).toBeVisible()
    // Nothing reaches the host before Review is clicked
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
    // Not imported yet
    expect(await mockList<unknown[]>(page, 'importCommits')).toEqual([])
    await expect(page.getByTestId('app-row-_user/notes')).toHaveCount(0)

    await dialog.getByTestId('import-enable').click()
    await expect(dialog).toHaveCount(0)
    expect(await mockList<unknown[]>(page, 'importCommits')).toEqual([{ token: expect.any(String), enable: true, appId: 'notes' }])
    // Enabled it, so the app opens — the host calls home
    await expect(page.getByTestId('pinned-app-_user/notes')).toBeVisible()
    await expect.poll(() => mockList<unknown[]>(page, 'openedViews')).toEqual([{ appId: 'notes', projectId: null }])
  })

  test('"Import" brings it in disabled — the row says "not enabled" and the pinned view shows the review, and clicking Enable launches the app right there', async ({ page }) => {
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
    // Nothing is called before it is enabled — not even home
    expect(await mockList<unknown[]>(page, 'openedViews')).toEqual([])

    await gate.getByTestId('pinned-enable').click()
    await expect.poll(() => mockList<string[]>(page, 'enabledApps')).toEqual(['notes'])
    await expect(pinned.getByTestId('pinned-review')).toHaveCount(0)
    await expect.poll(() => mockList<unknown[]>(page, 'openedViews')).toEqual([{ appId: 'notes', projectId: null }])
    await expect(page.getByTestId('app-row-_user/notes').getByTestId('app-row-hint')).toHaveCount(0)
  })

  test('a host refusal shows verbatim in the dialog with nothing imported, and closing the dialog clears the staging area', async ({ page }) => {
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

    // Closing after it was prepared clears the host's staging area
    await dialog.getByTestId('import-source').fill('/tmp/notes.zip')
    await dialog.getByTestId('import-review').click()
    await expect(dialog.getByTestId('app-review')).toBeVisible()
    await dialog.getByTestId('import-cancel').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => mockList<string[]>(page, 'importCancels')).toHaveLength(1)
    expect(await mockList<unknown[]>(page, 'importCommits')).toEqual([])
  })

  test('an app that changed after being enabled is reviewed again, showing what it used to run', async ({ page }) => {
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
    // The settings row gives both where it came from and a path to review
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

test.describe('versions (E-1)', () => {
  const snap = (id: string, at: number, reason: string, current = false) => ({ id, at, files: 4, bytes: 2048, reason, current })

  test('user-folder app: saved versions show, and "Restore previous version" asks once then reverts to the version right before the current one', async ({ page }) => {
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
    // Nothing goes out while it is asking — cancelling leaves everything as it was
    await panel.getByTestId('versions-confirm-cancel').click()
    expect(await restored()).toEqual([])

    await panel.getByTestId('versions-restore-previous').click()
    await panel.getByTestId('versions-confirm-yes').click()
    await expect.poll(restored).toEqual([{ appId: 'notes', id: 's2' }])
    // The restored version becomes the current one
    await expect(panel.getByTestId('version-row').nth(1).getByTestId('version-current')).toHaveText('current')
    // An older version can also be restored, row by row
    await panel.getByTestId('version-row').nth(2).getByTestId('version-restore').click()
    await panel.getByTestId('versions-confirm-yes').click()
    await expect.poll(restored).toEqual([
      { appId: 'notes', id: 's2' },
      { appId: 'notes', id: 's1' },
    ])
  })

  test('project app: since git is the versioning, only the commits that touched that app show, read-only, with no restore button', async ({ page }) => {
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

test.describe('app links (E-4)', () => {
  const openLink = (page: Page, link: string) => page.evaluate((l) => (window as any).__mock.openAppLink(l), link)

  test('a centralu://app?url= link handed off by the OS opens the import dialog with that source, and nothing reaches the host before Review is clicked', async ({ page }) => {
    await page.goto('/?mock=1')
    const source = 'https://example.com/team/notes.zip'
    await page.evaluate(([s, r]) => (window as any).__mock.importSources.set(s, r), [source, review({ source })] as const)
    await openLink(page, `centralu://app?url=${encodeURIComponent(source)}`)

    const dialog = page.getByTestId('import-app-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('import-from-link')).toContainText('Nothing is read or downloaded until you choose Review')
    await expect(dialog.getByTestId('import-source')).toHaveValue(source)
    // The link only opened the dialog — downloading (preparing) happens only after the person clicks
    await page.waitForTimeout(300)
    expect(await mockList<string[]>(page, 'importPrepares')).toEqual([])

    await dialog.getByTestId('import-review').click()
    await expect(dialog.getByTestId('review-source')).toHaveText(`From ${source}`)
    expect(await mockList<string[]>(page, 'importPrepares')).toEqual([source])
    await dialog.getByTestId('import-enable').click()
    await expect(page.getByTestId('pinned-app-_user/notes')).toBeVisible()
  })

  test('a malformed link does not open the dialog and states the reason in one line — http, a path, or a different destination', async ({ page }) => {
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

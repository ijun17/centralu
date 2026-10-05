import { expect, test, type Page } from '@playwright/test'

/**
 * Another project's app tools, on demand (#371 part A) — what a person sees and clicks: the per-app
 * "Share with other projects" switch (Settings → Apps and the app's own header). Real UI on the mock
 * platform; what a session can then find and attach, and the consent per pair of projects, are
 * pinned by agent-host's tests against a real runtime. A function, run in Chromium
 * (app-access.spec.ts) and WebKit (app-access-webkit.spec.ts).
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
  shared?: boolean
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

async function addProject(page: Page, path: string): Promise<string> {
  await page.evaluate((p) => ((window as any).__mock.nextPickedDirectory = p), path)
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId(`project-${path.split('/').pop()!}`)).toBeVisible()
  return page.evaluate(
    (p) => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === p)!.id,
    path,
  )
}

async function newSession(page: Page, project: string): Promise<string> {
  await page.getByTestId(`project-menu-${project}`).click()
  await page.getByTestId(`new-session-${project}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  return page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
}

const sharedWrites = (page: Page) => page.evaluate(() => (window as any).__mock.sharedWrites as { appId: string; projectId: string; shared: boolean }[])

export function appAccessTests(): void {
  test('a project app is shared from Settings → Apps, off by default; a user-folder app has no switch', async ({ page }) => {
    await page.goto('/?mock=1')
    const pid = await addProject(page, '/tmp/ops')
    await page.evaluate((l) => (window as any).__mock.setExternalApps(l), [app('counter', pid, { name: 'Counter' }), app('helper', null)])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-apps').click()

    const row = page.getByTestId(`external-app-${pid}/counter`)
    const box = row.getByTestId('external-app-share').getByRole('checkbox')
    await expect(row.getByTestId('external-app-share')).toContainText('Share with other projects')
    await expect(box).not.toBeChecked()
    await expect(page.getByTestId('external-app-_user/helper').getByTestId('external-app-share')).toHaveCount(0)

    await box.check()
    expect(await sharedWrites(page)).toEqual([{ appId: 'counter', projectId: pid, shared: true }])
    // The list the host broadcast again says it is shared
    await expect(box).toBeChecked()
    await box.uncheck()
    await expect(box).not.toBeChecked()
    expect((await sharedWrites(page)).at(-1)).toEqual({ appId: 'counter', projectId: pid, shared: false })
  })

  test("the app's own header shares it too, and says when it is shared", async ({ page }) => {
    await page.goto('/?mock=1')
    const pid = await addProject(page, '/tmp/ops')
    await page.evaluate((l) => (window as any).__mock.setExternalApps(l), [app('counter', pid, { name: 'Counter', shared: true }), app('helper', null)])
    await page.getByTestId(`app-row-${pid}/counter`).click()
    const toggle = page.getByTestId(`pinned-app-${pid}/counter`).getByTestId('pinned-share-toggle')
    await expect(toggle).toHaveText('Shared')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(toggle).toHaveText('Share')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(await sharedWrites(page)).toEqual([{ appId: 'counter', projectId: pid, shared: false }])

    // A user-folder app is everyone's already: no switch in its header
    await page.getByTestId('app-row-_user/helper').click()
    await expect(page.getByTestId('pinned-app-_user/helper').getByTestId('pinned-title')).toHaveText('App helper')
    await expect(page.getByTestId('pinned-app-_user/helper').getByTestId('pinned-share-toggle')).toHaveCount(0)
  })

  /*
   * The card attach_app raises the first time a project uses another project's app (the card is part B's,
   * `project_access`; here with `access: 'apps'`). The host side — that "always" is kept per pair and the
   * app then attaches — is app-access-manager.test.ts.
   */
  test("attaching another project's app asks once for the pair, naming the app, and 'a' answers always", async ({ page }) => {
    await page.goto('/?mock=1')
    const pid = await addProject(page, '/tmp/website')
    await page.getByTestId('trust-ask-yes-website').click()
    const sessionId = await newSession(page, 'website')
    await page.evaluate(
      ([sid, from]) =>
        (window as any).__mock.requestApproval(
          sid,
          {
            kind: 'project_access',
            access: 'apps',
            from: { id: from, name: 'website' },
            to: { id: 'p-ops', name: 'ops' },
            text: 'use its app Counter',
            app: { appId: 'counter', name: 'Counter' },
          },
          'xp-1',
        ),
      [sessionId, pid],
    )
    const card = page.getByTestId('approval-card')
    await expect(card).toHaveAttribute('data-kind', 'project_access')
    await expect(card.getByTestId('approval-detail')).toHaveText('Let website use the app Counter from ops?')
    await expect(card).toContainText("The app's tools attach to this session while it uses them.")
    await expect(card.getByTestId('approve-allow')).toBeVisible()
    await expect(card.getByTestId('approve-deny')).toBeVisible()
    await page.keyboard.press('a')
    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers))
      .toEqual([{ sessionId, requestId: 'xp-1', decision: 'always' }])
    await expect(card).toHaveCount(0)
  })
}

import { expect, test } from '@playwright/test'

const HOST_LABEL = 'mac-mini-loopback'
const GOOD_TOKEN = 'runtime-token-from-private-file'

async function stubRemoteHost(page: import('@playwright/test').Page, opts: { infoFailures?: number } = {}) {
  let infoAttempts = 0
  const authRequests: Array<{ url: string; authorization?: string }> = []

  await page.route('**/centralu-info.json', async (route) => {
    infoAttempts += 1
    if (infoAttempts <= (opts.infoFailures ?? 0)) {
      await route.fulfill({ status: 503, body: 'warming up' })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'remote', hostLabel: HOST_LABEL }),
    })
  })

  await page.route('**/centralu-auth', async (route, request) => {
    authRequests.push({ url: request.url(), authorization: request.headers().authorization })
    await route.fulfill({ status: request.headers().authorization === `Bearer ${GOOD_TOKEN}` ? 204 : 401 })
  })

  return { authRequests, infoAttempts: () => infoAttempts }
}

test('remote mode requires metadata retry and never stores or URLs the runtime token', async ({ page }) => {
  const remote = await stubRemoteHost(page, { infoFailures: 1 })

  await page.goto('/?remote=1')
  await expect(page.getByText('Remote host metadata failed with HTTP 503.')).toBeVisible()
  await page.getByRole('button', { name: 'Retry' }).click()

  await expect(page.getByTestId('remote-host-label')).toHaveText(HOST_LABEL)
  await expect(page.getByLabel('Runtime token')).toHaveAttribute('type', 'password')
  await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled()

  await page.getByLabel('Runtime token').fill('wrong-token')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('alert')).toContainText('Token rejected')

  await page.getByLabel('Runtime token').fill(GOOD_TOKEN)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('remote-app-shell')).toBeVisible()
  await expect(page.getByTestId('remote-topbar-label')).toContainText('REMOTE')
  await expect(page.getByTestId('remote-topbar-label')).toContainText(HOST_LABEL)
  await expect(page).toHaveTitle(`CENTRALU · Remote · ${HOST_LABEL}`)

  const storageSnapshot = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
    href: location.href,
  }))
  expect(JSON.stringify(storageSnapshot)).not.toContain(GOOD_TOKEN)
  expect(remote.authRequests).toHaveLength(2)
  expect(remote.authRequests[0]).toMatchObject({ authorization: 'Bearer wrong-token' })
  expect(remote.authRequests[1]).toMatchObject({ authorization: `Bearer ${GOOD_TOKEN}` })
  expect(remote.authRequests.every((request) => !request.url.includes(GOOD_TOKEN))).toBe(true)
  expect(remote.infoAttempts()).toBe(2)

  await page.screenshot({ path: '.omx/evidence/82/remote-gate-authenticated.png', fullPage: true })
})

test('remote token is tab-memory only and is required again after reload', async ({ page }) => {
  await stubRemoteHost(page)

  await page.goto('/?remote=1')
  await page.getByLabel('Runtime token').fill(GOOD_TOKEN)
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('remote-app-shell')).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Runtime token')).toBeVisible()
  await expect(page.getByLabel('Runtime token')).toHaveValue('')
})

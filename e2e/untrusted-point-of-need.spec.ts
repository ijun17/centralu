import { test, expect, type Page } from '@playwright/test'
import { setup, newSession } from './fixtures/control.js'
import { openSessionDialog } from './fixtures/new-session.js'

/**
 * A project the person has not trusted (#1512): what is off is said where they meet it, with the way to trust it there, and
 * the first worktree offers what a new worktree lacks.
 */

const trustCalls = (page: Page) => page.evaluate(() => (window as any).__mock.trustCalls as { projectId: string; trusted: boolean }[])

test('a session of an untrusted project says its instruction files are ignored, and trusting is one card away', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha')

  const notice = page.getByTestId('untrusted-notice')
  await expect(notice).toContainText('alpha is not trusted')
  await expect(notice).toContainText('CLAUDE.md and AGENTS.md')
  await expect(notice).toContainText("can't start agents")

  // The decision stays the person's: the card with the project's apps opens in place, and Trust is its answer
  await page.getByTestId('untrusted-notice-trust').click()
  expect(await trustCalls(page)).toEqual([])
  await page.getByTestId('untrusted-notice-trust-card-yes').click()
  await expect.poll(() => trustCalls(page)).toHaveLength(1)
  await expect(notice).toHaveCount(0)
})

test('the notice can be put away', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha')
  await expect(page.getByTestId('untrusted-notice')).toBeVisible()
  await page.getByTestId('untrusted-notice-dismiss').click()
  await expect(page.getByTestId('untrusted-notice')).toHaveCount(0)
})

test('a trusted project shows no notice', async ({ page }) => {
  await setup(page, { projects: ['/tmp/beta'], trusted: true })
  await newSession(page, 'beta')
  await expect(page.getByTestId('prompt-input')).toBeVisible()
  await expect(page.getByTestId('untrusted-notice')).toHaveCount(0)
})

test('the project row says its CLAUDE.md and AGENTS.md are ignored while it is not trusted', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await expect(page.getByTestId('trust-ask-alpha')).toContainText('CLAUDE.md and AGENTS.md')
})

test('a worktree in an untrusted project is refused before the press, with Trust beside it', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('worktree-toggle').locator('input').check()
  await expect(page.getByTestId('worktree-untrusted')).toContainText('A worktree needs a trusted project')
  await page.getByTestId('worktree-untrusted-trust').click()
  await page.getByTestId('worktree-untrusted-trust-card-yes').click()
  await expect(page.getByTestId('worktree-untrusted')).toHaveCount(0)
})

test('the first worktree offers the install command and the .env files as chips that fill their fields', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'pnpm-lock.yaml', path: 'pnpm-lock.yaml', isDir: false, ignored: false }]
    m.gitState.ignored = [
      { path: '.env', bytes: 120 },
      { path: '.env.local', bytes: 80 },
      { path: 'node_modules', bytes: 5000 },
    ]
  })
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('worktree-toggle').locator('input').check()

  const install = page.getByTestId('suggest-install')
  await expect(install).toHaveText('run pnpm install')
  await install.click()
  await expect(page.getByTestId('worktree-setup-command')).toHaveValue('pnpm install')

  const env = page.getByTestId('suggest-env')
  await expect(env).toHaveText('copy .env, .env.local')
  await env.click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('.env, .env.local')
  // Pressed again, it takes them out; node_modules was never offered by it
  await env.click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('')
})

test('once a setup is saved the chips are gone', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fsState.entries[''] = [{ name: 'pnpm-lock.yaml', path: 'pnpm-lock.yaml', isDir: false, ignored: false }]
    m.gitState.ignored = [{ path: '.env', bytes: 120 }]
  })
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('suggest-install').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await openSessionDialog(page, 'alpha')
  await page.getByTestId('worktree-toggle').locator('input').check()
  await expect(page.getByTestId('worktree-setup-summary')).toContainText('setup: pnpm install')
  await expect(page.getByTestId('worktree-first-suggestions')).toHaveCount(0)
})

import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * A linked machine's sessions asking this computer's projects (#550, docs/plans/remote-hub.md §12.7, owner decision
 * 2026-10-18), on screen against the mock: the per-machine switch in Settings → Machines (off by default, turning it on
 * asks once and says what it allows, off forgets the pairs), the approved pairs withdrawn there, and this computer's card
 * that names the machine and remembers Allow for the pair. The host side is links/reverse-asks.test.ts. A function,
 * because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 */

async function addMachine(page: Page, name: string): Promise<void> {
  const open = page.getByTestId('machines-add-open')
  if (await open.isVisible()) await open.click()
  await page.getByTestId('machines-add-name').fill(name)
  await page.getByTestId('machines-add-target').fill(`me@${name.toLowerCase().replace(/\s+/g, '-')}`)
  await page.getByTestId('machines-add-shell-posix').click()
  await page.getByTestId('machines-add-confirm').click()
  await expect(page.getByTestId('machines-add-form')).toHaveCount(0)
}

export function machineAsksTests(): void {
  // #1273 review: a machine with no window of its own has its "Allow auto from a linked computer" set from here
  test("each machine's own switch for this computer's auto agents is read and set here", async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()
    await addMachine(page, 'Ubuntu box')
    const sw = page.getByTestId('machine-hub-auto-ubuntu-box')
    await expect(sw).toBeChecked()
    await expect(page.getByTestId('machine-row-ubuntu-box')).toContainText('Let auto sessions here start agents under auto on Ubuntu box')
    await expect(page.getByTestId('machine-hub-auto-note-ubuntu-box')).toContainText('runs under auto too, without asking')
    await sw.uncheck()
    await expect(sw).not.toBeChecked()
    await expect.poll(() => page.evaluate(() => [...(window as any).__mock.hubAutoOff])).toEqual(['ubuntu-box'])
    await sw.check()
    await expect.poll(() => page.evaluate(() => [...(window as any).__mock.hubAutoOff])).toEqual([])
  })

  test('the switch is off for a new machine, asks once before it turns on, lists the pairs and forgets them when off', async ({ page }) => {
    await setup(page, ['/tmp/alpha'])
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-tab-machines').click()
    await addMachine(page, 'Ubuntu box')
    const sw = page.getByTestId('machine-asks-ubuntu-box')

    await test.step('off by default; Cancel leaves it off', async () => {
      await expect(sw).not.toBeChecked()
      await expect(page.getByTestId('machine-row-ubuntu-box')).toContainText("Let sessions on Ubuntu box ask this computer's projects")
      await sw.click()
      await expect(page.getByTestId('machine-asks-text-ubuntu-box')).toContainText('a card asks you on this computer')
      await page.getByTestId('machine-asks-no-ubuntu-box').click()
      await expect(sw).not.toBeChecked()
      await expect(page.getByTestId('machine-asks-confirm-ubuntu-box')).toHaveCount(0)
    })

    await test.step('Turn on: no pair yet, and the first ask of each will ask here', async () => {
      await sw.click()
      await page.getByTestId('machine-asks-yes-ubuntu-box').click()
      await expect(sw).toBeChecked()
      await expect(page.getByTestId('machine-ask-pairs-empty-ubuntu-box')).toContainText('No session on Ubuntu box is allowed yet')
    })

    await test.step('an approved pair is listed and withdrawn here', async () => {
      await page.evaluate(() => {
        const mock = (window as any).__mock
        const alpha = Object.values((window as any).__store.getState().projects as Record<string, { id: string; name: string }>).find((p) => p.name === 'alpha')!
        mock.askPairs = [
          { machineId: 'ubuntu-box', machineName: 'Ubuntu box', sessionId: 'w1', sessionName: 'nightly', projectId: alpha.id, projectName: 'alpha', decidedAt: Date.now() },
        ]
        mock.emit({ type: 'project_consents_changed' })
      })
      const pair = page.getByTestId('machine-ask-pairs-list-ubuntu-box')
      await expect(pair).toContainText('nightly may ask alpha')
      await pair.getByRole('button', { name: 'Withdraw' }).click()
      await expect(page.getByTestId('machine-ask-pairs-empty-ubuntu-box')).toBeVisible()
    })

    await test.step('off asks nothing and forgets the pairs', async () => {
      await page.evaluate(() => {
        const mock = (window as any).__mock
        mock.askPairs = [{ machineId: 'ubuntu-box', machineName: 'Ubuntu box', sessionId: 'w2', sessionName: 'w2', projectId: 'p', projectName: 'alpha', decidedAt: 1 }]
      })
      await sw.click()
      await expect(sw).not.toBeChecked()
      await expect(page.getByTestId('machine-asks-confirm-ubuntu-box')).toHaveCount(0)
      await expect(page.getByTestId('machine-ask-pairs-ubuntu-box')).toHaveCount(0)
      expect(await page.evaluate(() => (window as any).__mock.askPairs)).toEqual([])
    })
  })

  test('the card for an ask from a linked machine names the machine and the session there, and offers Allow and Deny', async ({ page }) => {
    await setup(page, ['/tmp/toolkit'])
    const asked = await newSession(page, 'toolkit')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const toolkit = await page.evaluate(() => Object.values((window as any).__store.getState().projects as Record<string, { id: string; name: string }>).find((p) => p.name === 'toolkit')!.id)
    await page.evaluate(
      ([sid, pid]) =>
        (window as any).__mock.emit({
          type: 'approval_request',
          sessionId: sid,
          requestId: 'xm-1',
          detail: {
            kind: 'project_access',
            access: 'delegate',
            from: { id: 'ubuntu-box', name: 'api', machine: 'Ubuntu box', session: { id: 'w1', name: 'nightly' } },
            to: { id: pid, name: 'toolkit', trusted: true },
            session: { id: sid, name: 'Sprites' },
            text: 'export the sprites',
          },
        }),
      [asked, toolkit] as const,
    )
    const card = page.locator('[data-testid="approval-card"][data-kind="project_access"]')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('approval-detail')).toHaveText('Let "nightly" in "api" on "Ubuntu box" ask "toolkit" / "Sprites" to export the sprites?')
    await expect(card).toContainText('A session on Ubuntu box wants to ask a project here')
    await expect(card.getByTestId('approval-from-machine')).toContainText('withdraw it in Settings → Machines')
    await expect(card.getByTestId('approve-allow')).toHaveText(/Allow(?! once)/)
    await expect(card.getByTestId('approve-always')).toHaveCount(0)
    // "a" (always) does nothing here: Allow is already remembered for the pair
    await page.keyboard.press('a')
    await expect(card).toBeVisible()
    await card.getByTestId('approve-allow').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers))
      .toEqual([{ sessionId: asked, requestId: 'xm-1', decision: 'allow' }])
  })
}

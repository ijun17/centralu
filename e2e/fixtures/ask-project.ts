import { expect, test, type Page } from '@playwright/test'
import { newSession, setup } from './project-screen.js'

/**
 * One project asking another (#371 part B) on screen, driven through the mock platform with the events the host
 * sends: the consent card in the caller's session, the caller's compact card linking to the session doing the work,
 * that session's "asked by" mark linking back, and the remembered pairs in Settings.
 *
 * A function because it runs in Chromium and in WebKit (ask-project-webkit.spec.ts) — the desktop app is WKWebView,
 * and the card answers by keyboard.
 */

async function emit(page: Page, sessionId: string, event: Record<string, unknown>) {
  await page.evaluate(([sid, e]) => (window as any).__mock.emit({ ...(e as object), sessionId: sid }), [sessionId, event] as const)
}

const projectId = (page: Page, name: string) =>
  page.evaluate((n) => Object.values((window as any).__store.getState().projects as Record<string, { id: string; name: string }>).find((p) => p.name === n)!.id, name)

async function start(page: Page): Promise<{ caller: string; consumer: string; toolkit: string }> {
  await setup(page, ['/tmp/consumer', '/tmp/toolkit'])
  const caller = await newSession(page, 'consumer')
  return { caller, consumer: await projectId(page, 'consumer'), toolkit: await projectId(page, 'toolkit') }
}

export function askProjectTests(): void {
  test.describe('asking another project (#371)', () => {
    test('the consent card asks in words, and "a" answers always for the pair', async ({ page }) => {
      const { caller, consumer, toolkit } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      await emit(page, caller, {
        type: 'approval_request',
        requestId: 'xp-1',
        detail: {
          kind: 'project_access',
          access: 'delegate',
          from: { id: consumer, name: 'consumer' },
          to: { id: toolkit, name: 'toolkit' },
          text: 'export the sprites',
        },
      })
      const card = page.locator('[data-testid="approval-card"][data-kind="project_access"]')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('approval-detail')).toHaveText('Let consumer ask toolkit to export the sprites?')
      await expect(card.getByTestId('approve-allow')).toContainText('Allow once')
      await expect(card.getByTestId('approve-always')).toContainText('Always for this pair')
      await expect(card.getByTestId('approve-deny')).toContainText('Deny')

      await page.keyboard.press('a')
      await expect
        .poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers))
        .toEqual([{ sessionId: caller, requestId: 'xp-1', decision: 'always' }])
      await expect(card).toHaveCount(0)
      await expect(page.getByText('Always allowed: consumer → toolkit. Revoke it in Settings.')).toBeVisible()
    })

    test('the caller\'s card links to the session doing the work, and that session links back', async ({ page }) => {
      const { caller, toolkit } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      await emit(page, caller, { type: 'tool_call', callId: 'ask-1', summary: { tool: 'mcp__centralu__ask_project', title: 'toolkit', readOnly: false, paths: [] } })
      // The host opens the delegated session in the other project, marked with the caller
      await page.evaluate(
        ([d, p, c]) =>
          (window as any).__mock.emit({
            type: 'session_created',
            sessionId: d,
            session: { id: d, projectId: p, tool: 'claude', externalId: null, name: 'Asked by consumer · 10:00', autoNamed: false, state: 'working', createdAt: Date.now(), askedBy: c },
          }),
        ['delegated-1', toolkit, caller] as const,
      )

      const card = page.getByTestId('ask-project-card')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('ask-project-toggle')).toContainText('Asked toolkit')
      await expect(card.getByTestId('ask-project-status')).toContainText('working…')

      await card.getByTestId('ask-project-open').click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe('delegated-1')
      const back = page.getByTestId('asked-by-badge')
      await expect(back).toContainText('Asked by consumer')
      await back.click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(caller)

      // The answer lands: the card says so, and the model's text is one click away
      await emit(page, caller, {
        type: 'tool_result',
        callId: 'ask-1',
        ok: true,
        summary: 'toolkit answered (from the session "Asked by consumer · 10:00" [delegated-1] in toolkit), as JSON:\n"Exported 12 sprites"',
      })
      await expect(card.getByTestId('ask-project-status')).toContainText('answered')
      await expect(card.getByTestId('ask-project-result')).toHaveCount(0)
      await card.getByTestId('ask-project-toggle').click()
      await expect(card.getByTestId('ask-project-result')).toContainText('Exported 12 sprites')
      await expect(card.getByTestId('ask-project-open')).toBeVisible()
    })

    test('Settings lists the pairs allowed always, and revoking one takes it off', async ({ page }) => {
      const { consumer, toolkit } = await start(page)
      await page.evaluate(
        ([c, t]) => {
          ;(window as any).__mock.consentsList = [
            { fromProjectId: c, fromName: 'consumer', toProjectId: t, toName: 'toolkit', kind: 'delegate', decidedAt: Date.now() },
          ]
        },
        [consumer, toolkit] as const,
      )
      await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
      await page.getByTestId('settings-tab-permissions').click()
      const row = page.getByTestId(`project-consent-${consumer}>${toolkit}>delegate`)
      await expect(row).toContainText('consumer may ask toolkit')
      await page.getByTestId(`revoke-consent-${consumer}>${toolkit}>delegate`).click()
      await expect(row).toHaveCount(0)
      await expect(page.getByTestId('project-consents-empty')).toBeVisible()
      expect(await page.evaluate(() => (window as any).__mock.consentsList)).toEqual([])
    })
  })
}

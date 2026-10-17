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
  // A new session's composer has the keyboard (#528); the card's letter keys answer from outside a field
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
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
          session: { id: 'existing', name: 'Sprites' },
          text: 'export the sprites',
        },
      })
      const card = page.locator('[data-testid="approval-card"][data-kind="project_access"]')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('approval-detail')).toHaveText('Let "consumer" ask "toolkit" / "Sprites" to export the sprites?')
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

    // #382: asking into a project the person has not trusted is allowed, and the card says so before they answer
    test('a card for an untrusted target says it is not trusted; a trusted one says nothing more', async ({ page }) => {
      const { caller, consumer, toolkit } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      const ask = (requestId: string, trusted: boolean) =>
        emit(page, caller, {
          type: 'approval_request',
          requestId,
          detail: {
            kind: 'project_access',
            access: 'delegate',
            from: { id: consumer, name: 'consumer' },
            to: { id: toolkit, name: 'toolkit', trusted },
            text: 'export the sprites',
          },
        })
      await ask('xp-u', false)
      const card = page.locator('[data-testid="approval-card"][data-kind="project_access"]')
      await expect(card.getByTestId('approval-detail')).toHaveText('Let "consumer" ask "toolkit" (not trusted) to export the sprites?')
      await expect(card.getByTestId('approval-untrusted')).toContainText('You have not trusted toolkit.')
      await page.keyboard.press('n')
      await expect(card).toHaveCount(0)

      await ask('xp-t', true)
      await expect(card.getByTestId('approval-detail')).toHaveText('Let "consumer" ask "toolkit" to export the sprites?')
      await expect(card.getByTestId('approval-untrusted')).toHaveCount(0)
    })

    // #700: a project on a linked machine is named with its machine, and nothing is remembered for it
    test('a card for a project on a linked machine names the machine and has no "always"', async ({ page }) => {
      const { caller, consumer } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      await emit(page, caller, {
        type: 'approval_request',
        requestId: 'xp-m',
        detail: {
          kind: 'project_access',
          access: 'delegate',
          from: { id: consumer, name: 'consumer' },
          to: { id: 'ijun1.p-cc', name: 'cc', machine: 'Windows PC', trusted: true },
          session: { id: 'ijun1.w1', name: 'Sprites' },
          text: 'export the sprites',
        },
      })
      const card = page.locator('[data-testid="approval-card"][data-kind="project_access"]')
      await expect(card.getByTestId('approval-detail')).toHaveText('Let "consumer" ask "cc" on "Windows PC" / "Sprites" to export the sprites?')
      await expect(card.getByTestId('approve-always')).toHaveCount(0)
      await expect(card).toContainText('Nothing is remembered for a project on another machine')
      // The letter that answers "always" does nothing on this card
      await page.keyboard.press('a')
      await expect(card).toBeVisible()
      await page.keyboard.press('y')
      await expect
        .poll(() => page.evaluate(() => (window as any).__mock.approvalAnswers))
        .toEqual([{ sessionId: caller, requestId: 'xp-m', decision: 'allow' }])
    })

    test('the caller\'s card opens the existing session and the task shows its caller', async ({ page }) => {
      const { caller, toolkit } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      await emit(page, caller, { type: 'tool_call', callId: 'ask-1', summary: { tool: 'mcp__centralu__ask_project', title: 'toolkit', paths: [] } })
      // An existing ordinary session receives a task with visible caller provenance
      await page.evaluate(
        ([d, p]) =>
          (window as any).__mock.emit({
            type: 'session_created',
            sessionId: d,
            session: { id: d, projectId: p, tool: 'claude', externalId: null, name: 'Sprites', autoNamed: false, state: 'working', createdAt: Date.now() },
          }),
        ['delegated-1', toolkit] as const,
      )

      await emit(page, 'delegated-1', { type: 'user_message', seq: 1, text: "[A session asks through Centralu's ask_project.] Export sprites", from: { sessionId: caller, name: 'consumer session' } })

      const card = page.getByTestId('ask-project-card')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('ask-project-toggle')).toContainText('Asked toolkit')
      await expect(card.getByTestId('ask-project-status')).toContainText('working…')

      await card.getByTestId('ask-project-open').click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe('delegated-1')
      await expect(page.getByText('Export sprites', { exact: false })).toBeVisible()
      await expect(page.getByTestId('msg-user-from')).toHaveText('consumer session ⤷')
      await expect(page.getByTestId('asked-by-badge')).toHaveCount(0)
      await page.evaluate((id) => (window as any).__store.getState().focusSession(id), caller)

      // The answer lands: the card says so, and the model's text is one click away
      await emit(page, caller, {
        type: 'tool_result',
        callId: 'ask-1',
        ok: true,
        summary: 'toolkit answered (from the session "Sprites" [delegated-1] in toolkit), as JSON:\n"Exported 12 sprites"',
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

  /*
   * start_agent (#561): a session starts another agent in its own project. The card says the agent, the
   * permissions and the job; "a" allows it for this session, ⌥a (or the button) for the whole project.
   */
  test.describe('starting another agent in the same project (#561)', () => {
    const agentCard = (page: Page, caller: string, consumer: string, requestId: string) =>
      emit(page, caller, {
        type: 'approval_request',
        requestId,
        detail: { kind: 'agent_start', project: { id: consumer, name: 'consumer' }, tool: 'Codex', preset: 'normal', text: 'write the parser' },
      })

    test('the card asks in words; "a" is always for this session, ⌥a and the button for the project', async ({ page }) => {
      const { caller, consumer } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      await agentCard(page, caller, consumer, 'ag-1')
      const card = page.locator('[data-testid="approval-card"][data-kind="agent_start"]')
      await expect(card.getByTestId('approval-detail')).toHaveText('Start Codex in "consumer", with normal permissions, to write the parser?')
      await expect(card.getByTestId('approve-allow')).toContainText('Allow once')
      await expect(card.getByTestId('approve-always')).toContainText('Always for this session')
      await expect(card.getByTestId('approve-always-project')).toContainText('Always for this project')
      await page.keyboard.press('a')
      await expect(card).toHaveCount(0)
      await expect(page.getByText('This session may start agents until Centralu restarts.')).toBeVisible()

      await agentCard(page, caller, consumer, 'ag-2')
      await page.keyboard.press('Alt+a')
      await expect(card).toHaveCount(0)
      await agentCard(page, caller, consumer, 'ag-3')
      await card.getByTestId('approve-always-project').click()
      await expect(card).toHaveCount(0)
      await expect(page.getByText('Sessions in consumer may start agents. Revoke it in Settings.')).toBeVisible()
      expect(await page.evaluate(() => (window as any).__mock.approvalAnswers.map((a: { decision: string }) => a.decision))).toEqual(['always', 'always', 'always'])
      expect(await page.evaluate(() => (window as any).__mock.approvalScopes)).toEqual(['session', 'project', 'project'])
    })

    /*
     * #853: the orchestrator starts sessions outside any project. Its card names no project and offers no project-wide
     * always, and the session it started hangs under its row, the one place a session with no project and no app has.
     */
    test("the orchestrator's card names no project, and its child hangs under its row", async ({ page }) => {
      await setup(page, ['/tmp/consumer'])
      const orc = await page.evaluate(async () => (await (window as any).__mock.agents.orchestrator()) as Record<string, unknown>)
      await page.getByTestId('orchestrator-button').click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().orchestratorId)).toBe(orc.id)
      await emit(page, orc.id as string, {
        type: 'approval_request',
        requestId: 'ag-orc',
        detail: { kind: 'agent_start', project: { id: '', name: 'a folder of its own, outside any project' }, tool: 'Codex', preset: 'normal', text: 'look up the release notes' },
      })
      const card = page.locator('[data-testid="approval-card"][data-kind="agent_start"]')
      await expect(card.getByTestId('approval-detail')).toHaveText('Start Codex in a folder of its own, outside any project, with normal permissions, to look up the release notes?')
      // "Always for this session" lives while the host does: the card says so (#994 review)
      await expect(card).toContainText('Always for this session lasts until Centralu restarts.')
      await expect(card.getByTestId('approve-always')).toContainText('Always for this session')
      await expect(card.getByTestId('approve-always-project')).toHaveCount(0)
      await card.getByTestId('approve-allow').click()
      await expect(card).toHaveCount(0)

      await page.evaluate((o) => {
        const child = { ...o, id: 'orc-child-1', kind: 'worker', name: 'Look up the release notes', askedBy: o.id }
        ;(window as any).__mock.emit({ type: 'session_created', sessionId: child.id, session: child })
      }, orc)
      const row = page.getByTestId('orchestrator-children').getByTestId('orchestrator-child-row-orc-child-1')
      await expect(row).toContainText('Look up the release notes')
      await row.click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe('orc-child-1')

      // Its ⋯ menu deletes it, through the same dialog as a project's session (#994 review)
      await row.hover()
      await page.getByTestId('session-menu-orc-child-1').click()
      await page.getByTestId('delete-session-orc-child-1').click()
      await expect(page.getByTestId('confirm-delete')).toBeVisible()
    })

    // #994 review: a child whose orchestrator was replaced kept no row
    test('a child whose orchestrator is gone keeps a row, among the earlier ones', async ({ page }) => {
      await setup(page, ['/tmp/consumer'])
      const orc = await page.evaluate(async () => (await (window as any).__mock.agents.orchestrator()) as Record<string, unknown>)
      await page.evaluate((o) => {
        const child = { ...o, id: 'orc-child-2', kind: 'worker', name: 'An older lookup', askedBy: 'orc-gone' }
        ;(window as any).__mock.emit({ type: 'session_created', sessionId: child.id, session: child })
      }, orc)
      await expect(page.getByTestId('orchestrator-children-earlier')).toHaveText('Started by an earlier orchestrator')
      await expect(page.getByTestId('orchestrator-child-row-orc-child-2')).toContainText('An older lookup')
    })

    // #673: the person was looking at another session and never saw the card, so the session worked alone
    test('a card raised in a session off screen leaves a card in the top right that opens it', async ({ page }) => {
      const { caller, consumer } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      // The person moves on to another session
      const other = await newSession(page, 'consumer')
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(other)
      await agentCard(page, caller, consumer, 'ag-off')
      const toast = page.locator(`[data-testid="notice"][data-kind="agent_start"][data-session="${caller}"]`)
      await expect(toast).toBeVisible()
      await expect(toast).toContainText('Wants to start an agent')
      await toast.getByTestId('notice-open').click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(caller)
      await expect(page.locator('[data-testid="approval-card"][data-kind="agent_start"]')).toBeVisible()
      await expect(toast).toHaveCount(0)
    })

    test('a card answered elsewhere takes its card in the top right away', async ({ page }) => {
      const { caller, consumer } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      await newSession(page, 'consumer')
      await agentCard(page, caller, consumer, 'ag-else')
      const toast = page.locator(`[data-testid="notice"][data-kind="agent_start"][data-session="${caller}"]`)
      await expect(toast).toBeVisible()
      // Another window answered it, or the session withdrew it
      await emit(page, caller, { type: 'approval_resolved', requestId: 'ag-else', decision: 'allow' })
      await expect(toast).toHaveCount(0)
    })

    test('a card raised in the session on screen leaves no card in the top right', async ({ page }) => {
      const { caller, consumer } = await start(page)
      await emit(page, caller, { type: 'state_change', state: 'working' })
      await agentCard(page, caller, consumer, 'ag-on')
      await expect(page.locator('[data-testid="approval-card"][data-kind="agent_start"]')).toBeVisible()
      await expect(page.locator('[data-testid="notice"][data-kind="agent_start"]')).toHaveCount(0)
    })

    test('a request that ended without an agent leaves a line in the session for the person', async ({ page }) => {
      const { caller } = await start(page)
      await emit(page, caller, {
        type: 'notice',
        seq: 5,
        level: 'warning',
        from: 'Centralu',
        label: 'agent request',
        audience: 'you',
        text: 'The request to start Codex (“write the parser”) was withdrawn: the call that asked was cancelled before you answered. No agent was started.',
      })
      const line = page.getByTestId('msg-mark').filter({ hasText: 'write the parser' })
      await expect(line.getByTestId('notice-head')).toContainText('Centralu · agent request')
      await expect(line).toContainText('No agent was started.')
    })

    test('the child links back to the session that started it, by name', async ({ page }) => {
      const { caller, consumer } = await start(page)
      await page.evaluate(
        ([d, p, c]) =>
          (window as any).__mock.emit({
            type: 'session_created',
            sessionId: d,
            session: { id: d, projectId: p, tool: 'codex', externalId: null, name: 'write the parser', autoNamed: false, state: 'working', createdAt: Date.now(), askedBy: c },
          }),
        ['child-1', consumer, caller] as const,
      )
      await page.evaluate(() => (window as any).__store.getState().focusSession('child-1'))
      const back = page.getByTestId('asked-by-badge')
      await expect(back).toContainText('Started by')
      await back.click()
      await expect.poll(() => page.evaluate(() => (window as any).__store.getState().focusedSessionId)).toBe(caller)
    })

    test('Settings lists a project whose sessions may start agents, and revokes it', async ({ page }) => {
      const { consumer } = await start(page)
      await page.evaluate((c) => {
        ;(window as any).__mock.consentsList = [{ fromProjectId: c, fromName: 'consumer', toProjectId: c, toName: 'consumer', kind: 'agents', decidedAt: Date.now() }]
      }, consumer)
      await page.evaluate(() => (window as any).__store.getState().toggleSettings(true))
      await page.getByTestId('settings-tab-permissions').click()
      const row = page.getByTestId(`project-consent-${consumer}>${consumer}>agents`)
      await expect(row).toHaveText(/^consumer sessions may start agents/)
      await page.getByTestId(`revoke-consent-${consumer}>${consumer}>agents`).click()
      await expect(row).toHaveCount(0)
    })
  })
}

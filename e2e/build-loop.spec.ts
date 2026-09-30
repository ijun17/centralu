import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * The UI side of the build loop (M4 C) — real UI on a mock platform, a real ViewHost, and a test
 * view built with the official ext-apps `App`.
 *
 * What the host does (scaffolding the template, raising the builder session, composing the
 * preamble, bundling errors, relaunching) is covered with a real app by agent-host's tests. Here
 * what is checked is what the UI does when it calls that door. The mock mirrors the host's exact
 * decisions and wording — a refusal reads the host's exact words, and the preamble is composed
 * with the same function (protocol) the host uses.
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
  codeStamp?: string
}

function app(appId: string, projectId: string | null, over: Partial<AppInfo> = {}): AppInfo {
  return {
    appId,
    projectId,
    dir: `/tmp/${projectId ?? 'user'}/.centralu/apps/${appId}`,
    name: `App ${appId}`,
    version: '0.1.0',
    description: null,
    home: 'show',
    trusted: true,
    status: 'stopped',
    error: null,
    warnings: [],
    ...over,
  }
}

const setApps = (page: Page, list: AppInfo[]) => page.evaluate((l) => (window as any).__mock.setExternalApps(l), list)
const trustCalls = (page: Page) => page.evaluate(() => (window as any).__mock.trustCalls as { projectId: string; trusted: boolean }[])

/** Picks a folder and registers a project, returning the id the mock assigned. If `trust`, it trusts the project right from the ask */
async function addProject(page: Page, path: string, trust = true): Promise<string> {
  await page.evaluate((p) => ((window as any).__mock.nextPickedDirectory = p), path)
  await page.getByTestId('add-project').click()
  const name = path.split('/').pop()!
  await expect(page.getByTestId(`project-${name}`)).toBeVisible()
  const pid = await page.evaluate(
    (p) => (Object.values((window as any).__store.getState().projects) as { id: string; path: string }[]).find((x) => x.path === p)!.id,
    path,
  )
  await page.getByTestId(`trust-ask-${trust ? 'yes' : 'no'}-${name}`).click()
  if (trust) await expect.poll(() => trustCalls(page)).toContainEqual({ projectId: pid, trusted: true })
  return pid
}

/** The inner frame the app's HTML runs in (the outer one is the proxy) */
const viewOf = (page: Page, key: string): FrameLocator =>
  page.getByTestId(`pinned-app-${key}`).getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()

const createdApps = (page: Page) => page.evaluate(() => (window as any).__mock.createdApps as Record<string, unknown>[])
const sessionsOfApp = (page: Page, appId: string) =>
  page.evaluate(
    (id) =>
      (Object.values((window as any).__store.getState().sessions) as { id: string; appId: string | null; name: string; tool: string; projectId: string | null }[])
        .filter((s) => s.appId === id)
        .map(({ id: sid, name, tool, projectId }) => ({ id: sid, name, tool, projectId })),
    appId,
  )

/**
 * One real ViewHost — plugged into the mock's `openView` (pinned view) and `viewFrame` (view
 * address). A newly created app's view also opens here: as if the host called home and opened the
 * instance, the result carries which app's home this is.
 */
let fx: FixtureHost
const docs: Record<string, { html: string }> = {}
test.beforeAll(async () => {
  for (const id of ['team-notes', 'daily-log', 'notes', 'slider']) docs[`${id} ui://${id}/main`] = { html: fixtureViewHtml() }
  fx = await startFixtureHost(docs)
})
test.afterAll(async () => {
  await fx?.close()
})

test.beforeEach(async ({ page }) => {
  await page.exposeFunction(
    '__viewFrame',
    (appId: string, instanceId: string, opts: { projectId?: string | null; hostOrigin: string }) =>
      fx.views.frame({ app: { appId, projectId: opts.projectId ?? null }, instanceId, hostOrigin: opts.hostOrigin }),
  )
  await page.exposeFunction('__openView', (appId: string, projectId: string | null) => {
    const instanceId = fx.open({ projectId, appId }, `ui://${appId}/main`)
    return {
      instanceId,
      tool: 'show',
      resourceUri: `ui://${appId}/main`,
      toolInput: {},
      toolResult: { content: [{ type: 'text', text: 'home' }], structuredContent: { home: appId } },
      runId: `run-${instanceId}`,
    }
  })
  await page.exposeFunction('__openInline', (appId: string, projectId: string | null) => fx.open({ projectId, appId }, `ui://${appId}/main`))
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const w = window as any
    w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
    w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
    w.__mock.inlineInstanceProvider = (a: string, p: string | null) => w.__openInline(a, p)
  })
})

test.describe('C-1: new app', () => {
  test('New app in the project menu: the id is derived from the name, and creating it with the chosen agent raises the app, opens the view, and creates the builder session', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')
    await expect(dialog).toContainText('New app · alpha')

    await dialog.getByTestId('new-app-name').fill('Team Notes')
    // The id derived from the name — it follows the name unless the person edits it
    await expect(dialog.getByTestId('new-app-id')).toHaveValue('team-notes')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveCount(0)
    // The default is the project's default tool — here the other one is picked
    await expect(dialog.getByTestId('new-app-tool-claude')).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('new-app-tool-codex').click()
    await dialog.getByTestId('new-app-create').click()
    await expect(dialog).toHaveCount(0)

    // What reached the host: this project, the derived id, the entered name, the chosen tool
    expect(await createdApps(page)).toEqual([{ projectId: pid, id: 'team-notes', name: 'Team Notes', tool: 'codex' }])
    // The app shows under that project, and the pinned view opens and receives home's result
    const row = page.getByTestId('project-alpha').getByTestId(`app-row-${pid}/team-notes`)
    await expect(row).toHaveText('Team Notes')
    await expect(row).toHaveAttribute('aria-current', 'page')
    const pinned = page.getByTestId(`pinned-app-${pid}/team-notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(viewOf(page, `${pid}/team-notes`).locator('li[data-k="tool-result"]')).toHaveText('tool-result {"home":"team-notes"}')
    // The builder session: belongs to that app, uses the chosen tool, gets the name the person set — shown as a row under that project in the sidebar
    const builders = await sessionsOfApp(page, 'team-notes')
    expect(builders).toEqual([{ id: expect.any(String), name: 'Team Notes · builder', tool: 'codex', projectId: pid }])
    await expect(page.getByTestId('project-alpha').getByTestId(`session-row-${builders[0]!.id}`)).toContainText('Team Notes · builder')
  })

  test('when the host refuses, its exact words show and the dialog stays open — a malformed id is not even sent', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await setApps(page, [app('notes', pid, { dir: '/tmp/alpha/.centralu/apps/notes' })])
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')

    // Shape is blocked first, by the dialog running the same check as the host — nothing is sent
    await dialog.getByTestId('new-app-name').fill('Store')
    await dialog.getByTestId('new-app-id').fill('app-store')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveText('Ids starting with "app-" are how apps attach to sessions. Pick another.')
    await expect(dialog.getByTestId('new-app-create')).toBeDisabled()
    await dialog.getByTestId('new-app-id').fill('')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveText('Give the app an id: lowercase letters, digits and hyphens.')
    expect(await createdApps(page)).toEqual([])

    // An id that already exists is known only to the host — its refusal shows verbatim
    await dialog.getByTestId('new-app-id').fill('notes')
    await dialog.getByTestId('new-app-create').click()
    await expect(dialog.getByTestId('new-app-error')).toHaveText('An app "notes" already exists (/tmp/alpha/.centralu/apps/notes) — use another id')
    await expect(dialog).toBeVisible()
    expect(await createdApps(page)).toEqual([{ projectId: pid, id: 'notes', name: 'Store', tool: 'claude' }])
    expect(await sessionsOfApp(page, 'notes')).toEqual([])
    await expect(page.getByTestId(`pinned-app-${pid}/notes`)).toHaveCount(0)
  })

  test('an untrusted project: the dialog states the reason and lets it be trusted right there — nothing is created before that', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha', false)
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')
    await dialog.getByTestId('new-app-name').fill('Daily log')
    await expect(dialog.getByTestId('new-app-untrusted')).toContainText('Apps only run in projects you trust.')
    await expect(dialog.getByTestId('new-app-create')).toBeDisabled()

    await dialog.getByTestId('new-app-trust').click()
    await expect.poll(() => trustCalls(page)).toEqual([{ projectId: pid, trusted: true }])
    await expect(dialog.getByTestId('new-app-untrusted')).toHaveCount(0)
    await dialog.getByTestId('new-app-create').click()
    await expect(page.getByTestId(`pinned-app-${pid}/daily-log`).getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  })

  test('New app in the user folder: the group shows even with no apps, an unusable agent states the reason, and creating one places it in that group', async ({ page }) => {
    await addProject(page, '/tmp/alpha')
    // Codex is not logged in
    await page.evaluate(() => {
      const m = (window as any).__mock
      m.detected = m.detected.map((t: { name: string }) => (t.name === 'codex' ? { ...t, loggedIn: false } : t))
    })
    const group = page.getByTestId('user-apps')
    await expect(group).toContainText('Your apps')
    await expect(group.getByTestId('user-apps-list')).toHaveCount(0)
    await group.getByTestId('user-apps-new').click()
    const dialog = page.getByTestId('new-app-dialog')
    await expect(dialog).toContainText('New app · Your apps')
    await dialog.getByTestId('new-app-name').fill('Daily log')
    await dialog.getByTestId('new-app-tool-codex').click()
    await expect(dialog.getByTestId('new-app-tool-blocked')).toHaveText('Codex needs a login. Run codex login in a terminal, then open this again.')
    await expect(dialog.getByTestId('new-app-create')).toBeDisabled()

    await dialog.getByTestId('new-app-tool-claude').click()
    await expect(dialog.getByTestId('new-app-tool-blocked')).toHaveCount(0)
    await dialog.getByTestId('new-app-create').click()
    await expect(group.getByTestId('app-row-_user/daily-log')).toHaveText('Daily log')
    await expect(page.getByTestId('pinned-app-_user/daily-log').getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    expect(await sessionsOfApp(page, 'daily-log')).toEqual([{ id: expect.any(String), name: 'Daily log · builder', tool: 'claude', projectId: null }])
    expect(await createdApps(page)).toEqual([{ projectId: null, id: 'daily-log', name: 'Daily log', tool: 'claude' }])
  })
})

/** As if the host created one app with its builder session in place — the mock's `apps.create` emits the list broadcast and session_created */
async function madeApp(page: Page, pid: string | null, id: string, name: string): Promise<string> {
  const made = await page.evaluate(
    ({ p, i, n }) => (window as any).__mock.apps.create({ projectId: p, id: i, name: n, tool: 'claude' }),
    { p: pid, i: id, n: name },
  )
  return made.builder.id as string
}

/** A person pastes a screenshot — a file is attached to the paste event instead of a real clipboard */
const pasteShot = (page: Page, testId: string, name = 'shot.png') =>
  page.getByTestId(testId).evaluate((el, n) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], n, { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, name)

test.describe('C-5: fix this', () => {
  test('a message from the field below the app is sent to the builder session, with the screenshot, wrapped in a preamble, and the person does not leave the app', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    const builderId = await madeApp(page, pid, 'notes', 'Team notes')
    // The last run failed — the preamble carries that fact
    await page.evaluate(
      ({ key, p }) =>
        (window as any).__mock.appRuns.set(key, [
          {
            id: 'r1', projectId: p, appId: 'notes', tool: 'reset', callerKind: 'view', callerSessionId: null, parentRunId: null,
            status: 'error', durationMs: 4, argsDigest: 'd', argsSummary: '{}', error: 'TypeError: count is undefined\n    at server.mjs:40', createdAt: Date.now(), failure: null,
          },
        ]),
      { key: `${pid}/notes`, p: pid },
    )
    await page.getByTestId(`app-row-${pid}/notes`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId as string)

    const input = pinned.getByTestId('fix-bar-input')
    await expect(input).toHaveAttribute('placeholder', 'Ask Team notes · builder to change this app…')
    await pasteShot(page, 'fix-bar-input')
    await expect(pinned.getByTestId('fix-bar-attachments')).toContainText('shot.png')
    await input.fill('The reset button does nothing')
    await input.press('Enter')

    // What reached the host: this app, the person's words verbatim, the attached screenshot (its saved path), the instance of the view being viewed
    const asks = await page.evaluate(() => (window as any).__mock.builderAsks)
    expect(asks).toEqual([
      {
        appId: 'notes',
        projectId: pid,
        text: 'The reset button does nothing',
        attachments: [{ kind: 'image', path: '/tmp/att/shot.png', name: 'shot.png', mime: 'image/png', bytes: expect.any(Number) }],
        instanceId,
      },
    ])
    await expect(input).toHaveValue('')
    await expect(pinned.getByTestId('fix-bar-attachments')).toHaveCount(0)
    await expect(pinned.getByTestId('fix-bar-sent')).toContainText('Sent to Team notes · builder.')
    // The person did not leave the app — the same view, the same instance
    expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('app')
    await expect(pinned).toBeVisible()
    expect(await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId)).toBe(instanceId)

    // Opens the builder session's conversation alongside — the person's message with the preamble, and the screenshot, are right there
    await pinned.getByTestId('fix-bar-show-builder').click()
    const pane = pinned.getByTestId('builder-pane')
    await expect(pinned.getByTestId('pinned-builder-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect(pane.getByTestId('session-name')).toHaveText('Team notes · builder')
    const said = pane.getByTestId('msg-user').filter({ hasText: 'The reset button does nothing' })
    await expect(said).toContainText(
      '[Centralu] The person wrote this in the app "Team notes" (app-notes) that you build, looking at its screen ui://notes/main (tool "show"). ' +
        'Its latest run, reset from its view, failed: TypeError: count is undefined.\nThe reset button does nothing',
    )
    await expect(said.getByTestId('msg-user-attachment')).toContainText('shot.png')
    expect(await page.evaluate((id) => (window as any).__store.getState().sessions[id].state, builderId)).toBe('working')
    // The pane can be closed, and closing it leaves the view untouched
    await pinned.getByTestId('pinned-builder-toggle').click()
    await expect(pane).toHaveCount(0)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  })

  test('an app with no builder session shows that fact and a button to raise one instead of the input field, and raising it shows the field', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider' })])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(pinned.getByTestId('fix-bar-no-builder')).toContainText('Slider has no builder session')
    await expect(pinned.getByTestId('fix-bar-input')).toHaveCount(0)
    await expect(pinned.getByTestId('pinned-builder-toggle')).toHaveCount(0)

    await pinned.getByTestId('fix-bar-start-builder').click()
    await expect(pinned.getByTestId('fix-bar-input')).toBeVisible()
    await expect(pinned.getByTestId('pinned-builder-toggle')).toBeVisible()
    expect(await sessionsOfApp(page, 'slider')).toEqual([{ id: expect.any(String), name: 'Slider · builder', tool: 'claude', projectId: pid }])
  })
})

/** One error bundle as the host would hold it — the test plants it in the mock (most recent first) */
function bundle(over: Record<string, unknown> = {}) {
  const stderr = Array.from({ length: 12 }, (_, i) => `stderr line ${i + 1}`)
  return {
    kind: 'crash',
    at: Date.now(),
    message: 'exited (code 7)',
    stderr,
    tool: null,
    args: null,
    runId: null,
    text: `App Team notes (alpha/notes): the app's process ended (2026-09-25T00:00:00.000Z)\nReason: exited (code 7)\nstderr (last lines):\n${stderr.join('\n')}`,
    ...over,
  }
}
const setErrors = (page: Page, key: string, list: unknown[]) =>
  page.evaluate(({ k, l }) => (window as any).__mock.appErrors.set(k, l), { k: key, l: list })
const errorSends = (page: Page) => page.evaluate(() => (window as any).__mock.errorSends as unknown[])
const builderSaid = (page: Page, id: string) =>
  page.evaluate(
    (sid) =>
      (((window as any).__mock.messages.get(sid) ?? []) as { role: string; payload: { text?: string } }[])
        .filter((m) => m.role === 'user')
        .map((m) => m.payload.text),
    id,
  )

/*
 * A card for a finished turn (M4 C-5) — the card stands at the top right and stays until
 * dismissed, and on the pinned view it covered the header's Builder, Runs, and close buttons plus
 * Runs' Refresh, hijacking clicks. Most cards that stayed up while fixing an app belonged to the
 * builder session opened alongside — a conversation the person was already watching.
 */
test('a turn ending in a builder session whose conversation is open beside the pinned view gets a breeze, not a card — closed, it gets a card', async ({ page }) => {
  const pid = await addProject(page, '/tmp/alpha')
  const builderId = await madeApp(page, pid, 'notes', 'Team notes')
  await page.evaluate(() => (window as any).__store.getState().setAppFocused(true))
  const finish = () =>
    page.evaluate(async (sid) => {
      const m = (window as any).__mock
      m.emit({ type: 'state_change', sessionId: sid, state: 'working' })
      await new Promise((r) => setTimeout(r, 50))
      m.emit({ type: 'turn_complete', sessionId: sid })
    }, builderId)
  await page.getByTestId(`app-row-${pid}/notes`).click()
  const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
  await pinned.getByTestId('pinned-builder-toggle').click()
  await expect(pinned.getByTestId('pinned-builder-toggle')).toHaveAttribute('aria-pressed', 'true')

  await finish()
  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().completion?.sessionId)).toBe(builderId)
  await expect(page.getByTestId('notice')).toHaveCount(0)

  // The conversation was closed — it is now a session that is not being watched
  await pinned.getByTestId('pinned-builder-toggle').click()
  await finish()
  await expect(page.getByTestId('notice')).toHaveCount(1)
})

test.describe('C-6: errors reach the builder', () => {
  test('when an app dies, the tail of the bundle shows below the view, nothing is sent on its own, and Send to builder sends once', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    const builderId = await madeApp(page, pid, 'notes', 'Team notes')
    await page.getByTestId(`app-row-${pid}/notes`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(pinned.getByTestId('error-tail')).toHaveCount(0)

    // A running app died — the host holds the bundle, and the list changes along with the reason
    const crash = bundle()
    await setErrors(page, `${pid}/notes`, [crash])
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'crashed', error: 'exited (code 7)' })])
    const tail = pinned.getByTestId('error-tail')
    await expect(tail.getByTestId('error-tail-title')).toHaveText('The app stopped')
    await expect(tail.getByTestId('error-tail-message')).toHaveText('exited (code 7)')
    // Only the tail — the last eight lines
    await expect(tail.getByTestId('error-tail-stderr')).toHaveText(Array.from({ length: 8 }, (_, i) => `stderr line ${i + 5}`).join('\n'))

    // Nothing goes out on its own — not even on a re-read (the app's status changed again)
    const reads = await page.evaluate(() => (window as any).__mock.errorReads as number)
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'failed', error: 'exited (code 7)' })])
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(reads)
    await expect(tail.getByTestId('error-tail-send')).toBeVisible()
    expect(await errorSends(page)).toEqual([])
    expect(await builderSaid(page, builderId)).toEqual([])

    // Clicking again while it is sending still sends only once — the host's answer is held back, and the second click is fired right away
    await page.evaluate(() => {
      const w = window as any
      w.__mock.sendErrorGate = new Promise<void>((r) => (w.__releaseSend = r))
    })
    await tail.getByTestId('error-tail-send').click()
    await expect(tail.getByTestId('error-tail-send')).toHaveText('Sending…')
    await tail.getByTestId('error-tail-send').dispatchEvent('click')
    await page.evaluate(() => (window as any).__releaseSend())
    await expect(tail.getByTestId('error-tail-sent')).toContainText('Sent to the builder.')
    await expect(tail.getByTestId('error-tail-send')).toHaveCount(0)
    expect(await errorSends(page)).toEqual([{ appId: 'notes', projectId: pid, at: crash.at }])
    // The app's output reaches the agent enclosed in a quote
    const said = await builderSaid(page, builderId)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('[Centralu] The person sent you this error report from the app "Team notes" (app-notes) that you build.')
    expect(said[0]).toContain('\n> Reason: exited (code 7)\n')
    expect(said[0]).toContain('\n> stderr line 12')

    // A re-read does not send it again — the host holds the fact that it was sent (sentAt)
    const after = await page.evaluate(() => (window as any).__mock.errorReads as number)
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'crashed', error: 'exited (code 7)' })])
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(after)
    await expect(tail.getByTestId('error-tail-sent')).toBeVisible()
    expect(await errorSends(page)).toHaveLength(1)
    expect(await builderSaid(page, builderId)).toHaveLength(1)
  })

  test('for a running app, only a tool failure that happened after this view was opened shows — dismissing it means that bundle never shows again', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await madeApp(page, pid, 'notes', 'Team notes')
    // Yesterday's failure — the app is fine right now
    await setErrors(page, `${pid}/notes`, [bundle({ kind: 'tool', tool: 'save', message: 'old failure', at: Date.now() - 86_400_000 })])
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'running' })])
    await page.getByTestId(`app-row-${pid}/notes`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(0)
    await expect(pinned.getByTestId('error-tail')).toHaveCount(0)

    // A read-only tool clicked from the view threw — that call does not emit "it changed." Once the host holds the bundle, the list's lastErrorAt changes
    await page.evaluate(
      ({ p, b }) => (window as any).__mock.recordAppError('notes', p, b),
      { p: pid, b: bundle({ kind: 'tool', tool: 'get_interval', message: 'TypeError: seconds is undefined', at: Date.now() }) },
    )
    const tail = pinned.getByTestId('error-tail')
    await expect(tail.getByTestId('error-tail-title')).toHaveText('get_interval failed')
    await expect(tail.getByTestId('error-tail-message')).toHaveText('TypeError: seconds is undefined')

    await tail.getByTestId('error-tail-dismiss').click()
    await expect(tail).toHaveCount(0)
    // A dismissed bundle does not show again even on a re-read
    const reads = await page.evaluate(() => (window as any).__mock.errorReads as number)
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'stopped' })])
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(reads)
    await expect(tail).toHaveCount(0)
    expect(await errorSends(page)).toEqual([])
  })

  /*
   * A call stalled by a capability the person denied (M4 D-4) — measured: a tool stalled by a
   * capability the person clicked Deny on used to show as an app error, complete with a stack
   * trace and a "Send to builder." The host attaches the person's decision to that bundle
   * (`denied`). The view instead speaks that decision, and points to where to reverse it.
   */
  test('a tool stalled by a capability the person denied shows that decision, not an error — no Send to builder, pointing instead to Forget in Runs', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await madeApp(page, pid, 'notes', 'Team notes')
    await page.getByTestId(`app-row-${pid}/notes`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const denied = { appId: 'notes', projectId: pid, name: 'Team notes', capability: 'agent:claude', text: 'run an agent (Claude Code) in a new session' }
    await page.evaluate(
      ({ p, b }) => (window as any).__mock.recordAppError('notes', p, b),
      {
        p: pid,
        b: bundle({
          kind: 'tool', tool: 'summarize', at: Date.now(), denied,
          message: 'centralu.agent() failed: run_agent refused: the person did not allow Team notes to run an agent (Claude Code) in a new session.',
          stderr: ['[notes] tool summarize threw: CentraluError: centralu.agent() failed: run_agent refused', '    at askBroker (runtime/centralu-app-runtime.mjs:1:1)'],
        }),
      },
    )
    const tail = pinned.getByTestId('error-tail')
    await expect(tail).toHaveAttribute('data-denied', 'true')
    await expect(tail.getByTestId('error-tail-title')).toHaveText('summarize stopped: you did not allow it')
    await expect(tail.getByTestId('error-tail-denied')).toHaveText(
      'You did not allow Team notes to run an agent (Claude Code) in a new session. This is your decision, not a bug in the app. ' +
        'To change it, open Runs, find it under Permissions and choose Forget. Centralu asks again the next time.',
    )
    // Not a bug in the app — no stack, and no sending to the builder session
    await expect(tail.getByTestId('error-tail-stderr')).toHaveCount(0)
    await expect(tail.getByTestId('error-tail-send')).toHaveCount(0)
    // Opens the place to reverse it
    await expect(pinned.getByTestId('runs-panel')).toHaveCount(0)
    await tail.getByTestId('error-tail-open-runs').click()
    await expect(pinned.getByTestId('runs-panel')).toBeVisible()
    expect(await errorSends(page)).toEqual([])
  })
})

const emit = (page: Page, e: Record<string, unknown>) => page.evaluate((ev) => (window as any).__mock.emit(ev), e)
const toolCall = (sid: string, callId: string, tool: string) => ({
  type: 'tool_call',
  sessionId: sid,
  callId,
  summary: { tool, title: callId, readOnly: false, paths: [] },
})
/** The conversation row that card is on — the card and the view live on the same row */
const rowOf = (page: Page, callId: string) => page.locator('[data-index]').filter({ has: page.getByTestId('tool-card').filter({ hasText: callId }) })
const viewIn = (scope: ReturnType<Page['getByTestId']>): FrameLocator =>
  scope.getByTestId('app-frame-iframe').contentFrame().locator('iframe').contentFrame()
async function logged(v: FrameLocator, k: string): Promise<unknown> {
  const li = v.locator(`li[data-k="${k}"]`).first()
  await expect(li).toBeVisible()
  return JSON.parse(((await li.textContent()) ?? '').slice(k.length + 1))
}
const openedViews = (page: Page) => page.evaluate(() => ((window as any).__mock.openedViews as unknown[]).length)
const reopenedViews = (page: Page) => page.evaluate(() => (window as any).__mock.reopenedViews as { sessionId: string; callId: string }[])
const closedViews = (page: Page) => page.evaluate(() => (window as any).__mock.closedViews as string[])
const pinnedInstance = (page: Page) => page.evaluate(() => (window as any).__store.getState().pinnedViews[0]?.instanceId as string | null)
/** How many times that instance's view received teardown — the test app calls the save tool and answers when it does */
const teardownsOf = (page: Page, instanceId: string) =>
  page.evaluate(
    (id) => ((window as any).__mock.appToolCalls as { tool: string; from: { instanceId?: string } }[]).filter((c) => c.tool === 'save-on-teardown' && c.from.instanceId === id).length,
    instanceId,
  )

test.describe('C-4: when an app relaunches with new code, its open views refresh too', () => {
  const DOC = 'reloader ui://reloader/main'
  const version = (page: Page, pid: string, v: string, status: AppInfo['status'] = 'running') => {
    docs[DOC] = { html: fixtureViewHtml({ marker: v }) }
    return setApps(page, [app('reloader', pid, { name: 'Reloader', status, codeStamp: `code-${v}` })])
  }

  /** One session and one view inline in its conversation — holding the input and result the way the host would */
  async function inlineView(page: Page, pid: string): Promise<{ sid: string; first: string }> {
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
    await emit(page, toolCall(sid, 'toolu_r', 'mcp__app-reloader__show'))
    const first = fx.open({ projectId: pid, appId: 'reloader' }, 'ui://reloader/main')
    await emit(page, { type: 'app_view', sessionId: sid, callId: 'toolu_r', appId: 'reloader', projectId: pid, tool: 'show', phase: 'open', instanceId: first, toolInput: { q: 'weather' } })
    await emit(page, {
      type: 'app_view', sessionId: sid, callId: 'toolu_r', appId: 'reloader', projectId: pid, tool: 'show', phase: 'result',
      toolResult: { content: [{ type: 'text', text: 'sunny' }], structuredContent: { forecast: 'sunny' } }, kept: true,
    })
    await expect(viewIn(rowOf(page, 'toolu_r').getByTestId('inline-view')).locator('#marker')).toHaveText('v1')
    return { sid, first }
  }

  test('the pinned view refreshes in place with new HTML, the inline view reopens with the input and result it was holding, and "Updated" shows briefly', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await version(page, pid, 'v1')
    const { sid, first: firstInline } = await inlineView(page, pid)
    await page.getByTestId(`app-row-${pid}/reloader`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/reloader`)
    await expect(viewOf(page, `${pid}/reloader`).locator('#marker')).toHaveText('v1')
    const firstPinned = (await pinnedInstance(page))!
    await expect(pinned.getByTestId('pinned-updated')).toHaveCount(0)

    // The builder session's turn ended — the app relaunched with new code
    await version(page, pid, 'v2')

    // Pinned view: same spot (still viewing the same app), a new instance, new HTML — the old view received teardown and was released
    await expect(viewOf(page, `${pid}/reloader`).locator('#marker')).toHaveText('v2')
    await expect(pinned.getByTestId('pinned-updated')).toHaveText('Updated')
    expect(await pinnedInstance(page)).not.toBe(firstPinned)
    expect(await teardownsOf(page, firstPinned)).toBe(1)
    expect(await closedViews(page)).toContain(firstPinned)
    expect(await page.evaluate(() => (window as any).__store.getState().focusedApp)).toEqual({ projectId: pid, appId: 'reloader' })
    expect(await openedViews(page)).toBe(2)

    // Inline view: reopened even while hidden — without calling the tool again, using the input and result it was holding
    await expect.poll(() => reopenedViews(page)).toEqual([{ sessionId: sid, callId: 'toolu_r' }])
    expect(await closedViews(page)).toContain(firstInline)
    await page.getByTestId(`session-row-${sid}`).click()
    const again = rowOf(page, 'toolu_r').getByTestId('inline-view')
    await expect(viewIn(again).locator('#marker')).toHaveText('v2')
    expect(await logged(viewIn(again), 'tool-input')).toEqual({ q: 'weather' })
    expect(await logged(viewIn(again), 'tool-result')).toEqual({ forecast: 'sunny' })
    await expect(again.getByTestId('inline-view-updated')).toHaveText('Updated')
  })

  test('an app that relaunches with the same code, or a mere "it changed" notification, does not reopen anything, but relaunching with new code too often stops after three times and leaves it to the person', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await version(page, pid, 'v1')
    const { sid } = await inlineView(page, pid)
    await page.getByTestId(`app-row-${pid}/reloader`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/reloader`)
    const marker = viewOf(page, `${pid}/reloader`).locator('#marker')
    await expect(marker).toHaveText('v1')

    // Died and came back with the same code, plus a notification that a value inside the app changed — neither is a reason to reopen
    await version(page, pid, 'v1', 'crashed')
    await version(page, pid, 'v1', 'running')
    for (let i = 0; i < 3; i++) await emit(page, { type: 'external_app_state_changed', appId: 'reloader', projectId: pid })
    await page.waitForTimeout(500)
    expect(await openedViews(page)).toBe(1)
    expect(await reopenedViews(page)).toEqual([])

    // Three times with new code — reopens all three times
    for (const [i, v] of ['v2', 'v3', 'v4'].entries()) {
      await version(page, pid, v)
      await expect(marker).toHaveText(v)
      expect(await openedViews(page)).toBe(i + 2)
      await expect.poll(async () => (await reopenedViews(page)).length).toBe(i + 1)
    }
    // A fourth time within a minute — it does not open on its own. Only a changed indicator and a reopen button
    await version(page, pid, 'v5')
    await expect(pinned.getByTestId('pinned-stale')).toHaveText('Changed · Reload')
    await expect
      .poll(() => page.evaluate(({ s }) => (window as any).__store.getState().inlineViews[s].toolu_r.stale as boolean | undefined, { s: sid }))
      .toBe(true)
    await page.waitForTimeout(500)
    expect(await openedViews(page)).toBe(4)
    expect(await reopenedViews(page)).toHaveLength(3)
    await expect(marker).toHaveText('v4')

    // Clicking it opens it — once, and it is quiet after that
    await pinned.getByTestId('pinned-stale').click()
    await expect(marker).toHaveText('v5')
    await expect(pinned.getByTestId('pinned-stale')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(await openedViews(page)).toBe(5)
  })
})

test.describe('B-4: a pinned view\'s ui/message', () => {
  test('shows in the picked session as a message sent by the app — going through the same path as an inline view, wrapped by the host as the app\'s words', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'running' })])
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    const sid = await page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)

    await page.getByTestId(`app-row-${pid}/slider`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/slider`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    const instanceId = await pinnedInstance(page)
    await viewOf(page, `${pid}/slider`).locator('#msg').click()
    // The person still chooses which session to send to
    await pinned.getByTestId(`pinned-message-to-${sid}`).click()

    // The same door as an inline view (apps.viewMessage) — the app is identified by instance, and it goes to the picked session
    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.viewMessages))
      .toEqual([{ sessionId: sid, instanceId, text: 'hello from the view' }])
    await expect(page.getByTestId('toast')).toContainText('Sent to')
    const stored = await page.evaluate(
      (id) => (((window as any).__mock.messages.get(id) ?? []) as { role: string; payload: Record<string, unknown> }[]).filter((m) => m.role === 'user').map((m) => m.payload),
      sid,
    )
    expect(stored).toEqual([expect.objectContaining({ text: 'hello from the view', fromApp: { appId: 'slider', projectId: pid, name: 'Slider' } })])
    // It shows in the conversation as sent by the app — not as a human speech bubble
    await page.getByTestId(`session-row-${sid}`).click()
    const said = page.getByTestId('msg-user').filter({ hasText: 'hello from the view' })
    await expect(said.getByTestId('msg-user-from-app')).toHaveText('Slider app ⤷')
  })
})

test.describe('a long view call — kept alive with progress notifications', () => {
  test('a tool that takes 70 seconds finishes in the view — a progress notification every 20 seconds resets the view\'s 60-second clock, and it stops once done', async ({ page }) => {
    test.setTimeout(60_000)
    await page.clock.install()
    await page.goto('/?mock=1')
    await page.evaluate(() => {
      const w = window as any
      w.__mock.viewFrameProvider = (a: string, i: string, o: unknown) => w.__viewFrame(a, i, o)
      w.__mock.openViewProvider = (a: string, p: string | null) => w.__openView(a, p)
      // A slow tool — while the host is waiting on the app (approval, slow work), the view waits for its answer
      w.__mock.appToolHandler = (_a: string, tool: string) =>
        tool === 'slow'
          ? new Promise((r) => setTimeout(() => r({ content: [{ type: 'text', text: 'done' }], structuredContent: { done: true } }), 70_000))
          : { content: [{ type: 'text', text: 'ok' }], structuredContent: {} }
    })
    const pid = await addProject(page, '/tmp/alpha')
    await setApps(page, [app('slider', pid, { name: 'Slider', status: 'running' })])
    await page.getByTestId(`app-row-${pid}/slider`).click()
    const v = viewOf(page, `${pid}/slider`)
    await expect(v.locator('li[data-k="connected"]')).toHaveCount(1)

    await v.locator('#slow').click()
    // Advance the clock 5 seconds at a time — messages between frames go through in between
    for (let t = 0; t < 75_000; t += 5_000) await page.clock.runFor(5_000)
    await expect(v.locator('li[data-k="slow-result"]')).toHaveText('slow-result {"done":true}')
    await expect(v.locator('li[data-k="slow-error"]')).toHaveCount(0)
    await expect(v.locator('li[data-k="progress"]')).toHaveCount(3)
    await expect(v.locator('li[data-k="progress-wire"]')).toHaveCount(3)
    // Nothing more is sent to a call that has finished — counted on the wire (a finished request's notifications never reach the view's handler)
    for (let t = 0; t < 45_000; t += 5_000) await page.clock.runFor(5_000)
    await expect(v.locator('li[data-k="progress-wire"]')).toHaveCount(3)
  })
})

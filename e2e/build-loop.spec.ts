import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { fixtureViewHtml, startFixtureHost, type FixtureHost } from './fixtures/app-views.js'

/**
 * 만들기 루프의 화면 쪽 (M4 C) — 목 플랫폼 위의 진짜 UI, 진짜 ViewHost, 공식 ext-apps `App`으로 만든 시험용 화면.
 *
 * host가 하는 일(템플릿 펼치기, 만드는 세션 세우기, 머리말 짓기, 오류 묶음, 다시 띄우기)은 agent-host의 시험들이 진짜
 * 앱으로 본다. 여기서는 그 문을 부르는 화면이 무엇을 하는지를 본다. 목은 host의 판정과 말을 그대로 흉내 낸다 —
 * 거절의 말은 host의 말 그대로이고, 머리말은 host가 쓰는 같은 함수(protocol)로 짓는다.
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

/** 폴더를 골라 프로젝트를 등록하고, 목이 붙인 id를 돌려준다. `trust`면 묻는 자리에서 곧바로 신뢰한다 */
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

/** 앱의 HTML이 도는 안쪽 프레임 (바깥은 프록시) */
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
 * 진짜 ViewHost 한 벌 — 목의 `openView`(고정 화면)와 `viewFrame`(화면 주소)에 꽂는다. 새로 만든 앱의 화면도 여기서
 * 뜬다: host가 home을 부르고 인스턴스를 연 것처럼, 결과에는 어느 앱의 home인지를 싣는다.
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

test.describe('C-1: 새 앱', () => {
  test('프로젝트 메뉴의 New app: 이름에서 id를 짓고, 고른 에이전트로 만들면 앱이 서고, 화면이 열리고, 만드는 세션이 선다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')
    await expect(dialog).toContainText('New app · alpha')

    await dialog.getByTestId('new-app-name').fill('Team Notes')
    // 이름에서 지은 id — 사람이 고치지 않으면 이름을 따라간다
    await expect(dialog.getByTestId('new-app-id')).toHaveValue('team-notes')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveCount(0)
    // 기본은 프로젝트의 기본 도구다 — 여기서는 다른 쪽을 고른다
    await expect(dialog.getByTestId('new-app-tool-claude')).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('new-app-tool-codex').click()
    await dialog.getByTestId('new-app-create').click()
    await expect(dialog).toHaveCount(0)

    // host에 간 것: 이 프로젝트, 지은 id, 적은 이름, 고른 도구
    expect(await createdApps(page)).toEqual([{ projectId: pid, id: 'team-notes', name: 'Team Notes', tool: 'codex' }])
    // 앱이 그 프로젝트 아래에 서고, 고정 화면이 열려 home의 결과를 받는다
    const row = page.getByTestId('project-alpha').getByTestId(`app-row-${pid}/team-notes`)
    await expect(row).toHaveText('Team Notes')
    await expect(row).toHaveAttribute('aria-current', 'page')
    const pinned = page.getByTestId(`pinned-app-${pid}/team-notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(viewOf(page, `${pid}/team-notes`).locator('li[data-k="tool-result"]')).toHaveText('tool-result {"home":"team-notes"}')
    // 만드는 세션: 그 앱의 것, 고른 도구, 사람이 정한 이름 — 사이드바의 그 프로젝트 아래에 줄로 선다
    const builders = await sessionsOfApp(page, 'team-notes')
    expect(builders).toEqual([{ id: expect.any(String), name: 'Team Notes · builder', tool: 'codex', projectId: pid }])
    await expect(page.getByTestId('project-alpha').getByTestId(`session-row-${builders[0]!.id}`)).toContainText('Team Notes · builder')
  })

  test('host가 거절하면 그 말을 그대로 보이고 창은 남는다 — 모양이 틀린 id는 보내지도 않는다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await setApps(page, [app('notes', pid, { dir: '/tmp/alpha/.centralu/apps/notes' })])
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-app-alpha').click()
    const dialog = page.getByTestId('new-app-dialog')

    // 모양은 창이 host와 같은 판정으로 먼저 막는다 — 보내지 않는다
    await dialog.getByTestId('new-app-name').fill('Store')
    await dialog.getByTestId('new-app-id').fill('app-store')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveText('Ids starting with "app-" are how apps attach to sessions. Pick another.')
    await expect(dialog.getByTestId('new-app-create')).toBeDisabled()
    await dialog.getByTestId('new-app-id').fill('')
    await expect(dialog.getByTestId('new-app-id-problem')).toHaveText('Give the app an id: lowercase letters, digits and hyphens.')
    expect(await createdApps(page)).toEqual([])

    // 이미 있는 id는 host가 안다 — 거절의 말을 그대로 보인다
    await dialog.getByTestId('new-app-id').fill('notes')
    await dialog.getByTestId('new-app-create').click()
    await expect(dialog.getByTestId('new-app-error')).toHaveText('"notes" 앱이 이미 있습니다 (/tmp/alpha/.centralu/apps/notes) — 다른 id를 쓰세요')
    await expect(dialog).toBeVisible()
    expect(await createdApps(page)).toEqual([{ projectId: pid, id: 'notes', name: 'Store', tool: 'claude' }])
    expect(await sessionsOfApp(page, 'notes')).toEqual([])
    await expect(page.getByTestId(`pinned-app-${pid}/notes`)).toHaveCount(0)
  })

  test('신뢰하지 않은 프로젝트: 창이 까닭을 말하고 그 자리에서 신뢰하게 한다 — 그 전에는 만들지 않는다', async ({ page }) => {
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

  test('사용자 폴더의 New app: 앱이 없어도 무리가 서고, 못 쓰는 에이전트는 까닭을 말하며, 만들면 그 무리에 선다', async ({ page }) => {
    await addProject(page, '/tmp/alpha')
    // Codex는 로그인 전이다
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

/** 만드는 세션이 선 앱 하나를 host가 만든 것처럼 — 목의 `apps.create`가 목록 방송과 session_created를 낸다 */
async function madeApp(page: Page, pid: string | null, id: string, name: string): Promise<string> {
  const made = await page.evaluate(
    ({ p, i, n }) => (window as any).__mock.apps.create({ projectId: p, id: i, name: n, tool: 'claude' }),
    { p: pid, i: id, n: name },
  )
  return made.builder.id as string
}

/** 사람이 스크린샷을 붙여 넣는다 — 진짜 클립보드 대신 붙여넣기 이벤트에 파일을 싣는다 */
const pasteShot = (page: Page, testId: string, name = 'shot.png') =>
  page.getByTestId(testId).evaluate((el, n) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], n, { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, name)

test.describe('C-5: 여기를 고쳐 줘', () => {
  test('앱 아래 입력줄의 말이 스크린샷과 함께 만드는 세션에 머리말을 달고 가고, 사람은 앱을 떠나지 않는다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    const builderId = await madeApp(page, pid, 'notes', 'Team notes')
    // 마지막 실행이 실패했다 — 머리말이 그 사실을 싣는다
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

    // host에 간 것: 이 앱, 사람이 쓴 그대로, 붙인 스크린샷(저장된 경로), 보던 화면의 인스턴스
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
    // 사람은 앱을 떠나지 않았다 — 같은 화면, 같은 인스턴스
    expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('app')
    await expect(pinned).toBeVisible()
    expect(await page.evaluate(() => (window as any).__store.getState().pinnedViews[0].instanceId)).toBe(instanceId)

    // 만드는 세션의 대화를 옆에 연다 — 머리말을 단 사람의 말과 스크린샷이 거기 있다
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
    // 판은 닫을 수 있고, 닫아도 화면은 그대로다
    await pinned.getByTestId('pinned-builder-toggle').click()
    await expect(pane).toHaveCount(0)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
  })

  test('만드는 세션이 없는 앱은 입력줄 대신 그 사실과 세우는 단추를 두고, 세우면 입력줄이 선다', async ({ page }) => {
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

/** host가 들고 있는 오류 묶음 하나 — 시험이 목에 심는다(최근 것부터) */
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
    text: `앱 Team notes (alpha/notes): 앱 프로세스가 끝났습니다 (2026-09-25T00:00:00.000Z)\n이유: exited (code 7)\n표준에러 (마지막 줄들):\n${stderr.join('\n')}`,
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

test.describe('C-6: 오류가 만드는 쪽에 닿는다', () => {
  test('앱이 죽으면 묶음의 끝이 화면 아래에 서고, 저절로는 아무것도 가지 않으며, Send to builder는 한 번 보낸다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    const builderId = await madeApp(page, pid, 'notes', 'Team notes')
    await page.getByTestId(`app-row-${pid}/notes`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect(pinned.getByTestId('error-tail')).toHaveCount(0)

    // 떠 있던 앱이 죽었다 — host가 묶음을 들고, 목록이 이유와 함께 바뀐다
    const crash = bundle()
    await setErrors(page, `${pid}/notes`, [crash])
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'crashed', error: 'exited (code 7)' })])
    const tail = pinned.getByTestId('error-tail')
    await expect(tail.getByTestId('error-tail-title')).toHaveText('The app stopped')
    await expect(tail.getByTestId('error-tail-message')).toHaveText('exited (code 7)')
    // 끝부분만 — 마지막 여덟 줄
    await expect(tail.getByTestId('error-tail-stderr')).toHaveText(Array.from({ length: 8 }, (_, i) => `stderr line ${i + 5}`).join('\n'))

    // 저절로는 가지 않는다 — 다시 읽어도(앱의 상태가 또 바뀌었다)
    const reads = await page.evaluate(() => (window as any).__mock.errorReads as number)
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'failed', error: 'exited (code 7)' })])
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(reads)
    await expect(tail.getByTestId('error-tail-send')).toBeVisible()
    expect(await errorSends(page)).toEqual([])
    expect(await builderSaid(page, builderId)).toEqual([])

    // 보내는 동안 한 번 더 눌러도 한 번이다 — host의 답을 붙들어 두고, 두 번째 누름을 곧바로 쏜다
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
    // 에이전트에게는 앱의 출력이 인용 안에 갇힌 채로 간다
    const said = await builderSaid(page, builderId)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('[Centralu] The person sent you this error report from the app "Team notes" (app-notes) that you build.')
    expect(said[0]).toContain('\n> 이유: exited (code 7)\n')
    expect(said[0]).toContain('\n> stderr line 12')

    // 다시 읽어도 다시 가지 않는다 — 보냈다는 것은 host가 든다(sentAt)
    const after = await page.evaluate(() => (window as any).__mock.errorReads as number)
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'crashed', error: 'exited (code 7)' })])
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(after)
    await expect(tail.getByTestId('error-tail-sent')).toBeVisible()
    expect(await errorSends(page)).toHaveLength(1)
    expect(await builderSaid(page, builderId)).toHaveLength(1)
  })

  test('도는 앱에서는 이 화면을 연 뒤의 도구 실패만 선다 — 걷으면 그 묶음은 다시 서지 않는다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await madeApp(page, pid, 'notes', 'Team notes')
    // 어제의 실패 — 앱은 지금 멀쩡하다
    await setErrors(page, `${pid}/notes`, [bundle({ kind: 'tool', tool: 'save', message: 'old failure', at: Date.now() - 86_400_000 })])
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'running' })])
    await page.getByTestId(`app-row-${pid}/notes`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/notes`)
    await expect(pinned.getByTestId('app-frame')).toHaveAttribute('data-phase', 'ready')
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(0)
    await expect(pinned.getByTestId('error-tail')).toHaveCount(0)

    // 화면에서 누른 읽기 전용 도구가 던졌다 — 그 호출은 "바뀌었다"를 내지 않는다. host가 묶음을 들면 목록의 lastErrorAt이 바뀐다
    await page.evaluate(
      ({ p, b }) => (window as any).__mock.recordAppError('notes', p, b),
      { p: pid, b: bundle({ kind: 'tool', tool: 'get_interval', message: 'TypeError: seconds is undefined', at: Date.now() }) },
    )
    const tail = pinned.getByTestId('error-tail')
    await expect(tail.getByTestId('error-tail-title')).toHaveText('get_interval failed')
    await expect(tail.getByTestId('error-tail-message')).toHaveText('TypeError: seconds is undefined')

    await tail.getByTestId('error-tail-dismiss').click()
    await expect(tail).toHaveCount(0)
    // 다시 읽어도 걷은 묶음은 다시 서지 않는다
    const reads = await page.evaluate(() => (window as any).__mock.errorReads as number)
    await setApps(page, [app('notes', pid, { name: 'Team notes', status: 'stopped' })])
    await expect.poll(() => page.evaluate(() => (window as any).__mock.errorReads as number)).toBeGreaterThan(reads)
    await expect(tail).toHaveCount(0)
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
/** 그 카드가 선 대화의 줄 — 카드와 화면은 한 줄에 산다 */
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
/** 그 인스턴스의 화면이 teardown을 받은 횟수 — 시험 앱은 받으면 저장 도구를 부르고 답한다 */
const teardownsOf = (page: Page, instanceId: string) =>
  page.evaluate(
    (id) => ((window as any).__mock.appToolCalls as { tool: string; from: { instanceId?: string } }[]).filter((c) => c.tool === 'save-on-teardown' && c.from.instanceId === id).length,
    instanceId,
  )

test.describe('C-4: 앱이 새 코드로 다시 뜨면 열린 화면도 새로', () => {
  const DOC = 'reloader ui://reloader/main'
  const version = (page: Page, pid: string, v: string, status: AppInfo['status'] = 'running') => {
    docs[DOC] = { html: fixtureViewHtml({ marker: v }) }
    return setApps(page, [app('reloader', pid, { name: 'Reloader', status, codeStamp: `code-${v}` })])
  }

  /** 세션 하나와 그 대화 안의 화면 하나 — 입력과 결과를 host처럼 들고 있다 */
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

  test('고정 화면은 제자리에서 새 HTML로, 대화 안 화면은 들고 있던 입력과 결과로 다시 열리고, "Updated"가 잠깐 선다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await version(page, pid, 'v1')
    const { sid, first: firstInline } = await inlineView(page, pid)
    await page.getByTestId(`app-row-${pid}/reloader`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/reloader`)
    await expect(viewOf(page, `${pid}/reloader`).locator('#marker')).toHaveText('v1')
    const firstPinned = (await pinnedInstance(page))!
    await expect(pinned.getByTestId('pinned-updated')).toHaveCount(0)

    // 만드는 세션의 턴이 끝났다 — 앱이 새 코드로 다시 떴다
    await version(page, pid, 'v2')

    // 고정 화면: 같은 자리(같은 앱을 보고 있다), 새 인스턴스, 새 HTML — 옛 화면은 teardown을 받고 놓였다
    await expect(viewOf(page, `${pid}/reloader`).locator('#marker')).toHaveText('v2')
    await expect(pinned.getByTestId('pinned-updated')).toHaveText('Updated')
    expect(await pinnedInstance(page)).not.toBe(firstPinned)
    expect(await teardownsOf(page, firstPinned)).toBe(1)
    expect(await closedViews(page)).toContain(firstPinned)
    expect(await page.evaluate(() => (window as any).__store.getState().focusedApp)).toEqual({ projectId: pid, appId: 'reloader' })
    expect(await openedViews(page)).toBe(2)

    // 대화 안 화면: 가려져 있던 동안에도 다시 열렸다 — 도구를 다시 부르지 않고, 들고 있던 입력과 결과로
    await expect.poll(() => reopenedViews(page)).toEqual([{ sessionId: sid, callId: 'toolu_r' }])
    expect(await closedViews(page)).toContain(firstInline)
    await page.getByTestId(`session-row-${sid}`).click()
    const again = rowOf(page, 'toolu_r').getByTestId('inline-view')
    await expect(viewIn(again).locator('#marker')).toHaveText('v2')
    expect(await logged(viewIn(again), 'tool-input')).toEqual({ q: 'weather' })
    expect(await logged(viewIn(again), 'tool-result')).toEqual({ forecast: 'sunny' })
    await expect(again.getByTestId('inline-view-updated')).toHaveText('Updated')
  })

  test('같은 코드로 다시 뜬 앱과 "바뀌었다" 알림에는 다시 열지 않고, 새 코드로 너무 자주 뜨면 세 번 뒤에 멈추고 사람에게 맡긴다', async ({ page }) => {
    const pid = await addProject(page, '/tmp/alpha')
    await version(page, pid, 'v1')
    const { sid } = await inlineView(page, pid)
    await page.getByTestId(`app-row-${pid}/reloader`).click()
    const pinned = page.getByTestId(`pinned-app-${pid}/reloader`)
    const marker = viewOf(page, `${pid}/reloader`).locator('#marker')
    await expect(marker).toHaveText('v1')

    // 죽었다가 같은 코드로 살아났다, 그리고 앱 안의 값이 바뀌었다는 알림 — 다시 열 까닭이 아니다
    await version(page, pid, 'v1', 'crashed')
    await version(page, pid, 'v1', 'running')
    for (let i = 0; i < 3; i++) await emit(page, { type: 'external_app_state_changed', appId: 'reloader', projectId: pid })
    await page.waitForTimeout(500)
    expect(await openedViews(page)).toBe(1)
    expect(await reopenedViews(page)).toEqual([])

    // 새 코드로 세 번 — 세 번 다 다시 연다
    for (const [i, v] of ['v2', 'v3', 'v4'].entries()) {
      await version(page, pid, v)
      await expect(marker).toHaveText(v)
      expect(await openedViews(page)).toBe(i + 2)
      await expect.poll(async () => (await reopenedViews(page)).length).toBe(i + 1)
    }
    // 1분 안의 넷째 — 저절로 열지 않는다. 바뀌었다는 표시와 다시 여는 단추만
    await version(page, pid, 'v5')
    await expect(pinned.getByTestId('pinned-stale')).toHaveText('Changed · Reload')
    await expect
      .poll(() => page.evaluate(({ s }) => (window as any).__store.getState().inlineViews[s].toolu_r.stale as boolean | undefined, { s: sid }))
      .toBe(true)
    await page.waitForTimeout(500)
    expect(await openedViews(page)).toBe(4)
    expect(await reopenedViews(page)).toHaveLength(3)
    await expect(marker).toHaveText('v4')

    // 사람이 누르면 연다 — 한 번, 그리고 그 뒤로 조용하다
    await pinned.getByTestId('pinned-stale').click()
    await expect(marker).toHaveText('v5')
    await expect(pinned.getByTestId('pinned-stale')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(await openedViews(page)).toBe(5)
  })
})

test.describe('B-4: 고정 화면의 ui/message', () => {
  test('고른 세션에 앱이 보낸 말로 선다 — 대화 안 화면과 같은 길로 가서 host가 앱의 글로 감싼다', async ({ page }) => {
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
    // 어느 세션으로 보낼지는 여전히 사람이 고른다
    await pinned.getByTestId(`pinned-message-to-${sid}`).click()

    // 대화 안 화면과 같은 문(apps.viewMessage) — 인스턴스로 앱을 가리고, 고른 세션으로 간다
    await expect
      .poll(() => page.evaluate(() => (window as any).__mock.viewMessages))
      .toEqual([{ sessionId: sid, instanceId, text: 'hello from the view' }])
    await expect(page.getByTestId('toast')).toContainText('Sent to')
    const stored = await page.evaluate(
      (id) => (((window as any).__mock.messages.get(id) ?? []) as { role: string; payload: Record<string, unknown> }[]).filter((m) => m.role === 'user').map((m) => m.payload),
      sid,
    )
    expect(stored).toEqual([expect.objectContaining({ text: 'hello from the view', fromApp: { appId: 'slider', projectId: pid, name: 'Slider' } })])
    // 대화에는 사람의 말풍선이 아니라 앱이 보낸 말로 선다
    await page.getByTestId(`session-row-${sid}`).click()
    const said = page.getByTestId('msg-user').filter({ hasText: 'hello from the view' })
    await expect(said.getByTestId('msg-user-from-app')).toHaveText('Slider app ⤷')
  })
})

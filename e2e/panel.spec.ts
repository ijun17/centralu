import { expect, test, type Page } from '@playwright/test'
import { columnsThrough } from './fixtures/columns.js'

/**
 * The right-hand panel and the usage modal — "what does the screen show when several things are
 * up at once."
 *
 * This is split from control-loop.spec.ts by subject. That file watches whether one lap of the
 * control loop runs; this one watches **what the screen picks when several things exist at the
 * same time** (#26, #21).
 */

/**
 * The position after movement has settled. A rising card or a dropping menu, if measured mid
 * transition, would record a **position in transit** as fact — this waits until the same value
 * appears twice in a row.
 */
async function settled(loc: ReturnType<Page['getByTestId']>): Promise<{ x: number; y: number; width: number; height: number }> {
  let last: { x: number; y: number; width: number; height: number } | null = null
  for (let i = 0; i < 40; i++) {
    const box = (await loc.boundingBox())!
    if (last && Math.round(last.y) === Math.round(box.y) && Math.round(last.height) === Math.round(box.height)) return box
    last = box
    await new Promise((r) => setTimeout(r, 50))
  }
  return last!
}

/** The height of the strip that raises a collapsed composer (the same value as SessionView's COMPOSER_REACH) */
const COMPOSER_REACH = 54

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  // With zero projects there is no sidebar — the first project is registered from the startup guide
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  // Registering a project the first time leads straight into creating a session — this test
  // only needs the project, so close it
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

/** Creates a session and returns its id */
async function newSession(
  page: Page,
  project: string,
  tool: 'claude' | 'codex',
  prompt: string,
): Promise<string> {
  await page.getByTestId(`project-menu-${project}`).click()
  await page.getByTestId(`new-session-${project}`).click()
  await page.getByTestId(`tool-option-${tool}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes through the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

async function openGrid(page: Page, ids: string[]) {
  await page.evaluate(
    (l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l),
    ids,
  )
  await page.getByTestId('grid-button').click()
}

/** The default mock has empty windows and only renders 'usage-unavailable' — this sets up the state where the donut shows */
async function stubUsage(page: Page, windows?: unknown[]) {
  await page.evaluate((ws: unknown[] | undefined) => {
    ;(window as never as { __mock: any }).__mock.usageState = {
      supported: true,
      usage: {
        plan: 'max',
        windows: ws ?? [{ id: 'session', label: '5 hours', percent: 41, resetsAt: null, scope: null }],
        daily: [],
      },
    }
  }, windows)
}

/**
 * The collapsed composer in the grid (user request, 2026-09-10).
 *
 * Reading space was tight in a two-row grid — out of a 370px panel, the input area took 95px,
 * while the actual text field was only 22px. Collapsed, the rounded card shows only its top edge,
 * and when a cursor arrives at the bottom, it **rises over the conversation.** It covers rather
 * than pushes, so the line being read does not move.
 */
test('in the grid, the composer is collapsed and rises when the cursor reaches the bottom', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  const b = await newSession(page, 'alpha', 'claude', 'two')
  await openGrid(page, [a, b])
  // If a newly created panel's input field is focused, the collapse cannot be observed — blur it
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const chat = panel.getByTestId('chat-stream')
  await expect(shell).not.toHaveAttribute('data-up', 'true')
  const resting = (await chat.boundingBox())!.height

  // Move the cursor to the bottom of the panel
  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await expect(shell).toHaveAttribute('data-up', 'true')

  // **It covers** — the conversation's height stays the same (the line being read must not shift)
  expect(Math.round((await chat.boundingBox())!.height)).toBe(Math.round(resting))

  // Moving the cursor to the middle of the conversation lowers it again
  await page.mouse.move(box.x + box.width / 2, box.y + 80)
  await expect(shell).not.toHaveAttribute('data-up', 'true')

  // Once the field is focused, it does not lower even after the cursor leaves — the ground must not disappear mid-typing.
  // (It has to rise before it can be focused — a lowered field is outside the panel, so it cannot be clicked in the first place)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await panel.getByTestId('prompt-input').click()
  await page.mouse.move(box.x + box.width / 2, box.y + 80)
  await expect(shell).toHaveAttribute('data-up', 'true')
})

/**
 * A raised card does not lower while the cursor is over it (user finding, 2026-09-10).
 *
 * The strip that triggers the rise sits at the **bottom** of the panel. Since the card rises
 * above that strip, the moment the cursor moved up to click the input field, it left the strip and
 * the card dropped back down — it could not be clicked at all.
 */
test('a raised composer does not lower while the cursor is over it — so it can be clicked', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  const b = await newSession(page, 'alpha', 'claude', 'two')
  await openGrid(page, [a, b])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const box = (await panel.boundingBox())!

  // Move the cursor to the bottom of the panel to raise it
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await expect(shell).toHaveAttribute('data-up', 'true')

  // Move the cursor to the top of the raised card (the input row) — this is already outside the strip.
  // The card keeps rising (300ms), so this measures **after it settles** — a position in transit is not yet fact
  const up = await settled(shell)
  expect(up.y + 12).toBeLessThan(box.y + box.height - COMPOSER_REACH)
  await page.mouse.move(up.x + up.width / 2, up.y + 12)
  await expect(shell).toHaveAttribute('data-up', 'true')

  // And it can be clicked
  await panel.getByTestId('prompt-input').click()
  await expect(panel.getByTestId('prompt-input')).toBeFocused()
})

/**
 * While rising, **there must be intermediate positions** (user request, 2026-09-10: "make it rise
 * smoothly").
 *
 * The transition was first written as `transition-[transform,…]`, but it snapped up in a single
 * frame — Tailwind v4's `translate-y-*` sets its value on the **`translate` property**, not
 * `transform`. The property the transition was attached to and the property actually changing
 * were different, so nothing animated. So what is measured here is not "which property was it
 * attached to" but the **visible fact**: does it pass through several positions along the way.
 */
test('the composer rises smoothly rather than snapping up', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  await expect(panel.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')

  // First attach a recorder that logs the card's position every frame
  await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="composer-shell"]')!
    const seen: number[] = []
    ;(window as never as { __tops: number[] }).__tops = seen
    const tick = () => {
      seen.push(Math.round(shell.getBoundingClientRect().top))
      if (seen.length < 60) requestAnimationFrame(tick)
    }
    tick()
  })

  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await page.waitForTimeout(700)

  const tops = await page.evaluate(() => (window as never as { __tops: number[] }).__tops)
  // If it snaps in one frame, there are only two positions (collapsed, risen)
  expect(new Set(tops).size).toBeGreaterThan(5)
})

/**
 * A raised composer **neither covers nor pushes the conversation** (user finding, 2026-09-13).
 *
 * The original rule was "push nothing, cover it" — but lowering the cursor to read something sent
 * the thing being read under the card. Conversely, pushing content up as the card rises makes a
 * response's button run away right in front of the cursor: the gesture that summons the card and
 * the gesture that clicks the button are the same. So the empty space is reserved from the start.
 */
test('a raised composer neither covers nor pushes the last line', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  // Has to be long enough to reach the bottom — a short conversation never touches the card in the first place
  await page.evaluate((sid: string) => {
    const m = (window as never as { __mock: any }).__mock
    for (let i = 0; i < 40; i++) {
      m.emit({ type: 'user_message', sessionId: sid, seq: 0, text: `question ${i + 1}` })
      m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: `reply ${i + 1}` })
    }
  }, a)
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  await expect(panel.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')

  const read = () =>
    panel.evaluate((el) => {
      const sc = el.querySelector('[data-testid="chat-stream"]') as HTMLElement
      const shell = el.querySelector('[data-testid="composer-shell"]') as HTMLElement
      const pad = parseFloat(getComputedStyle(sc).paddingBottom)
      return {
        pad: Math.round(pad),
        cardTop: Math.round(shell.getBoundingClientRect().top),
        cardHeight: Math.round(shell.getBoundingClientRect().height),
        atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 2,
        // The on-screen bottom edge of the last content (the padding is not content, so it is subtracted)
        lastBottom: Math.round(sc.getBoundingClientRect().top - sc.scrollTop + (sc.scrollHeight - pad)),
      }
    })

  // Sets up the state of reading the newest line — the exact spot that was called uncomfortable
  await panel.evaluate((el) => {
    const sc = el.querySelector('[data-testid="chat-stream"]') as HTMLElement
    sc.scrollTop = sc.scrollHeight
    sc.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(async () => (await read()).atBottom).toBe(true)
  // The padding settles into place over 300ms — measuring mid-transition records a value in transit as fact
  await expect.poll(async () => {
    const m = await read()
    return m.pad === m.cardHeight
  }).toBe(true)
  const down = await read()

  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await expect(panel.getByTestId('composer-shell')).toHaveAttribute('data-up', 'true')
  // Wait for the transition to finish — measuring mid-transition records a position in transit as fact
  await page.waitForTimeout(700)

  const up = await read()
  // The padding has been the card's height since it was collapsed, and stays that way once risen
  expect(down.pad).toBe(up.cardHeight)
  expect(up.pad).toBe(up.cardHeight)
  // The last line sits above the card — it is not covered
  expect(up.atBottom).toBe(true)
  expect(up.lastBottom).toBeLessThanOrEqual(up.cardTop)
  /*
   * And **it did not move a single pixel.** This assertion blocks a moving target — the gesture
   * that summons the card is the same gesture as reaching for the response's button, so any shift
   * here would make the button run away in front of the cursor.
   */
  expect(up.lastBottom).toBe(down.lastBottom)
})

/**
 * The rainbow ring around a panel mid-response is the **panel's border**. It must not break no
 * matter what is floating inside the panel, but the collapsed composer was covering its bottom
 * edge (user finding, 2026-09-10).
 */
test('the collapsed composer does not cover the response ring — the ring sits above it', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  const panel = page.getByTestId(`grid-panel-${a}`)
  await expect(panel.locator('.cc-orbit-ring-layer')).toBeVisible()

  // Two layers in the same stacking context — the ring has to be higher for the bottom edge to survive
  const z = await panel.evaluate((el) => {
    const ring = el.querySelector('.cc-orbit-ring-layer')!
    const shell = el.querySelector('[data-testid="composer-shell"]')!
    return [getComputedStyle(ring).zIndex, getComputedStyle(shell).zIndex].map(Number)
  })
  expect(z[0]!).toBeGreaterThan(z[1]!)
})

/**
 * A collapsed composer **does not scroll the panel up** (dogfooding, 2026-09-10: the header
 * vanished and a command button ate its first click).
 *
 * The collapsed input field sits outside the visible panel, and a freshly created session leaves
 * it focused. If the panel is a scroll container, the browser scrolls the whole panel to bring
 * that field into view — the header vanishes upward, and a button clicked in the meantime has its
 * mousedown and mouseup land in different places, dropping the click entirely. Scroll position
 * must be 0.
 */
test('a collapsed composer does not scroll the panel up — a header button gets clicked on the first try', async ({
  page,
}) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  const b = await newSession(page, 'alpha', 'claude', 'two')
  await openGrid(page, [a, b])

  // The collapsed panel (a): there must be no room to scroll up at all — try scrolling and check
  expect(
    await page.getByTestId(`grid-panel-${a}`).evaluate((el) => {
      el.scrollTop = 500
      return el.scrollTop
    }),
  ).toBe(0)

  // And in the panel (b) just created, whose field is still focused, the header button also opens **on the first click**
  // (focus leaves the field the moment it is clicked and the composer lowers, and if the panel scrolls then, mouseup lands elsewhere)
  const panel = page.getByTestId(`grid-panel-${b}`)
  await expect(panel.getByTestId('prompt-input')).toBeFocused()
  await panel.getByTestId('run-open').click()
  await expect(page.getByTestId('run-menu')).toBeVisible()
})

/**
 * With the setting off, it behaves as before — collapsing is **optional**.
 * And since collapsing is a concern specific to the grid, the focus view never has this problem
 * to begin with.
 */
test('turning collapsing off keeps the composer always expanded, and the focus view never collapses it in the first place', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const folded = (await panel.getByTestId('chat-stream').boundingBox())!.height

  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setFoldComposer(false))
  await expect(panel.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')
  // Turning collapsing off makes the composer take its space back — the conversation shrinks by that much
  const open = (await panel.getByTestId('chat-stream').boundingBox())!.height
  expect(open).toBeLessThan(folded)

  // Focus view: never collapses, regardless of the setting
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setFoldComposer(true))
  await page.evaluate((id: string) => (window as never as { __store: any }).__store.getState().focusSession(id), a)
  await expect(page.getByTestId('session-view').getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')
  await expect(page.getByTestId('prompt-input')).toBeVisible()
})

/*
 * ── Usage (#26 → 2026-09-09) ────────────────────────────────────────
 *
 * Usage is per **account**, but differs by tool. For a long time, that answer was inferred from
 * whatever was on screen (the tools showing in the grid). It is no longer inferred: **one donut
 * per tool** lives permanently on the dashboard, and the person chooses which limit to look at.
 * So what is checked here is not "is the guess correct" but "does each donut speak for its own
 * tool."
 */

test('usage gets one donut per tool — the screen never guesses which tool is meant', async ({ page }) => {
  await setup(page)
  await stubUsage(page)
  await newSession(page, 'alpha', 'claude', "Claude's task")

  // Even while looking only at a Claude session, the Codex donut stays in its own spot
  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  await expect(page.getByTestId('usage-donut-codex')).toBeVisible()

  await page.getByTestId('usage-donut-codex').click()
  await expect(page.getByTestId('usage-drop')).toContainText('Codex')
  await expect(page.getByTestId('usage-drop')).not.toContainText('Claude Code')
  await expect(page.getByTestId('usage-panel')).toHaveCount(1)

  // Clicking a different donut switches to that tool's limit (same spot, different answer)
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-drop')).toContainText('Claude Code')
})

/**
 * Only a connected agent gets a donut (user request, 2026-09-09).
 *
 * An empty ring for an unused tool would say nothing while still taking up space on the
 * dashboard. The test is installed-plus-logged-in — the **same test** the new-session dialog
 * uses, so the two places on screen never give different answers to "can this tool be used."
 */
test('a tool that is not logged in gets no donut', async ({ page }) => {
  await page.goto('/?mock=1')
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    const as = (name: string, s: object) => ({ ...m.detected.find((t: any) => t.name === name), ...s })
    m.detected = [
      as('claude', { installed: true, loggedIn: true, detail: 'mock 2.1.0' }),
      as('codex', { installed: true, loggedIn: false, detail: 'not logged in' }),
    ]
  })
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()

  // Opening the details is itself asking again (the person may have just logged out — the same rule as the session dialog)
  await page.getByTestId('usage-donut-claude').click()

  await expect(page.getByTestId('usage-donut-claude')).toBeVisible()
  await expect(page.getByTestId('usage-donut-codex')).toHaveCount(0)

  /*
   * If nothing at all can be used, the space is not left empty — the message is not "nothing to
   * see" but **"there is something to do"** (install, log in). The same rule that logs a
   * disconnection.
   */
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    const claude = m.detected.find((t: any) => t.name === 'claude')
    m.detected = [{ ...claude, installed: true, loggedIn: false, detail: 'not logged in' }]
  })
  // Closing (first click) then reopening (second) asks again at that point — closing asks nothing
  await page.getByTestId('usage-donut-claude').click()
  await page.getByTestId('usage-donut-claude').click()
  await expect(page.getByTestId('usage-no-agent')).toBeVisible()
})

/**
 * The unknown is not drawn as 0%.
 *
 * A ring drawn fully gray reads as "nothing used at all" — a failure where the fact that it could
 * not be read disappears from the screen (the same kind of failure as #26 "silently falling back
 * to claude"). When unknown, it is dotted, and the details opened by clicking it state the reason.
 */
test('if the weekly limit is unknown, the donut says so', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  // The default mock has no windows — weekly cannot be selected
  const donut = page.getByTestId('usage-donut-claude')
  await expect(donut).toHaveAttribute('data-percent', '')

  await stubUsage(page, [{ id: 'weekly_all', label: 'Weekly', percent: 93, resetsAt: null, scope: null }])
  await donut.click()
  await expect(page.getByTestId('usage-drop')).toBeVisible()
  // Once a value arrives, the donut carries that number
  await expect.poll(async () => donut.getAttribute('data-percent')).toBe('93')
})


/*
 * ── History tab (#21) ────────────────────────────────────────────────────
 *
 * The history strip inside the git tab is a context glanced at while making a commit, so it is
 * capped at seven rows. Coming **to read** the history is a different purpose and uses a whole
 * vertical panel.
 */

/** Builds a commit list, pushing `when` back one day at a time (so the relative date differs per row) */
async function seedCommits(
  page: Page,
  list: { sha: string; subject: string; author: string; daysAgo: number }[],
) {
  await page.evaluate((rows: typeof list) => {
    ;(window as never as { __mock: any }).__mock.gitState.commits = rows.map((r) => ({
      sha: r.sha,
      shortSha: r.sha.slice(0, 7),
      subject: r.subject,
      author: r.author,
      when: Date.now() - r.daysAgo * 86_400_000,
      parents: [],
    }))
  }, list)
}

test('history is a tab next to git, showing the short hash together with how long ago', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'First commit', author: 'me', daysAgo: 0 },
    { sha: 'bbb2222', subject: 'second', author: 'me', daysAgo: 3 },
  ])
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('evidence-history')).toBeVisible()
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('First commit')
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('aaa1111')
  await expect(page.getByTestId('history-commit-bbb2222')).toContainText('3d ago')

  // The selected tab is carried in the snapshot, for the next time it opens
  const snap = await page.evaluate(() => (window as never as { __mock: any }).__mock.workspaceSnapshot)
  expect(snap?.panelTab).toBe('history')
})

test('a single-author repository does not repeat the name, but shows it once there are several authors', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'solo work', author: 'me', daysAgo: 1 },
    { sha: 'bbb2222', subject: 'that too, alone', author: 'me', daysAgo: 2 },
  ])
  await newSession(page, 'alpha', 'claude', 'task')
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('1d ago')
  // At 340px, the same name on every row is noise, not information
  await expect(page.getByTestId('history-commit-aaa1111')).not.toContainText('me')

  // Once there is someone to distinguish, it makes room at that point
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'what I did', author: 'me', daysAgo: 1 },
    { sha: 'bbb2222', subject: 'what you did', author: 'you', daysAgo: 2 },
  ])
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-bbb2222')).toContainText('you')
})

test('clicking a commit opens its diff in the wide view', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [{ sha: 'aaa1111', subject: 'First commit', author: 'me', daysAgo: 0 }])
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.gitState.diffs['aaa1111'] = '@@ -0,0 +1 @@\n+new line'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('new line')
})

/** A list that is silently cut off is a list that lies by implying "there are no older commits" */
test('the list cuts off at 100, and the screen says so', async ({ page }) => {
  await setup(page)
  await seedCommits(
    page,
    Array.from({ length: 130 }, (_, i) => ({
      sha: `c${String(i).padStart(6, '0')}`,
      subject: `commit ${i}`,
      author: 'me',
      daysAgo: i,
    })),
  )
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.locator('[data-testid^="history-commit-"]')).toHaveCount(100)
  await expect(page.getByTestId('evidence-history-cap')).toContainText('Newest 100 commits')
})

test('below the cap, it does not mention being cut off at all', async ({ page }) => {
  await setup(page)
  await seedCommits(
    page,
    Array.from({ length: 12 }, (_, i) => ({
      sha: `c${String(i).padStart(6, '0')}`,
      subject: `commit ${i}`,
      author: 'me',
      daysAgo: i,
    })),
  )
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.locator('[data-testid^="history-commit-"]')).toHaveCount(12)
  await expect(page.getByTestId('evidence-history-cap')).toBeHidden()
})

/*
 * ── Change list → diff ─────────────────────────────────────────────────
 *
 * The right-hand list stays visible while the wide view is open (#15), and that was the
 * point of leaving it there: it is where the next file comes from. So a click on it has to
 * land in the diff every time, not just the first time.
 */

/**
 * The letter in front of each row says **what happened** (user request, 2026-09-10). The `?` git
 * writes for a new file reads on screen as "unknown," but it is actually a known fact — a newly
 * created file, so it is A (added). D (deleted) and M (modified) use git's own letters as-is.
 */
test('a new file shows A and a deleted file shows D', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/new.ts', staged: false, status: '?' },
      { path: 'src/gone.ts', staged: false, status: 'D' },
      { path: 'src/old.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'claude', 'task')

  const mark = async (path: string) =>
    page.getByTestId(`evidence-file-${path}`).locator('span').first().textContent()
  expect(await mark('src/new.ts')).toBe('A')
  expect(await mark('src/gone.ts')).toBe('D')
  expect(await mark('src/old.ts')).toBe('M')
})

test('the diff follows even a second file click — the list is not covered, so it stays clickable', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+line from the first file'
    m.gitState.diffs['src/b.ts'] = '@@ -1 +1 @@\n+line from the second file'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')

  // This was broken here: the name changed to src/b.ts but the content below was still the first file's diff
  await page.getByTestId('evidence-file-src/b.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the second file')
  await expect(page.getByTestId('diff-view')).not.toContainText('line from the first file')
})

test('a file picked from the wide list is not reverted by a list refresh', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+line from the first file'
    m.gitState.diffs['src/b.ts'] = '@@ -1 +1 @@\n+line from the second file'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')

  // The next file is also picked from the sidebar — there is no list inside the wide view (the left column was removed on 2026-09-07)
  await page.getByTestId('evidence-file-src/b.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the second file')
  await page.getByTestId('evidence-stage-all').click()
  await expect(page.getByTestId('evidence-unstage-all')).toBeVisible()
  // Even if staging changes the list, the diff being viewed must not be dragged back to the first path
  await expect(page.getByTestId('diff-view')).toContainText('line from the second file')
})

test('clicking the same file again still opens it — even after switching to a different tab', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+line from the first file'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')

  // After switching to the branch view from the sidebar (there is no tab inside the overlay — the only entry point is the sidebar, since 2026-09-07)
  await page.getByTestId('evidence-branch').click()
  await expect(page.getByTestId('git-branches')).toBeVisible()

  // Click the same file again — a matching path must not mean "nothing happened"
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')
  await expect(page.getByTestId('git-branches')).toBeHidden()
})

/*
 * A commit diff is several files in one text — a sticky band appears at every file boundary
 * (user's choice, 2026-09-07: a row of chips breaks the UI once there are many files). Only the
 * display gets a band; data-line stays untouched, so copying still produces the original
 * `diff --git` line (#36).
 */
test('a file-name band appears at every file boundary of a commit diff', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [{ sha: 'aaa1111', subject: 'commit touching two files', author: 'me', daysAgo: 0 }])
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.diffs['aaa1111'] = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '+first file line',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '+second file line',
    ].join('\n')
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('diff-view')).toContainText('first file line')

  const bands = page.getByTestId('diff-file-band')
  await expect(bands).toHaveCount(2)
  await expect(bands.nth(0)).toHaveText('src/a.ts')
  await expect(bands.nth(1)).toHaveText('src/b.ts')
})

test('a commit also opens from the second click onward — the list stays, so it stays clickable', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'First commit', author: 'me', daysAgo: 0 },
    { sha: 'bbb2222', subject: 'second', author: 'me', daysAgo: 1 },
  ])
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.diffs['aaa1111'] = '@@ -0,0 +1 @@\n+line from the first commit'
    m.gitState.diffs['bbb2222'] = '@@ -0,0 +1 @@\n+line from the second commit'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first commit')

  await page.getByTestId('history-commit-bbb2222').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the second commit')
  await expect(page.getByTestId('diff-view')).not.toContainText('line from the first commit')
})

/** Since this is a question asked of the repository, it is treated the same as the git tab */
test('when there is no git repository, the history tab is disabled just like the git tab', async ({ page }) => {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(async () => {
    const store = (window as never as { __store: any }).__store
    const m = (window as never as { __mock: any }).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit',
      path,
      name: 'nogit',
      defaultTool: 'claude',
      commands: [],
      git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await page.getByTestId('project-menu-nogit').click()
  await page.getByTestId('new-session-nogit').click()
  await page.getByTestId('create-session-confirm').click()

  await expect(page.getByTestId('evidence-tab-git')).toBeDisabled()
  await expect(page.getByTestId('evidence-tab-history')).toBeDisabled()
  await expect(page.getByTestId('evidence-not-repo')).toBeVisible()
})

/*
 * ── Frequently used commands (#44 → moved into a dialog in #60) ──────────────────────────
 *
 * Registering, running, deleting, and the log all live in one dialog. This is a run path separate
 * from the terminal tab: one process per command, one log of the last run. What is checked here is
 * **which project a command goes to** and **whether the log persists as promised**.
 */

/** The mock's run ledger — which command of which project ran, or is running */
async function commandRuns(page: Page): Promise<{ key: string; running: boolean; history: string }[]> {
  return page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    return [...m.commandRuns.entries()].map(([key, r]: [string, any]) => ({
      key,
      running: r.running,
      history: r.history,
    }))
  })
}

test('the run dialog: register → select → run streams the log, and finishing leaves the exit code', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm test')
  await page.getByTestId('run-add').click()
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm test')

  // Selecting is not running — there is a separate run button (#60 design)
  await page.getByTestId('run-command-0').click()
  expect(await commandRuns(page)).toEqual([])
  await page.getByTestId('run-exec').click()

  // A running indicator + the log stream
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm test', '3 tests passed\r\n')
  })
  await expect(page.getByTestId('run-log')).toContainText('3 tests passed')

  // The ending of a one-off run: finishing leaves the exit code as a badge
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm test', 0)
  })
  await expect(page.getByTestId('run-exit-0')).toContainText('exit 0')

  // The log survives closing and reopening the dialog — until the same command is run again (user decision)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await expect(page.getByTestId('run-log')).toContainText('3 tests passed')

  // Rerunning replaces the log — the old log must not mix in ahead of the new run
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-log')).not.toContainText('3 tests passed')
  await expect(page.getByTestId('run-running-0')).toBeVisible()
})

test('the run dialog: a dev server is stopped with Stop, and its log is kept', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm dev', 'Server listening on 5173\r\n')
  })
  await expect(page.getByTestId('run-log')).toContainText('5173')

  await page.getByTestId('run-stop').click()
  // Stopping clears the running indicator, and the log stays — stopping is a result too
  await expect(page.getByTestId('run-exit-0')).toBeVisible()
  await expect(page.getByTestId('run-log')).toContainText('5173')
})

test('the open button turns white while a command is running', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  const open = page.getByTestId('run-open')
  // `hover:text-chalk` is always attached, so the check anchors on a word boundary — loose matching would always pass
  const lit = /(^|\s)text-chalk(\s|$)/
  const dim = /(^|\s)text-slate(\s|$)/
  await expect(open).toHaveClass(dim)

  await open.click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()

  // Closing the dialog leaves the fact that "it is running" showing in the header — the door doubles as an indicator light
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()
  await expect(open).toHaveClass(lit)
  await expect(open).toHaveAttribute('aria-label', /running/)

  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm dev', 0)
  })
  // Turns gray again once finished — leaving a finished command lit turns the indicator into decoration
  await expect(open).toHaveClass(dim)
  await expect(open).not.toHaveAttribute('aria-label', /running/)
})

test('the run dialog: a registered command survives closing and reopening the dialog', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm lint')
  await page.getByTestId('run-add').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('run-menu')).toBeHidden()

  await page.getByTestId('run-open').click()
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm lint')
})

test('the run dialog: deleting targets something different from running — a running command that gets deleted cannot be undone', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  for (const cmd of ['pnpm test', 'pnpm lint']) {
    await page.getByTestId('run-add-input').fill(cmd)
    await page.getByTestId('run-add').click()
  }
  await expect(page.getByTestId('run-command-1')).toContainText('pnpm lint')

  await page.getByTestId('run-delete-0').click()

  // What remains moves up — the deleted spot must not stay as an empty row
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm lint')
  await expect(page.getByTestId('run-command-1')).toBeHidden()
  // And nothing was running
  expect(await commandRuns(page)).toEqual([])
})

/**
 * Does a grid panel's file link open from **that panel's project** (#182).
 *
 * WKWebView does not give focus on a button click, so clicking a link in another panel leaves
 * focus on the originally focused panel. If the viewer picked the project from the focused
 * session, a **different** file at the same relative path opened silently. Chromium does give
 * focus on click (the panel's onFocusCapture runs first there), so the click is dispatched only as
 * an event.
 */
test('grid: a file link opens from the project of the panel it was clicked in — not the focused panel (#182)', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    await (window as never as { __store: any }).__store.getState().addProject('/tmp/beta')
  })
  const alpha = await newSession(page, 'alpha', 'claude', 'alpha task')
  const beta = await newSession(page, 'beta', 'claude', 'beta task')
  await page.evaluate((sid: string) => {
    ;(window as never as { __mock: any }).__mock.emit({
      type: 'message_delta', sessionId: sid, role: 'assistant', text: 'Look at `src/index.ts`.',
    })
  }, beta)
  await page.evaluate(
    (id: string) => (window as never as { __store: any }).__store.getState().focusSession(id),
    alpha,
  )
  await openGrid(page, [alpha, beta])
  const betaProject = await page.evaluate(
    (id: string) => (window as never as { __store: any }).__store.getState().sessions[id].projectId,
    beta,
  )
  const link = page.getByTestId(`grid-panel-${beta}`).getByTestId('file-link')
  await expect(link).toBeVisible()

  await link.dispatchEvent('click')
  await expect(page.getByTestId('code-viewer')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as never as { __mock: any }).__mock.fileOps.filter((o: any) => o.op === 'read').at(-1)))
    .toEqual({ op: 'read', projectId: betaProject, path: 'src/index.ts' })

  await page.keyboard.press('Escape')
  await link.dispatchEvent('contextmenu')
  await expect
    .poll(() => page.evaluate(() => (window as never as { __mock: any }).__mock.fileOps.filter((o: any) => o.op === 'reveal').at(-1)))
    .toEqual({ op: 'reveal', projectId: betaProject, path: 'src/index.ts' })
})

/**
 * Does a grid panel's run button send its command to **that panel's project**.
 *
 * If it were keyed off whichever terminal happened to be on screen, this is where it would
 * diverge: the grid has no evidence rail at all, and the project last looked at is alpha. A
 * command must go to wherever the clicked panel's session lives.
 */
test('the run dialog: a command goes to the clicked panel\'s project — not whichever project was viewed last', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    await (window as never as { __store: any }).__store.getState().addProject('/tmp/beta')
  })
  const alpha = await newSession(page, 'alpha', 'claude', 'alpha task')
  const beta = await newSession(page, 'beta', 'claude', 'beta task')

  // Register a command on the beta session
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm build')
  await page.getByTestId('run-add').click()
  await page.keyboard.press('Escape')

  // Set the screen to be looking at alpha, then go to the grid
  await page.evaluate(
    (id: string) => (window as never as { __store: any }).__store.getState().focusSession(id),
    alpha,
  )
  await openGrid(page, [alpha, beta])
  await expect(page.getByTestId(`grid-panel-${beta}`)).toBeVisible()

  await page.getByTestId(`grid-panel-${beta}`).getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()

  // It was recorded as beta's — the log is also visible inside that panel, so there is no need to switch screens (#60)
  const runs = await commandRuns(page)
  expect(runs).toHaveLength(1)
  const betaProjectId = await page.evaluate(() => {
    const s = (window as never as { __store: any }).__store.getState()
    return (Object.values(s.projects) as { id: string; path: string }[]).find((p) => p.path === '/tmp/beta')!
      .id
  })
  expect(runs[0]!.key.startsWith(betaProjectId)).toBe(true)
})

test('the run dialog: absent from the orchestrator — with no project there is no directory to run in', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await expect(page.getByTestId('run-open')).toBeVisible()
  // The status dot is retired from the header, and the fact that it is responding is carried by the grid border and sidebar instead.
  await expect(page.getByTestId('dot-idle')).toHaveCount(0)

  await page.evaluate(async () => {
    const st = (window as never as { __store: any }).__store.getState()
    await st.openOrchestrator() // Opens only the screen — no session is created (#63)
    await st.askOrchestrator('hello') // The first question creates the session
  })
  await expect(page.getByTestId('session-name')).toContainText('Orchestrator')
  await expect(page.getByTestId('session-header-crown')).toBeVisible()
  // A menu that opens to nothing that can go into it is more honest absent than empty
  await expect(page.getByTestId('run-open')).toBeHidden()
})

/**
 * Once the orchestrator becomes a live session too, it can be viewed as a panel in the grid.
 *
 * Before, GridView could render that ID, but the sidebar had no drag handle, and clicking the
 * panel had focusSession snatch it away to the dedicated screen. This check ties both rules
 * together: it can only be dragged after the first message, and picking it from inside the grid
 * keeps it in the grid.
 */
test('an orchestrator session can also be placed in the grid to view side by side', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const st = (window as never as { __store: any }).__store.getState()
    await st.openOrchestrator()
    await st.askOrchestrator('view it together in the grid')
  })

  const id: string = await page.evaluate(() => (window as never as { __store: any }).__store.getState().orchestratorId)
  await expect(page.getByTestId('orchestrator-button')).toHaveAttribute('draggable', 'true')

  await page.dragAndDrop('[data-testid="orchestrator-button"]', '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  await page.evaluate((sessionId: string) => {
    ;(window as never as { __store: any }).__store.getState().focusSession(sessionId, { preferGrid: true })
  }, id)
  expect(await page.evaluate(() => (window as never as { __store: any }).__store.getState().view)).toBe('grid')
})

test('command aliases: the name leads and the command backs it up — in the list, the selected-run row, and the terminal panel (2026-09-06)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add-name').fill('Dev server')
  await page.getByTestId('run-add').click()
  // Wherever the name is shown, the command shows alongside it — this prevents the name from silently drifting to mean a different command
  await expect(page.getByTestId('run-command-0')).toContainText('Dev server')
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm dev')

  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-selected')).toContainText('Dev server · pnpm dev')
  await page.keyboard.press('Escape')

  // Both show in the command terminal of the terminal panel too
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('Dev server')
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('pnpm dev')

  // Editing the alias — using the button that appears on hover, saved with Enter
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').hover()
  await page.getByTestId('run-rename-0').click()
  await page.getByTestId('run-rename-input-0').fill('Local server')
  await page.getByTestId('run-rename-input-0').press('Enter')
  await expect(page.getByTestId('run-command-0')).toContainText('Local server')
  await expect(page.getByTestId('run-command-0')).toContainText('pnpm dev')
})

/*
 * ── The terminal panel projection of a running command (#60's final form, user decision 2026-09-06) ──
 *
 * Closing the dialog — or taking a panel down from the grid — must still leave a running command
 * standing as one terminal in the terminal panel. And once it finishes for any reason (a clean
 * exit, a crash, or Stop), that terminal **goes down**: this is the place for "what is running
 * right now," and the run dialog is the source of truth for past logs.
 */

test('a running command shows as a terminal in the terminal panel — and goes down for any reason it finishes', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  // Start a dev server from the run dialog and close the dialog
  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await expect(page.getByTestId('run-running-0')).toBeVisible()
  await page.keyboard.press('Escape')

  // Terminal tab: a command terminal stands next to the shell, the log streams, and a dot stays on the tab
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
  await expect(page.getByTestId('terminal-tab-running')).toBeVisible()
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.emitCommandOutput(pid, 'pnpm dev', 'Server listening on 5173\r\n')
  })
  await expect(page.getByTestId('cmd-term-pnpm dev')).toContainText('5173')

  // Collapsing the panel does not collapse "it is running" — clicking the dot reopens it
  await page.getByTestId('evidence-close').click()
  await expect(page.getByTestId('evidence-rail-running')).toBeVisible()
  await page.getByTestId('evidence-rail-running').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()

  // A crash — the terminal goes down and the badge clears too. The log survives in the run dialog
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __store: any }
    const pid = Object.keys(w.__store.getState().projects)[0]
    w.__mock.exitCommand(pid, 'pnpm dev', 1)
  })
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeHidden()
  await expect(page.getByTestId('terminal-tab-running')).toBeHidden()

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-command-0').click()
  await expect(page.getByTestId('run-exit-0')).toContainText('exit 1')
  await expect(page.getByTestId('run-log')).toContainText('5173')
})

test('the × on a command terminal means stop — the resulting exit takes the terminal down and the shell survives', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('run-open').click()
  await page.getByTestId('run-add-input').fill('pnpm dev')
  await page.getByTestId('run-add').click()
  await page.getByTestId('run-command-0').click()
  await page.getByTestId('run-exec').click()
  await page.keyboard.press('Escape')

  await page.getByTestId('evidence-tab-terminal').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeVisible()
  await page.getByTestId('cmd-term-stop-pnpm dev').click()
  await expect(page.getByTestId('cmd-term-pnpm dev')).toBeHidden()

  // Only the command panel goes down — the shell terminal survives untouched
  const shells = page.getByTestId('terminal-stack').locator('[data-testid^="terminal-mock-term-"]')
  await expect(shells.first()).toBeVisible()
})

/*
 * ── Things that spin watch one clock ──────────────────────────────────────
 *
 * The sidebar marker and the grid panel border spin the same orbit at the same 1.4 seconds. But a
 * CSS animation counts from **the moment the element is created**, so bringing a spinning session
 * into the grid late means the panel's orbit alone starts over from 0. Measured at 758ms out of
 * phase — nearly the exact opposite. Even with the same period, a different phase looks to the eye
 * like two things spinning independently.
 */
test('the grid panel border and the sidebar marker spin at the same angle — even joining late', async ({ page }) => {
  await setup(page)
  const id = await newSession(page, 'alpha', 'claude', 'task')

  // Start spinning first in the focus view — this is where the sidebar marker's orbit is born
  await page.getByTestId('prompt-input').fill('something that takes a while')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('tool-mark-claude')).toHaveClass(/cc-orbit/)

  // ...the panel is created much later. Before the fix, this gap was exactly the angle difference
  await page.waitForTimeout(700)
  await openGrid(page, [id])
  await expect(page.getByTestId(`grid-panel-${id}`)).toHaveClass(/cc-orbit-ring/)

  const phases = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => (a as CSSAnimation).animationName === 'cc-orbit-spin')
      .map((a) => Math.round(Number(a.currentTime))),
  )
  expect(phases).toHaveLength(2)
  // The same angle. Within one frame (16.7ms), it looks the same to the eye
  expect(Math.abs(phases[0]! - phases[1]!)).toBeLessThan(17)
})

/*
 * The grid counts its columns in real pixels (grid/real-size.ts). Three panels stand in two columns at 1280×720 at
 * the default text size and at the largest; a width measured at one size and multiplied by the other stood them in
 * three for a frame in between.
 */
test('changing the text size leaves the grid in the columns it stands in, never a count neither size lays out', async ({
  page,
}) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'first')
  const b = await newSession(page, 'alpha', 'claude', 'second')
  const c = await newSession(page, 'alpha', 'claude', 'third')
  await openGrid(page, [a, b, c])
  await expect(page.getByTestId(`grid-panel-${c}`)).toBeVisible()

  const counts = await columnsThrough(page, '[data-testid="grid"] > div', () =>
    page.evaluate(() => (window as never as { __store: any }).__store.getState().setTextScale(4)),
  )
  expect(counts).toEqual([2])
})

/*
 * ── The picked session follows the cursor ──────────────────────────────────────
 *
 * Inside the grid, nothing ever changed focusedSessionId — it stayed frozen for days on whatever
 * session was restored when the app started (dogfooding). Placing the cursor on a different
 * panel's composer must move the pick along with it: markRead and "the last session looked at"
 * (the target warmed up for the next run) come from this value. The view must stay in the grid.
 * (This is not drawn as a border — the same dogfooding case removed that indicator entirely.
 * There is no reason for a border to repeat what the cursor already says.)
 */
test('clicking a different panel\'s composer in the grid moves the picked session — the view stays the grid', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'first')
  const b = await newSession(page, 'alpha', 'claude', 'second')
  await openGrid(page, [a, b])

  // Start from the last-picked session (b)
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-focused', 'true')

  // A collapsed composer only rises once the cursor reaches the bottom (the same order a person follows)
  const boxA = (await page.getByTestId(`grid-panel-${a}`).boundingBox())!
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height - 20)
  await page.getByTestId(`grid-panel-${a}`).getByTestId('prompt-input').click()

  await expect(page.getByTestId(`grid-panel-${a}`)).toHaveAttribute('data-focused', 'true')
  await expect(page.getByTestId(`grid-panel-${b}`)).not.toHaveAttribute('data-focused', 'true')
  // Changing the pick must not pull the view into the focus view (preferGrid)
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()
})

/*
 * ── Grid: live reflow while dragging (#53) ──────────────────────────
 *
 * The old edge line said "before/after this neighbour", but the grid reflows on drop —
 * the line pointed at a layout that stopped existing the moment you let go. Now the grid
 * rearranges live while dragging, so the drop changes nothing visually. What has to hold:
 * the preview is *only* a preview (nothing persists, cancel restores), cells never change
 * size mid-drag, and panels move as the same DOM nodes (a remount would drop scroll state).
 *
 * Playwright's dragAndDrop is atomic — it cannot look at the screen mid-drag. So the drag
 * events are dispatched by hand, sharing one DataTransfer the way a real drag does
 * (same technique as control-loop.spec.ts).
 */

/** The panel order as the user sees it — DOM order is React's render order */
async function panelOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="grid-panel-"]')].map((el) =>
      el.dataset.testid!.slice('grid-panel-'.length),
    ),
  )
}

async function startDrag(page: Page, from: string) {
  await page.evaluate((id: string) => {
    const w = window as never as { __dt?: DataTransfer }
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="grid-panel-${id}"] [data-testid="pane-header"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, from)
}

/** dragover on the left (20%) or right (80%) half of a panel, like a pointer passing over it */
async function hoverPanel(page: Page, target: string, side: 'left' | 'right') {
  await page.evaluate(
    ({ to, where }: { to: string; where: string }) => {
      const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
      const r = card.getBoundingClientRect()
      const x = where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
      card.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: (window as never as { __dt?: DataTransfer }).__dt,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: r.top + r.height / 2,
        }),
      )
    },
    { to: target, where: side },
  )
}

/** drop on a panel, then dragend on the source — the order the browser fires them in */
async function dropOnPanel(page: Page, target: string, side: 'left' | 'right', from: string) {
  await page.evaluate(
    ({ to, where, src }: { to: string; where: string; src: string }) => {
      const dt = (window as never as { __dt?: DataTransfer }).__dt
      const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
      const r = card.getBoundingClientRect()
      const x = where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
      card.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: r.top + r.height / 2,
        }),
      )
      document
        .querySelector(`[data-testid="grid-panel-${src}"] [data-testid="pane-header"]`)!
        .dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    },
    { to: target, where: side, src: from },
  )
}

/** Escape and dropping outside the window both surface as dragend without a drop */
async function cancelDrag(page: Page, from: string) {
  await page.evaluate((src: string) => {
    document
      .querySelector(`[data-testid="grid-panel-${src}"] [data-testid="pane-header"]`)!
      .dispatchEvent(
        new DragEvent('dragend', {
          dataTransfer: (window as never as { __dt?: DataTransfer }).__dt,
          bubbles: true,
        }),
      )
  }, from)
}

const storedPanels = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as never as { __store: any }).__store.getState().gridPanels)

/*
 * ── Panel tabs: reorder, split, and one global arrangement (#20) ─────
 *
 * The tabs can be dragged into a new order, and dragged into the bottom half of the
 * body to split the panel into two stacked groups. The arrangement is global — one for
 * the whole app, surviving a relaunch — because the panel is a way of looking, not
 * project state. Drags are dispatched by hand with one shared DataTransfer, the same
 * technique as the grid tests above (Playwright's dragAndDrop is atomic).
 */

/** The strip order as the user sees it — every tab button, in DOM order */
async function tabOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="evidence-tab-"]')].map((el) =>
      el.dataset.testid!.slice('evidence-tab-'.length),
    ),
  )
}

async function startTabDrag(page: Page, tab: string) {
  await page.evaluate((t: string) => {
    const w = window as never as { __dt?: DataTransfer }
    w.__dt = new DataTransfer()
    document
      .querySelector(`[data-testid="evidence-tab-${t}"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: w.__dt, bubbles: true }))
  }, tab)
}

/** dragover then drop on the left (20%) or right (80%) half of another tab */
async function dropOnTab(page: Page, target: string, side: 'left' | 'right') {
  await page.evaluate(
    ({ to, where }: { to: string; where: string }) => {
      const dt = (window as never as { __dt?: DataTransfer }).__dt
      const el = document.querySelector(`[data-testid="evidence-tab-${to}"]`)!
      const r = el.getBoundingClientRect()
      const opts = {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8,
        clientY: r.top + r.height / 2,
      }
      el.dispatchEvent(new DragEvent('dragover', opts))
      el.dispatchEvent(new DragEvent('drop', opts))
    },
    { to: target, where: side },
  )
}

/** dragover then drop on the bottom half of the top group's body — the split gesture */
async function dropOnBodyBottom(page: Page) {
  await page.evaluate(() => {
    const dt = (window as never as { __dt?: DataTransfer }).__dt
    const el = document.querySelector('[data-testid="evidence-body-0"]')!
    const r = el.getBoundingClientRect()
    const opts = {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height * 0.8,
    }
    el.dispatchEvent(new DragEvent('dragover', opts))
    el.dispatchEvent(new DragEvent('drop', opts))
  })
}

/**
 * One tab-strip row carries two things (user request, 2026-09-07): the left side for where to go,
 * the right side for **the current tab's controls**. It used to draw an extra header per tab,
 * making the strip two rows.
 */
test('the active tab\'s controls live in the tab strip, not in a second header', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  const actions = page.getByTestId('evidence-actions')
  await page.getByTestId('evidence-tab-terminal').click()
  await expect(actions.getByTestId('terminal-add')).toBeVisible()

  // Switching tabs also switches the buttons to that tab's own — no leftover button from another tab
  await page.getByTestId('evidence-tab-files').click()
  await expect(actions.getByTestId('toggle-ignored')).toBeVisible()
  await expect(actions.getByTestId('terminal-add')).toHaveCount(0)
})

/**
 * When space runs short, tabs are the side that yields — control buttons act on what is being
 * viewed, so they never fold. A folded tab has not disappeared; it can still be picked by name
 * behind the `…`.
 */
test('when the strip runs out of room the extra tabs fold into a … menu', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('evidence-tab-terminal')).toBeVisible()

  // At a width where 'Show ignored' takes up the right side, the last tab gets pushed out
  await page.evaluate(() => (window as never as { __store: any }).__store.getState().setPanelWidth(280))

  const more = page.getByTestId('evidence-tabs-more')
  await expect(more).toBeVisible()
  await expect(page.getByTestId('evidence-tab-terminal')).toHaveCount(0)
  // The tab currently selected does not fold — the screen must never lose track of where the person currently is
  await expect(page.getByTestId('evidence-tab-files')).toBeVisible()

  await more.click()
  await page.getByTestId('evidence-overflow-tab-terminal').click()
  // The picked tab gets a slot (a different tab folds instead to make room)
  await expect(page.getByTestId('evidence-tab-terminal')).toBeVisible()
  await expect(page.getByTestId('evidence-actions').getByTestId('terminal-add')).toBeVisible()
})

test('tab order is dragged, and survives a relaunch — one arrangement for the whole app (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  expect(await tabOrder(page)).toEqual(['git', 'history', 'files', 'terminal'])

  await startTabDrag(page, 'terminal')
  await dropOnTab(page, 'git', 'left')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])

  /*
   * A relaunch: fresh page, fresh store, fresh mock — only localStorage survives, which
   * is the mock's stand-in for the host's on-disk snapshot. The project has to be added
   * again (the mock's projects are in-memory), and the arrangement must already be back.
   */
  await page.goto('/?mock=1')
  // The intro screen does not appear again — introSeen was saved in the snapshot (localStorage) (#63)
  await expect(page.getByTestId('add-project')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()
  await expect(page.getByTestId('project-alpha')).toBeVisible()
  await newSession(page, 'alpha', 'claude', 'again')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])
})

test('dragging a tab to the bottom half splits the panel — two tabs visible at once (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)

  // Git stays on top, the file tree opens below it — both on screen at the same time
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('file-tree')).toBeVisible()
  // The bottom group has its own strip, holding the tab that moved down
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()
  await expect(page.getByTestId('evidence-tabs-1').getByTestId('evidence-tab-files')).toBeVisible()
  // The top strip gave that tab up — a tab lives in exactly one group
  expect(await tabOrder(page)).toEqual(['git', 'history', 'terminal', 'files'])
})

/*
 * Adjusting the split ratio (dogfooding request). A fixed 50/50 split could not express "the
 * terminal can be narrow but the diff needs to be wide." Dragging the boundary (the top edge of
 * the bottom body) changes the ratio, which is carried in the snapshot and survives a relaunch,
 * and a double-click resets it to 50/50.
 */
test('the boundary between two split panels is dragged to move it — it survives a relaunch, and a double-click resets it to 50/50', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  const topHeight = () =>
    page.getByTestId('evidence-body-0').evaluate((el) => el.getBoundingClientRect().height)
  const before = await topHeight()

  // The boundary moves down 120px — the top body grows
  const handle = page.getByTestId('panel-split-handle')
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 120, { steps: 4 })
  await page.mouse.up()
  expect(await topHeight()).toBeGreaterThan(before + 80)
  const saved = await page.evaluate(() => (window as any).__store.getState().panelSplit)
  expect(saved).toBeGreaterThan(0.6)

  // A relaunch — the ratio comes back right where the layout comes back
  await page.goto('/?mock=1')
  await expect(page.getByTestId('add-project')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__store.getState().panelSplit)).toBeCloseTo(saved, 5)

  // Resetting: re-add the project to bring the panel up, then double-click — back to 50/50
  await page.evaluate((p: string) => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()
  await newSession(page, 'alpha', 'claude', 'again')
  await page.getByTestId('panel-split-handle').dblclick()
  expect(await page.evaluate(() => (window as any).__store.getState().panelSplit)).toBe(0.5)
})

/*
 * The dogfooding overlap: git on top, another tab split below, and the top group's
 * content painted over the bottom group's tab strip. Two causes, both fixed — the git
 * tab's fixed-height history strip (removed; history lives in its own tab) and the
 * group body clipping nothing (overflow-hidden now). The hit test is the claim: if
 * anything overlaps the strip, the point under its tab resolves to the intruder.
 */
test('a tall top group never paints over the bottom group‘s tab strip', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = Array.from({ length: 80 }, (_, i) => ({
      path: `src/f${i}.ts`,
      staged: false,
      status: 'M',
    }))
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="evidence-tabs-1"]')!
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  })
  expect(hit).toBe(true)
})

test('dragging the bottom group‘s last tab back to the top strip closes the split (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')
  await startTabDrag(page, 'files')
  await dropOnBodyBottom(page)
  await expect(page.getByTestId('evidence-tabs-1')).toBeVisible()

  await startTabDrag(page, 'files')
  await dropOnTab(page, 'terminal', 'right')

  await expect(page.getByTestId('evidence-tabs-1')).toBeHidden()
  await expect.poll(() => tabOrder(page)).toEqual(['git', 'history', 'terminal', 'files'])
  // One body again, showing the tab that just landed (dropping it is picking it)
  await expect(page.getByTestId('file-tree')).toBeVisible()
  await expect(page.getByTestId('evidence-git')).toBeHidden()
})

test('⌘⇧1–4 keeps working after a reorder — the digit follows the tab, not the seat (#20)', async ({
  page,
}) => {
  await setup(page)
  await newSession(page, 'alpha', 'claude', 'task')

  await startTabDrag(page, 'terminal')
  await dropOnTab(page, 'git', 'left')
  await expect.poll(() => tabOrder(page)).toEqual(['terminal', 'git', 'history', 'files'])

  /*
   * Identity mapping (1 git · 2 history · 3 files · 4 terminal): the Settings list is
   * static text, so only a mapping a reorder does not move can stay truthful — and
   * muscle memory should not be silently retargeted by a drag.
   */
  await page.keyboard.press('ControlOrMeta+Shift+Digit3')
  await expect(page.getByTestId('file-tree')).toBeVisible()

  // 4 is still the terminal even though the terminal now sits first in the strip
  await page.keyboard.press('ControlOrMeta+Shift+Digit4')
  await expect(page.getByTestId('evidence-terminal')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+Shift+Digit1')
  await expect(page.getByTestId('evidence-git')).toBeVisible()
})

test('the grid previews the rearrangement while dragging — panel sizes stay put, nothing is saved yet', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'first')
  const b = await newSession(page, 'alpha', 'claude', 'second')
  const c = await newSession(page, 'alpha', 'claude', 'third')
  await openGrid(page, [a, b, c])
  await expect(page.getByTestId(`grid-panel-${c}`)).toBeVisible()
  const sizeBefore = await page.getByTestId(`grid-panel-${b}`).boundingBox()

  await startDrag(page, a)
  await hoverPanel(page, c, 'right')
  // The screen already shows the outcome — this is the whole point of #53.
  // (Polled: React flushes dragover updates at continuous priority, a beat after the event)
  await expect.poll(() => panelOrder(page)).toEqual([b, c, a])
  // ...but it is only a preview: the committed order must not move until the drop
  expect(await storedPanels(page)).toEqual([a, b, c])

  // Cells must not change size mid-drag, or the cell the hand is aiming at moves
  const sizeDuring = await page.getByTestId(`grid-panel-${b}`).boundingBox()
  expect(sizeDuring!.width).toBe(sizeBefore!.width)
  expect(sizeDuring!.height).toBe(sizeBefore!.height)

  // Hovering the other half previews the other outcome — the preview follows the pointer
  await hoverPanel(page, c, 'left')
  await expect.poll(() => panelOrder(page)).toEqual([b, a, c])

  await cancelDrag(page, a)
  await expect.poll(() => panelOrder(page)).toEqual([a, b, c])
  expect(await storedPanels(page)).toEqual([a, b, c])
})

test('dropping leaves it exactly as previewed — panels move as the same node (scroll survives)', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'first')
  const b = await newSession(page, 'alpha', 'claude', 'second')
  const c = await newSession(page, 'alpha', 'claude', 'third')
  await openGrid(page, [a, b, c])
  await expect(page.getByTestId(`grid-panel-${c}`)).toBeVisible()

  // Give the dragged panel a conversation long enough to scroll, and scroll it
  await page.evaluate((sid: string) => {
    const store = (window as never as { __store: any }).__store
    store.setState({
      chat: {
        ...store.getState().chat,
        [sid]: Array.from({ length: 80 }, (_, i) => ({
          kind: i % 2 ? 'assistant' : 'user',
          seq: 1000 + i,
          text: `past conversation ${i}`,
        })),
      },
    })
  }, a)
  await page.evaluate((sid: string) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"]`)!
    panel.dataset.probe = 'same-node'
    panel.querySelector<HTMLElement>('[data-testid="chat-stream"]')!.scrollTop = 40
  }, a)
  /*
   * The chat adjusts its own scroll for a few frames after content lands (virtualised rows
   * re-measure). Wait for it to settle and take *that* value as the baseline — pinning the
   * 40 set above races the chat's measurement pass and fails on a number like 8.
   */
  const readScroll = () =>
    page.evaluate(
      (sid: string) =>
        document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"] [data-testid="chat-stream"]`)!
          .scrollTop,
      a,
    )
  /*
   * Setting 40 once is not enough: if the pane's landing pass is still running it takes
   * the value straight back (the test died on its own precondition, ~1 in 3 under a full
   * parallel run — same failure on unmodified main). Write until it holds, the same
   * pattern the fs-watch tests use for slow observers.
   */
  await expect
    .poll(async () => {
      await page.evaluate((sid: string) => {
        document.querySelector<HTMLElement>(
          `[data-testid="grid-panel-${sid}"] [data-testid="chat-stream"]`,
        )!.scrollTop = 40
      }, a)
      await page.waitForTimeout(80)
      return readScroll()
    })
    .toBeGreaterThan(0)
  let scrolled = await readScroll()
  for (let prev = -1; scrolled !== prev; scrolled = await readScroll()) {
    prev = scrolled
    await page.waitForTimeout(50)
  }
  expect(scrolled).toBeGreaterThan(0) // the pane really is scrolled — otherwise the check below proves nothing

  await startDrag(page, a)
  await hoverPanel(page, c, 'right')
  await expect.poll(() => panelOrder(page)).toEqual([b, c, a])

  /*
   * Two separate things must hold here, because they fail separately:
   * - the marker proves key={id} made React *move* the pane, not remake it — a remount
   *   would discard the old node and the marker with it;
   * - the scrollTop proves GridView put the conversation scroll back. Moving a node resets
   *   its scrollable descendants to 0 even *without* a remount (scroll is layout state,
   *   not a DOM property — measured 40 → 0 before GridView restored it), so without the
   *   restore every reflow step would kick the conversation back to the top.
   */
  const after = await page.evaluate((sid: string) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"]`)!
    return {
      probe: panel.dataset.probe ?? null,
      scrollTop: panel.querySelector<HTMLElement>('[data-testid="chat-stream"]')!.scrollTop,
    }
  }, a)
  expect(after).toEqual({ probe: 'same-node', scrollTop: scrolled })

  await dropOnPanel(page, c, 'right', a)
  // The drop changed nothing visually — and now the store agrees with the screen
  await expect.poll(() => panelOrder(page)).toEqual([b, c, a])
  expect(await storedPanels(page)).toEqual([b, c, a])
})

/**
 * The path in from a notification **prefers the grid** (dogfooding request).
 *
 * A session placed in a panel was placed there to be watched. If that session finishing its
 * response tore down the grid and swapped in one big screen, a single notification would end up
 * clearing every other panel off the screen. Instead, that panel lights up and its composer gets
 * focus — because the reason for coming here was to reply.
 */
test('a session clicked from a notification that is in the grid goes to that panel in the grid', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'first')
  const b = await newSession(page, 'alpha', 'claude', 'second')
  await openGrid(page, [a, b])
  await expect(page.getByTestId('grid')).toBeVisible()

  // b finishes its response while the grid is being watched — since it is not the session being watched, a card shows up
  await page.evaluate((id: string) => (window as any).__store.getState().focusSession(id), a)

  await page.evaluate((id: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'state_change', sessionId: id, state: 'working' })
    m.emit({ type: 'turn_complete', sessionId: id })
  }, b)

  await page.getByTestId('notice-open').click()

  // Stays in the grid, and the panel that caused the notification is lit
  expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('grid')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-focused', 'true')
  await expect(page.getByTestId(`grid-panel-${a}`)).not.toHaveAttribute('data-focused', 'true')
})

/** A session not in the grid behaves as before — it goes to the big screen */
test('a session that is not in the grid still goes to the focus view when clicked from a notification', async ({ page }) => {
  await setup(page)
  const onGrid = await newSession(page, 'alpha', 'claude', 'in a panel')
  const outside = await newSession(page, 'alpha', 'claude', 'session outside the panel')
  await openGrid(page, [onGrid])
  await expect(page.getByTestId('grid')).toBeVisible()

  await page.evaluate((id: string) => (window as any).__store.getState().focusSession(id), onGrid)

  await page.evaluate((id: string) => {
    const m = (window as any).__mock
    m.emit({ type: 'state_change', sessionId: id, state: 'working' })
    m.emit({ type: 'turn_complete', sessionId: id })
  }, outside)

  await page.getByTestId('notice-open').click()
  expect(await page.evaluate(() => (window as any).__store.getState().view)).toBe('focus')
})

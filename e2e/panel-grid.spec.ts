import { expect, test, type Page } from '@playwright/test'
import { columnsThrough } from './fixtures/columns.js'
import { setup, newSession, openGrid } from './fixtures/panel.js'

/**
 * The right-hand panel and the grid around it: the grid's panels — which project a click goes to,
 * the picked session, drag reflow and notifications. Moved out of panel.spec.ts by subject; the
 * shared helpers (setup, newSession, openGrid) are in fixtures/panel.ts.
 */

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
    page.evaluate(() => (window as never as { __store: any }).__store.getState().setPrefs({ textSize: 1.25 })),
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
 * (same technique as fixtures/control.ts dropFile).
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
  page.evaluate(() => (window as never as { __store: any }).__store.getState().gridPanels.map((p: any) => p.sessionId))

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
   * pattern the fs-watch tests use for slow observers. Both waits count the page's frames,
   * not milliseconds: the landing pass and the re-measuring move the scroll only when a frame
   * is drawn, and on a busy machine 50ms can pass without one, which read an unsettled value
   * twice and took it as settled.
   */
  const afterFrames = (frames: number, write?: number) =>
    page.evaluate(
      async ({ sid, n, top }) => {
        const el = document.querySelector<HTMLElement>(`[data-testid="grid-panel-${sid}"] [data-testid="chat-stream"]`)!
        if (top !== undefined) el.scrollTop = top
        const before = el.scrollTop
        for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
        return { before, after: el.scrollTop }
      },
      { sid: a, n: frames, top: write },
    )
  await expect.poll(async () => (await afterFrames(2, 40)).after).toBeGreaterThan(0)
  // Settled once three frames in a row leave it where it was
  await expect.poll(async () => {
    const { before, after } = await afterFrames(3)
    return before === after
  }).toBe(true)
  const scrolled = await readScroll()
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

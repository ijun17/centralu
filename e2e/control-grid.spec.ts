import { test, expect } from '@playwright/test'
import { setup, newSession, pickSetting, emitEvent, dropFile, seedLongChat, distanceFromBottom } from './fixtures/control.js'

/**
 * The control loop's scenarios on the grid: adding and arranging panels, their composers, drafts and answering look. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('Grid — a collapsed composer expands in the panel it was dropped into', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'b')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, b])
  await page.getByTestId('grid-button').click()
  const cell = page.getByTestId(`grid-panel-${a}`)
  await expect(cell).toBeVisible()

  /*
    The other half of this bug is that the composer defaults to collapsed (foldComposer) — the
    one spot that can receive a drop was usually off-screen. If an attachment landed there, it
    would be indistinguishable from nothing happening at all, so it must expand the moment
    something attaches.
  */
  const shell = cell.getByTestId('composer-shell')
  await expect(shell).not.toHaveAttribute('data-up', 'true')

  // The header — the spot inside the panel farthest from the composer
  await cell
    .getByTestId('pane-header')
    .dispatchEvent('drop', { dataTransfer: await dropFile(page, 'report.pdf') })

  await expect(shell).toHaveAttribute('data-up', 'true')
  await expect(cell.getByTestId('attachment-list')).toContainText('report.pdf')

  // What it attaches to is **the session of the panel it was dropped in** — not the focused
  // session (b)
  const where = await page.evaluate(() => {
    const drafts = (window as any).__store.getState().drafts
    const out: Record<string, string[]> = {}
    for (const [id, d] of Object.entries(drafts as Record<string, any>)) {
      out[id] = d.attachments.map((x: any) => x.name)
    }
    return out
  })
  expect(where[a!]).toEqual(['report.pdf'])
  expect(where[b!] ?? []).toEqual([])
})

test('Grid — making the panel a drop target does not break reordering sessions', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'b')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, b])
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()

  /*
    Dropping a file and reordering now end up on **the same surface**. This checks that the
    panel accepts only files (only when Files is present in types) — otherwise the panel
    silently swallows a drop meant to reorder, and that only shows up as "it sometimes does not
    move".
  */
  await page.evaluate(
    ({ from, to }: { from: string; to: string }) => {
      const dt = new DataTransfer()
      const header = document.querySelector(`[data-testid="grid-panel-${from}"] [data-testid="pane-header"]`)!
      header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
      const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
      const r = card.getBoundingClientRect()
      /*
        Where it drops is **inside** the panel — over the conversation. That is where a real
        drop actually lands, so the event bubbles up through the session screen to the panel.
        Firing directly at the card would skip the session screen and fail to check the very
        thing being checked: "does it pass the event through".
      */
      const inside = card.querySelector('[data-testid="chat-stream"]')!
      // The right half — it goes behind b
      const at = { clientX: r.left + r.width * 0.8, clientY: r.top + 10 }
      const init = { dataTransfer: dt, bubbles: true, cancelable: true, ...at }
      inside.dispatchEvent(new DragEvent('dragover', init))
      inside.dispatchEvent(new DragEvent('drop', init))
    },
    { from: a!, to: b! },
  )

  await expect.poll(() => page.evaluate(() => (window as any).__store.getState().gridPanels.map((p: any) => p.sessionId))).toEqual([b, a])
})

/**
 * The grid — several sessions on one screen.
 *
 * This is the grid that spec §5.4 held back for v1. What was preserved when bringing it back:
 * the column count is computed from the width so panels never shrink below the minimum width,
 * and each panel uses **the same component** as the focus view so their settings never diverge.
 */
test('Dragging a session onto the grid button adds it to the grid', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')

  // Dragging it also opens the grid screen — opening it and then dragging separately would be two steps
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  // There is no right-side evidence panel (§5.4: adding one more lane would push the panel below
  // its minimum width)
  await expect(page.getByTestId('evidence-panel')).toBeHidden()
})

test('A grid panel and the focus view see the same settings', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  // Change the model from the grid panel
  await pickSetting(page, 'settings-model-opus', page.getByTestId(`grid-panel-${id}`))

  // It must stay the same when returning to the focus view — a copy would diverge right here
  // (the way out is 'picking something else'. The grid button is not a toggle)
  await page.getByTestId(`session-row-${id}`).click()
  // The current value is written on the button without needing to open the menu
  await expect(page.getByTestId('settings-open')).toContainText('Opus')
})

test('Removing a session from the grid leaves it in the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await page.getByTestId(`grid-remove-${id}`).click()

  await expect(page.getByTestId(`grid-panel-${id}`)).toBeHidden()
  // It only came off the screen — the session keeps running as before
  await expect(page.getByTestId(`session-row-${id}`)).toBeVisible()
})

/**
 * Even as a conversation piles up in a grid panel, the composer must hold its place (dogfooding
 * finding).
 *
 * A flex child's default min-height is auto, so it cannot shrink below its content. As the
 * conversation grew, the whole panel grew with it and pushed the composer outside the panel —
 * "it keeps scrolling and stops, and the composer never appears" was the symptom. This surfaced
 * first in the grid, where panel height is fixed.
 */
test("A grid panel's composer is not pushed out even as the conversation grows longer", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // Enough content to reliably exceed the panel's height
  await page.evaluate((sid) => {
    const store = (window as any).__store
    const items = Array.from({ length: 60 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      text: `long conversation ${i}`,
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  // The composer must be **inside** the panel. Merely being visible is not enough — something
  // pushed out of view is still "visible"
  const composer = panel.getByTestId('prompt-input')
  await expect(composer).toBeVisible()
  /*
   * Measure **only after the position settles** (2026-09-13).
   *
   * In the very first frame the panel exists, the card's absolute position is not yet final —
   * measured, it sits about 10px lower than the panel for a frame or two before settling into
   * place. Measuring during that frame made this assertion pass sometimes and fail other times
   * (three runs of the same code failed three times, then passed once). What this test is meant
   * to state is a property of the **settled state** — "the composer is never pushed outside the
   * panel even in a long conversation" — so it reads the value only after it stops moving.
   */
  const overflow = async () => {
    const box = (await composer.boundingBox())!
    const card = (await panel.boundingBox())!
    return Math.round(box.y + box.height - (card.y + card.height))
  }
  await expect.poll(overflow, { timeout: 2000 }).toBeLessThanOrEqual(1)
})

/**
 * With the grid open, picking a different session left the screen unchanged (dogfooding
 * finding). If the selection changed but the display did not, then to the person who clicked,
 * nothing happened.
 */
test('Picking a session from the grid navigates to that session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  await newSession(page, 'alpha', 'second')
  const ids = await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  await page.getByTestId(`session-row-${ids[0]}`).click()
  await expect(page.getByTestId('grid')).toBeHidden()
  await expect(page.getByTestId('session-view')).toBeVisible()
})

/**
 * Opening a panel must show **the most recent conversation first** (dogfooding finding: "the
 * scroll does not start at the bottom, it starts at the top and scrolling down gets weird").
 *
 * The cause was the same as the composer being pushed out. If the conversation area cannot
 * shrink and instead grows with its content, scrollHeight ends up equal to clientHeight —
 * **there is no scroll to speak of.** So this checks two things together: does it actually
 * scroll, and is it sitting at the bottom.
 */
test('Opening a grid panel shows the most recent conversation first', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((sid) => {
    const store = (window as any).__store
    const items = Array.from({ length: 80 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      text: `long conversation ${i} `.repeat(6),
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  await expect(page.getByTestId(`grid-panel-${id}`)).toBeVisible()

  const box = await page
    .getByTestId(`grid-panel-${id}`)
    .getByTestId('chat-stream')
    .evaluate((el) => ({
      top: el.scrollTop,
      h: el.scrollHeight,
      c: el.clientHeight,
    }))
  // Scroll must be meaningful inside the panel (if it just grows, these two become equal)
  expect(box.h).toBeGreaterThan(box.c)
  // And it must be sitting at the very bottom
  expect(box.h - box.c - box.top).toBeLessThanOrEqual(40)
})

/**
 * "It does not grow to fill space below, so it looks awkward" (dogfooding finding).
 * Pinning the height at 52vh left empty space below even with a single panel.
 * Setting row height to minmax(minimum, 1fr) lets panels share the remaining space.
 */
test('A grid panel fills the remaining vertical space', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  const card = (await panel.boundingBox())!
  const area = (await page.getByTestId('grid').boundingBox())!
  // After subtracting the padding (p-2), it uses almost the entire screen — nothing should
  // remain below
  expect(card.height).toBeGreaterThan(area.height - 24)
})

/**
 * The grid does not scroll.
 * If there might be more below, that makes it a list, not a control tower —
 * "seeing everything at a glance" only holds if what is on screen is everything there is.
 */
test('Even with many panels, they fit the screen exactly and no scroll appears', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const ids: string[] = []
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await newSession(page, 'alpha', name)
    ids.push(await page.evaluate(() => (window as any).__store.getState().focusedSessionId))
  }
  await page.evaluate((list) => (window as any).__store.getState().setGridPanels(list.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[4]}`)).toBeVisible()

  const scroll = await page.getByTestId('grid').evaluate((el) => ({
    h: el.scrollHeight,
    c: el.clientHeight,
  }))
  expect(scroll.h).toBeLessThanOrEqual(scroll.c + 1)

  // Even the last panel fits entirely within the screen
  const area = (await page.getByTestId('grid').boundingBox())!
  const last = (await page.getByTestId(`grid-panel-${ids[4]}`).boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(area.y + area.height + 1)
})

/**
 * "Dragging the conversation moves the panel instead, so text cannot be selected" (dogfooding
 * finding). A draggable ancestor stops the browser from letting text inside it be selected.
 */
test('Conversation text can be selected inside a grid panel', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid) => {
    const store = (window as any).__store
    store.setState({
      chat: {
        ...store.getState().chat,
        [sid]: [{ kind: 'assistant', seq: 1, text: 'a sentence that must be selectable' }],
      },
    })
  }, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  // There must be no ancestor that starts a drag
  const draggableAncestor = await panel.getByTestId('chat-stream').evaluate((el) => {
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
      if (n.getAttribute('draggable') === 'true') return n.getAttribute('data-testid') ?? 'unknown'
    }
    return null
  })
  expect(draggableAncestor).toBeNull()
})

/**
 * "Dragging by the session panel's tab moves the entire window" (dogfooding finding).
 * In the focus view, the header doubles as the title bar, but not in a grid panel.
 */
test("Dragging a grid panel's header does not move the app window", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const header = page.getByTestId(`grid-panel-${id}`).getByTestId('pane-header')
  await expect(header).toBeVisible()

  await page.evaluate(() => ((window as any).__mock.windowDrags = 0))
  const box = (await header.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40)
  await page.mouse.up()

  expect(await page.evaluate(() => (window as any).__mock.windowDrags)).toBe(0)
  // It must instead be the handle for moving the panel
  await expect(header).toHaveAttribute('draggable', 'true')
})

/**
 * "If I never open the session directly from the sidebar, the conversation never shows up in the
 * grid" (dogfooding finding).
 *
 * Loading history was hooked only into focusSession. In the focus view, selecting and viewing
 * are the same action, so this never showed — but the grid is a screen people **view
 * without selecting**.
 */
test('A session never opened before still shows its conversation in the grid', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  // The store has the transcript, but the screen has not loaded it yet (a session right after the
  // app started)
  await page.evaluate((sid) => {
    const m = (window as any).__mock
    m.messages.set(sid, [
      {
        sessionId: sid,
        seq: 1,
        role: 'user',
        kind: 'text',
        payload: { text: 'a saved old question' },
        ts: Date.now(),
      },
      {
        sessionId: sid,
        seq: 2,
        role: 'assistant',
        kind: 'text',
        payload: { text: 'a saved old answer' },
        ts: Date.now(),
      },
    ])
    const store = (window as any).__store
    // A freshly started app has neither the conversation nor a history cursor — the panel
    // decides "has this been read" by whether a cursor exists (#79)
    store.setState({ chat: {}, history: {}, focusedSessionId: null })
  }, id)

  // Add it to the grid directly, without going through the sidebar
  await page.evaluate((sid) => (window as any).__store.getState().setGridPanels([{ kind: 'session', sessionId: sid }]), id)
  await page.getByTestId('grid-button').click()

  await expect(page.getByTestId(`grid-panel-${id}`)).toContainText('a saved old answer')
})

/**
 * A grid panel's "remove" and "restart" buttons used to differ in both size and height
 * (dogfooding finding). "Remove" alone was placed on the panel with absolute coordinates —
 * there was no reason for it to line up with something in a different flow. Putting it in the
 * same row removes the need to align them at all.
 */
test("A grid panel's restart and remove buttons share the same size and the same row", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await expect(panel).toBeVisible()

  const restart = (await panel.getByTestId('restart-session').boundingBox())!
  const remove = (await page.getByTestId(`grid-remove-${id}`).boundingBox())!

  expect(Math.abs(restart.width - remove.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(restart.height - remove.height)).toBeLessThanOrEqual(1)
  // Their vertical centers align on the same line
  expect(Math.abs(restart.y + restart.height / 2 - (remove.y + remove.height / 2))).toBeLessThanOrEqual(1)
})

/**
 * The grid button is a selection, not a toggle.
 * Leaving it as an on/off switch reads as "a temporary overlay on top of the previous screen" —
 * that misreading actually happened.
 */
test('Clicking the grid button again does not turn it off — leaving requires picking something else', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // Clicking it again still stays
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // The only way out is to pick something else
  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('grid')).toBeHidden()
})

/**
 * In the grid, which swaps whole screens in and out, the opposite symptom appeared — the
 * component unmounted and the draft disappeared along with it.
 */
test('A draft in the grid survives switching screens and coming back', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const panel = page.getByTestId(`grid-panel-${id}`)
  await panel.getByTestId('prompt-input').fill('text being written in the grid')

  await page.getByTestId(`session-row-${id}`).click()
  await expect(page.getByTestId('prompt-input')).toHaveValue('text being written in the grid')

  await page.getByTestId('grid-button').click()
  await expect(panel.getByTestId('prompt-input')).toHaveValue('text being written in the grid')
})

/**
 * "Even after entering the grid, the UI still shows the previously selected session as
 * selected" (dogfooding finding). With two things lit up at once, the screen contradicts itself
 * about which one is being viewed.
 */
test('Entering the grid leaves only the grid marked as selected in the sidebar', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  const row = page.getByTestId(`session-row-${id}`)
  await row.click()
  const focusedClass = (await row.getAttribute('class')) ?? ''

  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // The session row must no longer look selected
  expect(await row.getAttribute('class')).not.toBe(focusedClass)
  await expect(page.getByTestId('grid-button')).toHaveAttribute('aria-pressed', 'true')

  // Returning restores the selected appearance
  await row.click()
  expect(await row.getAttribute('class')).toBe(focusedClass)
})

/**
 * Where a drag will land must be visible while dragging (dogfooding: "there is no position
 * indicator, so dropping a tab leaves me unsure where it will go").
 *
 * Playwright's dragAndDrop finishes in one step and skips over the middle, so this fires the
 * drag events by hand to check the screen **mid-drag**.
 */
test('The drop position is shown left or right while dragging a panel', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'a')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'b')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.evaluate((ids) => (window as any).__store.getState().setGridPanels(ids.map((sessionId: string) => ({ kind: 'session', sessionId }))), [a, b])
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${b}`)).toBeVisible()

  /** Fires dragover over the left/right half of the target panel */
  const hover = (side: 'left' | 'right') =>
    page.evaluate(
      ({ from, to, where }: { from: string; to: string; where: string }) => {
        const dt = new DataTransfer()
        const header = document
          .querySelector(`[data-testid="grid-panel-${from}"]`)!
          .querySelector('[data-testid="pane-header"]')!
        header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
        const card = document.querySelector(`[data-testid="grid-panel-${to}"]`)!
        const r = card.getBoundingClientRect()
        const x = where === 'left' ? r.left + r.width * 0.2 : r.left + r.width * 0.8
        card.dispatchEvent(
          new DragEvent('dragover', {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: r.top + 10,
          }),
        )
      },
      { from: a!, to: b!, where: side },
    )

  await hover('left')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-drop', 'before')

  await hover('right')
  await expect(page.getByTestId(`grid-panel-${b}`)).toHaveAttribute('data-drop', 'after')

  // The original being dragged dims to show "this is what is moving"
  const cls = (await page.getByTestId(`grid-panel-${a}`).getAttribute('class')) ?? ''
  expect(cls).toContain('opacity-40')

  /*
   * The dragged image must be **the panel itself**.
   * Since the draggable element is the header, the browser by default only lifts the header —
   * the panel stays put while a thin strip follows the cursor, leaving no clue what is being
   * moved.
   */
  const lifted = await page.evaluate((from: string) => {
    let captured: string | null = null
    const real = DataTransfer.prototype.setDragImage
    DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
      captured = (el as HTMLElement).getAttribute('data-testid')
      return real.call(this, el, x, y)
    }
    const header = document
      .querySelector(`[data-testid="grid-panel-${from}"]`)!
      .querySelector('[data-testid="pane-header"]')!
    header.dispatchEvent(new DragEvent('dragstart', { dataTransfer: new DataTransfer(), bubbles: true }))
    DataTransfer.prototype.setDragImage = real
    return captured
  }, a!)
  expect(lifted).toBe(`grid-panel-${a}`)
})

/**
 * In the grid, a panel that is responding has a **thick white border** (#736).
 *
 * With several panels, a small marker in the header alone is too small for the eye to track
 * which one is working. The grid is a screen to glance at, not read, so the signal has to be the
 * size of the whole panel to catch peripheral vision.
 */
test('Grid: only the responding panel has the answering border', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await newSession(page, 'alpha', 'second')
  const b = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)

  await page.dragAndDrop(`[data-testid="session-row-${a}"]`, '[data-testid="grid-button"]')
  await page.dragAndDrop(`[data-testid="session-row-${b}"]`, '[data-testid="grid-button"]')

  const panelA = page.getByTestId(`grid-panel-${a}`)
  const panelB = page.getByTestId(`grid-panel-${b}`)

  // Both are working from their first prompt — compare only after they finish
  for (const idx of [0, 1]) await emitEvent(page, idx, { type: 'turn_complete' })
  await expect(panelA).toHaveAttribute('data-look', 'idle')
  await expect(panelB).toHaveAttribute('data-look', 'idle')

  // Only give work to a
  await page.getByTestId(`grid-panel-${a}`).getByTestId('prompt-input').fill('something that takes a while')
  await page.getByTestId(`grid-panel-${a}`).getByTestId('send').click()

  await expect(panelA).toHaveAttribute('data-look', 'answering')
  // If the neighboring panel lights up too, "which one is busy" cannot be read — it becomes
  // decoration, not a signal
  await expect(panelB).toHaveAttribute('data-look', 'idle')
})

/**
 * Scroll survives leaving a grid panel and coming back (issue #31).
 *
 * Fourth time this shape has bitten: draft text, expanded folders, the elapsed count, and
 * now this. What is preserved is **"was I stuck to the bottom"**, not a pixel offset — a
 * `scrollTop` restored into a virtualiser that has not measured its rows yet lands *near*
 * the right place, which was the reported symptom rather than a cure for it.
 *
 * Note this one **passes against the old code on a quiet machine**, and fails on a busy
 * one (measured 339px short, repeatedly, with the suite running in parallel). The gap it
 * is about opens while rows are being measured, so how much of it you see depends on how
 * many frames the measuring takes. So: a contract written down, not a net. The net for
 * this pair is the test below, which fails on the old code every time.
 */
test('stuck to the bottom of a grid panel, still there after looking away (#31)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const stream = page.getByTestId(`grid-panel-${id}`).getByTestId('chat-stream')
  await expect(stream).toBeVisible()
  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)

  // Away to the focus view and back — the panel is torn down and built again
  await page.getByTestId(`session-row-${id}`).click()
  await page.getByTestId('grid-button').click()
  await expect(stream).toBeVisible()

  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)
})

/**
 * The other half: reading something further up is also a position worth keeping.
 *
 * We cannot promise the exact spot back — that is the offset problem above — but being
 * yanked to the newest message is a decision the app makes *against* you, and it used to
 * make it every single time, because the flag was born `true` with the component.
 */
test('scrolled up to read, a grid panel does not yank you back down (#31)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)

  await page.dragAndDrop(`[data-testid="session-row-${id}"]`, '[data-testid="grid-button"]')
  const stream = page.getByTestId(`grid-panel-${id}`).getByTestId('chat-stream')
  await expect(stream).toBeVisible()
  await expect.poll(() => distanceFromBottom(stream)).toBeLessThanOrEqual(80)

  // Scroll up by hand — the wheel, so it is a real user scroll and not an assignment
  await stream.hover()
  await page.mouse.wheel(0, -4000)
  await expect.poll(() => distanceFromBottom(stream)).toBeGreaterThan(80)

  await page.getByTestId(`session-row-${id}`).click()
  await page.getByTestId('grid-button').click()
  await expect(stream).toBeVisible()

  // Give the follow logic every chance to drag us down before we believe it did not
  await page.waitForTimeout(300)
  expect(await distanceFromBottom(stream)).toBeGreaterThan(80)
})

/**
 * The screen being viewed carries over a restart (the remaining half of C-3).
 *
 * The session came back, but the **way** it was viewed did not — closed from the grid, it
 * reopened in the focus view. The restore order (focusSession forces the view to focus) is
 * guarded by unit tests; this one runs through an actual reload. The mock's restart rule matches
 * #20's relaunch test: only localStorage (standing in for the snapshot) survives, and projects
 * have to be re-registered.
 */
test('Closing and restarting from the grid returns to the grid', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await page.evaluate((sid: string) => (window as any).__store.getState().setGridPanels([{ kind: 'session', sessionId: sid }]), id)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId('grid')).toBeVisible()

  // Restart — only the snapshot survives. The intro screen does not come back (introSeen also
  // lives in the snapshot)
  await page.goto('/?mock=1')
  await expect(page.getByTestId('add-project')).toBeVisible()
  await expect(page.getByTestId('intro')).toHaveCount(0)
  await page.evaluate((p: string) => {
    ;(window as any).__mock.nextPickedDirectory = p
  }, '/tmp/alpha')
  await page.getByTestId('add-project').click()

  // The moment the project comes back, the screen must be **the grid**, not the focus view
  await expect(page.getByTestId('grid')).toBeVisible()
})

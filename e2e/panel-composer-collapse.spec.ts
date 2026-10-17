import { expect, test, type Page } from '@playwright/test'
import { setup, newSession, openGrid } from './fixtures/panel.js'

/**
 * The right-hand panel and the grid around it: the grid's collapsed composer, which rises when the
 * cursor reaches the bottom. Moved out of panel.spec.ts by subject; the shared helpers (setup,
 * newSession, openGrid) are in fixtures/panel.ts.
 */

/**
 * The position after movement has settled. A rising card or a dropping menu, if measured mid
 * transition, would record a **position in transit** as fact — this waits until every transition
 * and animation running on the element has finished, then measures.
 *
 * It used to wait for the same box twice in a row, 50ms apart. That reads the clock, not the
 * transition: a transition only moves when a frame is drawn, and on a busy CI runner two reads
 * with no frame between them saw the same box, still where the card started. Chromium in CI then
 * measured the card 688 to 707px down a panel whose strip starts at 658 (1 run in 4). Slowing
 * animations to 1/50 through DevTools reproduced it every time; waiting for the transitions does
 * not care how fast frames come. A transition cancelled by another (the card turned back) ends its
 * `finished` with an AbortError, so this asks again until nothing is running.
 */
async function settled(loc: ReturnType<Page['getByTestId']>): Promise<{ x: number; y: number; width: number; height: number }> {
  await loc.evaluate(async (el) => {
    for (let running = el.getAnimations(); running.length > 0; running = el.getAnimations()) {
      await Promise.allSettled(running.map((a) => a.finished))
    }
  })
  return (await loc.boundingBox())!
}

/** The height of the strip that raises a collapsed composer (the same value as SessionView's COMPOSER_REACH) */
const COMPOSER_REACH = 54

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

  /*
   * The positions are read off the rise itself, not off the frames that happen to be drawn during
   * it. This used to record the card's top once a frame for 700ms; in CI WebKit the page drew no
   * frame for 200-300ms right as the card started (the grid opened just before was still being
   * laid out and painted), so the whole 300ms rise fell between two frames and read as a snap
   * (#526: 2 positions, 1 run in 8). So the moment the card is told to rise, everything animating
   * on it is paused and stepped through its duration, and the card's top is read at each step. A
   * card that snaps has nothing moving it (the original bug: a transition on `transform` while
   * `translate` changed), so every step reads the same top.
   */
  await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="composer-shell"]') as HTMLElement
    const w = window as never as { __rise: Promise<number[]> }
    w.__rise = new Promise((resolve) => {
      const watch = new MutationObserver(() => {
        if (shell.dataset.up !== 'true') return
        watch.disconnect()
        // Resolving the style now starts the transitions the change sets off
        void getComputedStyle(shell).translate
        const running = shell.getAnimations()
        for (const a of running) a.pause()
        const tops: number[] = []
        for (let step = 0; step <= 10; step++) {
          for (const a of running) a.currentTime = (Number(a.effect?.getComputedTiming().duration) * step) / 10
          tops.push(Math.round(shell.getBoundingClientRect().top))
        }
        for (const a of running) a.finish()
        resolve(tops)
      })
      watch.observe(shell, { attributes: true, attributeFilter: ['data-up'] })
    })
  })

  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)

  const tops = await page.evaluate(() => (window as never as { __rise: Promise<number[]> }).__rise)
  // If it snaps, every step reads one position (risen)
  expect(new Set(tops).size, `tops ${tops.join(', ')}`).toBeGreaterThan(5)
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
 * The border of a panel that is answering is the **panel's own border** (#736). It must not break no
 * matter what is floating inside the panel; the collapsed composer once covered the bottom edge of a ring drawn
 * on top (user finding, 2026-09-10). A border the browser draws belongs to the panel, and what is inside it is
 * clipped by the panel, so the pixel on the bottom edge hits the panel itself and never the composer.
 */
test('the collapsed composer does not cover the answering border of a panel', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  const panel = page.getByTestId(`grid-panel-${a}`)
  await expect(panel).toHaveAttribute('data-look', 'answering')
  await expect(panel).toHaveCSS('border-bottom-width', '1px')
  // The answering look's light grey (ink-muted), as the browser computes the token
  const muted = await page.evaluate(() => {
    const probe = document.createElement('i')
    probe.style.color = 'var(--color-ink-muted)'
    document.body.append(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
  await expect(panel).toHaveCSS('border-bottom-color', muted)

  // The middle of the bottom edge, where the folded composer sits: half a pixel in is inside the 1px border
  const hit = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return document.elementFromPoint(r.left + r.width / 2, r.bottom - 0.5) === el
  })
  expect(hit).toBe(true)
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

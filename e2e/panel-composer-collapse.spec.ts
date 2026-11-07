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

/**
 * The same wait as `settled`, for every transition inside `loc` too (a card rising and the padding that follows
 * it). Only transitions: an animation such as a working session's pulse never finishes and moves nothing measured.
 */
async function transitionsDone(loc: ReturnType<Page['getByTestId']>): Promise<void> {
  await loc.evaluate(async (el) => {
    const running = () => el.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition)
    for (let now = running(); now.length > 0; now = running()) {
      await Promise.allSettled(now.map((a) => a.finished))
    }
  })
}

/**
 * A grid panel folds its composer by its own height (SessionPane's `foldWhenShort`: below about 570px it folds, above
 * about 620px it opens, with the usual composer; owner, 2026-11-07). So every scenario here runs in a short window, whose one-row grid
 * gives a panel under that line; the last one makes the window tall to see the composer stay open.
 */
const SHORT_WINDOW = { width: 1280, height: 320 }
test.use({ viewport: SHORT_WINDOW })

/** The height of the strip that raises a collapsed composer (the same value as SessionView's COMPOSER_REACH) */
const COMPOSER_REACH = 54

/**
 * The collapsed composer in the grid (user request, 2026-09-10).
 *
 * Reading space was tight in a two-row grid — out of a 370px panel, the input area took 95px,
 * while the actual text field was only 22px. Collapsed, the rounded card waits below the panel's bottom edge,
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
  const shell = panel.getByTestId('composer-shell')
  await expect(shell).not.toHaveAttribute('data-up', 'true')
  /*
   * The card has to be at rest below the edge before the hand comes. `not data-up` is no proof of that: it holds for an
   * open pane too, and a pane that has not measured itself yet is open. The card then slides down for 300ms once it
   * folds, and a hand arriving in that time raised it from where it had got to (216px, not 312px down), so the rise
   * read as a few pixels and 3 steps in 10 were the same position (17 runs in 60 in WebKit, 1 in 8 alone).
   */
  const edge = (await panel.getByTestId('session-view').boundingBox())!
  await expect.poll(async () => Math.round((await settled(shell)).y - (edge.y + edge.height))).toBeGreaterThanOrEqual(0)

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
  // The rows near the end are still being measured (each is estimated at 64px until drawn), and the last line moves
  // with every measurement; read it as `down` only once two consecutive polls agree (each is two frames after the last)
  let before = ''
  await expect
    .poll(async () => {
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const m = JSON.stringify(await read())
      const same = m === before
      before = m
      return same
    })
    .toBe(true)
  const down = await read()

  const box = (await panel.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20)
  await expect(panel.getByTestId('composer-shell')).toHaveAttribute('data-up', 'true')
  // Wait for the transitions to finish — measuring mid-transition records a position in transit as fact
  await transitionsDone(panel)

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
 * A panel tall enough keeps the composer open — folding is a rule of the panel's height, not of the grid.
 * And since folding is a concern specific to grid and project panels, the focus view never has this problem
 * to begin with, however short the window.
 */
test('a panel tall enough keeps the composer open, and the focus view never folds it in the first place', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const hangsBelow = async () => {
    const p = (await panel.boundingBox())!
    const s = (await shell.boundingBox())!
    return s.y + s.height > p.y + p.height + 1
  }
  // The short window folds it: the card hangs wholly below the panel's bottom edge
  expect((await panel.boundingBox())!.height).toBeLessThan(570)
  expect(await hangsBelow()).toBe(true)

  // A taller window gives the panel enough height: the composer opens and sits wholly inside it
  await page.setViewportSize({ width: SHORT_WINDOW.width, height: 800 })
  await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(620)
  await expect.poll(hangsBelow).toBe(false)
  await expect(shell).not.toHaveAttribute('data-up', 'true')

  // Focus view: never folds, however short the window
  await page.setViewportSize(SHORT_WINDOW)
  await page.evaluate((id: string) => (window as never as { __store: any }).__store.getState().focusSession(id), a)
  const view = page.getByTestId('session-view')
  await expect(view.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')
  await expect(page.getByTestId('prompt-input')).toBeVisible()
  const v = (await view.boundingBox())!
  const c = (await view.getByTestId('composer-shell').boundingBox())!
  expect(c.y + c.height).toBeLessThanOrEqual(v.y + v.height + 1)
})

/**
 * A folded composer is wholly below the pane's bottom edge at rest (owner, 2026-11-07; #2018 had left 32px showing,
 * which the owner did not mean). Neither its box nor its shadow is inside the pane (read off the boxes and the computed shadow, not from pixels). A hand in the strip that raises it still raises it, and it goes down again when the hand leaves.
 */
test('a folded composer shows nothing of itself at rest, rises to a hand at the bottom and goes back down', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  const b = await newSession(page, 'alpha', 'claude', 'two')
  await openGrid(page, [a, b])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  await expect(shell).not.toHaveAttribute('data-up', 'true')
  const pane = (await panel.getByTestId('session-view').boundingBox())!
  const card = await settled(shell)
  // The card's top edge is at the pane's bottom edge or below it: no pixel of the card is inside the pane
  expect(Math.round(card.y - (pane.y + pane.height))).toBeGreaterThanOrEqual(0)
  // Nor its shadow, which is cast upward from the top edge
  // (Tailwind's `shadow-none` is a stack of transparent, zero-size shadows, not the keyword)
  await expect(shell).toHaveCSS('box-shadow', /^(rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?)+$/)

  // A hand 40px up, over the conversation but inside the strip, raises it; it comes to rest inside the pane
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 40)
  await expect(shell).toHaveAttribute('data-up', 'true')
  const up = await settled(shell)
  expect(up.y + up.height).toBeLessThanOrEqual(pane.y + pane.height + 1)

  // And goes back down, wholly below the edge again, when the hand returns to the middle of the conversation
  await page.mouse.move(pane.x + pane.width / 2, pane.y + 80)
  await expect(shell).not.toHaveAttribute('data-up', 'true')
  const down = await settled(shell)
  expect(Math.round(down.y - (pane.y + pane.height))).toBeGreaterThanOrEqual(0)
})

/**
 * A panel of a middling height folds too (owner, 2026-11-07): the line was about 285px and is about 570px now, so a
 * 450px panel, which an ordinary two-row grid gives, folds its composer and a 700px one keeps it open. Run in both
 * engines, as CI does (WebKit is the one the desktop app runs in).
 */
test('a panel of 450px folds its composer and one of 700px does not', async ({ page }) => {
  await page.setViewportSize({ width: SHORT_WINDOW.width, height: 500 })
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const hangsBelow = async () => {
    const p = (await panel.boundingBox())!
    const s = (await shell.boundingBox())!
    return s.y + s.height > p.y + p.height + 1
  }
  const height = async () => Math.round((await panel.boundingBox())!.height)
  expect(await height()).toBeGreaterThan(420)
  expect(await height()).toBeLessThan(480)
  await expect.poll(hangsBelow).toBe(true)

  await page.setViewportSize({ width: SHORT_WINDOW.width, height: 750 })
  await expect.poll(height).toBeGreaterThan(620)
  await expect.poll(hangsBelow).toBe(false)
})

/**
 * The pinned copy of the last message leaves while the pane is folded, and its original shows (owner, 2026-11-06).
 *
 * A short panel gives the composer's fold the room it takes from the conversation, and the copy at the top took more
 * of what was left. It slides up and fades; the original row, hidden while the copy speaks for it, is drawn instead so
 * the message is not gone from the stream; a taller window brings the copy back and hides the original again.
 */
test('the pinned message leaves while the pane is folded and comes back when it opens', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'pinned question')
  await page.evaluate((sid: string) => {
    const m = (window as never as { __mock: any }).__mock
    for (let i = 0; i < 60; i++) m.emit({ type: 'message_delta', sessionId: sid, role: 'assistant', text: `answer line ${i}\n\n` })
    m.emit({ type: 'turn_complete', sessionId: sid })
  }, a)
  // The copy appears in a pane that is already folded: its first drawn state is the hidden one (nothing flashes)
  await page.evaluate(() => {
    const w = window as never as { __firstOpacity: string[] }
    w.__firstOpacity = []
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid^="grid-panel-"] [data-testid="sticky-user"]')
      if (el && w.__firstOpacity.length === 0) w.__firstOpacity.push(getComputedStyle(el).opacity)
    }).observe(document.body, { childList: true, subtree: true })
  })
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

  const panel = page.getByTestId(`grid-panel-${a}`)
  const stream = panel.getByTestId('chat-stream')
  const banner = panel.getByTestId('sticky-user')
  await expect(panel.getByTestId('composer-shell')).not.toHaveAttribute('data-up', 'true')
  const toEnd = () => stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
  const original = () =>
    stream.evaluate((el) => {
      const row = [...el.querySelectorAll<HTMLElement>('[data-index]')].find((r) => r.querySelector('[data-testid="msg-user"]'))
      return row ? getComputedStyle(row).visibility : 'gone'
    })

  await expect.poll(async () => { await toEnd(); return banner.count() }).toBe(1)
  await expect(banner).toHaveAttribute('data-folded', 'true')
  expect(await page.evaluate(() => (window as never as { __firstOpacity: string[] }).__firstOpacity)).toEqual(['0'])
  await expect(banner).toHaveCSS('opacity', '0')
  const hiddenAt = (await banner.boundingBox())!
  expect(hiddenAt.y + hiddenAt.height).toBeLessThanOrEqual((await stream.boundingBox())!.y)
  // The original is drawn once the copy has gone, a moment after it starts to leave
  await expect.poll(original).toBe('visible')

  // A taller window opens the composer: the copy comes back by a transition, and the original hides behind it
  await page.evaluate(() => {
    const w = window as never as { __moves: Promise<string[]> }
    w.__moves = new Promise((resolve) => {
      const watch = new MutationObserver(() => {
        const el = document.querySelector('[data-testid="sticky-user"]') as HTMLElement
        if (el.dataset.folded === 'true') return
        watch.disconnect()
        void getComputedStyle(el).translate
        resolve(el.getAnimations().map((x) => (x as CSSTransition).transitionProperty))
      })
      watch.observe(document.querySelector('[data-testid="sticky-user"]')!, { attributes: true, attributeFilter: ['data-folded'] })
    })
  })
  await page.setViewportSize({ width: SHORT_WINDOW.width, height: 800 })
  const moves = await page.evaluate(() => (window as never as { __moves: Promise<string[]> }).__moves)
  expect(moves.sort()).toEqual(['opacity', 'translate'])
  await expect.poll(async () => { await toEnd(); return banner.getAttribute('data-folded') }).toBeNull()
  await expect(banner).toHaveCSS('opacity', '1')
  await expect.poll(original).toBe('hidden')

  // Short again: it leaves again, and the original is drawn once it has gone
  await page.setViewportSize(SHORT_WINDOW)
  await expect(banner).toHaveAttribute('data-folded', 'true')
  await expect(banner).toHaveCSS('opacity', '0')
  await expect.poll(original).toBe('visible')
})

/**
 * A short panel keeps its composer open while a note with a button shows above it (owner, 2026-11-07).
 *
 * The folded card rises over the bottom of the pane, which is exactly where the notes (Done after an error, Continue
 * after an interruption, Retry on a session that could not wake) wait: it would cover the button just as a hand came to
 * press it. So while such a note shows the pane behaves as an open one, and when the note goes it folds again.
 */
const noteCases = [
  {
    name: 'an error (Done)',
    note: 'error-note',
    button: 'error-done',
    show: (page: Page, id: string) =>
      page.evaluate((sid) => {
        const m = (window as never as { __mock: any }).__mock
        m.emit({ type: 'state_change', sessionId: sid, state: 'working' })
        m.emit({ type: 'error', sessionId: sid, error: { code: 'internal', message: 'boom', retryable: true } })
      }, id),
    // Pressing the button is the way out
    dismiss: (page: Page) => page.getByTestId('error-done').click(),
  },
  {
    name: 'an interruption (Continue)',
    note: 'interrupted-note',
    button: 'interrupted-continue',
    show: (page: Page, id: string) =>
      page.evaluate((sid) => {
        const m = (window as never as { __mock: any }).__mock
        // The prompt left the turn running; a note offers Continue once it has stopped
        m.emit({ type: 'state_change', sessionId: sid, state: 'idle' })
        m.emit({ type: 'interruption', sessionId: sid, interruption: { reason: 'quit', at: Date.now() } })
      }, id),
    dismiss: (page: Page) => page.getByTestId('interrupted-continue').click(),
  },
  {
    name: 'a session that could not wake (Retry)',
    note: 'dormant-note',
    button: 'dormant-retry',
    show: (page: Page, id: string) =>
      page.evaluate((sid) => {
        const store = (window as never as { __store: any }).__store
        const st = store.getState()
        store.setState({
          sessions: { ...st.sessions, [sid]: { ...st.sessions[sid], live: false } },
          wakeError: { ...st.wakeError, [sid]: 'it cannot be resumed' },
        })
      }, id),
    // The state changes: the reason is cleared (a retry that worked does this)
    dismiss: (page: Page) =>
      page.evaluate(() => (window as never as { __store: any }).__store.setState({ wakeError: {} })),
  },
]

for (const c of noteCases) {
  test(`a short panel keeps its composer open while ${c.name} shows, and folds when it goes`, async ({ page }) => {
    await setup(page)
    const a = await newSession(page, 'alpha', 'claude', 'one')
    await openGrid(page, [a])
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    const panel = page.getByTestId(`grid-panel-${a}`)
    const shell = panel.getByTestId('composer-shell')
    expect((await panel.boundingBox())!.height).toBeLessThan(570)
    const hangsBelow = async () => {
      const p = (await panel.boundingBox())!
      const s = (await shell.boundingBox())!
      return s.y + s.height > p.y + p.height + 1
    }
    await expect.poll(hangsBelow).toBe(true)

    await c.show(page, a)
    const note = panel.getByTestId(c.note)
    await expect(note).toBeVisible()
    // Open in place: wholly inside the panel, below the note, and nothing hangs below the edge
    await expect.poll(hangsBelow).toBe(false)
    await transitionsDone(panel)
    const noteBox = (await note.boundingBox())!
    const shellBox = (await shell.boundingBox())!
    expect(shellBox.y).toBeGreaterThanOrEqual(noteBox.y + noteBox.height - 1)

    // A hand at the bottom of the panel, where the folded card would have risen: the button is still what is under it
    const pane = (await panel.getByTestId('session-view').boundingBox())!
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 10)
    const button = panel.getByTestId(c.button)
    const box = (await button.boundingBox())!
    const covered = await button.evaluate((el, at) => {
      const hit = document.elementFromPoint(at.x, at.y)
      return !hit || !(hit === el || el.contains(hit))
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    expect(covered).toBe(false)

    // The note goes, the pane folds again
    await c.dismiss(page)
    await expect(note).toHaveCount(0)
    await page.mouse.move(pane.x + pane.width / 2, pane.y + 80)
    await expect.poll(hangsBelow).toBe(true)
  })
}

/**
 * Two things that outlive the note (found in review). The hand that was in the bottom strip when the note came must
 * not leave the card raised when the note goes while the hand is elsewhere; and a panel in the band where the fold and
 * the open line overlap (the folded card measures a few pixels taller than the open one) folds again after the note,
 * as it was folded before it.
 */
const fail = (page: Page, id: string) =>
  page.evaluate((sid) => {
    const m = (window as never as { __mock: any }).__mock
    m.emit({ type: 'state_change', sessionId: sid, state: 'working' })
    m.emit({ type: 'error', sessionId: sid, error: { code: 'internal', message: 'boom', retryable: true } })
  }, id)
const clear = (page: Page, id: string) =>
  page.evaluate((sid) => (window as never as { __mock: any }).__mock.emit({ type: 'state_change', sessionId: sid, state: 'idle' }), id)

test('a hand that left the strip while a note showed does not leave the card raised when the note goes', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const pane = (await panel.getByTestId('session-view').boundingBox())!

  // The hand is in the bottom strip (the card is raised) when the error arrives
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 20)
  await expect(shell).toHaveAttribute('data-up', 'true')
  await fail(page, a)
  await expect(panel.getByTestId('error-note')).toBeVisible()
  // It leaves the panel, and then the error goes by another way (Done from the inbox, a new turn)
  await page.mouse.move(pane.x + pane.width / 2, 2)
  await clear(page, a)
  await expect(panel.getByTestId('error-note')).toHaveCount(0)
  await expect(shell).not.toHaveAttribute('data-up', 'true')
})

test('a panel in the band where the fold and open lines overlap folds again when the note goes', async ({ page }) => {
  await page.setViewportSize({ width: SHORT_WINDOW.width, height: 450 })
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const hangsBelow = async () => {
    const p = (await panel.boundingBox())!
    const s = (await shell.boundingBox())!
    return s.y + s.height > p.y + p.height + 1
  }
  // The card's height folded, and open (a note holds it open): the two lines are 1/6 of one and 0.16 of the other
  await expect.poll(hangsBelow).toBe(true)
  await transitionsDone(panel)
  const folded = (await shell.boundingBox())!.height
  await fail(page, a)
  await expect.poll(hangsBelow).toBe(false)
  const open = (await shell.boundingBox())!.height
  await clear(page, a)
  await expect.poll(hangsBelow).toBe(true)

  // A panel between "open / 0.16" and "folded / 0.16": a folded panel stays folded there (the fold line was crossed
  // on the way down), and it has to be folded once a note has come and gone
  const target = Math.round((open / 0.16 + folded / 0.16) / 2)
  expect(target, 'the folded card must measure more than the open one for this band to exist').toBeGreaterThan(open / 0.16 + 1)
  const panelH = async () => Math.round((await panel.boundingBox())!.height)
  const chrome = (await panelH()) === 0 ? 0 : 450 - (await panelH())
  await page.setViewportSize({ width: SHORT_WINDOW.width, height: target + chrome })
  await expect.poll(panelH).toBe(target)
  await expect.poll(hangsBelow).toBe(true)

  await fail(page, a)
  await expect.poll(hangsBelow).toBe(false)
  await clear(page, a)
  await expect(panel.getByTestId('error-note')).toHaveCount(0)
  await expect.poll(hangsBelow).toBe(true)
})

/**
 * Opening the composer is animated like folding it (owner: every fold and unfold is, design-system §9). The card comes
 * up from below the pane's edge into its place, by both ways a pane opens (a note shows; the panel grows), and does not
 * move under reduced motion. Read off the animation itself, as "the composer rises smoothly" does: the moment the card
 * is told to rise, what runs on it is paused and stepped, so a slow frame cannot make a slide look like a jump.
 */
async function watchOpening(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="composer-shell"]') as HTMLElement
    const pane = shell.closest('[data-testid="session-view"]') as HTMLElement
    const w = window as never as { __open: Promise<{ names: string[]; tops: number[]; edge: number; place: number; clip: string }> }
    w.__open = new Promise((resolve) => {
      const watch = new MutationObserver(() => {
        if (!shell.classList.contains('cc-composer-rise')) return
        watch.disconnect()
        void getComputedStyle(shell).transform
        const running = shell.getAnimations()
        const names = running.map((x) => (x as CSSAnimation).animationName ?? '')
        for (const x of running) x.pause()
        const tops: number[] = []
        for (let step = 0; step <= 10; step++) {
          for (const x of running) x.currentTime = (Number(x.effect?.getComputedTiming().duration) * step) / 10
          tops.push(Math.round(shell.getBoundingClientRect().top))
        }
        for (const x of running) x.finish()
        resolve({ names, tops, edge: Math.round(pane.getBoundingClientRect().bottom), place: Math.round(shell.getBoundingClientRect().top), clip: getComputedStyle(pane).overflow })
      })
      watch.observe(shell, { attributes: true, attributeFilter: ['class'] })
    })
  })
}
const opening = (page: Page) => page.evaluate(() => (window as never as { __open: Promise<{ names: string[]; tops: number[]; edge: number; place: number; clip: string }> }).__open)

test('a note opening the composer slides the card up from below the edge into its place', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const edge = (await panel.getByTestId('session-view').boundingBox())!
  await expect.poll(async () => Math.round((await settled(shell)).y - (edge.y + edge.height))).toBeGreaterThanOrEqual(0)

  await watchOpening(page)
  await fail(page, a)
  const open = await opening(page)
  expect(open.names).toEqual(['cc-composer-rise'])
  // It starts at the pane's edge (wholly below it), passes through several places, and ends where the layout puts it
  expect(open.tops[0]).toBeGreaterThanOrEqual(open.edge - 1)
  expect(new Set(open.tops).size, `tops ${open.tops.join(', ')}`).toBeGreaterThan(5)
  expect(open.tops[10]).toBeLessThan(open.edge - 50)
  // The pane clips (not hides: a scroll container would scroll to a field focused below its edge) while the card is out of it
  expect(open.clip).toBe('clip')
  // Nothing waits on it: the button is there to press at once, and the pane stops clipping once the card is in place
  await expect(panel.getByTestId('error-done')).toBeEnabled()
  await expect.poll(() => panel.getByTestId('session-view').evaluate((el) => getComputedStyle(el).overflow)).not.toBe('clip')
})

test('a panel that grows slides the card up into the open composer', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const edge = (await panel.getByTestId('session-view').boundingBox())!
  await expect.poll(async () => Math.round((await settled(shell)).y - (edge.y + edge.height))).toBeGreaterThanOrEqual(0)

  await watchOpening(page)
  await page.setViewportSize({ width: SHORT_WINDOW.width, height: 800 })
  const open = await opening(page)
  expect(open.names).toEqual(['cc-composer-rise'])
  expect(new Set(open.tops).size, `tops ${open.tops.join(', ')}`).toBeGreaterThan(5)
  expect(open.tops[0]).toBeGreaterThanOrEqual(open.edge - 1)
})

test('under reduced motion the card does not slide when the composer opens', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const edge = (await panel.getByTestId('session-view').boundingBox())!
  await expect.poll(async () => Math.round((await settled(shell)).y - (edge.y + edge.height))).toBeGreaterThanOrEqual(0)

  await fail(page, a)
  await expect(panel.getByTestId('error-note')).toBeVisible()
  // In place at once, with no class that moves it and nothing running on it, and the pane never clips for it
  const state = await shell.evaluate((el) => ({
    cls: el.classList.contains('cc-composer-rise'),
    running: el.getAnimations().length,
    clip: getComputedStyle(el.closest('[data-testid="session-view"]')!).overflow === 'clip',
    top: Math.round(el.getBoundingClientRect().top),
  }))
  expect(state).toMatchObject({ cls: false, running: 0, clip: false })
  expect(state.top).toBeLessThan(Math.round(edge.y + edge.height) - 50)
})

test('a card that was raised when the pane opens its composer stays where it is and does not slide', async ({ page }) => {
  await setup(page)
  const a = await newSession(page, 'alpha', 'claude', 'one')
  await openGrid(page, [a])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const panel = page.getByTestId(`grid-panel-${a}`)
  const shell = panel.getByTestId('composer-shell')
  const pane = (await panel.getByTestId('session-view').boundingBox())!
  await expect.poll(async () => Math.round((await settled(shell)).y - (pane.y + pane.height))).toBeGreaterThanOrEqual(0)

  // The hand is in the strip: the card is up, wholly inside the pane, when the note opens the composer
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 20)
  await expect(shell).toHaveAttribute('data-up', 'true')
  const up = await settled(shell)
  await fail(page, a)
  await expect(panel.getByTestId('error-note')).toBeVisible()
  const now = await shell.evaluate((el) => ({
    cls: el.classList.contains('cc-composer-rise'),
    running: el.getAnimations().filter((x) => x instanceof CSSAnimation).length,
    bottom: Math.round(el.getBoundingClientRect().bottom),
  }))
  expect(now).toMatchObject({ cls: false, running: 0 })
  // Wholly inside the pane and at the bottom edge, as the raised card was
  expect(Math.abs(now.bottom - Math.round(up.y + up.height))).toBeLessThanOrEqual(6)
})

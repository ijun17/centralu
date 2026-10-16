import { test, expect, type Locator, type Page } from '@playwright/test'
import { setup, newSession, seedLongChat, distanceFromBottom } from './fixtures/control.js'

/**
 * The control loop's scenarios on where the conversation is scrolled: following the bottom, keeping the spot being read, windowing. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('A long conversation renders only what is visible (D-1 virtual scroll)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'long task')

  // Inject 200 turns worth
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    for (let i = 0; i < 200; i++) {
      m.emit({
        type: 'message_delta',
        sessionId: id,
        role: 'assistant',
        text: `line ${i} — this is the conversation content.\n`,
      })
      m.emit({ type: 'turn_complete', sessionId: id })
    }
  })

  // If all 200 are rendered into the DOM, virtualization is not working
  const rendered = await page.locator('[data-testid="chat-stream"] [data-index]').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(60)
})

test('Auto-scroll does not interrupt while scrolled up reading (D-1)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  // Injecting **before** the session is created sends events to a session that does not exist
  // yet, so nothing accumulates on screen — there is nothing to scroll and the test spins
  // uselessly. Fill it in only after creating the session.
  await newSession(page, 'alpha', 'long task')
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    // Consecutive deltas merge into one assistant bubble, and a single newline is collapsed into
    // one paragraph by markdown — only a blank line actually breaks the paragraph and makes the
    // screen grow taller
    for (let i = 0; i < 100; i++)
      m.emit({
        type: 'message_delta',
        sessionId: id,
        role: 'assistant',
        text: `line ${i} — this is the conversation content.\n\n`,
      })
  })

  const stream = page.getByTestId('chat-stream')
  // For "scrolled up" to be a meaningful state, the scrollable range must be far larger than the
  // bottom slack (scroll.ts BOTTOM_SLACK=80px) — otherwise even the very top counts as "near the
  // bottom" and following it would be correct, and with zero range scrollTop is always 0, making
  // the check pass vacuously
  await expect.poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(400)
  await stream.evaluate((el) => {
    el.scrollTop = 0
  }) // Scrolled to the very top, reading
  // Virtual scroll can nudge the position slightly right after scrolling, once it measures the
  // actual item sizes — the baseline must be taken only after that correction settles, so this
  // measures the effect of the new message alone
  await expect
    .poll(async () => {
      const now = await stream.evaluate((el) => el.scrollTop)
      await page.waitForTimeout(120)
      return (await stream.evaluate((el) => el.scrollTop)) === now
    })
    .toBe(true)
  const before = await stream.evaluate((el) => el.scrollTop)

  // A new message arriving does not pull the scroll back down
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'new line\n' })
  })
  await page.waitForTimeout(300)
  expect(await stream.evaluate((el) => el.scrollTop)).toBe(before)
})

test('Messages in unfocused sessions are trimmed (D-2 windowing)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'long session')
  await newSession(page, 'alpha', 'another session')

  const longId: string = (
    await page.evaluate(() => Object.keys((window as any).__store.getState().sessions))
  )[0]!
  await page.evaluate((id) => {
    const m = (window as any).__mock
    const store = (window as any).__store
    store.getState().focusSession(id)
    // Deltas merge into one message, so fill it with tool calls, which actually add distinct entries
    for (let i = 0; i < 300; i++) {
      m.emit({
        type: 'tool_call',
        sessionId: id,
        callId: `c${i}`,
        summary: { tool: 'Read', title: `file ${i}`, paths: [] },
      })
    }
  }, longId)

  const before = await page.evaluate((id) => (window as any).__store.getState().chat[id].length, longId)
  expect(before).toBeGreaterThan(100)

  // Switching to another session trims it from memory
  await page.evaluate(() => {
    const store = (window as any).__store
    const ids = Object.keys(store.getState().sessions)
    store.getState().focusSession(ids[1])
  })
  const after = await page.evaluate((id) => (window as any).__store.getState().chat[id].length, longId)
  expect(after).toBeLessThanOrEqual(50)
})

/**
 * Even with a session still running, this window's scroll stays put (dogfooding finding,
 * 2026-09-07: "when I turn on a worktree and the modal gets longer, scrolling it drifts back to
 * the top after a moment").
 *
 * The cause was an inline `ref` callback attached to every row: its identity changed on every
 * render, so React kept detaching and reattaching it, and each time, the selected row called
 * scrollIntoView. This window subscribes to the store, so even one session running re-renders it
 * on every event — which is why the list kept getting pulled back.
 */
test("The new-session window's scroll stays put even while session events keep arriving", async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  const id = await newSession(page, 'alpha', 'work').then(() =>
    page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId),
  )
  // Long enough for the list to overflow the collapsed panel
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.externalSessions = {
      supported: true,
      sessions: Array.from({ length: 30 }, (_, i) => ({
        externalId: `ext-${i}`,
        tool: 'claude',
        title: `past conversation ${i}`,
        updatedAt: Date.now() - i * 60_000,
        createdAt: null,
        branch: null,
        imported: false,
        importedAs: null,
      })),
    }
  })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  const list = page.getByTestId('past-sessions')
  await expect(page.getByTestId('past-ext-0')).toBeVisible()

  const bottom = await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight
    return Math.round(el.scrollTop)
  })
  expect(bottom).toBeGreaterThan(0) // The test only sees something meaningful once it overflows the collapsed panel

  // The session is working — events keep re-rendering the window
  for (let i = 0; i < 3; i++) {
    await page.evaluate(
      (sid: string) =>
        (window as never as { __mock: any }).__mock.emit({
          type: 'message_delta',
          sessionId: sid,
          role: 'assistant',
          text: 'In progress… ',
        }),
      id,
    )
  }
  await page.waitForTimeout(300)
  await expect.poll(async () => list.evaluate((el) => Math.round(el.scrollTop))).toBe(bottom)

  // The arrow-selected row still stays in view — the side that must not be lost while fixing this
  await page.getByTestId('past-new').click()
  await page.keyboard.press('ArrowDown')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="past-sessions"] [aria-pressed="true"]')!
        const row = el.getBoundingClientRect()
        const box = el.parentElement!.getBoundingClientRect()
        return row.top >= box.top - 1 && row.bottom <= box.bottom + 1
      }),
    )
    .toBe(true)
})

/**
 * While reading a long reply, the person should not have to scroll back up to find "what was
 * this answering". Because this is a virtual scroll, CSS sticky cannot be used, so the position
 * is computed from the scroll offset instead — this checks that computation.
 */
test("Scrolling pins the current turn's own message to the top", async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  const input = page.getByTestId('prompt-input')
  // Long enough to create scroll — too short and there would be nothing to scroll past
  await input.fill('first question\n' + 'content\n'.repeat(40))
  await page.getByTestId('send').click()
  // The second one is long too — the content below must exceed one screen for the first to count
  // as "fully scrolled past"
  await input.fill('second question\n' + 'content\n'.repeat(40))
  await page.getByTestId('send').click()
  /*
    And the second question gets an answer much taller than the screen, so that at the bottom
    the last question has fully scrolled past with room to spare: the banner there pins it, and
    there is no next user message for it to step aside from.

    Without the answer, the bottom is no such place. The second question is taller than the
    screen and never fully scrolls past, so the banner there pins the first question and the
    second question crosses it — the banner is stepped aside (`cc-hang-out-up`,
    pointer-events: none). The checks below that need a banner a person can see and click used
    to run there anyway, and passed or failed by timing (2026-10-03, Chromium):
    - the expand check opened it with a DOM click, which ignores pointer-events, and its real
      click was then intercepted by the second question's row. Playwright scrolled the list
      itself looking for a clickable spot — sometimes landing in the ~6px window where the
      banner was back, sometimes far enough that the first question no longer counted as
      scrolled past, the pinned turn changed, and the expanded card was unmounted mid-click
      ("element was detached from the DOM", 3 runs in 40);
    - the shape check measured the banner while it was stepping out, and read a gap from the
      ceiling of -2px (the 6px gap minus the 8px it rises) whenever the exit animation won.
  */
  await page.evaluate(() => {
    const m = (window as any).__mock
    const id = [...m.sessions.keys()][0]
    for (let i = 0; i < 60; i++)
      m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `answer line ${i}\n\n` })
    m.emit({ type: 'turn_complete', sessionId: id })
  })

  const stream = page.getByTestId('chat-stream')
  const banner = page.getByTestId('sticky-user')
  // The banner moves while it enters or steps aside — positions are read only once it holds still
  const bannerAtRest = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) => {
          const card = document.querySelector('[data-testid="sticky-user"] > div')
          void Promise.all((card?.getAnimations() ?? []).map((a) => a.finished.catch(() => {}))).then(() => r())
        }),
    )

  /*
    **Wait for it to settle first.** Right after sending, it is still animating down to the
    bottom — scrolling to the top before that finishes lets the belated auto-scroll pull it back
    down, which would look like "it is at the top, so why is it still pinned" when it was
    actually never at the top.
    (This intermittently failed exactly this way under the full suite.)

    The test takes itself to the bottom rather than waiting for the auto-scroll to get there,
    and waits until the height stops changing — every row measured, nothing left to follow.
    Following is not what this test is about. The answer lands as one burst right behind the
    send, and in WebKit that burst used to make the auto-scroll let go of the bottom on its own
    (2 runs in 30, 914px short): the virtual scroller compensated the answer row from a stale
    offset and put the view 54px up, which read as the person scrolling up. That is fixed and
    guarded on its own in fixtures/auto-follow.ts.
  */
  let lastHeight = -1
  await expect
    .poll(async () => {
      const height = await stream.evaluate((el) => {
        el.scrollTop = el.scrollHeight
        return el.scrollHeight
      })
      const steady = height === lastHeight
      lastHeight = height
      return steady
    })
    .toBe(true)

  /*
    There is nothing to pin at the top (this own message has not scrolled past the top of the
    screen yet).

    **Check only after waiting.** Virtual scroll measures row heights on the next frame, and only
    once that measurement finishes is "what scrolled past the top" settled. Asserting immediately
    can catch a frame before that measurement finishes and fail intermittently (this actually
    happened under the full suite).
  */
  await stream.evaluate((el) => (el.scrollTop = 0))
  await expect(page.getByTestId('sticky-user')).toBeHidden({ timeout: 3000 })

  /*
    Scrolling down pins the own message that has scrolled past — at the bottom, the last one.
    Naming it exactly is not row-height arithmetic: its answer is about three screens tall, so
    no layout change short of a broken one leaves it on screen there. Nothing follows it, so it
    has no reason to step aside. (`data-obscured` lives on the card inside the banner.)
  */
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('second question')
  await expect(banner.locator('[data-obscured="true"]')).toHaveCount(0)

  /*
    **The banner shares the same position and the same width as the chat bubble.**

    Back when it was full width, dogfooding read it as "not flush with the top". Measured, the
    gap from the ceiling was actually 0px (across zoom 0.9-1.2) — what made it look detached was
    shape, not position. A bubble that normally spans 75% on the right suddenly stretching edge
    to edge reads not as my own message but as a tool banner floating below the header. So two
    things are kept as a contract: the right edge matches, and it never exceeds 75%. (Measured
    only after the entrance animation finishes — while it is still moving it sits a few px lower.)
  */
  await bannerAtRest()
  const shape = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="chat-stream"]') as HTMLElement
    const btn = document.querySelector('[data-testid="sticky-user"] button') as HTMLElement
    /*
      The right edge is compared with a rendered bubble, not with the stream's own box. The
      stream's border box includes its scrollbar, which headless Chromium hides but WebKit lays
      out at the 10px that index.css gives it — measured against the box, WebKit reported an
      inset of 10 on every run while the banner and the bubble both ended at x=914.
    */
    const bubble = s.querySelector('[data-index]:not(.invisible) [data-testid="msg-user"]') as HTMLElement
    const cs = getComputedStyle(s)
    const rowWidth = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const b = btn.getBoundingClientRect()
    return {
      gapFromCeiling: Math.round(b.top - s.getBoundingClientRect().top),
      rightInset: Math.round(bubble.getBoundingClientRect().right - b.right),
      widthRatio: b.width / rowWidth,
    }
  })
  /*
    It now **deliberately sits 6px off** (see StickyUser's -top-[10px] comment — pinning it
    flush lost twice to compositor rounding on the actual WKWebView, so this now folds that
    hairline gap into the design spacing instead). The contract is "close to the intended gap
    (4-8px)" — 0 would mean a regression back to flush, and a large value would mean it has
    drifted away.
  */
  expect(shape.gapFromCeiling).toBeGreaterThanOrEqual(4)
  expect(shape.gapFromCeiling).toBeLessThanOrEqual(8)
  expect(shape.rightInset).toBe(0)
  expect(shape.widthRatio).toBeLessThanOrEqual(0.76)

  /*
    The original is hidden while the banner speaks for it (dogfooding finding: "the same message
    shows twice"). Because the banner itself takes up space in the flow and pushes the list down,
    the original — already judged to have "fully scrolled past" — was pushed back down below the
    banner and became visible again. Hiding it via visibility keeps its spot in layout while
    keeping it invisible.

    This scrolls down little by little to find the point where the banner picks up "the first
    question" — at that point the original row is still rendered at the screen's edge (overscan),
    so both can be observed together.
  */
  /*
    Scrolling in small increments does not work: a row not yet measured is positioned by an
    estimated height until it enters view, at which point it switches to a measured height and
    every coordinate below it shifts — if polling catches that moment, "pinned" flips to "not
    pinned" one frame later (this actually happened). Having just visited the bottom, every row
    is already measured, so this jumps straight there using that final geometry.
  */
  await stream.evaluate((el) => (el.scrollTop = 0))
  const q1End = await stream.evaluate((el) => {
    const rows = [...el.querySelectorAll('div[data-index]')] as HTMLElement[]
    const row = rows.find((r) => (r.textContent ?? '').includes('first question'))!
    // The row's place in the list (rows are placed with `top`, #364)
    return row.offsetTop + row.offsetHeight
  })
  // +80: comfortably covers the banner taking up space in the flow and pushing the list down by
  // its own height
  await stream.evaluate((el, y) => (el.scrollTop = y + 80), q1End)
  await expect(page.getByTestId('sticky-user')).toContainText('first question')
  // When the next user question rises to the banner's spot, the banner retreats upward before it
  // covers that question.
  await expect(page.getByTestId('sticky-user').locator('[data-obscured="true"]')).toHaveClass(
    /cc-hang-out-up/,
  )
  // The original row is still rendered at the screen's edge (overscan) — rendered but must remain
  // invisible
  await expect
    .poll(() =>
      stream.evaluate((el) => {
        const rows = [...el.querySelectorAll('div[data-index]')] as HTMLElement[]
        const row = rows.find((r) => (r.textContent ?? '').includes('first question'))
        return row ? getComputedStyle(row).visibility : 'gone'
      }),
    )
    .toBe('hidden')

  /*
    Clicking it expands — the full text appears **layered on top of** the collapsed row. Growing
    its height within the flow would shift every virtual-scroll coordinate below it, so the
    collapsed row's own position must stay exactly where it was.
  */
  // At the bottom again: the last question is pinned, nothing below it to step aside for
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(banner).toContainText('second question')
  await expect(banner.locator('[data-obscured="true"]')).toHaveCount(0)
  /*
    Real clicks, not DOM clicks: what is kept is that a person can click it. They wait for the
    banner's entrance animation to end — a click started while it ran had Playwright's
    scroll-into-view step move the list itself (in WebKit 249-504px up, 6 runs in 6, 1-3ms
    before the pointerdown), which no person's click does.
  */
  await bannerAtRest()
  const settledTop = await stream.evaluate((el) => el.scrollTop)
  const collapsed = banner.getByRole('button').first()
  const collapsedBox = (await collapsed.boundingBox())!
  await collapsed.click()
  const expanded = page.getByTestId('sticky-user-expanded')
  await expect(expanded).toBeVisible()
  // Multiple lines expanded (clearly taller than the one collapsed line), and the collapsed row's
  // position did not change
  expect((await expanded.boundingBox())!.height).toBeGreaterThan(collapsedBox.height * 2)
  // Approximate, not exact — WebKit reported the same row as 39.125 vs 39.12499237, causing flakes
  // (measured twice)
  expect((await collapsed.boundingBox())!.height).toBeCloseTo(collapsedBox.height, 1)
  // Clicking it again collapses it
  await expanded.click()
  await expect(page.getByTestId('sticky-user-expanded')).toBeHidden()
  /*
    Neither click moved the list. If one had, Playwright had to scroll to find something
    clickable, and a pass would mean only that its scrolling got lucky — the way this test
    used to pass.
  */
  expect(await stream.evaluate((el) => el.scrollTop)).toBe(settledTop)
})

/**
 * Staying pinned to the bottom follows a streaming reply down as it grows.
 *
 * Streaming has **a fixed item count with the last item growing.** So using the item count as
 * the yardstick freezes the screen while the reply grows longer — only the total height brings
 * both cases under one measure.
 *
 * Note: on the mock, this test **also passes with the old, buggy logic.** The browser's scroll
 * anchoring appears to mask it. So this is not a net that catches the regression — it records
 * the "follows it down" contract, and the actual symptom has to be confirmed in the real app.
 */
test('Staying at the bottom follows a growing reply down', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')

  const stream = page.getByTestId('chat-stream')
  await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))

  // Only one item keeps growing — the count stays the same
  // Long enough to reliably overflow the screen — without overflow there is no scroll and the
  // check means nothing
  for (let i = 0; i < 150; i++) {
    await page.evaluate((n) => {
      const s = (window as any).__store.getState()
      ;(window as any).__mock.emit({
        type: 'message_delta',
        sessionId: s.focusedSessionId,
        role: 'assistant',
        text: `line ${n}\n`,
      })
    }, i)
  }

  await expect
    .poll(async () => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
      timeout: 3000,
    })
    .toBeLessThan(40)
})

/** The row at the top edge of the conversation and how far into it the edge is: what is being read (#61) */
type Spot = { index: number; into: number }

function readingSpot(stream: Locator): Promise<Spot> {
  return stream.evaluate((el) => (window as any).__readingSpot(el))
}

/**
 * Runs `act`, which leaves the conversation and comes back to it, and returns the spot the
 * conversation shows **at the moment it is shown again** (#61).
 *
 * Returning hides the list (`data-settling`) while it aims at the row it left, and shows it once
 * it is there. The spot is read in the same task that shows it, by a MutationObserver, so a list
 * shown short of the spot and corrected a few frames later is caught: that is what a person
 * would see. Read any later and the correction has already happened. The page's own observer
 * also outlives the grid rebuilding the panel, which a locator taken before would not.
 */
async function spotWhenShown(page: Page, sessionId: string, act: () => Promise<void>): Promise<Spot> {
  await page.evaluate((sid) => {
    const w = window as any
    w.__shownAt = undefined
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement
        // The focus view's list, showing this session, going from hidden to shown. Not a grid
        // panel's list, which settles on its own, nor another session's
        if (w.__shownAt || el.dataset.testid !== 'chat-stream' || el.closest('[data-testid="grid"]')) continue
        if (r.oldValue !== 'true' || el.dataset.settling === 'true') continue
        if (w.__store.getState().focusedSessionId !== sid) continue
        w.__shownAt = w.__readingSpot(el)
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-settling'] })
  }, sessionId)
  await act()
  // A list that never hides to settle never went back to a row at all (the #61 bug itself)
  const shown = await page.waitForFunction(() => (window as any).__shownAt, undefined, { timeout: 10_000 }).catch(() => {
    throw new Error('the conversation was never hidden to settle and shown again: it did not go back to the row being read')
  })
  return (await shown.jsonValue()) as Spot
}

/** Puts `__readingSpot` on the page, for `readingSpot` and `spotWhenShown` */
async function installReadingSpot(page: Page) {
  await page.evaluate(() => {
    ;(window as any).__readingSpot = (el: HTMLElement) => {
      const top = el.getBoundingClientRect().top
      const row = [...el.querySelectorAll<HTMLElement>('[data-index]')].find((r) => {
        const b = r.getBoundingClientRect()
        return b.top <= top && b.bottom > top
      })
      return row ? { index: Number(row.dataset.index), into: Math.round(top - row.getBoundingClientRect().top) } : { index: -1, into: 0 }
    }
  })
}

/**
 * Wheel up until the list has left the bottom, and return where it comes to rest (#424).
 *
 * Two things WebKit does that Chromium does not show. Playwright's WebKit can deliver the first
 * wheel after the pointer arrives without scrolling anything, so one wheel is not a promise of a
 * scroll. And the list keeps moving after the wheel: the rows it brought in measure taller than
 * the virtualiser's guess and the offset is corrected by as much (measured: 4,863 read at once,
 * 5,944 half a second later). The spot being read is where it rests.
 *
 * 1,000px a wheel, not more: a wheel that did not scroll at once can still arrive, so the poll
 * can land two. At 3,000 a wheel, two took the 6,830px list of the session-switching scenario to
 * its very top in macOS WebKit, where that scenario then compared nothing with nothing.
 */
async function wheelUpToRead(page: Page, stream: Locator): Promise<number> {
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -1000)
      return distanceFromBottom(stream)
    })
    .toBeGreaterThan(80)
  let last = -1
  await expect
    .poll(
      async () => {
        const now = await stream.evaluate((el) => el.scrollTop)
        const still = now === last
        last = now
        return still
      },
      { intervals: [250] },
    )
    .toBe(true)
  return last
}

/**
 * #61: on returning, it must be **the spot being read** — "it was not the bottom" is not enough.
 *
 * What #31 guaranteed only went as far as "does not pull you down to the bottom". But since
 * nothing was preserved, the browser started the new element at scrollTop 0, so the result was
 * always **the very top** — leaving mid-read in an 80-turn conversation and coming back landed
 * right at the beginning. Now, on leaving, the row (seq) straddling the top of the screen is
 * recorded, and returning scrolls back to that row.
 */
test('Returns to the spot being read — not the top (#61)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'work')
  const id = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, id)
  await installReadingSpot(page)

  const stream = page.getByTestId('chat-stream')
  // Scroll up to somewhere in the middle to read (the bug only lives in a spot that is neither
  // the bottom nor the top)
  await stream.hover()
  expect(await wheelUpToRead(page, stream)).toBeGreaterThan(200)
  const reading = await readingSpot(stream)

  // Leave the screen and come back (the grid discards the panel entirely and rebuilds it). The
  // intermediate position is never drawn while settling — it stays hidden while being measured
  const shown = await spotWhenShown(page, id, async () => {
    await page.getByTestId('grid-button').click()
    await expect(page.getByTestId('grid')).toBeVisible()
    await page.getByTestId(`session-row-${id}`).click()
  })

  // The same row at the top, the same distance into it. A row, not a scrollTop: the rows above
  // it can be measured differently on the way back (a row not on screen keeps the 64px guess), so
  // the same spot can sit at a different offset — 4,357 before and 2,975 after, with the same row
  // and the same 49px into it, in CI's Chromium
  expectSameSpot(shown, reading)
})
/**
 * The same thing happens without the grid too (pointed out by the person): even just switching
 * sessions in the focus view reuses the same component with only sessionId swapped, so without
 * something preserved, the position is lost.
 */
test('Switching sessions and returning keeps the spot being read (#61)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'first')
  const a = await page.evaluate(() => (window as any).__store.getState().focusedSessionId)
  await seedLongChat(page, a)
  await newSession(page, 'alpha', 'second')
  await installReadingSpot(page)

  await page.getByTestId(`session-row-${a}`).click()
  const stream = page.getByTestId('chat-stream')
  await stream.hover()
  expect(await wheelUpToRead(page, stream)).toBeGreaterThan(200)
  const reading = await readingSpot(stream)

  // Visit a neighboring session and come back — the screen type stays the same, only sessionId
  // changes. What the person sees is the list once it shows: it stays hidden while it settles
  const b = await page.evaluate(
    (aId: string) => Object.keys((window as any).__store.getState().sessions).find((x) => x !== aId),
    a,
  )
  const shown = await spotWhenShown(page, a, async () => {
    await page.getByTestId(`session-row-${b}`).click()
    await page.getByTestId(`session-row-${a}`).click()
  })
  expectSameSpot(shown, reading)
})

/** The same row at the top, within a couple of pixels of the same place in it (#61) */
function expectSameSpot(shown: Spot, reading: Spot) {
  expect(reading.index, 'a row is at the top before leaving').toBeGreaterThan(0)
  expect(shown.index, `shown at row ${shown.index} (${shown.into}px in), left at row ${reading.index} (${reading.into}px in)`).toBe(reading.index)
  expect(Math.abs(shown.into - reading.into)).toBeLessThanOrEqual(2)
}

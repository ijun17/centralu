import { expect, test, type Page } from '@playwright/test'

/**
 * Measured input latency (dogfooding finding: "the composer feels a bit laggy").
 *
 * What is measured is **the cost of a single keystroke**: from the moment an input event is
 * dispatched to the moment React finishes render, commit and layout and dispatch returns.
 *
 * Measured across varying conversation lengths. If the draft lives in the global store such that
 * the whole session view re-renders on every keystroke, this number **grows as the conversation
 * grows** — there is no reason the composer's cost should scale with the size of the conversation,
 * so that slope is itself the evidence.
 *
 * What this harness first answered was not timing but **who re-renders**. Planting a temporary
 * render counter and measuring per keystroke:
 *   before  pane=1.0  stream=1.0  row=2.0   (pane=2.0 row=4.5 while a response streams)
 *   after   composer=1.0, everything else 0  (composer=1.0 even while a response streams)
 * The timing (p50 1–2ms) is measured at this screen size and this amount of markdown, so it is
 * not a ceiling — what was cut down is "the cost that used to grow along with the conversation."
 *
 * No threshold is set (same reason as perf-idle) — what comes out of this is a number.
 *   PERF=1 pnpm e2e perf-typing --workers=1
 *
 * Measured on WebKit — the real app is WKWebView.
 */
test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })

test.beforeEach(() => {
  test.skip(!process.env.PERF, 'Only when PERF=1')
})

type Sample = { p50: number; p95: number; max: number; commits: number; keys: number }

const show = (label: string, s: Sample) =>
  console.log(
    `${label.padEnd(30)} p50=${s.p50.toFixed(2)}ms  p95=${s.p95.toFixed(2)}ms  max=${s.max.toFixed(2)}ms  commits/key=${(s.commits / s.keys).toFixed(1)}`,
  )

async function boot(page: Page): Promise<string> {
  // The hook has to attach before React does, or commits go unseen (same approach as perf-idle)
  await page.addInitScript(() => {
    const w = window as never as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
    w.__commits = 0
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      supportsFlight: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      sub: () => {},
      on: () => {},
      off: () => {},
      emit: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: () => {
        w.__commits += 1
      },
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      setStrictMode: () => {},
    }
  })

  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-alpha')).toBeVisible()

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await page.getByTestId('prompt-input').fill('start')
  await page.getByTestId('prompt-input').press('Enter')
  return page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId)
}

/**
 * Fills the conversation.
 *
 * Makes each turn **the size of an actual response** (~1.5KB, including a code block). Filling it
 * with short one-liners would make markdown parsing nearly free no matter how many lines are on
 * screen, hiding the true cost of a re-render — what a person actually experiences is a screen
 * filled with a few long responses.
 */
async function fill(page: Page, id: string, turns: number) {
  await page.evaluate(
    ({ id, turns }: { id: string; turns: number }) => {
      const m = (window as never as { __mock: any }).__mock
      const body = Array.from(
        { length: 12 },
        (_, k) =>
          `Paragraph ${k}. A fairly long line mixing \`inline code\` and a [link](https://example.com). A real reply runs about this long.`,
      ).join('\n\n')
      const code = Array.from({ length: 20 }, (_, k) => `  const value${k} = compute(${k}, options)`).join(
        '\n',
      )
      for (let i = 0; i < turns; i++) {
        m.emit({
          type: 'message_delta',
          sessionId: id,
          role: 'assistant',
          text: `## Turn ${i}\n\n${body}\n\n- item 1\n- item 2\n- item 3\n\n\`\`\`ts\nfunction turn${i}() {\n${code}\n}\n\`\`\`\n`,
        })
        m.emit({ type: 'turn_complete', sessionId: id })
      }
    },
    { id, turns },
  )
  await page.waitForTimeout(300)
}

/**
 * Enters characters one at a time and measures **until that frame is painted**.
 *
 * Why this measures in-page instead of using Playwright's typing: keyboard.type mixes in CDP
 * round trips whose noise is larger than the interval being measured (React render + layout +
 * paint). What React actually listens for is a native setter plus an input event, so this takes
 * the same path as real typing.
 */
async function typeAndMeasure(page: Page, keys: number): Promise<Sample> {
  await page.getByTestId('prompt-input').click()
  return page.evaluate(async (keys: number) => {
    const w = window as never as { __commits: number }
    const el = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const times: number[] = []
    w.__commits = 0
    for (let i = 0; i < keys; i++) {
      const t0 = performance.now()
      setter.call(el, el.value + 'a')
      /*
       * The interval measured ends right here: React flushes a discrete event like input
       * **synchronously**, so by the time dispatch returns, render, commit, and
       * useLayoutEffect (measuring height) are all finished. Waiting for rAF instead would
       * flatten the number against the screen's refresh rate (16.7ms) and hide the very size
       * of the work being cut down.
       */
      el.dispatchEvent(new Event('input', { bubbles: true }))
      times.push(performance.now() - t0)
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }
    times.sort((a, b) => a - b)
    const at = (q: number) => times[Math.min(times.length - 1, Math.floor(times.length * q))] ?? 0
    return { p50: at(0.5), p95: at(0.95), max: times[times.length - 1] ?? 0, commits: w.__commits, keys }
  }, keys)
}

/**
 * Types while a response is streaming — this is the moment that actually feels laggy.
 *
 * Typing the next instruction while the agent is still talking is routine for this app, and at
 * that moment the screen is already re-rendering continuously because of the streaming. The cost
 * of typing sits on top of that.
 */
async function stream(page: Page, id: string, on: boolean) {
  await page.evaluate(
    ({ id, on }: { id: string; on: boolean }) => {
      const w = window as never as { __streamTimer?: number; __mock: any }
      if (!on) {
        clearInterval(w.__streamTimer)
        w.__streamTimer = undefined
        return
      }
      w.__mock.emit({ type: 'state_change', sessionId: id, state: 'working' })
      w.__streamTimer = setInterval(() => {
        w.__mock.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: 'a streaming reply chunk. ' })
      }, 30) as never as number
    },
    { id, on },
  )
}

test('what does typing one character cost', async ({ page }) => {
  test.setTimeout(180000)
  const id = await boot(page)

  show('conversation, 0 turns', await typeAndMeasure(page, 40))

  await fill(page, id, 50)
  show('conversation, 50 turns', await typeAndMeasure(page, 40))

  await fill(page, id, 150)
  show('conversation, 200 turns', await typeAndMeasure(page, 40))

  await fill(page, id, 200)
  show('conversation, 400 turns', await typeAndMeasure(page, 40))

  await stream(page, id, true)
  await page.waitForTimeout(500)
  show('conversation, 400 turns · reply streaming', await typeAndMeasure(page, 40))
  await stream(page, id, false)
})

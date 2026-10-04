import { expect, test, type Page } from '@playwright/test'

/**
 * Measured grid performance (plan step 7).
 *
 * Spec §5.4: "The focus-view structure also helps performance — rendering only one session on
 * screen keeps the steady-state render load lower than a grid's." This measures whether that
 * claim holds, and if so, by how much.
 *
 * What is measured is **frames**. A person cannot feel total elapsed time, but a dropped frame is
 * felt immediately. Is the screen smooth while a response streams, and can the person type while
 * it does.
 */

test.describe.configure({ mode: 'serial' })

/*
 * Not part of the default e2e suite. The measured values depend on machine state, so setting a
 * threshold would eventually turn red for the wrong reason — what comes out of this is not a
 * pass/fail but **a number**.
 *   pnpm perf
 */
test.beforeEach(() => {
  test.skip(!process.env.PERF, 'Only when PERF=1 — `pnpm perf`')
})

type Result = {
  frames: number
  p50: number
  p95: number
  max: number
  janky: number
  heapMB: number | null
  /** Whether it actually got painted to the screen — if this is false, every number above is meaningless */
  painted: boolean
  /** How much longer the last item grew (characters) */
  grew: number
}

async function boot(page: Page, count: number): Promise<string[]> {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  // The first project is registered as the way out of the empty orchestrator screen (#63)
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.nextPickedDirectory = '/tmp/alpha'
  })
  await page.getByTestId('orchestrator-pick-folder').click()
  // Registering a project the first time leads straight into creating a session — this test
  // only needs the project, so close it
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-alpha')).toBeVisible()

  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    await page.getByTestId('project-menu-alpha').click()
    await page.getByTestId('new-session-alpha').click()
    await page.getByTestId('create-session-confirm').click()
    await expect(page.getByTestId('new-session-dialog')).toBeHidden()
    // The first instruction goes through the composer, not the modal — the dialog has no prompt field (#8)
    await page.getByTestId('prompt-input').fill(`session ${i}`)
    await page.getByTestId('prompt-input').press('Enter')
    ids.push(await page.evaluate(() => (window as never as { __store: any }).__store.getState().focusedSessionId))
  }

  // An empty session is not realistic — seed each session with a 200-line conversation
  await page.evaluate((list: string[]) => {
    const store = (window as never as { __store: any }).__store
    const chat: Record<string, unknown[]> = {}
    for (const id of list) {
      chat[id] = Array.from({ length: 200 }, (_, i) => ({
        kind: i % 2 ? 'assistant' : 'user',
        seq: 1000 + i,
        text: `past message ${i} `.repeat(8),
      }))
    }
    store.setState({ chat })
  }, ids)

  return ids
}

/**
 * Streams a delta to each of the `streaming` sessions every frame while measuring the gap between
 * frames. The rhythm matches real streaming — dumping everything in at once would let React batch
 * it, and the measurement would become a lie.
 */
async function streamAndMeasure(page: Page, streaming: string[], frames: number): Promise<Result> {
  return page.evaluate(
    async ({ ids, n }: { ids: string[]; n: number }) => {
      const mock = (window as never as { __mock: any }).__mock
      const gaps: number[] = []
      let last = performance.now()

      await new Promise<void>((done) => {
        let i = 0
        const tick = () => {
          const now = performance.now()
          gaps.push(now - last)
          last = now
          for (const id of ids) {
            mock.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `token${i} ` })
          }
          i++
          if (i < n) requestAnimationFrame(tick)
          else done()
        }
        requestAnimationFrame(tick)
      })

      /*
       * Checks that the measurement is not a lie.
       * If the screen never actually changed, frames are smooth by definition —
       * only checking that the last token is in the DOM turns this into "smooth while actually painting."
       */
      const painted = document.body.innerText.includes(`token${n - 1}`)
      const store = (window as never as { __store: any }).__store
      const grew = (store.getState().chat[ids[0]!] ?? []).at(-1)?.text?.length ?? 0

      const sorted = [...gaps].sort((a, b) => a - b)
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      return {
        frames: gaps.length,
        p50: Math.round(at(0.5) * 10) / 10,
        p95: Math.round(at(0.95) * 10) / 10,
        max: Math.round(Math.max(...gaps) * 10) / 10,
        // Above 32ms means at least one dropped frame at a 60fps baseline
        janky: gaps.filter((g) => g > 32).length,
        heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        painted,
        grew,
      }
    },
    { ids: streaming, n: frames },
  )
}

const show = (label: string, r: Result) =>
  console.log(
    `${label.padEnd(34)} p50=${String(r.p50).padStart(5)}ms  p95=${String(r.p95).padStart(6)}ms  max=${String(r.max).padStart(6)}ms  skipped=${String(r.janky).padStart(3)}/${r.frames}  heap=${r.heapMB}MB  painted=${r.painted}  +${r.grew} chars`,
  )

test('1 focus view (baseline)', async ({ page }) => {
  const ids = await boot(page, 1)
  await page.getByTestId(`session-row-${ids[0]}`).click()
  show('Focus view · 1 streaming', await streamAndMeasure(page, ids, 120))
})

test('grid, 4 panels, all streaming', async ({ page }) => {
  const ids = await boot(page, 4)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[3]}`)).toBeVisible()
  show('Grid 4 panels · 4 streaming', await streamAndMeasure(page, ids, 120))
})

test('grid, 9 panels, all streaming', async ({ page }) => {
  const ids = await boot(page, 9)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toBeVisible()
  show('Grid 9 panels · 9 streaming', await streamAndMeasure(page, ids, 120))
})

test('grid, 9 panels, only 1 streaming (the steady-state load from §5.4)', async ({ page }) => {
  const ids = await boot(page, 9)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toBeVisible()
  show('Grid 9 panels · only 1 streaming', await streamAndMeasure(page, [ids[0]!], 120))
})

test('can the person type while 9 panels are streaming', async ({ page }) => {
  const ids = await boot(page, 9)
  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toBeVisible()

  // Let all 9 keep streaming in the background
  await page.evaluate((l: string[]) => {
    const mock = (window as never as { __mock: any }).__mock
    const w = window as never as { __stop?: () => void }
    let on = true
    let i = 0
    const tick = () => {
      if (!on) return
      for (const id of l) mock.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: `token${i++} ` })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    w.__stop = () => (on = false)
  }, ids)

  const box = page.getByTestId(`grid-panel-${ids[0]}`).getByTestId('prompt-input')
  await box.click()
  const t0 = Date.now()
  await box.pressSequentially('key test', { delay: 0 })
  const typed = Date.now() - t0
  const value = await box.inputValue()

  await page.evaluate(() => (window as never as { __stop?: () => void }).__stop?.())
  console.log(`typing: 8 chars in ${typed}ms (${Math.round(typed / 8)}ms/char), value="${value}"`)
  expect(value).toBe('key test')
})

/**
 * The moment panels are first opened.
 *
 * Each panel was made to load its own transcript, so opening 9 panels at once means 9 loads. How
 * long that moment takes — this is where this change raised the stakes.
 */
test('time to first open 9 panels', async ({ page }) => {
  const ids = await boot(page, 9)

  // Storage has the transcript and nothing is loaded on screen yet (right after the app starts)
  await page.evaluate((list: string[]) => {
    const mock = (window as never as { __mock: any }).__mock
    for (const id of list) {
      mock.messages.set(
        id,
        Array.from({ length: 200 }, (_, i) => ({
          sessionId: id, seq: i + 1, role: i % 2 ? 'assistant' : 'user',
          kind: 'text', payload: { text: `saved message ${i} `.repeat(8) }, ts: 0,
        })),
      )
    }
    const store = (window as never as { __store: any }).__store
    store.setState({ chat: {} })
    store.getState().setGridPanels(list.map((sessionId: string) => ({ kind: 'session', sessionId })))
  }, ids)

  const t0 = Date.now()
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[8]}`)).toContainText('saved message')
  const opened = Date.now() - t0

  const loadedCount = await page.evaluate(
    (list: string[]) => list.filter((id) => (window as never as { __store: any }).__store.getState().chat[id]?.length).length,
    ids,
  )
  console.log(`first open of 9 panels: ${opened}ms, panels with loaded conversation ${loadedCount}/9`)
  expect(loadedCount).toBe(9)
})

/**
 * Does it slow down as a conversation grows longer — the answer to "would trimming the top off
 * in the UI help."
 *
 * It already trims in three layers: an unfocused session is capped at 50 items (WINDOW_SIZE), the
 * transcript is read in windows of 200, and virtual scroll only renders the visible rows. Even so,
 * whether **list length itself** is a cost can only be known by measuring it.
 */
/**
 * Dragging a panel now reflows the whole grid on every dragover (#53) — every hover is a
 * reorder of N keyed panes, each holding a real conversation. The issue's condition for
 * shipping was that this holds up at the panel counts we actually run: 4 / 6 / 9.
 *
 * A dragover is dispatched every frame on a cycling target, alternating left/right halves
 * so *every* event produces a different order — the worst case; a human hand reorders far
 * less often. `reorders` counts the frames where the on-screen order actually changed:
 * if it stays 0 the grid never moved and the frame numbers next to it are meaningless.
 */
for (const n of [4, 6, 9]) {
  test(`drag reflow with ${n} panels`, async ({ page }) => {
    const ids = await boot(page, n)
    await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
    await page.getByTestId('grid-button').click()
    await expect(page.getByTestId(`grid-panel-${ids[n - 1]}`)).toBeVisible()

    const r = await page.evaluate(
      ({ list, frames }: { list: string[]; frames: number }) =>
        new Promise<{ p50: number; p95: number; max: number; janky: number; frames: number; reorders: number }>((done) => {
          const dt = new DataTransfer()
          document
            .querySelector(`[data-testid="grid-panel-${list[0]}"] [data-testid="pane-header"]`)!
            .dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))

          const gaps: number[] = []
          let last = performance.now()
          let reorders = 0
          let prevOrder = ''
          let i = 0
          const domOrder = () =>
            [...document.querySelectorAll<HTMLElement>('[data-testid^="grid-panel-"]')].map((el) => el.dataset.testid).join()
          const tick = () => {
            const now = performance.now()
            gaps.push(now - last)
            last = now
            const target = list[1 + (i % (list.length - 1))]!
            const card = document.querySelector(`[data-testid="grid-panel-${target}"]`)!
            const rect = card.getBoundingClientRect()
            const x = i % 2 ? rect.left + rect.width * 0.8 : rect.left + rect.width * 0.2
            card.dispatchEvent(
              new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: rect.top + rect.height / 2 }),
            )
            const order = domOrder()
            if (order !== prevOrder) {
              if (prevOrder) reorders++
              prevOrder = order
            }
            if (++i < frames) requestAnimationFrame(tick)
            else {
              document
                .querySelector(`[data-testid="grid-panel-${list[0]}"] [data-testid="pane-header"]`)!
                .dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
              const sorted = [...gaps].sort((a, b) => a - b)
              const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
              done({
                p50: Math.round(at(0.5) * 10) / 10,
                p95: Math.round(at(0.95) * 10) / 10,
                max: Math.round(Math.max(...gaps) * 10) / 10,
                janky: gaps.filter((g) => g > 32).length,
                frames: gaps.length,
                reorders,
              })
            }
          }
          requestAnimationFrame(tick)
        }),
      { list: ids, frames: 120 },
    )
    console.log(
      `drag reflow ${n} panels: p50=${r.p50}ms p95=${r.p95}ms max=${r.max}ms skipped=${r.janky}/${r.frames} reorders=${r.reorders}`,
    )
    expect(r.reorders).toBeGreaterThan(0)
  })
}

for (const n of [200, 5000]) {
  test(`streaming with a ${n}-line conversation`, async ({ page }) => {
    const ids = await boot(page, 1)
    await page.evaluate(
      ({ sid, count }: { sid: string; count: number }) => {
        const store = (window as never as { __store: any }).__store
        const items = Array.from({ length: count }, (_, i) => ({
          kind: i % 2 ? 'assistant' : 'user', seq: 1000 + i, text: `past message ${i} `.repeat(8),
        }))
        store.setState({ chat: { ...store.getState().chat, [sid]: items } })
      },
      { sid: ids[0]!, count: n },
    )
    await page.getByTestId(`session-row-${ids[0]}`).click()
    show(`Focus view · ${n} lines of conversation`, await streamAndMeasure(page, ids, 120))
  })
}

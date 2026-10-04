import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

/**
 * Measured steady-state render load (dogfooding finding: "the battery drains fast").
 *
 * This measures not streaming but **doing nothing at all**. Cost while a response is streaming is
 * the cost of real work, but cost while sitting idle is pure waste — and on a laptop that waste
 * gets billed to the battery.
 *
 * Three things are watched together:
 *  - React commit count: if commits keep running while state is quiet, a timer is hiding somewhere
 *  - Running animation count: an infinite CSS animation keeps repainting the screen with no commit at all
 *  - Total browser-process CPU: what the two above actually cost in practice (measured with top)
 *
 * Measured on WebKit — the real app is WKWebView. In particular, cc-orbit rotates a
 * conic-gradient angle through a registered CSS variable, and this is suspected of being unable
 * to offload to the compositor, forcing a main-thread repaint every frame. The numbers here are
 * the verdict on that suspicion.
 *
 * No threshold is set (same reason as perf-grid) — what comes out of this is **a number**.
 *   pnpm perf
 */

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })

test.beforeEach(() => {
  test.skip(!process.env.PERF, 'Only when PERF=1 — `pnpm perf`')
})

/** Every WebKit process under ms-playwright (UIProcess, WebContent, GPU, Networking) */
function webkitPids(): number[] {
  const out = execSync('ps -Ao pid,command').toString()
  return out
    .split('\n')
    .filter((l) => l.includes('ms-playwright') && /[Ww]eb[Kk]it|Playwright/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n))
}

/**
 * Measures interval CPU with top. The first sample is dropped, since it is a cumulative figure
 * since boot. ps's %cpu is a decaying average and cannot keep up with scenario changes, so top's
 * interval value is used instead.
 */
function cpuOver(seconds: number, pids: number[]): number {
  const out = execSync(`top -l ${seconds + 1} -s 1 -stats pid,cpu,command`, {
    maxBuffer: 32 * 1024 * 1024,
  }).toString()
  const blocks = out.split(/Processes:/).slice(2) // drops the first block (cumulative)
  const wanted = new Set(pids)
  let total = 0
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+(?:\.\d+)?)/)
      if (m && wanted.has(Number(m[1]))) total += Number(m[2])
    }
  }
  return blocks.length ? total / blocks.length : 0
}

type Sample = { commits: number; perSec: number; animations: number; cpu: number }

/** Counts commits over the interval, and measures CPU for that same interval from outside */
async function measure(page: Page, seconds: number): Promise<Sample> {
  const pids = webkitPids()
  await page.evaluate(() => {
    ;(window as never as { __commits: number }).__commits = 0
  })
  // While the (synchronous) CPU measurement runs, the page keeps doing whatever it does
  const cpu = cpuOver(seconds, pids)
  const { commits, animations } = await page.evaluate(() => ({
    commits: (window as never as { __commits: number }).__commits,
    animations: document.getAnimations().length,
  }))
  return { commits, perSec: Math.round((commits / seconds) * 10) / 10, animations, cpu: Math.round(cpu * 10) / 10 }
}

const show = (label: string, s: Sample) =>
  console.log(
    `${label.padEnd(34)} commits=${String(s.commits).padStart(4)} (${String(s.perSec).padStart(5)}/s)  anims=${String(s.animations).padStart(2)}  cpu=${String(s.cpu).padStart(6)}%`,
  )

async function boot(page: Page, count: number): Promise<string[]> {
  // The hook has to attach before React does, or commits go unseen
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
  return ids
}

/** State changes go through the real path (events) — the same flow the app actually goes through */
async function setStates(page: Page, ids: string[], state: 'idle' | 'working') {
  await page.evaluate(
    ({ list, s }: { list: string[]; s: string }) => {
      const mock = (window as never as { __mock: any }).__mock
      for (const id of list) mock.emit({ type: 'state_change', sessionId: id, state: s })
    },
    { list: ids, s: state },
  )
}

test('how much does the app spend while sitting idle', async ({ page }) => {
  test.setTimeout(120000)
  const ids = await boot(page, 4)

  // Sessions become working the moment they are created (the initial prompt) — start from a quiet baseline
  await setStates(page, ids, 'idle')
  await page.waitForTimeout(500)
  show('Focus view · all 4 idle', await measure(page, 8))

  await setStates(page, ids, 'working')
  await page.waitForTimeout(500)
  show('Focus view · all 4 working', await measure(page, 8))

  await page.evaluate((l: string[]) => (window as never as { __store: any }).__store.getState().setGridPanels(l.map((sessionId: string) => ({ kind: 'session', sessionId }))), ids)
  await page.getByTestId('grid-button').click()
  await expect(page.getByTestId(`grid-panel-${ids[3]}`)).toBeVisible()
  await page.waitForTimeout(500)
  show('Grid, 4 panels · all 4 working', await measure(page, 8))

  // What remains once only animations are turned off — the remainder is what timers and re-renders account for
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important }' })
  await page.waitForTimeout(500)
  show('Grid, 4 panels · working · animations off', await measure(page, 8))

  await setStates(page, ids, 'idle')
  await page.waitForTimeout(500)
  show('Grid, 4 panels · all 4 idle', await measure(page, 8))
})

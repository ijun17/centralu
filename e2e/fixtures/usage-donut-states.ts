import { expect, test, type Locator, type Page } from '@playwright/test'
import { setup } from './control.js'

/**
 * What a usage donut's ring says (#1616, owner 2026-10-26): a tool whose usage Centralu cannot read at all
 * (`agents.usage` answers `supported: false` with `notReported`) has a plain, dimmed, solid ring and its letter at full ink; a usage that is
 * unknown for now (`supported: true`, no weekly window, a read that failed, or a host that predates the mark) keeps its dashed ring and faint
 * letter. A function, because it runs in Chromium and in WebKit: the desktop app is WKWebView.
 *
 * The mock answers per tool (`toolUsage`), so which donut is unsupported is the flag in the answer. Codex stands for
 * the tool that cannot report limits, on purpose: nothing on the screen may know a tool's name for this.
 */

type MockWindow = { __mock: any; __store: any }

const WEEKLY = (percent: number) => ({
  supported: true,
  usage: { plan: 'max', windows: [{ id: 'weekly_all', label: 'Weekly', percent, resetsAt: null, scope: null }], daily: [] },
})
const UNKNOWN = { supported: true, usage: { plan: 'max', windows: [], daily: [] } }
const UNSUPPORTED = { supported: false, reason: 'Codex does not report usage limits', notReported: true, usage: null }

/** The host connection dropping and coming back: the moment every donut asks again */
async function reconnect(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
  await expect(page.getByTestId('connection')).toBeVisible()
  await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
  await expect(page.getByTestId('connection')).toHaveCount(0)
}

/** Sets what the mock answers for each tool, then makes the donuts ask again */
async function answer(page: Page, tools: Record<string, unknown>): Promise<void> {
  await page.evaluate((t) => {
    ;(window as unknown as MockWindow).__mock.toolUsage = t
  }, tools)
  await reconnect(page)
}

const donut = (page: Page, id: string): Locator => page.getByTestId(`usage-donut-${id}`)
const ring = (d: Locator, which: 'dashed' | 'solid' | 'dim' | 'fill'): Locator => d.locator(`circle[data-ring="${which}"]`)
const opacity = (l: Locator): Promise<number> => l.evaluate((el) => Number(getComputedStyle(el).opacity))
const letter = (d: Locator): Promise<string> => d.locator('text').evaluate((el) => getComputedStyle(el).fill)

/** Waits for the fade (150ms) to settle rather than for the clock: the ring is there when its opacity stops moving */
async function expectOpacity(l: Locator, want: number): Promise<void> {
  await expect.poll(() => opacity(l)).toBeCloseTo(want, 1)
}

async function expectState(page: Page, id: string, state: 'known' | 'unknown' | 'unsupported'): Promise<void> {
  const d = donut(page, id)
  await expect(d).toHaveAttribute('data-state', state)
  await expectOpacity(ring(d, 'dashed'), state === 'unknown' ? 1 : 0)
  await expectOpacity(ring(d, 'solid'), state === 'known' ? 1 : 0)
  await expectOpacity(ring(d, 'dim'), state === 'unsupported' ? 0.5 : 0)
  await expectOpacity(ring(d, 'fill'), state === 'known' ? 1 : 0)
}

export function usageDonutStatesTests(): void {
  test.describe('the usage donut, by what the tool can report (#1616)', () => {
    test('a tool that cannot report usage has a dimmed solid ring and a full-ink letter; an unknown one stays dashed and faint', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await answer(page, { claude: WEEKLY(40), codex: UNSUPPORTED })

      await expectState(page, 'claude', 'known')
      await expectState(page, 'codex', 'unsupported')
      // The letter is the same ink as a donut whose usage is known, and not the faint one
      const known = await letter(donut(page, 'claude'))
      await expect.poll(() => letter(donut(page, 'codex'))).toBe(known)

      // The tooltip keeps saying why (its wording is another matter)
      await donut(page, 'codex').hover()
      await expect(page.getByTestId('usage-donut-reason-codex')).toHaveText('Codex does not report usage limits.')

      // A usage that is unknown for now (supported, no weekly window) is the dashed, faint one still
      await answer(page, { claude: WEEKLY(40), codex: UNKNOWN })
      await expectState(page, 'codex', 'unknown')
      await expect.poll(() => letter(donut(page, 'codex'))).not.toBe(known)
    })

    test('a read that failed, or a host that predates the mark, is unknown for now, never unsupported', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      // An older host's answer: no `supported`, and a reason it may have given
      await answer(page, { claude: WEEKLY(40), codex: { reason: 'needs a live session', usage: null } })
      await expectState(page, 'codex', 'unknown')
      await expectState(page, 'claude', 'known')

      // A read the host could not make (`supported: false` with no `notReported`: not logged in, a timeout; what an older host answers for both) is not "never"
      await answer(page, { claude: WEEKLY(40), codex: { supported: false, reason: 'not logged in', usage: null } })
      await expectState(page, 'codex', 'unknown')
      await donut(page, 'codex').hover()
      await expect(page.getByTestId('usage-donut-reason-codex')).toHaveText('not logged in')
    })

    test('a call that fails is not an answer: each donut keeps what it last knew (RV1624)', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await answer(page, { claude: WEEKLY(40), codex: UNSUPPORTED })
      await expectState(page, 'codex', 'unsupported')
      await expectState(page, 'claude', 'known')
      // Every ask now fails, as one does when the connection drops mid-call (a host swap)
      await page.evaluate(() => {
        const w = window as unknown as MockWindow & { __failed: number }
        w.__failed = 0
        w.__mock.agents.usage = () => {
          w.__failed++
          return Promise.reject(new Error('the tool is busy'))
        }
      })
      // Every state the donuts are ever drawn in from here on, so a flash to dashed and back cannot pass unseen
      await page.evaluate(() => {
        const w = window as unknown as { __seen: Set<string> }
        w.__seen = new Set()
        const note = () =>
          document.querySelectorAll('[data-testid^="usage-donut-"][data-state]').forEach((d) => w.__seen.add(`${d.getAttribute('data-testid')}:${d.getAttribute('data-state')}`))
        new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] })
      })
      await reconnect(page)
      await expect.poll(() => page.evaluate(() => (window as unknown as { __failed: number }).__failed)).toBeGreaterThanOrEqual(2)
      // Not a flash to dashed and back: neither state changes, and the percent stays
      expect(await page.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen].sort())).toEqual([
        'usage-donut-claude:known',
        'usage-donut-codex:unsupported',
      ])
      await expectState(page, 'codex', 'unsupported')
      await expectState(page, 'claude', 'known')
      await expect(donut(page, 'claude')).toHaveAttribute('data-percent', '40')
    })

    test('the retry after a failed call settles a provisional answer, as the first ask does', async ({ page }) => {
      test.setTimeout(90_000)
      await setup(page, { projects: ['/tmp/alpha'] })
      await answer(page, { claude: WEEKLY(40), codex: UNSUPPORTED })
      await expectState(page, 'codex', 'unsupported')
      // The next ask of codex fails, the retry (15 s later) is provisional, and its settle says nobody is logged in
      await page.evaluate(() => {
        const w = window as unknown as MockWindow & { __codex: { settle: boolean }[] }
        w.__codex = []
        const was = w.__mock.agents.usage
        let failed = false
        w.__mock.agents.usage = (tool: string, machine?: string, opts?: { settle?: boolean }) => {
          if (tool !== 'codex') return was(tool, machine, opts)
          w.__codex.push({ settle: opts?.settle === true })
          if (opts?.settle) return Promise.resolve({ supported: false, reason: 'Codex is not logged in on this computer', usage: null })
          if (!failed) {
            failed = true
            return Promise.reject(new Error('the tool is busy'))
          }
          return Promise.resolve({ supported: false, reason: 'Codex does not report usage limits', notReported: true, usage: null, provisional: true })
        }
      })
      await reconnect(page)
      await expect(donut(page, 'codex')).toHaveAttribute('data-state', 'unknown', { timeout: 40_000 })
      expect(await page.evaluate(() => (window as unknown as { __codex: { settle: boolean }[] }).__codex)).toEqual([{ settle: false }, { settle: false }, { settle: true }])
    })

    test('a tool that changes between supported and unsupported while the window is open follows it, both ways', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await answer(page, { claude: WEEKLY(40), codex: UNSUPPORTED })
      await expectState(page, 'codex', 'unsupported')

      await answer(page, { claude: WEEKLY(40), codex: WEEKLY(70) })
      await expectState(page, 'codex', 'known')
      await expect(donut(page, 'codex')).toHaveAttribute('data-percent', '70')

      await answer(page, { claude: WEEKLY(40), codex: UNSUPPORTED })
      await expectState(page, 'codex', 'unsupported')
      await expect(donut(page, 'codex')).toHaveAttribute('data-percent', '')
    })

    test('the change between states is a short transition, and only a fade with reduced motion', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await answer(page, { claude: WEEKLY(40), codex: UNSUPPORTED })
      const props = (l: Locator) =>
        l.evaluate((el) => {
          const s = getComputedStyle(el)
          return { property: s.transitionProperty, duration: s.transitionDuration }
        })

      const moving = await props(ring(donut(page, 'codex'), 'solid'))
      expect(moving.property).toContain('stroke-dasharray')
      for (const d of moving.duration.split(',')) {
        const ms = parseFloat(d) * 1000
        expect(ms).toBeGreaterThanOrEqual(150)
        expect(ms).toBeLessThanOrEqual(200)
      }

      await page.emulateMedia({ reducedMotion: 'reduce' })
      const still = await props(ring(donut(page, 'codex'), 'solid'))
      expect(still.property).toBe('opacity')
      // The fade itself is kept: it is the information
      expect(parseFloat(still.duration)).toBeGreaterThan(0)
    })

    for (const theme of ['light', 'dark', 'hc-light', 'hc-dark'] as const) {
      test(`${theme} theme: the unsupported ring is drawn clear of the top bar, and its letter is the full ink`, async ({ page }) => {
        const side = theme.endsWith('light') ? 'light' : 'dark'
        await setup(page, { projects: ['/tmp/alpha'] })
        // The app does not follow the OS: the theme is the stored pick (docs/design-system.md, themes)
        await page.evaluate(
          ([sd, t]) => {
            ;(window as unknown as MockWindow).__store.getState().setPrefs(
              sd === 'light' ? { themeMode: 'light', themeLight: t } : { themeMode: 'dark', themeDark: t },
            )
          },
          [side, theme] as const,
        )
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeBase)).toBe(side)
        await answer(page, { claude: WEEKLY(0), codex: UNSUPPORTED })
        await expectState(page, 'codex', 'unsupported')
        // The ring as the eye gets it: its ink at the ring's opacity over the top bar's ground, against that ground
        const contrast = await donut(page, 'codex').evaluate((el) => {
          const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
          const lum = ([r, g, b]: number[]) => {
            const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
            return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
          }
          const dim = el.querySelector('circle[data-ring="dim"]')!
          const a = Number(getComputedStyle(dim).opacity)
          const ink = rgb(getComputedStyle(dim).stroke)
          const probe = document.body.appendChild(document.createElement('div'))
          probe.style.background = 'var(--color-surface-side)'
          const ground = rgb(getComputedStyle(probe).backgroundColor)
          probe.remove()
          const seen = ink.map((v, i) => v * a + ground[i]! * (1 - a))
          const [hi, lo] = [lum(seen), lum(ground)].sort((x, y) => y - x)
          return (hi! + 0.05) / (lo! + 0.05)
        })
        expect(contrast).toBeGreaterThan(1.5)
        const known = await letter(donut(page, 'claude'))
        await expect.poll(() => letter(donut(page, 'codex'))).toBe(known)
      })
    }

    test("a linked machine's donuts follow the same rule, and the machine fades in when its link comes back", async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await page.evaluate(() => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', name: 'Box', sshTarget: 'me@box' }))
      await answer(page, { claude: WEEKLY(40), codex: WEEKLY(40), 'box.claude': WEEKLY(61), 'box.codex': UNSUPPORTED })
      await expectState(page, 'box.claude', 'known')
      await expectState(page, 'box.codex', 'unsupported')
      // This computer's own codex is not touched by the machine's answer
      await expectState(page, 'codex', 'known')

      const capsule = page.getByTestId('usage-machine-box')
      await page.evaluate(() => (window as unknown as MockWindow).__mock.machineRow('box', { status: 'disconnected' }))
      await expect(capsule).toHaveCount(0)
      await page.evaluate(() => (window as unknown as MockWindow).__mock.machineRow('box', { status: 'connected' }))
      await expect(capsule).toBeVisible()
      // It comes in by opacity and is pressable from the first frame
      await donut(page, 'box.claude').click({ trial: true })
      await expectState(page, 'box.codex', 'unsupported')
    })
  })
}

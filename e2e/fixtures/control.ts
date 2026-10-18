import { expect, type Locator, type Page } from '@playwright/test'
import { openSessionDialog, startSession } from './new-session.js'

/**
 * Meets the M1 Phase 5 completion criteria. Drives the UI with the mock platform (?mock).
 * The core is the final "control loop" scenario — whether the actual usage flow from §1.3 runs.
 */

/** Helper that drives the mock inside the browser (window.__mock) */
/**
 * `trusted` trusts every project it registers, as a person does before a worktree session: the host (and the mock,
 * #999) refuses a worktree in an untrusted project, since checking out runs the repository's hooks and filters (#407).
 */
export async function setup(page: Page, opts: { projects?: string[]; trusted?: boolean } = {}) {
  await page.goto('/?mock=1')
  // On first run the intro screen comes first (#63) — pick one tool card for the orchestrator to run
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  // Clicking the card leads to the orchestrator screen (empty conversation + suggested questions)
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  for (const [i, path] of (opts.projects ?? []).entries()) {
    if (i === 0) {
      /*
        Register the first project as the **escape hatch** from the empty orchestrator screen
        (#63 — do not force a conversation). With zero projects there is no + button in the sidebar.
      */
      await page.evaluate((p: string) => {
        ;(window as any).__mock.nextPickedDirectory = p
      }, path)
      await page.getByTestId('orchestrator-pick-folder').click()
      // The first registration leads straight into creating a session — here only the project is
      // needed, so close it
      await page.getByTestId('new-session-dialog').waitFor()
      await page.keyboard.press('Escape')
    } else {
      // Folder selection is a single native picker across the whole app (the path-typing dialog is
      // gone)
      await page.evaluate((p: string) => {
        ;(window as any).__mock.nextPickedDirectory = p
      }, path)
      await page.getByTestId('add-project').click()
    }
    await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
  }
  if (opts.trusted) {
    await page.evaluate(async () => {
      const m = (window as any).__mock
      for (const p of m.projectsList) await m.projects.setTrusted(p.id, true)
    })
  }
}

/**
 * Creates a session in `projectName` and sends `prompt` as its first instruction, when given; resolves to the new
 * session's id. `tool` picks that tool in the dialog first; without it the dialog's own choice stands.
 */
export async function newSession(
  page: Page,
  projectName: string,
  prompt?: string,
  opts: { tool?: 'claude' | 'codex' } = {},
): Promise<string> {
  if (opts.tool) {
    // A chosen tool goes through the dialog (FR-7: pick the tool, model and permission)
    await openSessionDialog(page, projectName)
    await page.getByTestId(`tool-option-${opts.tool}`).click()
    await page.getByTestId('create-session-confirm').click()
    await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  } else {
    // The project menu's New session starts one at once (owner, 2026-10-18)
    await startSession(page, projectName)
  }
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  if (prompt !== undefined) {
    await page.getByTestId('prompt-input').fill(prompt)
    await page.getByTestId('prompt-input').press('Enter')
  }
  return page.evaluate(() => (window as any).__store.getState().focusedSessionId as string)
}

/**
 * The model, effort, permission and agent all live **inside a menu** below the composer (not
 * four separate selectors). When `scope` is given, it is that panel's menu — the grid gives each
 * panel its own composer.
 */
export async function pickSetting(page: Page, testId: string, scope?: Locator) {
  const root = scope ?? page
  // If it is already open, use it as is — picking a model leaves the menu open (the contract
  // below), so clicking unconditionally would let the toggle close the menu
  if (!(await root.getByTestId('settings-menu').isVisible())) {
    await root.getByTestId('settings-open').click()
  }
  await expect(root.getByTestId('settings-menu')).toBeVisible()
  await root.getByTestId(testId).click()
}

/** Inject an approval request into the mock */
export async function injectApproval(page: Page, sessionIdx: number, detail: Record<string, unknown>) {
  return page.evaluate(
    ({ idx, d }) => {
      const m = (window as any).__mock
      const sessions = [...(m as any).sessions.values()]
      const s = sessions[idx]
      return m.requestApproval(s.id, d)
    },
    { idx: sessionIdx, d: detail },
  )
}

export async function emitEvent(page: Page, sessionIdx: number, event: Record<string, unknown>) {
  await page.evaluate(
    ({ idx, e }) => {
      const m = (window as any).__mock
      const sessions = [...(m as any).sessions.values()]
      m.emit({ ...e, sessionId: sessions[idx].id })
    },
    { idx: sessionIdx, e: event },
  )
}

/**
 * #116 — a drop that **missed** the composer used to overwrite the entire app.
 *
 * Because Tauri does not intercept drops (dragDropEnabled: false), a drop nobody handles falls
 * through to the webview's default behavior: navigate to the dropped file. One PDF filled the
 * whole window, and the only way back was the browser's back button.
 *
 * A real OS drag cannot be automated, so this constructs a DataTransfer and fires it directly —
 * what the app sees (the event and the types on it) is the same either way.
 */
export const dropFile = (page: Page, name: string, type = 'application/pdf') =>
  page.evaluateHandle(
    ({ n, t }: { n: string; t: string }) => {
      const data = new DataTransfer()
      data.items.add(new File(['content'], n, { type: t }))
      return data
    },
    { n: name, t: type },
  )

/**
 * A choice the agent presents (AskUserQuestion).
 *
 * Displaying it is only half the job if the answer never goes anywhere — that is exactly how the
 * approval card once went unresponsive. So every test here also checks **whether the answer
 * actually reached the session**.
 */
export const QUESTIONS = [
  {
    question: 'What should we have for lunch?',
    header: 'Lunch',
    options: [
      { label: 'Kimbap', description: 'Fast' },
      { label: 'Ramen', description: 'Warm' },
    ],
    multiSelect: false,
  },
  {
    question: 'What about something to drink?',
    header: 'Drink',
    options: [
      { label: 'Water', description: 'A safe choice' },
      { label: 'Coffee', description: 'Wakes you up' },
    ],
    multiSelect: false,
  },
]

/**
 * A conversation long enough that the panel scrolls and the virtualiser has real work to
 * do, left where a reader would leave it — at the newest line.
 *
 * The pinning loop at the end is setup, not the behaviour under test. Dropping eighty
 * turns into a view somebody is already looking at is not something a person can do, and
 * the view is entitled to end up somewhere odd afterwards; the tests below are about what
 * happens to a position you actually held.
 */
export async function seedLongChat(page: Page, sessionId: string) {
  await page.evaluate((sid: string) => {
    const store = (window as any).__store
    const items = Array.from({ length: 80 }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      seq: 1000 + i,
      // Well past the virtualiser's 64px guess — that gap is where #31 lived
      text: `line ${i} `.repeat(60),
    }))
    store.setState({ chat: { ...store.getState().chat, [sid]: items } })
  }, sessionId)

  const stream = page.getByTestId('chat-stream')
  await expect
    .poll(async () => {
      await stream.evaluate((el) => (el.scrollTop = el.scrollHeight))
      return distanceFromBottom(stream)
    })
    .toBeLessThanOrEqual(80)
}

/** How far the stream is from its own bottom, in px. `< BOTTOM_SLACK` means "at the bottom" */
export function distanceFromBottom(stream: Locator): Promise<number> {
  return stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
}

/**
 * Resolves once the page has drawn `n` more frames. A render the app scheduled in reaction to something (a store
 * update, a resize observer, an effect that sets state) lands within a frame or two, so this is how long "the
 * screen caught up" takes, counted in the page's own frames rather than in milliseconds a loaded machine may not
 * draw any frame in.
 */
export function nextFrames(page: Page, n = 2): Promise<void> {
  return page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((r) => requestAnimationFrame(r))
  }, n)
}

/**
 * Starts recording whether an element with `testId` is in the page at any moment from now on, and returns the
 * question to ask afterwards.
 *
 * A negative ("it never showed") cannot be polled: `toHaveCount(0)` passes once a flash is over, and a poll that
 * comes late misses it. An observer installed before the cause records every insertion, however brief. Call the
 * returned check only after waiting for something the same cause did draw (its positive half); the check then lets
 * two more frames pass, so a render that cause scheduled has landed, before it answers.
 */
export async function watchAppearance(page: Page, testId: string): Promise<() => Promise<boolean>> {
  const key = `__appeared_${testId}`
  await page.evaluate(
    ({ id, k }) => {
      const w = window as any
      const there = () => document.querySelector(`[data-testid="${id}"]`) !== null
      w[`${k}_watch`]?.disconnect()
      w[k] = there()
      w[`${k}_watch`] = new MutationObserver(() => {
        if (there()) w[k] = true
      })
      w[`${k}_watch`].observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'] })
    },
    { id: testId, k: key },
  )
  return async () => {
    await nextFrames(page)
    return page.evaluate((k) => (window as any)[k] as boolean, key)
  }
}

import { expect, test, type Page } from '@playwright/test'

/**
 * Clicking a file an agent named (#39).
 *
 * The subject here is the join between two halves that already worked separately: the
 * conversation renders the agent's words, and the overlay shows a file. What is new is
 * that a word can *be* a file — which makes the interesting questions "which words" and
 * "what happens when the guess is wrong", and those are what this file asks.
 */

async function setup(page: Page, path = '/tmp/alpha') {
  await page.goto('/?mock=1')
  await expect(page.getByTestId('intro')).toBeVisible()
  await page.getByTestId('intro-card-claude').click()
  await expect(page.getByTestId('orchestrator-suggestions')).toBeVisible()
  await page.evaluate((p: string) => {
    ;(window as any).__mock.nextPickedDirectory = p
  }, path)
  await page.getByTestId('orchestrator-pick-folder').click()
  // Registering a project the first time leads straight into creating a session — this test
  // only needs the project, so close it
  await page.getByTestId('new-session-dialog').waitFor()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId(`project-${path.split('/').pop()}`)).toBeVisible()
}

async function seedFiles(page: Page, files: Record<string, string>) {
  await page.evaluate((f: Record<string, string>) => {
    const m = (window as any).__mock
    m.fsState.files = { ...m.fsState.files, ...f }
  }, files)
}

async function newSession(page: Page, projectName: string, prompt: string) {
  await page.getByTestId(`project-menu-${projectName}`).click()
  await page.getByTestId(`new-session-${projectName}`).click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes through the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill(prompt)
  await page.getByTestId('prompt-input').press('Enter')
}

/** Put words in the agent's mouth. Without an id, the session that is on screen */
async function agentSays(page: Page, text: string, sessionId?: string) {
  await page.evaluate(
    ({ t, sid }: { t: string; sid?: string }) => {
      const m = (window as any).__mock
      const id = sid ?? (window as any).__store.getState().focusedSessionId
      m.emit({ type: 'message_delta', sessionId: id, role: 'assistant', text: t })
    },
    { t: text, sid: sessionId },
  )
}

/**
 * The narrow rule, from both sides at once. A backticked path opens; a backticked word
 * that merely contains a slash, or a package name, or a directory, stays text — otherwise
 * a paragraph of ordinary technical prose turns into a wall of links that lead nowhere.
 */
test('a backticked path opens the file; prose with a slash in it does not', async ({ page }) => {
  await setup(page)
  await seedFiles(page, { 'src/a.ts': 'first line\nsecond line' })
  await newSession(page, 'alpha', 'work')
  await agentSays(
    page,
    'I read `src/a.ts`. The `and/or` case lives under `packages/ui/src` and comes from `@tanstack/react-virtual` at `v1.2.0`.',
  )

  const links = page.getByTestId('file-link')
  await expect(links).toHaveCount(1)
  await expect(links).toHaveText('src/a.ts')

  await links.click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('viewer-path')).toContainText('src/a.ts')
  await expect(page.getByTestId('code-viewer')).toContainText('second line')
})

test('viewer Open in IDE uses a host-resolved absolute path and reports resolve failures', async ({ page }) => {
  await setup(page)
  await seedFiles(page, { 'src/a.ts': 'first line\nsecond line' })
  await newSession(page, 'alpha', 'work')
  await agentSays(page, 'See `src/a.ts`.')

  await page.getByTestId('file-link').click()
  await expect(page.getByTestId('code-viewer')).toContainText('second line')
  await page.getByTestId('viewer-open-ide').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.opened))
    .toEqual([{ path: '/mock-project/src/a.ts' }])

  await page.evaluate(() => {
    const mock = (window as any).__mock
    mock.fs.resolve = async () => {
      throw new Error('resolve blocked')
    }
  })
  await page.getByTestId('viewer-open-ide').click()
  await expect(page.getByTestId('toast')).toContainText('Could not open in IDE: resolve blocked')
})

/**
 * Agents print absolute paths as often as relative ones, and the viewer speaks
 * project-relative. A path outside the project is not a link at all: `fs.readFile` refuses
 * anything above the root, so it could only ever open an error.
 */
test('an absolute path inside the project opens; one outside it stays text', async ({ page }) => {
  await setup(page)
  await seedFiles(page, { 'src/a.ts': 'first line' })
  await newSession(page, 'alpha', 'work')
  await agentSays(page, 'Changed `/tmp/alpha/src/a.ts`, left `/etc/hosts.conf` alone.')

  const links = page.getByTestId('file-link')
  await expect(links).toHaveCount(1)
  await expect(links).toHaveText('/tmp/alpha/src/a.ts')

  await links.click()
  // It arrives as the project-relative path the rest of the app uses, not as typed
  await expect(page.getByTestId('viewer-path')).toHaveText('src/a.ts')
})

/**
 * `file:123` is how every tool prints a location, and the viewer is virtualized, so
 * landing on the line costs the same as landing at the top.
 */
test('`path:line` lands on that line, and says which one it landed on', async ({ page }) => {
  await setup(page)
  await seedFiles(page, {
    'big.ts': Array.from({ length: 400 }, (_, i) => `line ${i + 1} of the file`).join('\n'),
  })
  await newSession(page, 'alpha', 'work')
  await agentSays(page, 'The bug is at `big.ts:300`.')

  await page.getByTestId('file-link').click()
  await expect(page.getByTestId('viewer-path')).toHaveText('big.ts')

  // Line 300 is row index 299 — on screen, and marked as the row that was asked for
  await expect(page.locator('[data-line="299"]')).toBeVisible()
  await expect(page.locator('[data-landed]')).toContainText('line 300 of the file')
})

/**
 * Nothing checks the path against the disk before it becomes a link — that would be an
 * RPC per span of every message, to answer a question only a click ever asks. So the link
 * is a guess, and this is the test that the app admits it when the guess is wrong instead
 * of sitting on "Loading…" about a file that will never load.
 */
test('a path that is not there says so, in the viewer and on top of it', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'work')
  await page.evaluate(() => {
    ;(window as any).__mock.fs.readFile = async () => {
      throw new Error('ENOENT: no such file or directory')
    }
  })
  await agentSays(page, 'It is handled in `src/ghost.ts`.')

  await page.getByTestId('file-link').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('viewer-error')).toContainText('ENOENT')

  /*
   * And the toast is not merely in the document — it is the thing you would actually see.
   * The overlay is opaque and covers the lane the toast sits in, so "present in the DOM"
   * and "readable by a person" were two different facts here until the toast was lifted
   * above it. `elementFromPoint` is the only assertion that can tell them apart.
   */
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="toast"]')
      if (!el) return false
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return !!hit && el.contains(hit)
    },
    undefined,
    { timeout: 4000 },
  )
})

/**
 * The path an agent writes is often relative to wherever it happened to be looking (user
 * finding, 2026-09-07). Rather than leaving a dead link because it is not at the root, the
 * project is searched for a file with that tail and that file is opened instead.
 */
test('a path written from a subdirectory still opens (#39)', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'work')
  await page.evaluate(() => {
    const m = (window as any).__mock
    // A file that does not exist relative to the root — the real one is one level down
    m.fs.readFile = async (_p: string, path: string) => {
      if (path !== 'Cli/Media/ImageSearch.cs') throw new Error('ENOENT: no such file or directory')
      return { text: 'found me', truncated: false, binary: false, bytes: 8 }
    }
    m.fs.search = async () => [{ path: 'Cli/Media/ImageSearch.cs', name: 'ImageSearch.cs' }]
  })
  await agentSays(page, 'Look at `Media/ImageSearch.cs:2`.')

  await page.getByTestId('file-link').click()
  // The path the viewer reports is **where the file actually lives** — opening in the IDE
  // uses this same path
  await expect(page.getByTestId('viewer-path')).toHaveText('Cli/Media/ImageSearch.cs')
  await expect(page.getByTestId('viewer-error')).toBeHidden()
})

/**
 * When several files share the same tail, none is picked automatically — that would be a
 * guess dressed up as a fact.
 */
test('when several files share the tail the viewer asks which one', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'work')
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.fs.readFile = async (_p: string, path: string) => {
      if (path !== 'app/Media/ImageSearch.cs') throw new Error('ENOENT: no such file or directory')
      return { text: 'the app one', truncated: false, binary: false, bytes: 11 }
    }
    m.fs.search = async () => [
      { path: 'app/Media/ImageSearch.cs', name: 'ImageSearch.cs' },
      { path: 'cli/Media/ImageSearch.cs', name: 'ImageSearch.cs' },
    ]
  })
  await agentSays(page, 'Look at `Media/ImageSearch.cs`.')

  await page.getByTestId('file-link').click()
  await expect(page.getByTestId('viewer-error')).toBeVisible()
  const candidates = page.getByTestId('viewer-candidates')
  await expect(candidates.locator('button')).toHaveCount(2)

  await page.getByTestId('viewer-candidate-app/Media/ImageSearch.cs').click()
  await expect(page.getByTestId('viewer-path')).toHaveText('app/Media/ImageSearch.cs')
})

/**
 * Agents also write links, not just backticks — `[manager.ts](src/a.ts)` — and those used
 * to render as anchors whose relative href led nowhere. A link whose target is a project
 * file is the same thing as a backticked path, so it gets the same button.
 */
test('a markdown link to a project file opens the viewer', async ({ page }) => {
  await setup(page)
  await seedFiles(page, { 'src/a.ts': 'first line' })
  await newSession(page, 'alpha', 'work')
  await agentSays(page, 'I changed [the manager](src/a.ts) and left [the docs](https://example.com) alone.')

  // A real web link that is not a file stays a plain anchor
  await expect(page.getByTestId('markdown').locator('a')).toHaveText('the docs')
  const link = page.getByTestId('file-link')
  await expect(link).toHaveText('the manager')
  await link.click()
  await expect(page.getByTestId('viewer-path')).toHaveText('src/a.ts')
})

/** Right-click means Finder — the door for when the actual file is needed, not the viewer */
test('right-clicking a file link reveals it in Finder', async ({ page }) => {
  await setup(page)
  await seedFiles(page, { 'src/a.ts': 'first line' })
  await newSession(page, 'alpha', 'work')
  await agentSays(page, 'See `src/a.ts`.')

  await page.getByTestId('file-link').click({ button: 'right' })
  // The viewer does not open (right-click is not opening it), and the path goes to the reveal port
  await expect(page.getByTestId('overlay')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.revealed)).toEqual(['src/a.ts'])
})

/**
 * A model-written href the browser would *interpret* never reaches the DOM: not a file,
 * not http(s)/mailto → the words stay words. The alternative is an attribute a scheme can
 * be smuggled into.
 */
test('a link that is neither a file nor a web URL renders as plain text', async ({ page }) => {
  await setup(page)
  await newSession(page, 'alpha', 'work')
  await agentSays(page, 'Do not click [here](foo://bar) or [there](packages/ui).')

  const md = page.getByTestId('markdown').last()
  await expect(md).toContainText('Do not click here or there.')
  await expect(md.locator('a')).toHaveCount(0)
  await expect(page.getByTestId('file-link')).toHaveCount(0)
})

/**
 * The orchestrator has no project, so it has no root for a relative path to be relative
 * *to* — and guessing one from whatever project happens to be selected would open a file
 * of the same name from some other repository. The same sentence therefore links in a
 * project session and stays text here.
 */
test('the same path links in a project session and stays text in the orchestrator', async ({ page }) => {
  await setup(page)
  await seedFiles(page, { 'src/a.ts': 'first line' })
  await newSession(page, 'alpha', 'work')
  await agentSays(page, 'Look at `src/a.ts`.')
  // In a project session the code span is wrapped in the button that opens it
  await expect(page.getByTestId('file-link')).toHaveText('src/a.ts')

  await page.getByTestId('orchestrator-button').click()
  // A session is born on its first message (#63)
  await page.getByTestId('orchestrator-input').fill('hello')
  await page.getByTestId('orchestrator-input').press('Enter')
  await expect(page.getByTestId('session-view')).toBeVisible()
  // The orchestrator belongs to no project, so it is not the *focused* session — it is
  // reached by its own id, which is the same fact that makes its paths unresolvable
  const orcId: string = await page.evaluate(() => (window as any).__store.getState().orchestratorId)
  await agentSays(page, 'Look at `src/a.ts`.', orcId)

  const code = page.getByTestId('markdown').locator('code')
  await expect(code).toHaveText('src/a.ts')
  // Same words, no button around them — the span sits straight in the paragraph
  expect(await code.evaluate((el) => el.parentElement?.tagName)).toBe('P')
})

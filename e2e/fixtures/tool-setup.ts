import { expect, test, type Page } from '@playwright/test'
import { setup } from './control.js'
import { openSessionDialog, startSession } from './new-session.js'

/**
 * A tool's setup line and the top bar's signed-out donuts (#59, owner 2026-10-27): Antigravity's Install and Sign in inside
 * Centralu, the terminal hint for the other tools, a sentence only on a linked machine, and a signed-out donut for every
 * tool that is installed but signed out. Driven through the mock platform, which answers the four setup RPCs and
 * moves the setup the way the host's `tool_setup` event does. A function, because it runs in Chromium and in WebKit
 * (the desktop app is WKWebView): tool-setup.spec.ts and tool-setup-webkit.spec.ts.
 */

type MockWindow = { __mock: any; __store: any }

type Setup = { state: string } & Record<string, unknown>
const centralu = (state: string, over: Record<string, unknown> = {}): Setup => ({ state, install: 'centralu', signIn: 'centralu', ...over })

/** Puts Antigravity among the tools in the state given (the pickers read the store's tool list, the donuts read detect) */
async function antigravity(page: Page, setup: Setup, machine?: string): Promise<void> {
  await page.evaluate(
    ([s, box]: readonly [Setup, string | null]) => {
      const w = window as unknown as MockWindow
      const m = w.__mock
      const state = s.state
      const agy = {
        name: 'antigravity',
        label: 'Antigravity',
        mark: 'A',
        install: 'Installed from Centralu',
        login: 'Sign in with Google',
        installed: state !== 'not_installed' && state !== 'installing',
        loggedIn: state === 'ready',
        detail: 'agent 1.4.3',
        setup: s,
      }
      if (box) m.machineDetected = { ...m.machineDetected, [box]: [...m.detected.filter((t: any) => t.name !== 'antigravity'), agy] }
      else m.detected = [...m.detected.filter((t: any) => t.name !== 'antigravity'), agy]
      w.__store.setState({ tools: [...m.detected.filter((t: any) => t.name !== 'antigravity'), agy].map((t: any) => ({ name: t.name, label: t.label, mark: t.mark, install: t.install, login: t.login })) })
    },
    [setup, machine ?? null] as const,
  )
}

/** The pickers and labels read the store's tool list, which the app reads at connection: the mock's, after a test changed it */
async function declareTools(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as MockWindow
    w.__store.setState({ tools: w.__mock.detected.map((t: any) => ({ name: t.name, label: t.label, mark: t.mark, install: t.install, login: t.login })) })
  })
}

/** The host telling the window how a tool's setup went on, as `tool_setup` */
async function told(page: Page, setup: Setup, tool = 'antigravity'): Promise<void> {
  await page.evaluate(([t, s]) => (window as unknown as MockWindow).__mock.emit({ type: 'tool_setup', tool: t, setup: s }), [tool, setup] as const)
}

/** The calls the screens made to the setup actions */
const calls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as MockWindow).__mock.setupCalls.map((c: { action: string; tool: string }) => `${c.action}:${c.tool}`))

async function pickAntigravity(page: Page): Promise<void> {
  await openSessionDialog(page, 'alpha')
  await page.getByTestId('tool-option-antigravity').click()
}

export function toolSetupTests(): void {
  test.describe('a tool\'s setup line (#59)', () => {
    test.beforeEach(async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
    })

    test('not installed: Install, then progress with Stop, a failure with its reason and Retry', async ({ page }) => {
      await antigravity(page, centralu('not_installed'))
      await pickAntigravity(page)
      const line = page.getByTestId('tool-blocked')
      await expect(line).toContainText('Antigravity is not installed.')
      await expect(page.getByTestId('create-session-confirm')).toBeDisabled()

      await page.getByTestId('tool-blocked-install').click()
      expect(await calls(page)).toEqual(['install:antigravity'])
      await expect(line).toHaveAttribute('data-setup', 'installing')
      await expect(page.getByTestId('tool-blocked-progress-text')).toContainText('Installing Antigravity… 0%')

      await told(page, centralu('installing', { progress: { received: 50, total: 100 } }))
      await expect(page.getByTestId('tool-blocked-progress-text')).toContainText('50%')
      await expect(page.getByTestId('tool-blocked-progress')).toHaveAttribute('aria-valuenow', '50')

      // Every button that halts work in progress reads Stop, never Cancel (owner, 2026-10-28)
      await expect(page.getByTestId('tool-blocked-stop-install')).toHaveText('Stop')
      await page.getByTestId('tool-blocked-stop-install').click()
      expect(await calls(page)).toEqual(['install:antigravity', 'cancelInstall:antigravity'])
      // A cancel is the person's own act: back to Install, with nothing to apologise for
      await expect(line).toHaveAttribute('data-setup', 'install')

      await told(page, centralu('not_installed', { failure: { reason: 'network', message: 'The download stopped.' } }))
      await expect(line).toContainText('Could not install Antigravity: The download stopped.')
      await page.getByTestId('tool-blocked-retry-install').click()
      expect(await calls(page)).toEqual(['install:antigravity', 'cancelInstall:antigravity', 'install:antigravity'])
      await expect(line).toHaveAttribute('data-setup', 'installing')

      // Installed, and signed out: the line goes on to Sign in
      await told(page, centralu('signed_out'))
      await expect(line).toHaveAttribute('data-setup', 'sign_in')
    })

    test('signed out: Sign in, waiting for the browser with Stop, then the line fades out and Start enables', async ({ page }) => {
      await antigravity(page, centralu('signed_out'))
      await pickAntigravity(page)
      const line = page.getByTestId('tool-blocked')
      await expect(line).toContainText('Antigravity needs a Google sign-in.')
      await expect(page.getByTestId('create-session-confirm')).toBeDisabled()

      await page.getByTestId('tool-blocked-sign-in').click()
      expect(await calls(page)).toEqual(['signIn:antigravity'])
      await expect(line).toContainText('Waiting for the browser…')
      // Its own button is Stop, so it is not mistaken for the dialog's Cancel
      await expect(page.getByTestId('tool-blocked-stop-sign-in')).toHaveText('Stop')
      await page.getByTestId('tool-blocked-stop-sign-in').click()
      await expect(line).toHaveAttribute('data-setup', 'sign_in')
      await page.getByTestId('tool-blocked-sign-in').click()

      await told(page, centralu('ready', { plan: { name: 'Free' } }))
      // Start is enabled at once; the line is still there only to fade out
      await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
      await expect(line).toHaveCount(0)
    })

    test('the 5-minute timeout says so and offers Sign in again', async ({ page }) => {
      await antigravity(page, centralu('signing_in'))
      await pickAntigravity(page)
      await expect(page.getByTestId('tool-blocked')).toContainText('Waiting for the browser…')
      await told(page, centralu('signed_out', { failure: { reason: 'timed_out', message: 'Sign-in timed out' } }))
      await expect(page.getByTestId('tool-blocked')).toContainText('Sign-in timed out.')
      await page.getByTestId('tool-blocked-retry-sign-in').click()
      await expect(page.getByTestId('tool-blocked')).toContainText('Waiting for the browser…')
      expect(await calls(page)).toEqual(['signIn:antigravity'])
    })

    test('an action the host refuses says why and leaves the line as it was', async ({ page }) => {
      await antigravity(page, centralu('signed_out'))
      await pickAntigravity(page)
      await page.evaluate(() => {
        ;(window as unknown as MockWindow).__mock.agents.signInTool = async () => {
          throw new Error('Antigravity is busy')
        }
      })
      await page.getByTestId('tool-blocked-sign-in').click()
      await expect(page.getByTestId('tool-blocked-error')).toHaveText('Antigravity is busy')
      await expect(page.getByTestId('tool-blocked')).toHaveAttribute('data-setup', 'sign_in')
    })

    test('a tool the host is told signed in elsewhere enables Start without asking detect again', async ({ page }) => {
      await antigravity(page, centralu('signed_out'))
      await pickAntigravity(page)
      await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
      await told(page, centralu('ready'))
      await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
    })

    test('install progress does not make the top bar and the pickers ask again', async ({ page }) => {
      await antigravity(page, centralu('not_installed'))
      await pickAntigravity(page)
      await page.getByTestId('tool-blocked-install').click()
      await expect(page.getByTestId('tool-blocked')).toHaveAttribute('data-setup', 'installing')
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.asked = 0
        const real = m.agents.detect.bind(m.agents)
        m.agents.detect = (machine?: string) => {
          m.asked++
          return real(machine)
        }
      })
      for (const received of [10, 20, 30, 40]) await told(page, centralu('installing', { progress: { received, total: 100 } }))
      await expect(page.getByTestId('tool-blocked-progress-text')).toContainText('40%')
      expect(await page.evaluate(() => (window as unknown as MockWindow).__mock.asked)).toBe(0)
    })

    test('after the host comes back, a setup it said before is not believed over what it says now', async ({ page }) => {
      await antigravity(page, centralu('signed_out'))
      await pickAntigravity(page)
      await page.getByTestId('tool-blocked-sign-in').click()
      await expect(page.getByTestId('tool-blocked')).toHaveAttribute('data-setup', 'signing_in')
      // The host restarted: its detect says signed out, and nothing is signing in
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.detected = m.detected.map((t: any) => (t.name === 'antigravity' ? { ...t, setup: { state: 'signed_out', install: 'centralu', signIn: 'centralu' } } : t))
        m.setConnectionState('disconnected')
      })
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      await expect(page.getByTestId('tool-blocked')).toHaveAttribute('data-setup', 'sign_in')
    })

    test('the line that fades out keeps the words of its own tool', async ({ page }) => {
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.detected = m.detected.map((t: any) => (t.name === 'codex' ? { ...t, installed: true, loggedIn: false } : t))
      })
      await openSessionDialog(page, 'alpha')
      await page.getByTestId('tool-option-codex').click()
      await expect(page.getByTestId('tool-blocked')).toContainText('Codex needs a login')
      await page.getByTestId('tool-option-claude').click()
      // On its way out, and still about Codex
      await expect(page.getByTestId('tool-blocked')).not.toContainText('Claude Code')
      await expect(page.getByTestId('tool-blocked')).toHaveCount(0)
    })

    test('a tool the list of that machine does not have is not found there, not an empty line', async ({ page }) => {
      await page.evaluate(() => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', name: 'Box', sshTarget: 'me@box' }))
      await antigravity(page, centralu('ready'))
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.machineDetected = { ...m.machineDetected, box: m.detected.filter((t: any) => t.name !== 'antigravity') }
      })
      await page.getByTestId('add-project').click()
      await page.getByTestId('add-project-on-box').click()
      await page.getByTestId('add-remote-project-path').fill('/srv/beta')
      await page.getByTestId('add-remote-project-confirm').click()
      await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
      await openSessionDialog(page, 'beta')
      await page.getByTestId('tool-option-antigravity').click()
      await expect(page.getByTestId('tool-blocked')).toHaveText('Antigravity not found (not installed)')
    })

    test('a sign-in running on a linked machine has no Cancel here', async ({ page }) => {
      await page.evaluate(() => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', name: 'Box', sshTarget: 'me@box' }))
      await antigravity(page, centralu('ready'))
      await antigravity(page, centralu('signing_in'), 'box')
      await page.getByTestId('add-project').click()
      await page.getByTestId('add-project-on-box').click()
      await page.getByTestId('add-remote-project-path').fill('/srv/beta')
      await page.getByTestId('add-remote-project-confirm').click()
      await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
      await openSessionDialog(page, 'beta')
      await page.getByTestId('tool-option-antigravity').click()
      await expect(page.getByTestId('tool-blocked')).toHaveText('Antigravity needs a Google sign-in. Sign in on Box.')
      await expect(page.getByTestId('tool-blocked').getByRole('button')).toHaveCount(0)
    })

    test('Claude Code keeps its terminal hint, and the sign-in of Antigravity is not offered for it', async ({ page }) => {
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.detected = m.detected.map((t: any) => (t.name === 'codex' ? { ...t, installed: true, loggedIn: false } : t))
      })
      await openSessionDialog(page, 'alpha')
      await page.getByTestId('tool-option-codex').click()
      await expect(page.getByTestId('tool-blocked')).toHaveText('Codex needs a login — run codex login in a terminal')
      await expect(page.getByTestId('tool-blocked-sign-in')).toHaveCount(0)
      await expect(page.getByTestId('tool-blocked-install')).toHaveCount(0)
    })

    test('a linked machine: the line says to sign in there, and has no button', async ({ page }) => {
      await page.evaluate(() => (window as unknown as MockWindow).__mock.machines.add({ shell: 'posix', name: 'Box', sshTarget: 'me@box' }))
      await antigravity(page, centralu('ready'))
      await antigravity(page, centralu('signed_out'), 'box')
      await page.getByTestId('add-project').click()
      await page.getByTestId('add-project-on-box').click()
      await page.getByTestId('add-remote-project-path').fill('/srv/beta')
      await page.getByTestId('add-remote-project-confirm').click()
      await expect(page.getByTestId('add-remote-project-dialog')).toHaveCount(0)
      await openSessionDialog(page, 'beta')
      await page.getByTestId('tool-option-antigravity').click()
      await expect(page.getByTestId('tool-blocked')).toHaveText('Antigravity needs a Google sign-in. Sign in on Box.')
      await expect(page.getByTestId('tool-blocked').getByRole('button')).toHaveCount(0)
      await expect(page.getByTestId('create-session-confirm')).toBeDisabled()
    })

    test('the new-app dialog gives the reason Antigravity cannot build an app, and no Install or Sign in', async ({ page }) => {
      // The mock says what the real host says: Antigravity takes no role text, and an app's builder is given its role as text
      for (const setup of [centralu('not_installed'), centralu('signed_out'), centralu('ready')]) {
        await antigravity(page, setup)
        await page.getByTestId('create-app').click()
        const dialog = page.getByTestId('new-app-dialog')
        await dialog.getByTestId('new-app-tool-antigravity').click()
        const line = dialog.getByTestId('new-app-tool-blocked')
        await expect(line).toHaveAttribute('data-setup', 'refused')
        await expect(line).toContainText("Antigravity cannot take Centralu's role instructions yet")
        await expect(line.getByRole('button')).toHaveCount(0)
        await expect(dialog.getByTestId('new-app-create')).toBeDisabled()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
      }
    })

    test('an account that is not eligible: Verify account opens Google\'s address, then Sign in again', async ({ page }) => {
      const uri = 'https://accounts.google.com/verify?x=1'
      await antigravity(page, centralu('signed_out', { failure: { reason: 'ineligible', message: 'Google did not set up Antigravity for this account', verifyUri: uri } }))
      await pickAntigravity(page)
      const line = page.getByTestId('tool-blocked')
      await expect(line).toContainText('Google needs to verify this account.')
      // Both buttons stand on one line
      const [v, s] = await Promise.all([page.getByTestId('tool-blocked-verify').boundingBox(), page.getByTestId('tool-blocked-sign-in').boundingBox()])
      expect(Math.abs((v?.y ?? 0) - (s?.y ?? 99))).toBeLessThan(4)
      await page.getByTestId('tool-blocked-verify').click()
      expect(await page.evaluate(() => (window as unknown as MockWindow).__mock.openedUrls)).toEqual([uri])
      await page.getByTestId('tool-blocked-sign-in').click()
      await expect(line).toContainText('Waiting for the browser…')

      // Without an address there is nothing to open: only the sentence and Sign in again
      await told(page, centralu('signed_out', { failure: { reason: 'ineligible', message: 'no' } }))
      await expect(line).toContainText('Google did not set up Antigravity for this account.')
      await expect(page.getByTestId('tool-blocked-verify')).toHaveCount(0)
    })
  })

  test.describe("the empty session's tool capsule (#59, owner 2026-10-28)", () => {
    const stored = (page: Page, id: string) => page.evaluate((x) => (window as unknown as MockWindow).__store.getState().sessions[x]?.tool as string, id)
    // The real adapter cannot keep a project's own files out, so it runs only in trusted projects (the mock's default says nothing of it)
    const likeTheRealAdapter = (page: Page) => page.evaluate(() => ((window as unknown as MockWindow).__mock.capabilityLimits.antigravity = { keepsRepoFilesOut: false }))

    test('a tool Centralu sets up is shown dimmed before it is ready; picking it shows the line, and it switches once it is ready', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'], trusted: true })
      await likeTheRealAdapter(page)
      await antigravity(page, centralu('not_installed'))
      const id = await startSession(page, 'alpha')
      const radio = page.getByTestId('session-start-tool-antigravity')
      await expect(radio).toBeVisible()
      await expect(radio).toHaveClass(/(^|\s)opacity-50(\s|$)/)
      // Another tool that is not ready stays out (the 2026-10-18 rule)
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.detected = m.detected.map((t: any) => (t.name === 'codex' ? { ...t, installed: false, loggedIn: false } : t))
      })

      await radio.click()
      // The picked tool wears the selected look, and the session's tool is still Claude Code
      await expect(radio).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('session-start-tool-claude')).toHaveAttribute('aria-checked', 'false')
      expect(await stored(page, id)).toBe('claude')
      const line = page.getByTestId('session-start-tool-blocked')
      await expect(line).toContainText('Antigravity is not installed.')
      await line.getByTestId('session-start-tool-blocked-install').click()
      await expect(line).toHaveAttribute('data-setup', 'installing')
      await told(page, centralu('signed_out'))
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.detected = m.detected.map((t: any) => (t.name === 'antigravity' ? { ...t, installed: true } : t))
      })
      await expect(line).toContainText('Antigravity needs a Google sign-in.')
      await line.getByTestId('session-start-tool-blocked-sign-in').click()
      await expect(line).toContainText('Waiting for the browser…')

      await told(page, centralu('ready'))
      await expect(line).toHaveCount(0)
      // Ready is not switched to: the look goes back to the session's own tool, and Antigravity is an ordinary ready tool
      await expect(page.getByTestId('session-start-tool-claude')).toHaveAttribute('aria-checked', 'true')
      await expect(radio).toHaveAttribute('aria-checked', 'false')
      await expect(radio).not.toHaveClass(/(^|\s)opacity-50(\s|$)/)
      expect(await stored(page, id)).toBe('claude')
      await radio.click()
      await expect.poll(() => stored(page, id)).toBe('antigravity')
      await expect(page.getByTestId('session-start-tool-codex')).toHaveCount(0)
    })

    test("picking the session's own tool again moves the look back and folds the line; a running install keeps running, and finishing switches nothing", async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'], trusted: true })
      await likeTheRealAdapter(page)
      await antigravity(page, centralu('not_installed'))
      const id = await startSession(page, 'alpha')
      const radio = page.getByTestId('session-start-tool-antigravity')
      const claude = page.getByTestId('session-start-tool-claude')
      await radio.click()
      await page.getByTestId('session-start-tool-blocked-install').click()
      await expect(page.getByTestId('session-start-tool-blocked')).toHaveAttribute('data-setup', 'installing')

      await claude.click()
      await expect(page.getByTestId('session-start-tool-blocked')).toHaveCount(0)
      await expect(claude).toHaveAttribute('aria-checked', 'true')
      await expect(radio).toHaveAttribute('aria-checked', 'false')
      await expect(radio).toHaveClass(/(^|\s)opacity-50(\s|$)/)
      // The install goes on without the line; nothing asked the host to stop it
      expect(await calls(page)).toEqual(['install:antigravity'])
      await told(page, centralu('signed_out'))
      await told(page, centralu('ready'))
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        m.detected = m.detected.map((t: any) => (t.name === 'antigravity' ? { ...t, installed: true, loggedIn: true } : t))
      })
      // Done while the person was back on Claude Code: no switch, no line, Antigravity undimmed
      await expect(radio).not.toHaveClass(/(^|\s)opacity-50(\s|$)/)
      await expect(claude).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('session-start-tool-blocked')).toHaveCount(0)
      expect(await stored(page, id)).toBe('claude')
    })

    test('in a project that is not trusted it says why, as the dialog does, with no Install', async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
      await likeTheRealAdapter(page)
      await antigravity(page, centralu('not_installed'))
      await startSession(page, 'alpha')
      await page.getByTestId('session-start-tool-antigravity').click()
      const line = page.getByTestId('session-start-tool-blocked')
      await expect(line).toHaveAttribute('data-setup', 'refused')
      await expect(line).toContainText('runs only in trusted projects')
      await expect(line.getByRole('button')).toHaveCount(0)
    })
  })

  test.describe('first run (#59)', () => {
    for (const [name, tool] of [
      ['not installed', { installed: false, loggedIn: false, setup: { state: 'not_installed', install: 'centralu', signIn: 'centralu' } }],
      ['installed, signed out', { installed: true, loggedIn: false, setup: { state: 'signed_out', install: 'centralu', signIn: 'centralu' } }],
      ['installed and signed in', { installed: true, loggedIn: true, setup: { state: 'ready', install: 'centralu', signIn: 'centralu' } }],
    ] as const) {
      test(`the first-run card of Antigravity (${name}) is a refused card: the reason, dimmed whole, no Install or Sign in`, async ({ page }) => {
        await page.goto('/?mock=1')
        await expect(page.getByTestId('intro')).toBeVisible()
        await page.evaluate((t) => {
          const m = (window as unknown as MockWindow).__mock
          const claude = m.detected.find((x: any) => x.name === 'claude')
          m.detected = [claude, { name: 'antigravity', label: 'Antigravity', mark: 'A', install: 'Installed from Centralu', login: 'Sign in with Google', detail: 'agent 1.4.3', ...t }]
        }, tool)
        await page.getByTestId('redetect').click()
        const card = page.getByTestId('intro-card-antigravity')
        await expect(page.getByTestId('intro-card-antigravity-status')).toContainText("Antigravity cannot take Centralu's role instructions yet")
        await expect(card.getByRole('button')).toHaveCount(0)
        await expect(card).toBeDisabled()
        // The same dimming and reason type as the other refused cards: the whole card, not only its title
        await expect(card).toHaveClass(/opacity-40/)
        await expect(page.getByTestId('intro-card-antigravity-status')).toHaveClass(/text-sm/)
        await expect(page.getByTestId('intro-card-antigravity-setup')).toHaveCount(0)
      })
    }
  })

  test.describe('the top bar: a signed-out donut for a tool installed but signed out (#59)', () => {
    test.beforeEach(async ({ page }) => {
      await setup(page, { projects: ['/tmp/alpha'] })
    })

    test('Claude Code, Codex, Cursor and Antigravity each get one when signed out; a missing tool and OpenCode do not', async ({ page }) => {
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        const claude = m.detected.find((t: any) => t.name === 'claude')
        const mk = (name: string, over: object) => ({ ...claude, name, label: name, mark: name.slice(0, 1).toUpperCase(), ...over })
        m.detected = [
          { ...claude, loggedIn: false },
          mk('codex', { loggedIn: false }),
          mk('cursor-agent', { loggedIn: false }),
          mk('antigravity', { loggedIn: false, setup: { state: 'signed_out', install: 'centralu', signIn: 'centralu' } }),
          mk('opencode', { loggedIn: true, setup: { state: 'ready', install: 'terminal', signIn: 'none' } }),
          mk('absent', { installed: false, loggedIn: false }),
        ]
      })
      await declareTools(page)
      // Asked again when the connection comes back
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('disconnected'))
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      for (const tool of ['claude', 'codex', 'cursor-agent', 'antigravity']) {
        await expect(page.getByTestId(`usage-donut-${tool}`)).toHaveAttribute('data-signed-out', 'true')
      }
      await expect(page.getByTestId('usage-donut-opencode')).not.toHaveAttribute('data-signed-out', 'true')
      // Waiting on the person is the signal's white, not an error's red (design-system §1)
      await expect(page.getByTestId('usage-donut-antigravity').locator('circle').first()).toHaveClass(/text-ink-signal/)
      await expect(page.getByTestId('usage-donut-antigravity').locator('circle').first()).not.toHaveClass(/text-danger/)
      await expect(page.getByTestId('usage-donut-antigravity').locator('text')).toHaveClass(/text-ink-signal/)
      await expect(page.getByTestId('usage-donut-antigravity').locator('text')).not.toHaveClass(/text-danger/)
      await expect(page.getByTestId('usage-donut-absent')).toHaveCount(0)
      // Something to do is not "no agent"
      await expect(page.getByTestId('usage-no-agent')).toHaveCount(0)
    })

    test('its tooltip says it is not signed in; Antigravity\'s panel signs in, Claude Code\'s says how from a terminal', async ({ page }) => {
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        const claude = m.detected.find((t: any) => t.name === 'claude')
        m.detected = [
          { ...claude, loggedIn: false },
          { ...claude, name: 'antigravity', label: 'Antigravity', mark: 'A', loggedIn: false, setup: { state: 'signed_out', install: 'centralu', signIn: 'centralu' } },
        ]
        m.setConnectionState('disconnected')
      })
      await declareTools(page)
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      const agy = page.getByTestId('usage-donut-antigravity')
      await agy.hover()
      await expect(page.getByTestId('usage-donut-tip-antigravity')).toContainText('Not signed in')

      await page.getByTestId('usage-donut-claude').click()
      await expect(page.getByTestId('usage-drop-title')).toHaveText('Claude Code')
      await expect(page.getByTestId('usage-signed-out-line')).toContainText('Claude Code is not signed in. Run claude auth login in a terminal.')

      await agy.click()
      await expect(page.getByTestId('usage-drop-title')).toHaveText('Antigravity')
      await expect(page.getByTestId('usage-signed-out-line')).toContainText('Antigravity needs a Google sign-in.')
      await page.getByTestId('usage-signed-out-line-sign-in').click()
      await expect(page.getByTestId('usage-signed-out-line')).toContainText('Waiting for the browser…')

      // Signed in: the donut turns into a reading and the panel into the usage
      await told(page, centralu('ready'))
      await expect(agy).not.toHaveAttribute('data-signed-out', 'true')
      await expect(page.getByTestId('usage-signed-out')).toHaveCount(0)
    })

    test('a donut comes and goes with a fade, not a cut', async ({ page }) => {
      await page.evaluate(() => {
        const m = (window as unknown as MockWindow).__mock
        const claude = m.detected.find((t: any) => t.name === 'claude')
        m.detected = [claude, { ...claude, name: 'antigravity', label: 'Antigravity', mark: 'A', loggedIn: false, setup: { state: 'signed_out', install: 'centralu', signIn: 'centralu' } }]
        m.setConnectionState('disconnected')
      })
      await declareTools(page)
      await expect(page.getByTestId('connection')).toBeVisible()
      await page.evaluate(() => (window as unknown as MockWindow).__mock.setConnectionState('connected'))
      await expect(page.getByTestId('usage-donut-antigravity')).toBeVisible()
      // Uninstalled: it stays in the DOM for its exit, then goes
      await told(page, centralu('not_installed'))
      await expect(page.getByTestId('usage-donut-antigravity')).toHaveAttribute('data-leaving', 'true')
      await expect(page.getByTestId('usage-donut-antigravity')).toHaveCount(0)
      // Installed and signed out again: it comes in
      await told(page, centralu('signed_out'))
      await expect(page.getByTestId('usage-donut-antigravity')).toHaveClass(/cc-donut-in/)
    })
  })

  test.describe('motion (#59, design-system §9)', () => {
    for (const reduced of [false, true]) {
      test(`the line's changes are animated ${reduced ? 'by a short fade, with no travel, under reduced motion' : 'in 150-200 ms'}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
        await setup(page, { projects: ['/tmp/alpha'] })
        await antigravity(page, centralu('signed_out'))
        await pickAntigravity(page)
        await page.getByTestId('tool-blocked-sign-in').click()
        await expect(page.getByTestId('tool-blocked')).toHaveAttribute('data-setup', 'signing_in')
        const swap = page.getByTestId('tool-blocked').locator('.cc-setup-swap')
        const style = await swap.evaluate((el) => {
          const s = getComputedStyle(el)
          return { name: s.animationName, ms: parseFloat(s.animationDuration) * 1000 }
        })
        if (reduced) {
          expect(style.name).toBe('cc-setup-swap-still')
          expect(style.ms).toBeLessThanOrEqual(120)
        } else {
          expect(style.name).toBe('cc-setup-swap')
          expect(style.ms).toBeGreaterThanOrEqual(150)
          expect(style.ms).toBeLessThanOrEqual(200)
        }
        // The line folds away on success, and Start never waits for it
        await told(page, centralu('ready'))
        await expect(page.getByTestId('create-session-confirm')).toBeEnabled()
        await expect(page.getByTestId('tool-blocked')).toHaveCount(0)
      })
    }
  })
}

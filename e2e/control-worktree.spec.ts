import { test, expect } from '@playwright/test'
import { setup, newSession } from './fixtures/control.js'

/**
 * The control loop's scenarios on worktree sessions: the toggle, branches, setup, proposals and merged or PR badges. Moved out of control-loop.spec.ts by subject (#845); the
 * shared helpers (setup, newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

/**
 * The worktree option (FR-2).
 *
 * The spec's principle is "work directly in the original directory", and a worktree is turned on
 * only by **the person who wants one**. So the screen has to hold two things: it defaults to
 * off, and once it is on, that fact must be visible.
 */
test('The worktree defaults to off, and turning it on shows the branch on the session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  const toggle = page.getByTestId('worktree-toggle').locator('input')
  await expect(toggle).not.toBeChecked()

  await toggle.check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('fix it in isolation')
  await page.getByTestId('prompt-input').press('Enter')

  // If it stays invisible that this runs in a different directory, the person hits "why isn't my
  // project folder changing"
  await expect(page.getByTestId('worktree-badge')).toBeVisible()
  await expect(page.getByTestId('worktree-badge')).toContainText('centralu/')
})

test('A session with the worktree off has no badge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await newSession(page, 'alpha', 'just do it here')

  await expect(page.getByTestId('worktree-badge')).toHaveCount(0)
})

/**
 * A worktree's **lifetime differs from the session's.** Hours of an agent's work can be sitting
 * in it, so the default is to keep it, and deleting it requires the person to read what would be
 * lost and turn that on themselves.
 */
test('Deleting a worktree session asks first, and deletion requires opting in', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  // The first instruction goes in the composer, not the modal — the dialog has no prompt field (#8)
  await page.getByTestId('prompt-input').fill('isolated session')
  await page.getByTestId('prompt-input').press('Enter')

  // Set up uncommitted changes — the dialog must state what would be lost in that case
  await page.evaluate(() => {
    ;(window as any).__mock.mockWorktreeDirty = true
  })

  // A worktree session the person makes stands on its own (#561 part 3): it is the project's only row
  await page.getByTestId('sidebar').getByTestId(/^session-menu-/).first().click()
  await page.getByTestId(/^delete-session-/).click()

  const panel = page.getByTestId('delete-worktree')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('worktree-dirty')).toContainText('2')

  // Off by default — if deleting were the default, an irreversible action would happen quietly
  await expect(page.getByTestId('delete-worktree-toggle')).not.toBeChecked()
})

test('Deleting a non-worktree session never mentions worktrees', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await newSession(page, 'alpha', 'regular session')

  await page
    .getByTestId(/^session-menu-/)
    .first()
    .click()
  await page
    .getByTestId(/^delete-session-/)
    .first()
    .click()

  await expect(page.getByTestId('confirm-delete')).toBeVisible()
  await expect(page.getByTestId('delete-worktree')).toHaveCount(0)
})

/**
 * The session tree (#69, #561): a worktree session the person makes stands on its own, and one a session started
 * (start_agent) is drawn nested under that session. The worktree manager the tree used to hang from was folded into
 * ordinary sessions (#561 part 3), so making a worktree session adds no manager row.
 */
test('A worktree session the person makes stands on its own; one a session started sits under that session', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  const sidebar = page.getByTestId('sidebar')
  await expect(sidebar.getByText('Worktree manager', { exact: true })).toHaveCount(0)
  await expect(page.locator('li[data-nested]')).toHaveCount(0)

  // The host opens a worktree child started by that session (start_agent), linked to it
  await page.evaluate(() => {
    const m = (window as any).__mock
    const parent = [...m.sessions.values()][0]
    m.emit({
      type: 'session_created',
      sessionId: 'child-1',
      session: {
        ...parent,
        id: 'child-1',
        name: 'centralu/write-the-parser-1a2b',
        worktree: { path: '/tmp/wt/child-1', branch: 'centralu/write-the-parser-1a2b' },
        parentSessionId: parent.id,
        askedBy: parent.id,
      },
    })
  })
  await expect(page.locator('li[data-nested]')).toHaveCount(1)
  await expect(page.locator('li[data-nested]').getByText('centralu/write-the-parser-1a2b')).toBeVisible()

  // A child in the parent's own folder nests under it too: grouped by who started it (owner decision, #561)
  await page.evaluate(() => {
    const m = (window as any).__mock
    const parent = [...m.sessions.values()][0]
    m.emit({
      type: 'session_created',
      sessionId: 'child-2',
      session: { ...parent, id: 'child-2', name: 'review the parser', worktree: null, parentSessionId: null, askedBy: parent.id },
    })
  })
  await expect(page.locator('li[data-nested]')).toHaveCount(2)
  await expect(page.locator('li[data-nested]').getByText('review the parser')).toBeVisible()
})

/**
 * The project's worktree trunk (#76) is still what a new worktree session forks from by default. Nothing in the project
 * menu sets it any more (#733): it is detected, and the store keeps `setWorktreeTrunk` for whatever sets it next.
 */
test('A new worktree session forks from the project trunk, and the project menu no longer sets it (#733)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await page.evaluate(() => {
    const st = (window as any).__store.getState()
    return st.setWorktreeTrunk(Object.keys(st.projects)[0], 'develop')
  })

  await page.getByTestId('project-menu-alpha').click()
  await expect(page.getByTestId('project-menu-open-alpha')).toBeVisible()
  await expect(page.locator('[data-testid^="worktree-trunk-"]')).toHaveCount(0)
  await expect(page.getByTestId('project-menu-open-alpha')).not.toContainText(/trunk/i)
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await expect(page.getByTestId('worktree-base-input')).toHaveValue('develop')
})

test('Naming the worktree branch becomes the session name', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  // The branch field does not exist before the worktree is turned on — details of an off option
  // are never expanded ahead of time
  await expect(page.getByTestId('worktree-branch-input')).toHaveCount(0)
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/login-fix')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // Session name = branch name — that name appears on its row in the sidebar
  await expect(page.getByTestId('sidebar').getByText('feat/login-fix')).toBeVisible()
})

/**
 * Where it branches from (pointed out by the person, 2026-09-07: "when creating a worker there
 * is no way to say which branch to base it on").
 *
 * It used to be a fact nowhere on screen — the host quietly branched from the trunk (or HEAD if
 * there was none). Now that default is written in a field, and it can be changed.
 */
test('Turning on the worktree shows where it branches from, and it can be changed before sending', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'release', current: false, remote: false },
    ]
  })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  // Details of an off option are never expanded ahead of time — the same rule as the branch field
  await expect(page.getByTestId('worktree-base-input')).toHaveCount(0)
  await page.getByTestId('worktree-toggle').locator('input').check()

  // The default is exactly what used to happen quietly (the project's current branch)
  await expect(page.getByTestId('worktree-base-input')).toHaveValue('main')

  await page.getByTestId('worktree-base-input').fill('release')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // The choice actually reached the host — a field that exists only on screen would mean nothing
  // was actually changed
  await expect
    .poll(async () =>
      page.evaluate(() => (window as never as { __mock: any }).__mock.lastCreateParams?.worktreeBase),
    )
    .toBe('release')
})

/**
 * The manager's worktree proposal (#69) — the third case of propose-not-power.
 * A proposal line stays in the conversation, the + button lights up, and opening it comes with
 * the branch name already filled in. Creating it remains, to the end, the person's own act.
 */
test('Worktree proposal: a line stays in the conversation, + lights up, and the dialog comes pre-filled with the name', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  // A session whose conversation holds a proposal (the worktree manager made them before #561 part 3)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // Open the session and replay a proposal in it — the branch name arrives in the title
  await page.evaluate(() => {
    const m = (window as any).__mock
    const manager = [...m.sessions.values()][0]
    ;(window as any).__store.getState().focusSession(manager.id)
    m.emit({
      type: 'tool_call',
      sessionId: manager.id,
      callId: 'c-prop',
      summary: {
        tool: 'mcp__centralu__propose_worktree_session',
        title: 'feat/proposed-work',
        paths: [],
      },
    })
  })

  // The proposal line in the conversation — one line that points, not a tool card
  await expect(page.getByTestId('worktree-proposal')).toContainText('feat/proposed-work')
  // This project's + button lights up
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(1)

  // Opening that door: worktree turned on + branch name filled in
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).toBeChecked()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/proposed-work')

  // The proposal is consumed the moment it is opened — closing and reopening gives an ordinary
  // empty dialog
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(0)
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-toggle').locator('input')).not.toBeChecked()
})

/**
 * Worktree provisioning (#69) — expanded input fields on first use, a collapsed summary after
 * saving. The setup is persisted before creation (since the host reads and runs it during
 * creation).
 */
test('Worktree setup: input fields at first, collapsing into a summary once saved', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  // With no saved setup, the input fields stay expanded
  await expect(page.getByTestId('worktree-setup-edit')).toBeVisible()
  await page.getByTestId('worktree-setup-command').fill('pnpm install')
  await page.getByTestId('worktree-copy-files').fill('.env.local, .env')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  // It was saved — this also checks whether the mock normalized it the same way the real thing does
  const saved = await page.evaluate(() => {
    const m = (window as any).__mock
    return m.projectsList?.[0]?.worktreeSetup ?? [...(m.projectsList ?? [])][0]?.worktreeSetup
  })
  expect(saved).toEqual({ command: 'pnpm install', copyFiles: ['.env.local', '.env'] })

  // Opening it next time shows one collapsed summary line — clicking it allows editing again
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await expect(page.getByTestId('worktree-setup-summary')).toContainText('setup: pnpm install')
  await expect(page.getByTestId('worktree-setup-summary')).toContainText('copies: .env.local, .env')
  await page.getByTestId('worktree-setup-summary').click()
  await expect(page.getByTestId('worktree-setup-command')).toHaveValue('pnpm install')
})

/**
 * Copy candidates (#76) — the app only **points them out.**
 *
 * The reason "copy everything ignored" is never the default is right there on this screen:
 * node_modules at 637MB sits in the list with its size shown, and whether to click it is for the
 * person to decide.
 */
test('Worktree setup: gitignored candidates are pointed out, and clicking adds or removes them', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await page.evaluate(() => {
    ;(window as any).__mock.gitState.ignored = [
      { path: 'node_modules/', bytes: 668213248 },
      { path: '.env.local', bytes: 24 },
      { path: 'weird/', bytes: null },
    ]
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()

  // The size shows alongside — the judgment a person makes from this list is "this is too big"
  await expect(page.getByTestId('ignored-node_modules/')).toContainText('637 MB')
  // Something whose size could not be measured still appears in the list (the size is only a hint)
  await expect(page.getByTestId('ignored-weird/')).toBeVisible()

  await page.getByTestId('ignored-.env.local').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('.env.local')
  await page.getByTestId('ignored-node_modules/').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('.env.local, node_modules/')
  // Clicking it again removes it — the field remains the source of truth, so it never diverges
  // from what was typed by hand
  await page.getByTestId('ignored-.env.local').click()
  await expect(page.getByTestId('worktree-copy-files')).toHaveValue('node_modules/')

  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  const saved = await page.evaluate(() => (window as any).__mock.projectsList[0].worktreeSetup)
  expect(saved).toEqual({ command: '', copyFiles: ['node_modules/'] })
})

/** The merged badge (#69) — reporting the fact becomes a badge, and cleanup is left to the person via the delete dialog */
test('Merging a branch shows a merged badge on the sidebar row', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/badge')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(0)

  // The host's own detection emits this event — merging from the terminal follows the same path
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({ type: 'worktree_merged', sessionId: child.id })
  })

  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(1)
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveText('merged')
})

/** The PR chip (#76 stage 3) — the PR state measured by gh becomes a chip, and it yields its spot to the merged badge once merged */
test('Opening a PR shows a PR chip, and merging replaces it with the merged badge', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })

  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('worktree-branch-input').fill('feat/pr-chip')
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveCount(0)

  // The host's gh measurement emits this event — the signal that covers the blind spot of a
  // squash merge
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({
      type: 'worktree_pr',
      sessionId: child.id,
      pr: { number: 12, state: 'open', url: 'https://github.com/x/y/pull/12' },
    })
  })
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveText('PR #12')

  // Once merged, the outcome is stated only once — the merged badge appears and the PR chip steps
  // aside
  await page.evaluate(() => {
    const m = (window as any).__mock
    const child = [...m.sessions.values()].find((s: any) => s.worktree)
    m.emit({ type: 'worktree_merged', sessionId: child.id })
  })
  await expect(page.locator('[data-testid^="merged-badge-"]')).toHaveCount(1)
  await expect(page.locator('[data-testid^="pr-badge-"]')).toHaveCount(0)
})

/** #69 dogfooding finding 3: proposals are a queue — receiving two, opening + twice consumes both */
test('Two worktree proposals fill in order across two dialog openings', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'], trusted: true })
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await page.getByTestId('worktree-toggle').locator('input').check()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('new-session-dialog')).toBeHidden()

  await page.evaluate(() => {
    const m = (window as any).__mock
    const manager = [...m.sessions.values()][0]
    for (const branch of ['feat/first', 'feat/second']) {
      m.emit({
        type: 'tool_call',
        sessionId: manager.id,
        callId: 'c-' + branch,
        summary: {
          tool: 'mcp__centralu__propose_worktree_session',
          title: branch,
          paths: [],
        },
      })
    }
  })

  await page.getByTestId('project-menu-alpha').click()

  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/first')
  await page.keyboard.press('Escape')
  await page.getByTestId('project-menu-alpha').click()
  await page.getByTestId('new-session-alpha').click()
  await expect(page.getByTestId('worktree-branch-input')).toHaveValue('feat/second')
  await page.keyboard.press('Escape')
  // The queue is empty — the glow turns off, and the next dialog is an ordinary one
  await expect(page.locator('[data-worktree-proposal]')).toHaveCount(0)
})

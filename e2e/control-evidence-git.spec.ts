import { test, expect } from '@playwright/test'
import { copied, pressCopy, watchCopies } from './fixtures/clipboard.js'
import { setup, newSession } from './fixtures/control.js'

/**
 * The control loop's scenarios on the evidence panel: git changes, staging, commits and history.
 * Moved out of control-evidence-git-files.spec.ts by subject; the shared helpers (setup,
 * newSession, emitEvent and the rest) are in fixtures/control.ts.
 */

test('Git: the diff gets the wide area; the list, staging and commit live in the sidebar (B-2, B-6 — left column removed 2026-09-07)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/new.ts', staged: false, status: '?' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged'
  })
  await newSession(page, 'alpha', 'task')

  // Clicking a file in the sidebar opens the wide diff — the wide area has no list in it
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  await expect(page.getByTestId('git-panel').locator('[data-testid^="git-file-"]')).toHaveCount(0)
  // The diff is achromatic: distinguished by symbol and brightness, not color
  await expect(page.locator('[data-diff="add"]')).toContainText('new line')
  await expect(page.locator('[data-diff="del"]')).toContainText('old line')

  // The sidebar is the source of truth for staging and commit (visible even with an overlay open — #15)
  await page.getByTestId('evidence-stage-all').click()
  await page.getByTestId('evidence-commit-message').fill('test commit')
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('test commit')
})

/*
 * #1007: a commit or push waits up to ten minutes on a hook or a credential helper waiting on a sign-in (#980), and
 * the panel's buttons wait with it. Cancel ends it; the toast says it was cancelled, not that it failed.
 */
test('Git panel: a commit or push still running can be cancelled (#1007)', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: true, status: 'M' }]
    m.gitState.holdWrites = true
  })
  await newSession(page, 'alpha', 'task')

  // Nothing to cancel while nothing runs
  await expect(page.getByTestId('evidence-git-cancel')).toHaveCount(0)
  await page.getByTestId('evidence-commit-message').fill('held commit')
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('evidence-push')).toBeDisabled()
  await page.getByTestId('evidence-git-cancel').click()
  await expect(page.getByTestId('toast')).toContainText('Commit cancelled')
  await expect(page.getByTestId('evidence-git-cancel')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBeUndefined()
  // The message stays for the next try
  await expect(page.getByTestId('evidence-commit-message')).toHaveValue('held commit')

  await page.getByTestId('evidence-push').click()
  await page.getByTestId('evidence-git-cancel').click()
  await expect(page.getByTestId('toast')).toContainText('Push cancelled')
  await expect(page.getByTestId('evidence-push')).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__mock.gitState.pushed)).toBe(false)
})

test('Git panel: a copied diff comes out exactly as that diff (#36)', async ({ page }) => {
  const diff =
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-const old = 1\n+const next = 1\n   indented\n unchanged'
  await watchCopies(page)
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate((d) => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = d
  }, diff)
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toBeVisible()

  // Drag the whole diff. Nothing here is virtualized, so every row is under the pointer —
  // what went wrong is the marker: it lives in its own select-none span, and here the
  // browser honours that and drops it, leaving added and removed lines identical.
  const rows = page.locator('[data-testid="diff-view"] [data-diff]')
  const first = (await rows.first().boundingBox())!
  const last = (await rows.last().boundingBox())!
  // From the very left edge — the marker column, which is the start of the line
  await page.mouse.move(first.x + 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.x + last.width - 4, last.y + last.height / 2, { steps: 10 })
  await page.mouse.up()
  await pressCopy(page)

  // Whatever it looks like on screen, what comes off it is a diff you can apply: ASCII
  // markers rather than the typographic −, and indentation the DOM had already collapsed
  expect(await copied(page)).toBe(diff)

  // The file header used to lose a dash to the marker-stripping, on screen too
  await expect(page.getByTestId('diff-view')).toContainText('--- a/src/a.ts')
})

test('Git panel: checking out with a dirty working tree is not blocked — the result is shown first (B-4)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.branches = [
      { name: 'main', current: true, remote: false },
      { name: 'feature/x', current: false, remote: false },
      { name: 'origin/main', current: false, remote: true },
    ]
    m.gitState.dirty = ['src/a.ts']
  })
  await newSession(page, 'alpha', 'task')
  await page.getByTestId('evidence-branch').click()
  // The panels split by the remote flag the host provides — a `/` in the name cannot distinguish
  // local feature/x from remote origin/main (#175)
  await expect(page.getByTestId('branches-remote').getByTestId('branch-origin/main')).toBeVisible()
  await expect(page.getByTestId('branches-local').getByTestId('branch-feature/x')).toBeVisible()
  await page.getByTestId('branch-feature/x').click()

  await expect(page.getByTestId('checkout-warning')).toContainText('src/a.ts')
  await page.getByTestId('checkout-proceed').click()
  await expect(page.getByTestId('toast')).toContainText('Switched')
})

test('The Git tab is disabled when the project is not a git repository (B-1 abnormal path)', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(async () => {
    const store = (window as any).__store
    const m = (window as any).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit',
      path,
      name: 'nogit',
      defaultTool: 'claude',
      git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await page.getByTestId('project-menu-nogit').click()
  await page.getByTestId('new-session-nogit').click()
  await page.getByTestId('create-session-confirm').click()
  await expect(page.getByTestId('evidence-tab-git')).toBeDisabled()
  await expect(page.getByTestId('evidence-not-repo')).toBeVisible()
})

test('A permission denial is explained separately from "not a repository" (F-1, reflecting what was actually measured)', async ({
  page,
}) => {
  await setup(page)
  await page.evaluate(async () => {
    const m = (window as any).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-denied',
      path,
      name: 'denied',
      defaultTool: 'claude',
      git: { branch: '', changedFiles: 0, isRepo: true, denied: true },
    })
    await (window as any).__store.getState().addProject('/Users/me/Desktop/proj')
  })
  // Being blocked shows immediately as a marker, and hovering explains what to do about it
  await expect(page.getByTestId('git-denied-denied')).toBeVisible()
  await page.getByTestId('project-header-denied').hover()
  await expect(page.getByTestId('git-denied')).toContainText('permission')
})

/** Evidence panel: split by tabs, and collapsing still leaves a way to bring it back */
test('Evidence panel tabs: Git shows only changes, and History shows the graph in its own tab', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: 'First commit', author: 'me', when: Date.now(), parents: [] },
      {
        sha: 'bbb222',
        shortSha: 'bbb222',
        subject: 'second',
        author: 'me',
        when: Date.now(),
        parents: ['a', 'b'],
      },
    ]
    m.fsState.entries[''] = [{ name: 'README.md', path: 'README.md', isDir: false, ignored: false }]
  })
  await newSession(page, 'alpha', 'task')

  // The Git tab is the default — only changes. The history strip was moved off, covering the
  // neighboring tab strip during the split (#20)
  await expect(page.getByTestId('evidence-git')).toBeVisible()
  await expect(page.getByTestId('evidence-file-src/a.ts')).toBeVisible()
  await expect(page.getByTestId('evidence-tree')).toHaveCount(0)

  // History lives under the History tab — the lane graph that used to live in the strip moved
  // here too
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-aaa111')).toContainText('First commit')
  await expect(page.getByTestId('history-commit-bbb222')).toContainText('merge')
  await expect(page.getByTestId('commit-graph-aaa111')).toBeVisible()

  // Switching to the Files tab shows only the tree
  await page.getByTestId('evidence-tab-files').click()
  await expect(page.getByTestId('file-README.md')).toBeVisible()
  await expect(page.getByTestId('evidence-git')).toBeHidden()

  // The chosen tab is recorded in the snapshot
  const snap = await page.evaluate(() => (window as any).__mock.workspaceSnapshot)
  expect(snap?.panelTab).toBe('files')
})

test('Clicking a commit in History opens it in the wide area', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'aaa111', shortSha: 'aaa111', subject: 'First commit', author: 'me', when: Date.now(), parents: [] },
    ]
    m.gitState.diffs['aaa111'] = '@@ -0,0 +1 @@\n+new line'
  })
  await newSession(page, 'alpha', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa111').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('new line')
})

test('Staging and committing still work in a narrow panel', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
  })
  await newSession(page, 'alpha', 'task')

  // Commit is disabled before staging (a live commit button with nothing staged would be a lie)
  await page.getByTestId('evidence-commit-message').fill('commit from the panel')
  await expect(page.getByTestId('evidence-commit')).toBeDisabled()

  await page.getByTestId('evidence-stage-all').click()
  await page.getByTestId('evidence-commit').click()
  await expect(page.getByTestId('toast')).toContainText('Committed')
  expect(await page.evaluate(() => (window as any).__mock.gitState.lastCommitMessage)).toBe('commit from the panel')
})

/**
 * The Git tab — like VSCode, shows staged and unstaged changes separately.
 * The one fact that matters right before a commit is "what is going in", and mixing everything
 * into a single list meant reading that off a small tag at the end of each row.
 */
test('The Git panel separates staged from changed and lets each file be staged individually', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: true, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'task')

  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/a.ts')
  await expect(page.getByTestId('evidence-group-changed')).toContainText('src/b.ts')

  // Stage only one file — no need to drop into the terminal just to "commit everything but this"
  await page.getByTestId('evidence-stage-src/b.ts').click({ force: true })
  await expect(page.getByTestId('evidence-group-changed')).toBeHidden()
  await expect(page.getByTestId('evidence-group-staged')).toContainText('src/b.ts')
})

/** Dots alone make a list, not a tree — branching and merging must be shown as lines */
test('Git history connects commits with lines', async ({ page }) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await page.evaluate(() => {
    const m = (window as any).__mock
    m.gitState.commits = [
      { sha: 'm', shortSha: 'mmmmmmm', subject: 'Merge', author: 'a', when: 0, parents: ['x', 'y'] },
      { sha: 'x', shortSha: 'xxxxxxx', subject: 'Trunk', author: 'a', when: 0, parents: ['z'] },
      { sha: 'y', shortSha: 'yyyyyyy', subject: 'Branch', author: 'a', when: 0, parents: ['z'] },
      { sha: 'z', shortSha: 'zzzzzzz', subject: 'Root', author: 'a', when: 0, parents: [] },
    ]
  })
  await newSession(page, 'alpha', 'task')
  // The graph lives in the History tab — the Git tab's strip was moved off, covering its neighbor
  // during the split
  await page.getByTestId('evidence-tab-history').click()

  // Two branches extend from the merge commit (one straight line + one curving line)
  const merge = page.getByTestId('commit-graph-mmmmmmm')
  await expect(merge).toBeVisible()
  expect(await merge.locator('path').count()).toBeGreaterThan(0)

  // Since the branch merges into the trunk, only one line comes down to the root
  await expect(page.getByTestId('commit-graph-zzzzzzz')).toBeVisible()
})

/**
 * Three spots in the Git tab (#160).
 *
 * The moment everything was committed and the list emptied, Push disappeared along with it; the
 * panel's list only re-read when the count of files the agent touched changed, missing terminal
 * commits, Bash commits, re-editing the same file, and returning to the window; and a partially
 * staged file opened the staged diff even when clicked from Changed.
 */
test('Git tab: Push remains even when clean, the list re-reads on window return, and clicking opens the diff for the clicked group (#160)', async ({
  page,
}) => {
  await setup(page, { projects: ['/tmp/alpha'] })
  await newSession(page, 'alpha', 'task')

  await expect(page.getByTestId('evidence-clean')).toBeVisible()
  await expect(page.getByTestId('evidence-push')).toBeVisible()

  // Partially staged one file from outside the app — the count of files the agent touched is unchanged
  await page.evaluate(() => {
    const store = (window as any).__store.getState()
    store.setAppFocused(false)
    ;(window as any).__mock.gitState.files = [
      { path: 'a.ts', staged: true, status: 'M' },
      { path: 'a.ts', staged: false, status: 'M' },
    ]
    store.setAppFocused(true)
  })
  const changed = page.getByTestId('evidence-group-changed').getByTestId('evidence-file-a.ts')
  await expect(changed).toBeVisible()

  await changed.click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__mock.gitDiffCalls.at(-1)))
    .toEqual({ path: 'a.ts', staged: false })
})

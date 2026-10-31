import { expect, test, type Page } from '@playwright/test'
import { setup as firstRun } from './fixtures/control.js'
import { setup, newSession } from './fixtures/panel.js'
import { startSession } from './fixtures/new-session.js'

/**
 * The right-hand panel and the grid around it: the history tab and the change list's diff. Moved
 * out of panel.spec.ts by subject; the shared helpers (setup, newSession, openGrid) are in
 * fixtures/panel.ts.
 */


/*
 * ── History tab (#21) ────────────────────────────────────────────────────
 *
 * The history strip inside the git tab is a context glanced at while making a commit, so it is
 * capped at seven rows. Coming **to read** the history is a different purpose and uses a whole
 * vertical panel.
 */

/** Builds a commit list, pushing `when` back one day at a time (so the relative date differs per row) */
async function seedCommits(
  page: Page,
  list: { sha: string; subject: string; author: string; daysAgo: number }[],
) {
  await page.evaluate((rows: typeof list) => {
    ;(window as never as { __mock: any }).__mock.gitState.commits = rows.map((r) => ({
      sha: r.sha,
      shortSha: r.sha.slice(0, 7),
      subject: r.subject,
      author: r.author,
      when: Date.now() - r.daysAgo * 86_400_000,
      parents: [],
    }))
  }, list)
}

test('history is a tab next to git, showing the short hash together with how long ago', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'First commit', author: 'me', daysAgo: 0 },
    { sha: 'bbb2222', subject: 'second', author: 'me', daysAgo: 3 },
  ])
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('evidence-history')).toBeVisible()
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('First commit')
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('aaa1111')
  await expect(page.getByTestId('history-commit-bbb2222')).toContainText('3d ago')

  // The selected tab is carried in the snapshot, for the next time it opens
  const snap = await page.evaluate(() => (window as never as { __mock: any }).__mock.workspaceSnapshot)
  expect(snap?.panelLayout?.[0]?.active).toBe('history')
})

test('a single-author repository does not repeat the name, but shows it once there are several authors', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'solo work', author: 'me', daysAgo: 1 },
    { sha: 'bbb2222', subject: 'that too, alone', author: 'me', daysAgo: 2 },
  ])
  await newSession(page, 'alpha', 'claude', 'task')
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-aaa1111')).toContainText('1d ago')
  // At 340px, the same name on every row is noise, not information
  await expect(page.getByTestId('history-commit-aaa1111')).not.toContainText('me')

  // Once there is someone to distinguish, it makes room at that point
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'what I did', author: 'me', daysAgo: 1 },
    { sha: 'bbb2222', subject: 'what you did', author: 'you', daysAgo: 2 },
  ])
  await page.getByTestId('evidence-tab-files').click()
  await page.getByTestId('evidence-tab-history').click()
  await expect(page.getByTestId('history-commit-bbb2222')).toContainText('you')
})

test('clicking a commit opens its diff in the wide view', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [{ sha: 'aaa1111', subject: 'First commit', author: 'me', daysAgo: 0 }])
  await page.evaluate(() => {
    ;(window as never as { __mock: any }).__mock.gitState.diffs['aaa1111'] = '@@ -0,0 +1 @@\n+new line'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('overlay')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toContainText('new line')
})

/** A list that is silently cut off is a list that lies by implying "there are no older commits" */
test('the list cuts off at 100, and the screen says so', async ({ page }) => {
  await setup(page)
  await seedCommits(
    page,
    Array.from({ length: 130 }, (_, i) => ({
      sha: `c${String(i).padStart(6, '0')}`,
      subject: `commit ${i}`,
      author: 'me',
      daysAgo: i,
    })),
  )
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.locator('[data-testid^="history-commit-"]')).toHaveCount(100)
  await expect(page.getByTestId('evidence-history-cap')).toContainText('Newest 100 commits')
})

test('below the cap, it does not mention being cut off at all', async ({ page }) => {
  await setup(page)
  await seedCommits(
    page,
    Array.from({ length: 12 }, (_, i) => ({
      sha: `c${String(i).padStart(6, '0')}`,
      subject: `commit ${i}`,
      author: 'me',
      daysAgo: i,
    })),
  )
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await expect(page.locator('[data-testid^="history-commit-"]')).toHaveCount(12)
  await expect(page.getByTestId('evidence-history-cap')).toBeHidden()
})

/*
 * ── Change list → diff ─────────────────────────────────────────────────
 *
 * The right-hand list stays visible while the wide view is open (#15), and that was the
 * point of leaving it there: it is where the next file comes from. So a click on it has to
 * land in the diff every time, not just the first time.
 */

/**
 * The letter in front of each row says **what happened** (user request, 2026-09-10). The `?` git
 * writes for a new file reads on screen as "unknown," but it is actually a known fact — a newly
 * created file, so it is A (added). D (deleted) and M (modified) use git's own letters as-is.
 */
test('a new file shows A and a deleted file shows D', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/new.ts', staged: false, status: '?' },
      { path: 'src/gone.ts', staged: false, status: 'D' },
      { path: 'src/old.ts', staged: false, status: 'M' },
    ]
  })
  await newSession(page, 'alpha', 'claude', 'task')

  const mark = async (path: string) =>
    page.getByTestId(`evidence-file-${path}`).locator('span').first().textContent()
  expect(await mark('src/new.ts')).toBe('A')
  expect(await mark('src/gone.ts')).toBe('D')
  expect(await mark('src/old.ts')).toBe('M')
})

test('the diff follows even a second file click — the list is not covered, so it stays clickable', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+line from the first file'
    m.gitState.diffs['src/b.ts'] = '@@ -1 +1 @@\n+line from the second file'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')

  // This was broken here: the name changed to src/b.ts but the content below was still the first file's diff
  await page.getByTestId('evidence-file-src/b.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the second file')
  await expect(page.getByTestId('diff-view')).not.toContainText('line from the first file')
})

test('a file picked from the wide list is not reverted by a list refresh', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [
      { path: 'src/a.ts', staged: false, status: 'M' },
      { path: 'src/b.ts', staged: false, status: 'M' },
    ]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+line from the first file'
    m.gitState.diffs['src/b.ts'] = '@@ -1 +1 @@\n+line from the second file'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')

  // The next file is also picked from the sidebar — there is no list inside the wide view (the left column was removed on 2026-09-07)
  await page.getByTestId('evidence-file-src/b.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the second file')
  await page.getByTestId('evidence-stage-all').click()
  await expect(page.getByTestId('evidence-unstage-all')).toBeVisible()
  // Even if staging changes the list, the diff being viewed must not be dragged back to the first path
  await expect(page.getByTestId('diff-view')).toContainText('line from the second file')
})

test('clicking the same file again still opens it — even after switching to a different tab', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.files = [{ path: 'src/a.ts', staged: false, status: 'M' }]
    m.gitState.diffs['src/a.ts'] = '@@ -1 +1 @@\n+line from the first file'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')

  // After switching to the branch view from the sidebar (there is no tab inside the overlay — the only entry point is the sidebar, since 2026-09-07)
  await page.getByTestId('evidence-branch').click()
  await expect(page.getByTestId('git-branches')).toBeVisible()

  // Click the same file again — a matching path must not mean "nothing happened"
  await page.getByTestId('evidence-file-src/a.ts').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first file')
  await expect(page.getByTestId('git-branches')).toBeHidden()
})

/*
 * Clicking commit A and then B: A's answer arrives last, and only the newest click may draw. The changes screen has
 * always guarded this (its diff is the basis of an approval); the commit screen had no guard and drew A under B.
 */
test('the commit screen draws the commit picked last, even when an earlier one answers later', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'first', author: 'me', daysAgo: 1 },
    { sha: 'bbb2222', subject: 'second', author: 'me', daysAgo: 0 },
  ])
  await page.evaluate(() => {
    const w = window as never as { __mock: any; __slowDone?: boolean }
    w.__mock.gitState.diffs['aaa1111'] = ['@@ -1 +1 @@', '+diff of the slow commit'].join('\n')
    w.__mock.gitState.diffs['bbb2222'] = ['@@ -1 +1 @@', '+diff of the quick commit'].join('\n')
    const git = w.__mock.git
    const real = git.commitDetail
    // The first commit answers after the second one has
    git.commitDetail = async (projectId: string, sha: string) => {
      const answer = await real(projectId, sha)
      if (sha === 'aaa1111') {
        await new Promise((r) => setTimeout(r, 600))
        w.__slowDone = true
      }
      return answer
    }
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  // The panel is open and waiting for the first commit when the second is picked
  await expect(page.getByTestId('git-panel')).toBeVisible()
  await page.getByTestId('history-commit-bbb2222').click()
  await expect(page.getByTestId('diff-view')).toContainText('diff of the quick commit')
  await page.waitForFunction(() => (window as never as { __slowDone?: boolean }).__slowDone === true)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 100)))

  await expect(page.getByTestId('diff-view')).toContainText('diff of the quick commit')
  await expect(page.getByTestId('diff-view')).not.toContainText('diff of the slow commit')
})

/*
 * A commit diff is several files in one text — a sticky band appears at every file boundary
 * (user's choice, 2026-09-07: a row of chips breaks the UI once there are many files). Only the
 * display gets a band; data-line stays untouched, so copying still produces the original
 * `diff --git` line (#36).
 */
test('a file-name band appears at every file boundary of a commit diff', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [{ sha: 'aaa1111', subject: 'commit touching two files', author: 'me', daysAgo: 0 }])
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.diffs['aaa1111'] = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '+first file line',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '+second file line',
    ].join('\n')
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('diff-view')).toContainText('first file line')

  const bands = page.getByTestId('diff-file-band')
  await expect(bands).toHaveCount(2)
  await expect(bands.nth(0)).toHaveText('src/a.ts')
  await expect(bands.nth(1)).toHaveText('src/b.ts')
})

test('a commit also opens from the second click onward — the list stays, so it stays clickable', async ({ page }) => {
  await setup(page)
  await seedCommits(page, [
    { sha: 'aaa1111', subject: 'First commit', author: 'me', daysAgo: 0 },
    { sha: 'bbb2222', subject: 'second', author: 'me', daysAgo: 1 },
  ])
  await page.evaluate(() => {
    const m = (window as never as { __mock: any }).__mock
    m.gitState.diffs['aaa1111'] = '@@ -0,0 +1 @@\n+line from the first commit'
    m.gitState.diffs['bbb2222'] = '@@ -0,0 +1 @@\n+line from the second commit'
  })
  await newSession(page, 'alpha', 'claude', 'task')

  await page.getByTestId('evidence-tab-history').click()
  await page.getByTestId('history-commit-aaa1111').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the first commit')

  await page.getByTestId('history-commit-bbb2222').click()
  await expect(page.getByTestId('diff-view')).toContainText('line from the second commit')
  await expect(page.getByTestId('diff-view')).not.toContainText('line from the first commit')
})

/** Since this is a question asked of the repository, it is treated the same as the git tab */
test('when there is no git repository, the history tab is disabled just like the git tab', async ({ page }) => {
  await firstRun(page)
  await page.evaluate(async () => {
    const store = (window as never as { __store: any }).__store
    const m = (window as never as { __mock: any }).__mock
    m.projects.add = async (path: string) => ({
      id: 'p-nogit',
      path,
      name: 'nogit',
      defaultTool: 'claude',
      commands: [],
      git: null,
    })
    await store.getState().addProject('/tmp/nogit')
  })
  await startSession(page, 'nogit')

  await expect(page.getByTestId('evidence-tab-git')).toBeDisabled()
  await expect(page.getByTestId('evidence-tab-history')).toBeDisabled()
  await expect(page.getByTestId('evidence-not-repo')).toBeVisible()
})

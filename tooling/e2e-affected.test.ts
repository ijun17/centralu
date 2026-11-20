import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AFFECTED, affectedArgs, affectedEngines, engineOutput, listedCount, mergeBase, noSpecLines, reachesScreen, runAffected, type Engine } from './e2e-affected.js'
import { NO_GIT_MAINTENANCE } from './git-fixture.test-helpers.js'

/* `pnpm e2e --affected` (tooling/e2e-affected.ts): which specs, and what a run that picks none says. */

describe('the affected specs', () => {
  it("are Playwright's --only-changed against the merge-base, the flag itself never reaching Playwright", () => {
    expect(affectedArgs(['test', '--config', 'e2e/playwright.config.ts', AFFECTED, 'grid'], 'abc123')).toEqual(['test', '--config', 'e2e/playwright.config.ts', 'grid', '--only-changed=abc123'])
  })

  it('run in both engines, or in the one E2E_BROWSER names', () => {
    expect(affectedEngines({})).toEqual(['chromium', 'webkit'])
    expect(affectedEngines({ E2E_BROWSER: 'chromium' })).toEqual(['chromium'])
    expect(affectedEngines({ E2E_BROWSER: 'webkit' })).toEqual(['webkit'])
    expect(affectedEngines({ E2E_BROWSER: 'firefox' })).toEqual(['chromium', 'webkit'])
  })

  it("keep each engine's results apart, beside the config, where Playwright would put them", () => {
    expect(engineOutput(['test', '--config', 'e2e/playwright.config.ts'], 'webkit')).toBe(`--output=${join('e2e', 'test-results', 'webkit')}`)
    expect(engineOutput(['test', '--config=e2e/ux/playwright.config.ts'], 'chromium')).toBe(`--output=${join('e2e', 'ux', 'test-results', 'chromium')}`)
    expect(engineOutput(['test', '-c', 'e2e/playwright.config.ts', 'grid'], 'webkit')).toBe(`--output=${join('e2e', 'test-results', 'webkit')}`)
    expect(engineOutput(['test'], 'webkit')).toBe(`--output=${join('test-results', 'webkit')}`)
  })

  it('are counted from the listing, one test or many, and not guessed from a listing without a count', () => {
    expect(listedCount('Listing tests:\n  [app] › grid.spec.ts:3:1 › a\nTotal: 1 test in 1 file\n')).toBe(1)
    expect(listedCount('Total: 12 tests in 3 files')).toBe(12)
    expect(listedCount('Total: 0 tests in 0 files')).toBe(0)
    expect(listedCount('Error: no config')).toBeNull()
  })

  it('when none is picked, say so, and point to a filter only when the change reaches the screen', () => {
    expect(noSpecLines('0123456789abcdef', false)).toEqual(["e2e: no spec is affected (Playwright's --only-changed against 0123456789); nothing ran."])
    const screen = noSpecLines('0123456789abcdef', true)
    expect(screen).toHaveLength(2)
    expect(screen[1]).toContain('`CI=1 pnpm e2e <filter>`')
  })

  it('are measured from where the branch left main, not from main as it is now', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cc-e2e-affected-'))
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...NO_GIT_MAINTENANCE }
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env }).trim()
    try {
      git('init', '-q', '-b', 'main')
      writeFileSync(join(repo, 'a.txt'), 'a\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'fork')
      const fork = git('rev-parse', 'HEAD')
      git('checkout', '-q', '-b', 'feat')
      git('commit', '-q', '--allow-empty', '-m', 'feat')
      git('checkout', '-q', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'main moves on')
      git('update-ref', 'refs/remotes/origin/main', 'main')
      git('checkout', '-q', 'feat')
      expect(mergeBase(repo)).toBe(fork)
      expect(mergeBase(repo, 'origin/nothing')).toBeNull()
      // What reaches the screen is CI's answer for the files that differ, the uncommitted ones too
      expect(reachesScreen(fork, repo)).toBe(false)
      mkdirSync(join(repo, 'docs'))
      writeFileSync(join(repo, 'docs/a.md'), 'a\n')
      git('add', '-A')
      expect(reachesScreen(fork, repo)).toBe(false)
      // A new file not yet added, as --only-changed counts it
      mkdirSync(join(repo, 'packages/ui/src'), { recursive: true })
      writeFileSync(join(repo, 'packages/ui/src/a.ts'), 'a\n')
      expect(reachesScreen(fork, repo)).toBe(true)
      git('add', '-A')
      expect(reachesScreen(fork, repo)).toBe(true)
      expect(reachesScreen('not-a-commit', repo)).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('one --affected run', () => {
  const LISTED = 'Total: 2 tests in 1 file'
  function affected(o: { listing?: string; codes?: Partial<Record<Engine, number>>; stopAfter?: 'list' | Engine; screen?: boolean } = {}) {
    const said: string[] = []
    const ran: Engine[] = []
    let stop: number | null = null
    const result = runAffected({
      base: '0123456789abcdef',
      engines: ['chromium', 'webkit'],
      list: () => {
        if (o.stopAfter === 'list') stop = 130
        return Promise.resolve(o.listing ?? LISTED)
      },
      run: (engine) => {
        ran.push(engine)
        if (o.stopAfter === engine) stop = 130
        return Promise.resolve(o.codes?.[engine] ?? 0)
      },
      stopCode: () => stop,
      screen: () => o.screen ?? true,
      say: (line) => said.push(line),
    })
    return result.then((code) => ({ code, ran, said }))
  }

  it('runs each engine in turn and answers the first failing one\'s code', async () => {
    expect(await affected()).toEqual({ code: 0, ran: ['chromium', 'webkit'], said: ['e2e: the affected specs in chromium', 'e2e: the affected specs in webkit'] })
    expect(await affected({ codes: { chromium: 1, webkit: 2 } })).toMatchObject({ code: 1, ran: ['chromium', 'webkit'] })
    expect(await affected({ codes: { webkit: 2 } })).toMatchObject({ code: 2, ran: ['chromium', 'webkit'] })
  })

  it('starts no engine when the listing picks no spec, and says why', async () => {
    const none = await affected({ listing: 'Total: 0 tests in 0 files', screen: false })
    expect(none).toEqual({ code: 0, ran: [], said: noSpecLines('0123456789abcdef', false) })
    // A listing without a count (a config error) runs, so the error is shown
    expect((await affected({ listing: 'Error: no config' })).ran).toEqual(['chromium', 'webkit'])
  })

  it('starts no further engine once a signal reached the runner, the listing included', async () => {
    expect(await affected({ stopAfter: 'list' })).toEqual({ code: 130, ran: [], said: [] })
    expect(await affected({ stopAfter: 'list', listing: 'Total: 0 tests in 0 files' })).toEqual({ code: 130, ran: [], said: [] })
    expect(await affected({ stopAfter: 'chromium' })).toMatchObject({ code: 130, ran: ['chromium'] })
    expect(await affected({ stopAfter: 'chromium', codes: { chromium: 1 } })).toMatchObject({ code: 1, ran: ['chromium'] })
  })
})

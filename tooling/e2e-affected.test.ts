import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { affectedEngines, changedFiles, engineOutput, listedSpecs, mergeBase, noSpecLines, reachesScreen, runAffected, specFilter, specsReaching, type Engine } from './e2e-affected.js'
import { NO_GIT_MAINTENANCE } from './git-fixture.test-helpers.js'

/* `pnpm e2e --affected` (tooling/e2e-affected.ts): which specs, and what a run that picks none says. */

/** A temporary folder, removed after `body` */
function inTemp<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-affected-'))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Writes `files` (path → text) under `dir` */
function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

describe('the affected specs', () => {
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

  it("are the files of Playwright's JSON listing, by its top-level suites, not by the file a test is defined in", () => {
    // Trimmed from a real `--list --reporter=json` of Playwright 1.62.1: the spec's test is defined in its fixture
    const root = join(tmpdir(), 'repo', 'e2e')
    const listing = {
      config: { rootDir: root.split('\\').join('/'), version: '1.62.1' },
      suites: [
        {
          title: 'usage-donut-gap.spec.ts',
          file: 'usage-donut-gap.spec.ts',
          column: 0,
          line: 0,
          specs: [
            {
              title: "this computer's donuts stand as far apart as a linked machine's, and their hover circles do not touch",
              ok: true,
              tags: [],
              tests: [{ timeout: 20000, annotations: [], expectedStatus: 'passed', projectId: 'app', projectName: 'app', results: [], status: 'skipped' }],
              id: '40cb956e655ad34c4290-f0b01bf60839d7162f89',
              file: 'fixtures/usage-donut-gap.ts',
              line: 26,
              column: 3,
            },
          ],
        },
        { title: 'grid.spec.ts', file: 'grid.spec.ts', column: 0, line: 0, specs: [] },
      ],
      errors: [],
      stats: { startTime: '2026-11-21T00:39:00.329Z', duration: 10514.6, expected: 0, skipped: 1, unexpected: 0, flaky: 0 },
    }
    expect(listedSpecs(JSON.stringify(listing))).toEqual({ specs: [join(root, 'usage-donut-gap.spec.ts'), join(root, 'grid.spec.ts')] })
    expect(listedSpecs(JSON.stringify({ ...listing, suites: [] }))).toEqual({ specs: [] })
    // A spec that does not load is an error of the listing, not a spec less
    expect(listedSpecs(JSON.stringify({ ...listing, errors: [{ message: "Error: Cannot find module './gone'\nat x" }] }))).toEqual({ why: "Error: Cannot find module './gone'" })
    expect(listedSpecs('Error: no config')).toEqual({ why: 'the listing is not JSON' })
    expect(listedSpecs(JSON.stringify({ suites: [] }))).toEqual({ why: 'the listing names no rootDir or suites' })
    expect(listedSpecs(JSON.stringify({ ...listing, suites: [{ title: 'x' }] }))).toEqual({ why: 'a suite of the listing names no file' })
  })

  it('are the specs that are, or import at any depth through the repository, a changed file: a fixture-only change picks both twins', () => {
    inTemp((repo) => {
      write(repo, {
        'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', paths: { '@cc/theme': ['./packages/theme/src/index.ts'] } } }),
        'e2e/fixtures/donut.ts': "import { test } from '@playwright/test'\nexport const donutTests = () => test('a', () => {})\n",
        'e2e/donut.spec.ts': "import { donutTests } from './fixtures/donut.js'\ndonutTests()\n",
        'e2e/donut-webkit.spec.ts': "import { test } from '@playwright/test'\nimport { donutTests } from './fixtures/donut.js'\ntest.use({ browserName: 'webkit' })\ndonutTests()\n",
        'e2e/theme.spec.ts': "import { look } from './helpers/look.js'\nlook()\n",
        'e2e/helpers/look.ts': "export { look } from '@cc/theme'\n",
        'packages/theme/src/index.ts': "import { ink } from './ink.js'\nexport const look = () => ink\n",
        'packages/theme/src/ink.ts': 'export const ink = 1\n',
        'e2e/lone.spec.ts': "import { test } from '@playwright/test'\ntest('b', () => {})\n",
        'node_modules/@playwright/test/index.d.ts': 'export declare const test: any\n',
        'node_modules/@playwright/test/package.json': JSON.stringify({ name: '@playwright/test', types: 'index.d.ts' }),
      })
      const specs = ['donut.spec.ts', 'donut-webkit.spec.ts', 'theme.spec.ts', 'lone.spec.ts'].map((f) => join(repo, 'e2e', f))
      const picked = (...changed: string[]) => specsReaching(specs, changed.map((f) => join(repo, f)), repo).map((f) => f.slice(join(repo, 'e2e').length + 1))
      expect(picked('e2e/fixtures/donut.ts')).toEqual(['donut.spec.ts', 'donut-webkit.spec.ts'])
      // Through a helper and a workspace package's source, by tsconfig's paths
      expect(picked('packages/theme/src/ink.ts')).toEqual(['theme.spec.ts'])
      expect(picked('e2e/lone.spec.ts', 'docs/a.md')).toEqual(['lone.spec.ts'])
      // node_modules is not the repository's own: a change there picks nothing
      expect(picked('node_modules/@playwright/test/index.d.ts')).toEqual([])
      expect(picked()).toEqual([])
      if (process.platform === 'win32') expect(picked('E2E/Fixtures/Donut.ts')).toEqual(['donut.spec.ts', 'donut-webkit.spec.ts'])
    })
  })

  it('are each run by a filter that matches that file and no other, on either separator', () => {
    const filter = (spec: string) => new RegExp(specFilter(spec), 'i')
    const a = filter(join(tmpdir(), 'repo', 'e2e', 'a.spec.ts'))
    expect(a.test('/repo/e2e/a.spec.ts')).toBe(true)
    expect(a.test('C:\\repo\\e2e\\a.spec.ts')).toBe(true)
    expect(a.test('/repo/e2e/x/a.spec.ts')).toBe(false)
    expect(a.test('/repo/e2e/a-webkit.spec.ts')).toBe(false)
    expect(a.test('/repo/e2e/ba.spec.ts')).toBe(false)
    expect(a.test('/repo/e2e/a.spec.tsx')).toBe(false)
    expect(filter(join(tmpdir(), 'repo', 'e2e', 'ux', 'a.spec.ts')).test('/repo/e2e/ux/a.spec.ts')).toBe(true)
  })

  it('when none is picked, say so, and point to a filter only when the change reaches the screen', () => {
    expect(noSpecLines('0123456789abcdef', false)).toEqual(['e2e: no spec is or imports a file that differs from 0123456789; nothing ran.'])
    const screen = noSpecLines('0123456789abcdef', true)
    expect(screen).toHaveLength(2)
    expect(screen[1]).toContain('`CI=1 pnpm e2e <filter>`')
  })

  it('are measured from where the branch left main, not from main as it is now', () => {
    inTemp((repo) => {
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...NO_GIT_MAINTENANCE }
      const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env }).trim()
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
      // The files that differ, the uncommitted and the untracked ones too, and CI's answer for them
      expect(changedFiles(fork, repo)).toEqual([])
      expect(reachesScreen(changedFiles(fork, repo), repo)).toBe(false)
      write(repo, { 'docs/a.md': 'a\n' })
      git('add', '-A')
      expect(changedFiles(fork, repo)).toEqual(['docs/a.md'])
      expect(reachesScreen(changedFiles(fork, repo), repo)).toBe(false)
      write(repo, { 'packages/ui/src/a.ts': 'a\n' })
      expect(changedFiles(fork, repo)).toEqual(['docs/a.md', 'packages/ui/src/a.ts'])
      expect(reachesScreen(changedFiles(fork, repo), repo)).toBe(true)
      git('add', '-A')
      git('commit', '-q', '-m', 'both')
      expect(changedFiles(fork, repo)).toEqual(['docs/a.md', 'packages/ui/src/a.ts'])
      expect(() => changedFiles('not-a-commit', repo)).toThrow()
      // An answer that cannot be had says yes
      expect(reachesScreen(['docs/a.md'], join(repo, 'no-such-folder'))).toBe(true)
    })
  })
})

describe('one --affected run', () => {
  const A = join(tmpdir(), 'repo', 'e2e', 'a.spec.ts')
  const B = join(tmpdir(), 'repo', 'e2e', 'b.spec.ts')
  type Listed = { specs: string[] } | { why: string }
  function affected(o: { listed?: Partial<Record<Engine, Listed>>; pick?: string[]; codes?: Partial<Record<Engine, number>>; stopAfter?: `list-${Engine}` | Engine; screen?: boolean } = {}) {
    const said: string[] = []
    const ran: [Engine, string[]][] = []
    let stop: number | null = null
    const result = runAffected({
      base: '0123456789abcdef',
      engines: ['chromium', 'webkit'],
      list: (engine) => {
        if (o.stopAfter === `list-${engine}`) stop = 130
        return Promise.resolve(o.listed?.[engine] ?? { specs: [A, B] })
      },
      pick: (specs) => specs.filter((s) => (o.pick ?? [A]).includes(s)),
      run: (engine, specs) => {
        ran.push([engine, specs])
        if (o.stopAfter === engine) stop = 130
        return Promise.resolve(o.codes?.[engine] ?? 0)
      },
      stopCode: () => stop,
      screen: () => o.screen ?? true,
      say: (line) => said.push(line),
    })
    return result.then((code) => ({ code, ran, said }))
  }

  it("runs each engine in turn on the specs it picked from that engine's own listing, and answers the first failing one's code", async () => {
    expect(await affected()).toEqual({
      code: 0,
      ran: [
        ['chromium', [A]],
        ['webkit', [A]],
      ],
      said: ['e2e: 1 affected spec(s) in chromium: a.spec.ts', 'e2e: 1 affected spec(s) in webkit: a.spec.ts'],
    })
    expect(await affected({ codes: { chromium: 1, webkit: 2 } })).toMatchObject({ code: 1, ran: [['chromium', [A]], ['webkit', [A]]] })
    expect(await affected({ codes: { webkit: 2 } })).toMatchObject({ code: 2 })
    // An engine whose listing leaves the spec out (a twin, a WebKit-only spec) runs nothing
    expect(await affected({ listed: { webkit: { specs: [B] } } })).toEqual({ code: 0, ran: [['chromium', [A]]], said: ['e2e: 1 affected spec(s) in chromium: a.spec.ts', 'e2e: no affected spec runs in webkit'] })
  })

  it('starts no engine when no engine picked a spec, and says why', async () => {
    expect(await affected({ pick: [], screen: false })).toEqual({ code: 0, ran: [], said: noSpecLines('0123456789abcdef', false) })
  })

  it('fails, and starts no engine, when a listing fails', async () => {
    expect(await affected({ listed: { webkit: { why: "Error: Cannot find module './gone'" } } })).toEqual({ code: 1, ran: [], said: ["e2e: the specs in webkit could not be listed: Error: Cannot find module './gone'"] })
  })

  it('starts nothing further once a signal reached the runner, the listings included', async () => {
    expect(await affected({ stopAfter: 'list-chromium' })).toEqual({ code: 130, ran: [], said: [] })
    expect(await affected({ stopAfter: 'list-webkit', pick: [] })).toEqual({ code: 130, ran: [], said: [] })
    expect(await affected({ stopAfter: 'chromium' })).toMatchObject({ code: 130, ran: [['chromium', [A]]] })
    expect(await affected({ stopAfter: 'chromium', codes: { chromium: 1 } })).toMatchObject({ code: 1, ran: [['chromium', [A]]] })
  })
})

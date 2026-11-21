import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changedFiles, configOf, configReached, engineOutput, mergeBase, noSpecLines, reachesScreen, readListing, runAffected, specFilter, specsReaching, type Engine, type Listing } from './e2e-affected.js'
import { NO_GIT_MAINTENANCE } from './git-fixture.test-helpers.js'

/* `pnpm e2e --affected` (tooling/e2e-affected.ts): which specs, and what a run that picks none says. */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

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
  it.each([
    ['e2e', 'darwin', undefined, ['chromium', 'webkit']],
    ['e2e', 'linux', undefined, ['chromium', 'webkit']],
    // Playwright's WebKit on Windows cannot drag (#2022), so an unset run there is Chromium's (e2e/engine.ts)
    ['e2e', 'win32', undefined, ['chromium']],
    ['e2e', 'darwin', 'chromium', ['chromium']],
    ['e2e', 'win32', 'webkit', ['webkit']],
    // ux numbers compare only within one engine, the desktop app's (e2e/ux/engine.ts)
    ['ux', 'darwin', undefined, ['webkit']],
    ['ux', 'linux', undefined, ['webkit']],
    ['ux', 'win32', undefined, ['chromium']],
    ['ux', 'darwin', 'chromium', ['chromium']],
  ] as const)("run in the engines the %s config names for a run on %s with E2E_BROWSER=%s, read from its listing: %j", async (suite, platform, named, engines) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    vi.stubEnv('E2E_BROWSER', named)
    const { default: config } = await (suite === 'ux' ? import('../e2e/ux/playwright.config.js') : import('../e2e/playwright.config.js'))
    // The listing carries the config's metadata as it is (a real `--list --reporter=json` of the ux config on Windows:
    // `"metadata":{"e2eBrowser":"chromium"}`), and no project's browserName
    expect(readListing(JSON.stringify({ config: { rootDir: '/repo/e2e', metadata: config.metadata }, suites: [] }))).toEqual({ specs: [], engines })
  })

  it("keep each engine's results apart, beside the config, where Playwright would put them", () => {
    expect(engineOutput(['test', '--config', 'e2e/playwright.config.ts'], 'webkit')).toBe(`--output=${join('e2e', 'test-results', 'webkit')}`)
    expect(engineOutput(['test', '--config=e2e/ux/playwright.config.ts'], 'chromium')).toBe(`--output=${join('e2e', 'ux', 'test-results', 'chromium')}`)
    expect(engineOutput(['test', '-c', 'e2e/playwright.config.ts', 'grid'], 'webkit')).toBe(`--output=${join('e2e', 'test-results', 'webkit')}`)
    expect(engineOutput(['test'], 'webkit')).toBe(`--output=${join('test-results', 'webkit')}`)
    expect(configOf(['test', '-c', 'e2e/ux/playwright.config.ts'])).toBe('e2e/ux/playwright.config.ts')
  })

  it("are every spec when the change reaches this repository's config or a file it names, read from the config itself", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const reached = (config: string, ...changed: string[]) => configReached(join(root, config), changed.map((f) => join(root, f)), root).map((f) => relative(root, f).split(sep).join('/'))
    const e2e = 'e2e/playwright.config.ts'
    expect(reached(e2e, e2e)).toEqual([e2e])
    // What it imports, its setup and what that imports, its teardown, its reporter, and the script its web servers' commands name
    expect(reached(e2e, 'e2e/engine.ts')).toEqual([e2e])
    expect(reached(e2e, 'e2e/warm-engine.ts')).toEqual(['e2e/warm-engine.ts'])
    expect(reached(e2e, 'e2e/browser-sandbox.ts')).toEqual(['e2e/warm-engine.ts'])
    expect(reached(e2e, 'e2e/web-server-report.ts')).toEqual(['e2e/web-server-report.ts'])
    expect(reached(e2e, 'e2e/flaky-report.ts')).toEqual(['e2e/flaky-report.ts'])
    expect(reached(e2e, 'scripts/e2e-web-server.mjs')).toEqual(['scripts/e2e-web-server.mjs'])
    // Not a spec, a fixture, the window's code, or a package the reporter takes a helper from
    expect(reached(e2e, 'e2e/grid.spec.ts', 'e2e/fixtures/usage-donut-gap.ts', 'packages/ui/src/App.tsx', 'packages/protocol/src/index.ts')).toEqual([])
    expect(reached('e2e/ux/playwright.config.ts', 'e2e/ux/reporter.ts', 'e2e/ux/klm.ts')).toEqual(['e2e/ux/reporter.ts'])
    expect(reached('e2e/no-such.config.ts', 'e2e/engine.ts')).toEqual([])
  })

  it('name a file the config names in any string, a command included, once it is there', () => {
    inTemp((repo) => {
      write(repo, {
        'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler' } }),
        'e2e/pw.config.ts': [
          'const at = (p: number) => `node ../scripts/serve.mjs --port ${p} --`',
          "export default { globalSetup: './setup.ts', webServer: [{ command: at(1) }], reporter: [['list'], ['./gone.ts']] }",
        ].join('\n'),
        'e2e/setup.ts': "import { warm } from './warm.js'\nexport default warm\n",
        'e2e/warm.ts': 'export const warm = () => {}\n',
        'scripts/serve.mjs': '\n',
      })
      const reached = (...changed: string[]) => configReached(join(repo, 'e2e/pw.config.ts'), changed.map((f) => join(repo, f)), repo).map((f) => relative(repo, f).split(sep).join('/'))
      expect(reached('scripts/serve.mjs')).toEqual(['scripts/serve.mjs'])
      expect(reached('e2e/warm.ts')).toEqual(['e2e/setup.ts'])
      expect(reached('e2e/gone.ts')).toEqual([])
      write(repo, { 'e2e/gone.ts': '\n' })
      expect(reached('e2e/gone.ts')).toEqual(['e2e/gone.ts'])
    })
  })

  it("are the files of Playwright's JSON listing, by its top-level suites, not by the file a test is defined in", () => {
    // Trimmed from a real `--list --reporter=json` of Playwright 1.62.1: the spec's test is defined in its fixture
    const root = join(tmpdir(), 'repo', 'e2e')
    const listing = {
      config: { rootDir: root.split('\\').join('/'), metadata: { e2eBrowser: 'chromium' }, version: '1.62.1' },
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
    expect(readListing(JSON.stringify(listing))).toEqual({ specs: [join(root, 'usage-donut-gap.spec.ts'), join(root, 'grid.spec.ts')], engines: ['chromium'] })
    expect(readListing(JSON.stringify({ ...listing, suites: [] }))).toEqual({ specs: [], engines: ['chromium'] })
    expect(readListing(JSON.stringify({ ...listing, config: { ...listing.config, metadata: {} } }))).toEqual({ why: 'the config names no engine (metadata.e2eBrowser: chromium, webkit or mixed)' })
    // A spec that does not load is an error of the listing, not a spec less
    expect(readListing(JSON.stringify({ ...listing, errors: [{ message: "Error: Cannot find module './gone'\nat x" }] }))).toEqual({ why: "Error: Cannot find module './gone'" })
    expect(readListing('Error: no config')).toEqual({ why: 'the listing is not JSON' })
    expect(readListing(JSON.stringify({ suites: [] }))).toEqual({ why: 'the listing names no rootDir or suites' })
    expect(readListing(JSON.stringify({ ...listing, suites: [{ title: 'x' }] }))).toEqual({ why: 'a suite of the listing names no file' })
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
  type Listed = Listing | { why: string }
  function affected(
    o: { config?: string[]; first?: Listed; listed?: Partial<Record<Engine, Listed>>; pick?: string[]; codes?: Partial<Record<Engine, number>>; stopAfter?: `list-${Engine | 'first'}` | Engine; screen?: boolean } = {},
  ) {
    const said: string[] = []
    const ran: [Engine, string[] | null][] = []
    const lists: (Engine | null)[] = []
    let stop: number | null = null
    const result = runAffected({
      base: '0123456789abcdef',
      config: () => o.config ?? [],
      list: (engine) => {
        lists.push(engine)
        if (o.stopAfter === `list-${engine ?? 'first'}`) stop = 130
        if (!engine) return Promise.resolve(o.first ?? { specs: [A, B], engines: ['chromium', 'webkit'] })
        return Promise.resolve(o.listed?.[engine] ?? { specs: [A, B], engines: [engine] })
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
    return result.then((code) => ({ code, ran, said, lists }))
  }

  it("runs each engine in turn on the specs it picked from that engine's own listing, and answers the first failing one's code", async () => {
    expect(await affected()).toEqual({
      code: 0,
      ran: [
        ['chromium', [A]],
        ['webkit', [A]],
      ],
      said: ['e2e: 1 affected spec(s) in chromium: a.spec.ts', 'e2e: 1 affected spec(s) in webkit: a.spec.ts'],
      lists: [null, 'chromium', 'webkit'],
    })
    expect(await affected({ codes: { chromium: 1, webkit: 2 } })).toMatchObject({ code: 1, ran: [['chromium', [A]], ['webkit', [A]]] })
    expect(await affected({ codes: { webkit: 2 } })).toMatchObject({ code: 2 })
    // An engine whose listing leaves the spec out (a twin, a WebKit-only spec) runs nothing
    expect(await affected({ listed: { webkit: { specs: [B], engines: ['webkit'] } } })).toMatchObject({ code: 0, ran: [['chromium', [A]]], said: ['e2e: 1 affected spec(s) in chromium: a.spec.ts', 'e2e: no affected spec runs in webkit'] })
  })

  it("runs in the one engine the command's own listing names, listing it once (pnpm ux on macOS: WebKit)", async () => {
    expect(await affected({ first: { specs: [A, B], engines: ['webkit'] } })).toEqual({ code: 0, ran: [['webkit', [A]]], said: ['e2e: 1 affected spec(s) in webkit: a.spec.ts'], lists: [null] })
    expect(await affected({ first: { specs: [A, B], engines: ['webkit'] }, config: ['e2e/ux/reporter.ts'] })).toMatchObject({ ran: [['webkit', null]], lists: [null] })
  })

  it("runs every spec in each engine, listing no engine's own, when the change reaches the config", async () => {
    const config = ['e2e/warm-engine.ts']
    expect(await affected({ config, pick: [] })).toEqual({
      code: 0,
      lists: [null],
      ran: [
        ['chromium', null],
        ['webkit', null],
      ],
      said: [
        'e2e: the change reaches e2e/warm-engine.ts: the config, or a file it imports or names (setup, teardown, a reporter, a web server), which every spec runs through.',
        'e2e: every spec in chromium',
        'e2e: every spec in webkit',
      ],
    })
    expect(await affected({ config, listed: { chromium: { why: 'not asked' } } })).toMatchObject({ code: 0, ran: [['chromium', null], ['webkit', null]] })
    expect(await affected({ config, stopAfter: 'chromium', codes: { chromium: 1 } })).toMatchObject({ code: 1, ran: [['chromium', null]] })
  })

  it('starts no engine when no engine picked a spec, and says why', async () => {
    expect(await affected({ pick: [], screen: false })).toMatchObject({ code: 0, ran: [], said: noSpecLines('0123456789abcdef', false) })
  })

  it('fails, and starts no engine, when a listing fails', async () => {
    expect(await affected({ listed: { webkit: { why: "Error: Cannot find module './gone'" } } })).toMatchObject({ code: 1, ran: [], said: ["e2e: the specs in webkit could not be listed: Error: Cannot find module './gone'"] })
    // The command's own listing, which names the engines, before the config is asked
    const why = 'the config names no engine (metadata.e2eBrowser: chromium, webkit or mixed)'
    expect(await affected({ first: { why }, config: ['e2e/warm-engine.ts'] })).toEqual({ code: 1, ran: [], said: [`e2e: the specs could not be listed: ${why}`], lists: [null] })
  })

  it('starts nothing further once a signal reached the runner, the listings included', async () => {
    expect(await affected({ stopAfter: 'list-first', config: ['e2e/warm-engine.ts'] })).toMatchObject({ code: 130, ran: [], said: [] })
    expect(await affected({ stopAfter: 'list-chromium' })).toMatchObject({ code: 130, ran: [], said: [] })
    expect(await affected({ stopAfter: 'list-webkit', pick: [] })).toMatchObject({ code: 130, ran: [], said: [] })
    expect(await affected({ stopAfter: 'chromium' })).toMatchObject({ code: 130, ran: [['chromium', [A]]] })
    expect(await affected({ stopAfter: 'chromium', codes: { chromium: 1 } })).toMatchObject({ code: 1, ran: [['chromium', [A]]] })
  })
})

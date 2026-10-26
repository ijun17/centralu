import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { workflowCheckNames, workflowEventJobs } from '../.centralu/apps/project-board/ci.mjs'
// @ts-expect-error — a plain .mjs script the workflow runs with the runner's own Node
import { changedFiles, classify, draftOf, failFastOf, outputs, tierOf, VERSION_SOURCE } from '../.github/scripts/ci-changes.mjs'

// Like release-workflow.test.ts, inspect the workflow without adding a YAML dependency.
const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
  .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
const bundle = workflow.split('  bundle:\n')[1]?.split(/^ {2}\S/m)[0] ?? ''
const steps = bundle.split(/^ {6}- /m).slice(1)

describe('CI bundles carry the release their commit was cut from (#1501)', () => {
  it('fetches the tags and stamps the resolved version before building, on every platform', () => {
    expect(steps[0]).toMatch(/^uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n(?: {10}#[^\n]*\n)* {10}fetch-depth: 0\n {10}filter: blob:none\n/)
    const stamp = steps.findIndex((s) => s.startsWith('name: Stamp the version'))
    const build = steps.findIndex((s) => s.startsWith('name: Build bundle'))
    expect(stamp).toBeGreaterThan(-1)
    expect(stamp).toBeLessThan(build)
    expect(steps[stamp]).not.toContain('if:')
    expect(steps[stamp]).toContain('run: node scripts/stamp-version.mjs "$(node scripts/app-version.mjs --fallback)"\n')
  })
})

describe('CI proves the macOS app bundles without making an unused disk image', () => {
  it('builds only the app on macOS and keeps the default bundles on other platforms', () => {
    const builds = steps.filter((step) => /run:.*tauri build/.test(step))
    const mac = builds.find((step) => step.includes("if: runner.os == 'macOS'"))
    expect(mac, 'macOS must override the default app,dmg bundles').toBeDefined()
    expect(mac).toContain('run: pnpm --filter @cc/desktop exec tauri build --bundles app\n')
    const others = builds.find((step) => step.includes("if: runner.os != 'macOS'"))
    expect(others).toContain('run: pnpm --filter @cc/desktop exec tauri build\n')
    expect(others).toContain('APPIMAGE_EXTRACT_AND_RUN: 1')
    expect(builds).toHaveLength(2)
  })

  it('uploads the executable-preserving app archive without expecting a DMG', () => {
    const mac = bundle.split('- target: darwin-arm64\n')[1]?.split('- target:')[0] ?? ''
    expect(mac).toContain('apps/desktop/src-tauri/target/release/bundle/macos/Centralu-app.tar.gz')
    expect(mac).not.toContain('.dmg')
    const tar = steps.find((step) => step.startsWith('name: Tar the .app\n'))
    expect(tar).toContain("if: runner.os == 'macOS'")
    expect(tar).toContain('run: tar czf Centralu-app.tar.gz ./*.app')
    const upload = steps.find((step) => step.includes('name: centralu-${{ matrix.target }}\n'))
    expect(upload).toContain('path: ${{ matrix.artifacts }}')
    expect(upload).toContain('if-no-files-found: error')
  })
})

/*
 * Which jobs a commit needs (2026-10-17): `changes` answers from the files it changes, and each job a commit cannot
 * affect is left out. A left-out job must still report the check a required set waits for.
 *
 * Two tiers (2026-10-18): a pull request runs the quick tier (`changes`, `verify`, the Windows unit tests), every
 * other run the full one. Every other job waits on `changes`, and on a quick run neither it nor its stand-in runs.
 * A draft pull request (#1066: a stack's lower PRs are drafts) runs `changes` alone.
 */
describe('CI leaves out the jobs a commit cannot affect, and every check still reports', () => {
  const jobs = workflow.split(/^jobs:\n/m)[1]!.split(/(?=^ {2}[\w-]+:\n)/m).map((b) => ({ id: /^ {2}([\w-]+):/.exec(b)![1]!, body: b }))
  const job = (id: string) => jobs.find((j) => j.id === id)!
  const gate = (body: string) => /^ {4}if: needs\.changes\.outputs\.(\w+) == '(true|false)'$/m.exec(body)
  const names = (body: string) => workflowCheckNames(`jobs:\n${body}`).names.sort()

  it('runs only changes, verify and the Windows unit tests on a quick run, and gates every other job on an answer of `changes`', () => {
    const gated = Object.fromEntries(jobs.filter((j) => gate(j.body)?.[2] === 'true').map((j) => [j.id, gate(j.body)![1]]))
    expect(gated).toEqual({
      // The quick tier: what catches most problems cheaply (the Windows unit tests: build.yml's comment has the numbers)
      verify: 'quick',
      'windows-tests-unit': 'quick',
      'full-tier': 'full',
      bundle: 'bundle',
      'content-verify': 'host',
      'windows-tests': 'full',
      // WebKit e2e on every full run, documents only included (owner decisions of 2026-10-11 and 2026-10-18)
      e2e: 'full',
      'e2e-chromium': 'code',
      'ux-tasks': 'code',
      'host-tests-remote-node': 'host_tests',
      keeper: 'host',
      'keeper-linux': 'host',
    })
    expect(jobs.some((j) => j.id === 'e2e-skipped')).toBe(false)
    for (const id of Object.keys(gated)) expect(job(id).body).toMatch(/^ {4}needs: changes$/m)
    // Every job but `changes`, the report (which waits on the e2e jobs) and the fail fast (which waits on `verify`) has
    // a gate: nothing else runs on a draft
    const ungated = jobs.filter((j) => !gate(j.body)).map((j) => j.id)
    expect(ungated.sort()).toEqual(['changes', 'e2e-report', 'fail-fast'])
    expect(job('changes').body).toMatch(/^ {6}quick: \$\{\{ steps\.classify\.outputs\.quick \}\}$/m)
    expect(job('e2e-report').body).toMatch(/^ {4}needs: \[e2e, e2e-chromium\]$/m)
    expect(job('changes').body).toMatch(/^ {6}full: \$\{\{ steps\.classify\.outputs\.full \}\}$/m)
  })

  // What the merge queue and the release read to tell a full run from a quick one (project.json ci.fullTier)
  it('has a job that passes on a full run only, under the check name the board reads', () => {
    const board = JSON.parse(readFileSync(new URL('../.centralu/apps/project-board/project.json', import.meta.url), 'utf8')) as { ci: { fullTier: string } }
    const marker = job('full-tier').body
    expect(names(marker)).toEqual([board.ci.fullTier])
    expect(gate(marker)?.slice(1)).toEqual(['full', 'true'])
    expect(marker).not.toMatch(/continue-on-error|always\(\)/)
  })

  // #1035: the one Windows job was the longest of every run, 15 of its 16.5 minutes the unit tests
  it('runs the Windows unit tests in shards beside lint and types, under the check name required sets know', () => {
    const checks = job('windows-tests').body
    expect(names(checks)).toEqual(['windows tests'])
    for (const run of ['pnpm lint', 'pnpm depcruise', 'pnpm typecheck']) expect(checks).toContain(`run: ${run}\n`)
    expect(checks).not.toContain('pnpm test')
    const unit = job('windows-tests-unit').body
    const shards = Number(/^ {8}shards: \[(\d+)\]$/m.exec(unit)?.[1])
    expect(shards).toBeGreaterThan(1)
    expect(/^ {8}shard: \[([\d, ]+)\]$/m.exec(unit)?.[1]).toBe(Array.from({ length: shards }, (_, i) => i + 1).join(', '))
    expect(names(unit)).toEqual(Array.from({ length: shards }, (_, i) => `windows tests (vitest ${i + 1}/${shards})`))
    expect(unit).toContain('run: pnpm exec vitest run --shard=${{ matrix.shard }}/${{ matrix.shards }}\n')
    expect(unit).toMatch(/^ {4}runs-on: windows-2022$/m)
    expect(unit).toContain('CC_DATA_DIR: ${{ runner.temp }}')
  })

  // 2026-10-19 (owner): Playwright retries a failed test, not the shard, and a pass on the retry is named, not hidden
  it('runs each e2e shard once, retrying a failed test inside Playwright, and names every test that passed only on retry', () => {
    const config = readFileSync(new URL('../e2e/playwright.config.ts', import.meta.url), 'utf8')
    expect(config).toContain('retries: process.env.CI ? 1 : 0,')
    expect(config).toContain("['./flaky-report.ts']")
    for (const id of ['e2e', 'e2e-chromium']) {
      const body = job(id).body
      const step = body.slice(body.indexOf('- name: pnpm e2e'))
      expect(step, id).toMatch(/^ {8}id: e2e$/m)
      // One run of the shard: the whole-shard retry (#1035) is gone with its first-attempt artifact
      expect(step, id).toMatch(/^ {8}run: pnpm e2e --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\} --reporter=list,blob,\.\/e2e\/flaky-report\.ts --trace=retain-on-failure$/m)
      expect(body, id).not.toContain('e2e-first-attempt')
      expect(body, id).toMatch(/^ {4}outputs:\n {6}(?:#.*\n {6})?flaky: \$\{\{ steps\.e2e\.outputs\.flaky \}\}$/m)
    }
    const report = job('e2e-report').body
    for (const id of ['e2e', 'e2e-chromium']) {
      expect(report).toContain(`needs.${id}.result == 'failure'`)
      expect(report).toContain(`needs.${id}.outputs.flaky == 'true'`)
    }
    expect(report).toMatch(/E2E_FLAKY_LABEL="\$engine" .*merge-reports --reporter html,\.\/e2e\/flaky-report\.ts /)
    expect(workflow).toContain('pattern: e2e-blob-*')
  })

  // 2026-10-19 (owner): one e2e shard hung 35 minutes and held a merge batch; GitHub's default limit is 6 hours
  it("gives every job that does real work a time limit near its slowest green run, the e2e shards 25 minutes (the browser install's 9 at worst, #1503, and 12 for the tests)", () => {
    const limit = (id: string) => Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job(id).body)?.[1])
    // A job with only an echo (the stand-ins, `full tier`) or `changes` needs none
    const working = jobs.filter((j) => j.id !== 'changes' && !/^ {6}- run: echo /m.test(j.body) && !/^ {4}steps:\n {6}- run: echo [^\n]*\n*$/.test(j.body))
    expect(working.map((j) => j.id).sort()).toEqual(['bundle', 'content-verify', 'e2e', 'e2e-chromium', 'e2e-report', 'fail-fast', 'host-tests-remote-node', 'keeper', 'keeper-linux', 'ux-tasks', 'verify', 'windows-tests', 'windows-tests-unit'])
    for (const j of working) expect(limit(j.id), j.id).toBeGreaterThan(0)
    expect(limit('e2e')).toBe(25)
    expect(limit('e2e-chromium')).toBe(25)
    expect(limit('ux-tasks')).toBe(20)
    for (const j of working) expect(limit(j.id), j.id).toBeLessThanOrEqual(30)
  })

  // #1503: three e2e shards were cancelled at their 15 minute limit inside `playwright install --with-deps`, which downloaded
  // about 140 apt packages from a slow mirror (usually 20 to 45 s, 244 to 893 s on some shards), before any test ran. The
  // install is its own steps now, each limited and retried once, and the tests keep a limit of their own, so a slow
  // mirror costs a retry and not the shard. A container image with the browsers was tried first and does not fit: it has
  // no make or g++, which node-pty and better-sqlite3 need at `pnpm install`.
  it("installs the browser of every job that runs one in steps of its own: cached by Playwright's version, each try limited, one retry, the tests limited apart", () => {
    const browserJobs = [
      { id: 'e2e', browser: 'webkit', Browser: 'WebKit', tests: 'pnpm e2e', testLimit: 12 },
      { id: 'e2e-chromium', browser: 'chromium', Browser: 'Chromium', tests: 'pnpm e2e', testLimit: 12 },
      { id: 'ux-tasks', browser: 'webkit', Browser: 'WebKit', tests: 'pnpm ux', testLimit: 5 },
    ]
    for (const { id, browser, Browser, tests, testLimit } of browserJobs) {
      const body = job(id).body
      const start = body.indexOf("      - name: Read Playwright's version\n")
      const end = body.indexOf(`      - name: ${tests}`)
      expect(start, id).toBeGreaterThan(0)
      expect(end, id).toBeGreaterThan(start)
      expect(body.slice(start, end), id).toBe(
        [
          "      - name: Read Playwright's version",
          '        id: playwright',
          `        run: echo "version=$(pnpm exec playwright --version | cut -d' ' -f2)" >> "$GITHUB_OUTPUT"`,
          '',
          '      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
          '        with:',
          '          path: ~/.cache/ms-playwright',
          `          key: playwright-\${{ runner.os }}-\${{ steps.playwright.outputs.version }}-${browser}`,
          '',
          `      - name: Install ${Browser} system libraries`,
          '        id: libraries',
          '        timeout-minutes: 3',
          '        continue-on-error: true',
          `        run: pnpm exec playwright install-deps ${browser}`,
          '',
          `      - name: Install ${Browser} system libraries, second try`,
          "        if: steps.libraries.outcome == 'failure'",
          '        timeout-minutes: 3',
          '        run: |',
          '          bash .github/scripts/stop-leftover-apt.sh',
          '          sudo dpkg --configure -a || true',
          `          pnpm exec playwright install-deps ${browser}`,
          '',
          `      - name: Install ${Browser}`,
          '        timeout-minutes: 3',
          `        run: pnpm exec playwright install ${browser}`,
          '',
          '',
        ].join('\n'),
      )
      // The tests keep a budget of their own, whatever the install took
      const step = body.slice(end).split(/^ {6}- /m)[1]!
      expect(step, id).toMatch(new RegExp(`^ {8}(?:id: e2e\\n {8})?timeout-minutes: ${testLimit}$`, 'm'))
    }
    // The old one-step install, with the system libraries inside the tests' budget, is gone
    expect(workflow).not.toMatch(/--with-deps/)
    expect(workflow.match(/playwright install-deps /g)).toHaveLength(browserJobs.length * 2)
  })

  // #1259: changes land after the fast tier, so every push to main needs its full run to the end; a pull request's are superseded
  it("never cancels a run on main for a newer push, and still supersedes a branch's or pull request's run", () => {
    const block = /^concurrency:\n((?: {2}.*\n)+)/m.exec(workflow)?.[1] ?? ''
    expect(block).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}")
    expect(block).toMatch(/^ {2}group: build-\$\{\{ github\.ref \}\}/m)
  })

  // 2026-10-19 (owner): a failed verify was heard only after every e2e shard had finished, about 10 minutes later
  it('cancels the rest of a manual run once verify has failed, from a job of its own, as `changes` says', () => {
    const ff = job('fail-fast').body
    expect(names(ff)).toEqual(['fail fast'])
    expect(ff).toMatch(/^ {4}needs: \[changes, verify\]$/m)
    expect(ff).toContain("if: ${{ !cancelled() && needs.verify.result == 'failure' && needs.changes.outputs.fail_fast == 'true' }}")
    expect(ff).toMatch(/^ {4}permissions:\n {6}actions: write\n {4}steps:/m)
    // This run, by its id: never another run of the concurrency group
    expect(ff).toContain('RUN_ID: ${{ github.run_id }}')
    expect(ff).toContain('gh run cancel "$RUN_ID"')
    expect(ff).not.toContain('continue-on-error')
    // No event context: a release bump's run stays evidence for the release (docs/releasing.md, event audit)
    expect(workflowEventJobs(`on:\n  push:\n  pull_request:\njobs:\n${ff}`)[0]!.reason).toBeNull()
    // `verify` itself cancels nothing, so its check stays `failure`: how the queue tells this run from one cancelled for nothing
    expect(job('verify').body).not.toMatch(/run cancel|\/cancel/)
    expect(job('changes').body).toMatch(/^ {6}fail_fast: \$\{\{ steps\.classify\.outputs\.fail_fast \}\}$/m)
  })

  it('gives each matrix job the files gate a stand-in with the same checks, run on the other answer only', () => {
    // A job every run of its tier has (`full`, `quick`) has no other answer when that tier runs, and reports nothing when it does not
    for (const j of jobs.filter((x) => gate(x.body)?.[2] === 'true' && !['full', 'quick'].includes(gate(x.body)?.[1] ?? '') && /^ {4}strategy:/m.test(x.body))) {
      const stand = job(`${j.id}-skipped`)
      expect(stand, `${j.id} needs a stand-in`).toBeDefined()
      expect(gate(stand.body)?.slice(1)).toEqual([gate(j.body)![1], 'false'])
      expect(names(stand.body)).toEqual(names(j.body))
      expect(names(j.body).length).toBeGreaterThan(1)
      expect(stand.body).toMatch(/^ {4}runs-on: ubuntu-24.04$/m)
    }
    // A job without a matrix reports `skipped` under its own name, and needs none
    for (const id of ['ux-tasks', 'keeper', 'keeper-linux']) expect(jobs.some((j) => j.id === `${id}-skipped`)).toBe(false)
  })

  // #1066: a lower PR is a draft, and its run was waste; marked ready (its upper closed), it runs again
  it('starts a run when a pull request is marked ready or turned into a draft, besides the usual pull request events', () => {
    expect(workflow).toMatch(/^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft\]\n/m)
  })

  it('asks `changes` with the same rule on every event, a manual run being the one with the `everything` input', () => {
    const changes = job('changes').body
    expect(changes).toContain('run: node .github/scripts/ci-changes.mjs')
    // main and the history back to the merge-base (see changedFiles below)
    expect(changes).toContain('fetch-depth: 0')
    expect(workflowEventJobs(`on:\n  push:\n  pull_request:\njobs:\n${changes}`)[0]!.reason).toBeNull()
    const script = readFileSync(new URL('../.github/scripts/ci-changes.mjs', import.meta.url), 'utf8')
    // One fact of the event, whether a pull request is a draft, and nothing else of it
    expect([...new Set(script.match(/GITHUB_(EVENT|REF|HEAD_REF|BASE_REF)\w*|github\.event/g))]).toEqual(['GITHUB_EVENT_PATH'])
    expect(script).toContain('?.pull_request?.draft === true')
    expect(changes).toContain('EVERYTHING: ${{ inputs.everything }}')
    expect(changes).toContain('DISPATCH_TIER: ${{ inputs.tier }}')
    expect(workflow).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}everything:\n/m)
  })
})

describe('what a commit needs, from the files it changes (.github/scripts/ci-changes.mjs)', () => {
  const none = { bundle: false, host: false, host_tests: false, code: false }
  it.each([
    ['documents only', ['docs/agent-host.md', 'README.md', '.github/PULL_REQUEST_TEMPLATE.md'], none],
    ['host tests only', ['packages/agent-host/src/store.test.ts', 'packages/agent-host/src/fake-exe.test-helpers.ts'], { ...none, host_tests: true, code: true }],
    ['UI scenarios only', ['e2e/control-loop.spec.ts', 'e2e/fixtures/control.ts'], { ...none, code: true }],
    ['tooling tests', ['tooling/launcher-serve.test.ts', 'vitest.config.ts'], { ...none, host_tests: true, code: true }],
    // Read by the keeper's Rust tests too (host_proc/tests.rs), which only the host jobs run
    ['the Node floor fixture', ['tooling/fixtures/node-floor.json'], { ...none, host: true, host_tests: true, code: true }],
    ['the window only', ['packages/ui/src/app/App.tsx', 'packages/core/src/grid/grid.ts', 'apps/web/index.html'], { ...none, bundle: true, code: true }],
    ['the host', ['packages/agent-host/src/rpc.ts'], { bundle: true, host: true, host_tests: true, code: true }],
    ['the shell', ['apps/desktop/src-tauri/src/main.rs'], { bundle: true, host: true, host_tests: true, code: true }],
    ['the workflow', ['.github/workflows/build.yml'], { bundle: true, host: true, host_tests: true, code: true }],
    ['the workflow\'s scripts', ['.github/scripts/ci-changes.mjs'], { bundle: true, host: true, host_tests: true, code: true }],
    // What a build or the type checker reads runs everything, even where tests or the window live
    ['the shared TypeScript config', ['tooling/tsconfig.base.json'], { bundle: true, host: true, host_tests: true, code: true }],
    ['the window\'s TypeScript config', ['packages/ui/tsconfig.json'], { bundle: true, host: true, host_tests: true, code: true }],
    ['the lockfile', ['pnpm-lock.yaml'], { bundle: true, host: true, host_tests: true, code: true }],
    ['a package manifest', ['packages/ui/package.json'], { bundle: true, host: true, host_tests: true, code: true }],
    ['the web build\'s config', ['apps/web/vite.config.ts'], { bundle: true, host: true, host_tests: true, code: true }],
    // A document that ships (the app template's) is not a document here
    ['an app template document', ['packages/agent-host/app-template/AGENTS.md'], { bundle: true, host: true, host_tests: true, code: true }],
    ['nothing', [], none],
  ])('%s', (_what, files, needs) => {
    expect(classify(files)).toEqual(needs)
  })

  /*
   * A file under tooling/ counts as a test, which the keeper jobs skip. One the keeper's Rust tests take in with
   * `include_str!` must still run them, or a change to it alone would never reach the Rust half of its test.
   */
  it('runs the host jobs for every tooling/ file the Rust tests include', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const rust = (dir: string): string[] =>
      (readdirSync(join(root, dir), { recursive: true }) as string[])
        .map((f) => `${dir}/${f.split(sep).join('/')}`)
        .filter((f) => f.endsWith('.rs') && !f.includes('/target/'))
    const included = new Set<string>()
    for (const file of [...rust('apps/desktop/src-tauri/keeper/src'), ...rust('apps/desktop/src-tauri/shell/src'), ...rust('apps/desktop/content-verify')]) {
      for (const m of readFileSync(join(root, file), 'utf8').matchAll(/include_str!\("([^"]+)"\)/g)) {
        const rel = relative(root, resolve(root, dirname(file), m[1]!)).split(sep).join('/')
        if (rel.startsWith('tooling/')) included.add(rel)
      }
    }
    expect([...included]).toContain('tooling/fixtures/node-floor.json')
    for (const f of included) expect(classify([f]).host, f).toBe(true)
  })

  it('runs the quick tier on a pull request, and the full tier on main, on a manual run and on a release bump', () => {
    expect(tierOf({ files: ['packages/agent-host/src/rpc.ts'] }).tier).toBe('quick')
    expect(tierOf({ files: ['docs/a.md'] }).tier).toBe('quick')
    // A build or CI change is still the quick tier: the full one runs in the merge queue's batch
    expect(tierOf({ files: ['.github/workflows/build.yml'] }).tier).toBe('quick')
    expect(tierOf({ files: null, onMain: true }).tier).toBe('full')
    // The merge queue's batch asks for the quick tier (#1259); a release bump or a commit on main still runs in full
    expect(tierOf({ files: ['packages/ui/src/a.ts'], dispatch: true, dispatchTier: 'quick' }).tier).toBe('quick')
    expect(tierOf({ files: ['docs/a.md', VERSION_SOURCE], dispatch: true, dispatchTier: 'quick' }).tier).toBe('full')
    expect(tierOf({ files: null, onMain: true, dispatch: true, dispatchTier: 'quick' }).tier).toBe('full')
    expect(tierOf({ files: null, dispatch: true, dispatchTier: 'quick' }).tier).toBe('full')
    expect(tierOf({ files: ['docs/a.md'], dispatch: true }).tier).toBe('full')
    expect(tierOf({ files: null }).tier).toBe('full')
    expect(tierOf({ files: ['docs/a.md', VERSION_SOURCE] })).toMatchObject({ tier: 'full', why: expect.stringContaining('release bump') })
  })

  it('fails fast on a manual run alone, never on a release bump, on main or when the files are not known', () => {
    expect(failFastOf({ files: ['packages/ui/src/a.ts'], dispatch: true })).toBe(true)
    expect(failFastOf({ files: [], dispatch: true })).toBe(true)
    // A pull request's run, a release bump's included, and main's: every job to its end
    expect(failFastOf({ files: ['packages/ui/src/a.ts'] })).toBe(false)
    expect(failFastOf({ files: [VERSION_SOURCE] })).toBe(false)
    expect(failFastOf({ files: null, onMain: true })).toBe(false)
    // A manual run that is a release bump (a batch holding the bump PR), on main, or whose files are not known
    expect(failFastOf({ files: ['docs/a.md', VERSION_SOURCE], dispatch: true })).toBe(false)
    expect(failFastOf({ files: null, onMain: true, dispatch: true })).toBe(false)
    expect(failFastOf({ files: null, dispatch: true })).toBe(false)
  })

  // #1066: a stack's lower PRs are drafts, and the top's run (and the merge queue's batch) proves the stack
  it('runs nothing but changes for a draft pull request, except a release bump, and asks the event last', () => {
    expect(tierOf({ files: ['packages/agent-host/src/rpc.ts'], draft: true }).tier).toBe('none')
    expect(tierOf({ files: ['packages/agent-host/src/rpc.ts'], draft: false }).tier).toBe('quick')
    // A bump is the release's evidence, and runs in full whatever it is
    expect(tierOf({ files: [VERSION_SOURCE], draft: true }).tier).toBe('full')
    expect(tierOf({ files: null, onMain: true, draft: true }).tier).toBe('full')
    expect(outputs('none', classify(['packages/agent-host/src/rpc.ts']))).toEqual({ quick: 'off', full: 'off', bundle: 'off', host: 'off', host_tests: 'off', code: 'off' })
  })

  it('reads a draft from the event file, and reads anything else as not a draft', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ci-event-'))
    try {
      const file = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name))
      expect(draftOf(file('draft.json', JSON.stringify({ pull_request: { draft: true } })))).toBe(true)
      expect(draftOf(file('ready.json', JSON.stringify({ pull_request: { draft: false } })))).toBe(false)
      expect(draftOf(file('push.json', JSON.stringify({ ref: 'refs/heads/main' })))).toBe(false)
      expect(draftOf(file('bad.json', '{'))).toBe(false)
      expect(draftOf(join(dir, 'missing.json'))).toBe(false)
      expect(draftOf(undefined)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers off for every group on a quick run, so neither a job nor its stand-in runs', () => {
    const host = classify(['packages/agent-host/src/rpc.ts'])
    expect(outputs('quick', host)).toEqual({ quick: 'true', full: 'off', bundle: 'off', host: 'off', host_tests: 'off', code: 'off' })
    expect(outputs('full', host)).toEqual({ quick: 'true', full: 'true', bundle: 'true', host: 'true', host_tests: 'true', code: 'true' })
    expect(outputs('full', classify(['docs/a.md']))).toEqual({ quick: 'true', full: 'true', bundle: 'false', host: 'false', host_tests: 'false', code: 'false' })
    // Every answer a job's gate reads is one `changes` gives (`fail_fast` is written beside the groups, see failFastOf)
    const gates = new Set([...workflow.matchAll(/needs\.changes\.outputs\.(\w+) == '(true|false)'/g)].map((m) => m[1]))
    expect([...gates].sort()).toEqual([...Object.keys(outputs('full', host)), 'fail_fast'].sort())
  })

  it('runs everything when the changed files are not known', () => {
    expect(classify(null)).toEqual({ bundle: true, host: true, host_tests: true, code: true })
  })

  // So a bump PR's run is main's run, which runs everything (the release script's reuse, docs/releasing.md)
  it('runs everything for a release bump, from the file that declares the version alone', () => {
    const release = (JSON.parse(readFileSync(new URL('../.centralu/apps/project-board/project.json', import.meta.url), 'utf8')) as { release: { source: { path: string } } }).release
    expect(VERSION_SOURCE).toBe(release.source.path)
    expect(classify([release.source.path])).toEqual({ bundle: true, host: true, host_tests: true, code: true })
    expect(outputs(tierOf({ files: [release.source.path] }).tier, classify([release.source.path]))).toEqual(outputs('full', classify(null)))
  })

  /*
   * A repository with `main` and branches as GitHub's checkout would see them. `merge(b, into)` makes the merge commit
   * a pull request runs on: its first parent the base branch, its second the pull request's head.
   */
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ci-changes-'))
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    const commit = (files: Record<string, string>, message: string) => {
      for (const [f, t] of Object.entries(files)) write(f, t)
      git('add', '-A')
      git('commit', '-qm', message)
    }
    git('init', '-q', '-b', 'main')
    commit({ 'README.md': 'a', 'packages/agent-host/src/x.ts': 'x' }, 'root')
    const merge = (head: string, base: string) => {
      git('checkout', '-q', '--detach', base)
      git('merge', '-q', '--no-ff', '-m', `merge ${head}`, head)
    }
    return { dir, git, commit, merge, done: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('runs everything for a commit on main, and when main is not in the checkout', () => {
    const f = fixture()
    try {
      f.commit({ 'docs/a.md': 'b' }, 'docs on main')
      // A documents commit pushed to main still runs everything
      expect(changedFiles(f.dir, 'main')).toMatchObject({ files: null, onMain: true })
      expect(changedFiles(f.dir, 'origin/main').files).toBeNull()
      expect(changedFiles(f.dir, 'origin/main').onMain).toBeUndefined()
    } finally {
      f.done()
    }
  })

  it('judges a stacked pull request by the whole stack, not by its own layer', () => {
    const f = fixture()
    try {
      f.git('checkout', '-q', '-b', 'lower')
      f.commit({ 'packages/agent-host/src/x.ts': 'host change' }, 'lower: the host')
      f.git('checkout', '-q', '-b', 'upper')
      f.commit({ 'docs/upper.md': 'docs' }, 'upper: documents')
      // The upper pull request's run, based on the lower branch
      f.merge('upper', 'lower')
      const { files } = changedFiles(f.dir, 'main')
      expect(files!.sort()).toEqual(['docs/upper.md', 'packages/agent-host/src/x.ts'])
      expect(classify(files)).toEqual({ bundle: true, host: true, host_tests: true, code: true })
      // Its own layer alone (the merge commit against its first parent) would have been documents only
      expect(f.git('diff', '--name-only', 'HEAD^1', 'HEAD')).toBe('docs/upper.md')
    } finally {
      f.done()
    }
  })

  // The script as the `changes` job runs it: what it writes to $GITHUB_OUTPUT, by event
  it('writes the quick tier for a pull request, nothing but changes for a draft, and the full tier for a manual run, a release bump and main', () => {
    const f = fixture()
    const script = fileURLToPath(new URL('../.github/scripts/ci-changes.mjs', import.meta.url))
    const event = `${f.dir}-event.json`
    const answer = (everything = '', draft = false) => {
      const out = `${f.dir}-github-output.txt`
      writeFileSync(out, '')
      writeFileSync(event, JSON.stringify({ pull_request: { draft } }))
      execFileSync(process.execPath, [script], { cwd: f.dir, env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_EVENT_PATH: event, EVERYTHING: everything }, stdio: 'pipe' })
      return Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split('=')))
    }
    const off = { quick: 'true', full: 'off', bundle: 'off', host: 'off', host_tests: 'off', code: 'off', fail_fast: 'false' }
    const all = { quick: 'true', full: 'true', bundle: 'true', host: 'true', host_tests: 'true', code: 'true', fail_fast: 'false' }
    try {
      f.git('update-ref', 'refs/remotes/origin/main', 'main')
      f.git('checkout', '-q', '-b', 'docs')
      f.commit({ 'docs/a.md': 'docs' }, 'docs only')
      f.merge('docs', 'main')
      // A pull request's merge commit: the quick tier, whatever it changes
      expect(answer()).toEqual(off)
      // A draft's (a stack's lower, #1066): `changes` alone
      expect(answer('', true)).toEqual({ ...off, quick: 'off' })
      // A manual run on the same commit: everything, or what the files need when `everything` is unticked
      // (the only runs where a failed verify cancels the rest)
      expect(answer('true')).toEqual({ ...all, fail_fast: 'true' })
      expect(answer('false')).toEqual({ quick: 'true', full: 'true', bundle: 'false', host: 'false', host_tests: 'false', code: 'false', fail_fast: 'true' })
      // A release bump's pull request
      f.git('checkout', '-q', '-b', 'bump', 'main')
      f.commit({ [VERSION_SOURCE]: "export const APP_VERSION = '9.9.9'\n" }, 'chore(release): 9.9.9')
      f.merge('bump', 'main')
      expect(answer()).toEqual(all)
      expect(answer('', true)).toEqual(all)
      // Even run by hand, a release bump's run is never cut short
      expect(answer('true')).toEqual(all)
      // A commit on main
      f.git('checkout', '-q', 'main')
      f.commit({ 'docs/b.md': 'docs' }, 'docs on main')
      f.git('update-ref', 'refs/remotes/origin/main', 'main')
      expect(answer()).toEqual(all)
    } finally {
      f.done()
      rmSync(`${f.dir}-github-output.txt`, { force: true })
      rmSync(`${f.dir}-event.json`, { force: true })
    }
  })

  it('sees a file moved into docs/ as a change to where it was', () => {
    const f = fixture()
    try {
      f.git('checkout', '-q', '-b', 'move')
      mkdirSync(join(f.dir, 'docs'))
      f.git('mv', 'packages/agent-host/src/x.ts', 'docs/x.md')
      f.git('commit', '-qm', 'move')
      f.merge('move', 'main')
      const { files } = changedFiles(f.dir, 'main')
      expect(files!.sort()).toEqual(['docs/x.md', 'packages/agent-host/src/x.ts'])
      expect(classify(files).host).toBe(true)
    } finally {
      f.done()
    }
  })
})

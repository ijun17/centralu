import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { workflowCheckNames, workflowEventJobs } from '../.centralu/apps/project-board/ci.mjs'
// @ts-expect-error — a plain .mjs script the workflow runs with the runner's own Node
import { changedFiles, classify } from '../.github/scripts/ci-changes.mjs'

// Like release-workflow.test.ts, inspect the workflow without adding a YAML dependency.
const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
  .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
const bundle = workflow.split('  bundle:\n')[1]?.split(/^ {2}\S/m)[0] ?? ''
const steps = bundle.split(/^ {6}- /m).slice(1)

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
 */
describe('CI leaves out the jobs a commit cannot affect, and every check still reports', () => {
  const jobs = workflow.split(/^jobs:\n/m)[1]!.split(/(?=^ {2}[\w-]+:\n)/m).map((b) => ({ id: /^ {2}([\w-]+):/.exec(b)![1]!, body: b }))
  const job = (id: string) => jobs.find((j) => j.id === id)!
  const gate = (body: string) => /^ {4}if: needs\.changes\.outputs\.(\w+) == '(true|false)'$/m.exec(body)
  const names = (body: string) => workflowCheckNames(`jobs:\n${body}`).names.sort()

  it('gates the slow jobs on an answer of `changes`, and leaves verify, windows tests and WebKit e2e to every commit', () => {
    const gated = Object.fromEntries(jobs.filter((j) => gate(j.body)?.[2] === 'true').map((j) => [j.id, gate(j.body)![1]]))
    expect(gated).toEqual({
      bundle: 'bundle',
      'content-verify': 'host',
      'e2e-chromium': 'code',
      'ux-tasks': 'code',
      'host-tests-remote-node': 'host_tests',
      keeper: 'host',
      'keeper-linux': 'host',
    })
    // WebKit e2e on every pull request, documents only included: the owner's decision of 2026-10-11
    for (const id of ['verify', 'windows-tests', 'windows-tests-unit', 'e2e']) expect(job(id).body).not.toMatch(/^ {4}(needs|if):/m)
    expect(jobs.some((j) => j.id === 'e2e-skipped')).toBe(false)
    for (const id of Object.keys(gated)) expect(job(id).body).toMatch(/^ {4}needs: changes$/m)
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

  // #1035: a flaky shard cost a rerun of its whole job, 5 to 7 minutes with the queue
  it('runs a failed e2e shard once more inside its job, saying so, with time for both and the first report kept', () => {
    for (const id of ['e2e', 'e2e-chromium']) {
      const body = job(id).body
      const step = body.slice(body.indexOf('- name: pnpm e2e'))
      expect(step, id).toMatch(/^ {8}id: e2e$/m)
      const run = /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(step)?.[1] ?? ''
      const lines = run.split('\n').map((l) => l.trim()).filter(Boolean)
      expect(lines[0], id).toMatch(/^e2e\(\) \{ pnpm e2e --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\} .*; \}$/)
      expect(lines[1], id).toBe('if e2e; then exit 0; fi')
      expect(lines.at(-1), id).toBe('e2e')
      const rest = lines.slice(2, -1)
      expect(rest.some((l) => l.startsWith('echo "::warning title=e2e (')), id).toBe(true)
      expect(rest.some((l) => l.includes('mv "$d" "e2e-first-attempt/')), id).toBe(true)
      expect(rest, id).toContain('echo "retried=true" >> "$GITHUB_OUTPUT"')
      // The first run's report, uploaded apart from the blobs `e2e report` merges
      expect(body, id).toMatch(/if: \$\{\{ !cancelled\(\) && steps\.e2e\.outputs\.retried == 'true' \}\}\n {8}with:\n {10}name: e2e-first-attempt-/)
      expect(Number(/^ {4}timeout-minutes: (\d+)$/m.exec(body)?.[1]), id).toBeGreaterThanOrEqual(30)
    }
    expect(workflow).toContain('pattern: e2e-blob-*')
  })

  it('gives each gated matrix job a stand-in with the same checks, run on the other answer only', () => {
    for (const j of jobs.filter((x) => gate(x.body)?.[2] === 'true' && /^ {4}strategy:/m.test(x.body))) {
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

  it('asks `changes` with the same rule on every event', () => {
    const changes = job('changes').body
    expect(changes).toContain('run: node .github/scripts/ci-changes.mjs')
    // main and the history back to the merge-base (see changedFiles below)
    expect(changes).toContain('fetch-depth: 0')
    expect(workflowEventJobs(`on:\n  push:\n  pull_request:\njobs:\n${changes}`)[0]!.reason).toBeNull()
    const script = readFileSync(new URL('../.github/scripts/ci-changes.mjs', import.meta.url), 'utf8')
    expect(script).not.toMatch(/GITHUB_(EVENT|REF|HEAD_REF|BASE_REF)|github\.event/)
  })
})

describe('what a commit needs, from the files it changes (.github/scripts/ci-changes.mjs)', () => {
  const none = { bundle: false, host: false, host_tests: false, code: false }
  it.each([
    ['documents only', ['docs/agent-host.md', 'README.md', '.github/PULL_REQUEST_TEMPLATE.md'], none],
    ['host tests only', ['packages/agent-host/src/store.test.ts', 'packages/agent-host/src/fake-exe.test-helpers.ts'], { ...none, host_tests: true, code: true }],
    ['UI scenarios only', ['e2e/control-loop.spec.ts', 'e2e/fixtures/control.ts'], { ...none, code: true }],
    ['tooling tests', ['tooling/launcher-serve.test.ts', 'vitest.config.ts'], { ...none, host_tests: true, code: true }],
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

  it('runs everything when the changed files are not known', () => {
    expect(classify(null)).toEqual({ bundle: true, host: true, host_tests: true, code: true })
  })

  // So a bump PR's run is main's run, which runs everything (the release script's reuse, docs/releasing.md)
  it('runs everything for a release bump, from the file that declares the version alone', () => {
    const release = (JSON.parse(readFileSync(new URL('../.centralu/apps/project-board/project.json', import.meta.url), 'utf8')) as { release: { source: { path: string } } }).release
    expect(classify([release.source.path])).toEqual({ bundle: true, host: true, host_tests: true, code: true })
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
      expect(changedFiles(f.dir, 'main').files).toBeNull()
      expect(changedFiles(f.dir, 'origin/main').files).toBeNull()
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

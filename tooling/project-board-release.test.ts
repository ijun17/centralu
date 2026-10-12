import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import { APP_VERSION } from '../packages/protocol/src/brand.js'
import {
  bumpText,
  compareVersions,
  declaredVersion,
  filesNamed,
  nextVersion,
  pathMatches,
  releaseNotes,
  // @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
} from '../.centralu/apps/project-board/versions.mjs'

/**
 * The project board's release tool (#386 step 3): docs/releasing.md as `release_status` and
 * `release` (bump, rehearse, tag, approve). First the version rules (versions.mjs) and this
 * repository's own list of version files; then the app under the real external-app runtime, against
 * a fake `gh` that records every write and never reaches GitHub, and real git on repositories made
 * here, with a bare one standing for GitHub's. Pushes go to that bare repository by `pushurl`, so
 * nothing here can tag, push or publish anything real.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP = join(REPO_ROOT, '.centralu/apps/project-board')
const RELEASE = JSON.parse(readFileSync(join(APP, 'project.json'), 'utf8')).release as { source: { path: string; pattern: string }; versionFiles: string[] }
const TEMPLATE = readFileSync(join(REPO_ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
const CONVENTIONS_DOC = readFileSync(join(REPO_ROOT, 'docs/commit-conventions.md'), 'utf8')

const inRepo = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
/** The files of this repository that carry the current version as a quoted string, found without the app. */
const CARRIERS = inRepo('grep', '-l', '-F', '-e', `"${APP_VERSION}"`, '-e', `'${APP_VERSION}'`, '--')
  .split('\n')
  .filter(Boolean)
  .sort()
const NEXT = nextVersion(APP_VERSION) as string

describe('the version rules', () => {
  it('counts up the prerelease, or moves to the next patch, minor or major', () => {
    expect(nextVersion('2.3.0-beta.16')).toBe('2.3.0-beta.17')
    expect(nextVersion('0.1.0-beta.9')).toBe('0.1.0-beta.10')
    expect(nextVersion('1.0.0-rc.1.2')).toBe('1.0.0-rc.1.3')
    expect(nextVersion('2.3.0-beta.16', 'patch')).toBe('2.3.0')
    expect(nextVersion('2.3.0-beta.16', 'minor')).toBe('2.3.0')
    expect(nextVersion('0.1.0', 'minor')).toBe('0.2.0')
    expect(nextVersion('0.1.3', 'major')).toBe('1.0.0')
    expect(() => nextVersion('1.0.0')).toThrow(/no prerelease part to count up/)
    expect(() => nextVersion('1.0')).toThrow(/is not a version/)
  })

  it('orders versions as semver does, prereleases before their release and numbers by value', () => {
    expect(compareVersions('0.1.0-beta.9', '0.1.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('2.3.0-beta.16', '2.3.0')).toBeLessThan(0)
    expect(compareVersions('0.1.0-beta', '0.1.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('0.1.0-alpha.3', '0.1.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('2.3.0-beta.16', '2.3.0-beta.16')).toBe(0)
  })

  it('bumps the version where it is a quoted string, and leaves prose and longer versions alone', () => {
    const text = `version = "2.3.0-beta.16"\nconst V = '2.3.0-beta.16'\n"x": "2.3.0-beta.160"\nremoved in 2.3.0-beta.16 (#461)\n`
    expect(bumpText(text, '2.3.0-beta.16', '2.3.0-beta.17')).toEqual({
      text: `version = "2.3.0-beta.17"\nconst V = '2.3.0-beta.17'\n"x": "2.3.0-beta.160"\nremoved in 2.3.0-beta.16 (#461)\n`,
      count: 2,
    })
  })

  it('names files with * inside a folder and ** across folders', () => {
    expect(pathMatches('packaging/npm/*/package.json', 'packaging/npm/host-linux-x64/package.json')).toBe(true)
    expect(pathMatches('packaging/npm/*/package.json', 'packaging/npm/a/b/package.json')).toBe(false)
    expect(pathMatches('**/x.json', 'a/b/x.json')).toBe(true)
    expect(pathMatches('**/x.json', 'x.json')).toBe(true)
    expect(pathMatches('a.json', 'b/a.json')).toBe(false)
  })

  it('drafts the notes from what merged, without the release commits', () => {
    expect(releaseNotes(['feat(ui): one (#10)', 'chore(release): 2.3.0-beta.16 (#541)', '', 'fix: two (#11)'])).toEqual(['feat(ui): one (#10)', 'fix: two (#11)'])
  })

  it('reads the version from its one declaration in this repository', () => {
    expect(declaredVersion(readFileSync(join(REPO_ROOT, RELEASE.source.path), 'utf8'), RELEASE.source.pattern)).toBe(APP_VERSION)
  })

  /*
   * The list in project.json against what the repository holds: a file that carries the version and
   * is not named would keep the old version after a bump (and the release workflow's guard would only
   * notice brand.ts). Fails when a version file is added without adding it to release.versionFiles.
   */
  it("names exactly the files of this repository that carry the version (project.json release.versionFiles)", () => {
    const all = inRepo('ls-files').split('\n').filter(Boolean)
    expect([...filesNamed(RELEASE.versionFiles, all)].sort()).toEqual(CARRIERS)
    expect(CARRIERS).toEqual(
      expect.arrayContaining([
        'packages/protocol/src/brand.ts',
        'apps/desktop/package.json',
        'apps/desktop/src-tauri/tauri.conf.json',
        'apps/desktop/src-tauri/Cargo.toml',
        'apps/desktop/src-tauri/Cargo.lock',
        'packaging/npm/centralu/package.json',
      ]),
    )
  })
})

// --- The app, against a fake gh and real git ---------------------------------------------------------

const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const stdin = args.includes('--input') ? fs.readFileSync(0, 'utf8') : null
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + '\n')
const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st))
const fail = (stderr, code = 1, stdout = '') => { process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code) }
const json = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0) }
const R = 'repos/ijun17/centralu'
if (args[0] === 'pr' && args[1] === 'list') {
  const head = args[args.indexOf('--head') + 1]
  json(st.prs.filter((p) => p.headRefName === head))
}
if (args[0] === 'api' && args[1] === '-X') {
  const [method, path] = [args[2], args[3]]
  const body = JSON.parse(stdin)
  if (method === 'POST' && path === R + '/pulls') json({ number: 900, html_url: 'https://github.com/ijun17/centralu/pull/900' })
  if (method === 'POST' && path === R + '/actions/workflows/release.yml/dispatches') {
    st.runs.push({ id: 77, status: 'queued', conclusion: null, event: 'workflow_dispatch', head_branch: body.ref, head_sha: st.dispatchSha, html_url: 'https://github.com/ijun17/centralu/actions/runs/77', created_at: new Date().toISOString() })
    save()
    process.exit(0)
  }
  if (method === 'POST' && /\/actions\/runs\/\d+\/pending_deployments$/.test(path)) json([])
}
if (args[0] === 'api' && args[1] === '-H') {
  const m = /^repos\/[^/]+\/[^/]+\/contents\/([^?]+)(?:\?ref=(.*))?$/.exec(args[3])
  const text = m && st.files[decodeURIComponent(m[1])]
  if (text === undefined || text === null) fail('gh: Not Found (HTTP 404)\n', 1, '{"message":"Not Found"}')
  process.stdout.write(text)
  process.exit(0)
}
if (args[0] === 'api') {
  const [path, query] = args[1].split('?')
  const q = new URLSearchParams(query || '')
  if (path === R) json({ default_branch: 'main', permissions: st.permissions })
  if (path === R + '/branches/main/protection/required_status_checks') json({ contexts: ['build'], checks: [] })
  if (path === R + '/rules/branches/main') json([])
  if (/\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
    const c = { green: ['completed', 'success'], failing: ['completed', 'failure'], pending: ['in_progress', null] }[st.ci]
    json({ check_runs: [{ id: 1, name: 'build', status: c[0], conclusion: c[1], html_url: 'https://github.com/ijun17/centralu/actions/runs/1/job/1', app: { slug: 'github-actions' } }] })
  }
  if (/\/commits\/[0-9a-f]+\/status$/.test(path)) json({ statuses: [] })
  if (path === R + '/actions/workflows/release.yml/runs')
    json({ workflow_runs: st.runs.filter((r) => (!q.get('event') || r.event === q.get('event')) && (!q.get('head_sha') || r.head_sha === q.get('head_sha'))).reverse() })
  const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(path)
  if (jobs) json({ jobs: st.jobs[jobs[1]] || [] })
  const pending = /\/actions\/runs\/(\d+)\/pending_deployments$/.exec(path)
  if (pending) json(st.pending[pending[1]] || [])
}
fail('fake gh: unexpected call ' + JSON.stringify(args) + '\n')
`

type Run = { id: number; status: string; conclusion: string | null; event: string; head_branch: string; head_sha: string; html_url: string; created_at: string }
type State = {
  permissions: Record<string, boolean>
  ci: 'green' | 'failing' | 'pending'
  files: Record<string, string>
  prs: { number: number; state: string; headRefName: string }[]
  runs: Run[]
  jobs: Record<string, { name: string; status: string; conclusion: string | null }[]>
  pending: Record<string, unknown[]>
  dispatchSha?: string
}

const ref: AppRef = { projectId: 'p1', appId: 'project-board' }
const agent: AppCaller = { kind: 'session', sessionId: 's1' }
const GIT_BIN = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git')
let root = ''
let rt: ExternalApps | null = null
let statePath = ''
let logPath = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-project-board-release-')))
  for (const d of ['bin', 'data', 'node']) mkdirSync(join(root, d))
  symlinkSync(process.execPath, join(root, 'node', 'node'))
  writeFileSync(join(root, 'bin', 'gh'), FAKE_GH)
  writeFileSync(join(root, 'bin', 'git'), `#!/bin/sh\nexec "${GIT_BIN}" "$@"\n`)
  chmodSync(join(root, 'bin', 'gh'), 0o755)
  chmodSync(join(root, 'bin', 'git'), 0o755)
  statePath = join(root, 'state.json')
  logPath = join(root, 'gh.log')
  const state: State = {
    permissions: { admin: true, maintain: true, push: true },
    ci: 'green',
    files: { '.github/PULL_REQUEST_TEMPLATE.md': TEMPLATE, 'docs/commit-conventions.md': CONVENTIONS_DOC },
    prs: [],
    runs: [],
    jobs: {},
    pending: {},
  }
  writeFileSync(statePath, JSON.stringify(state))
  writeFileSync(logPath, '')
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmSync(root, { recursive: true, force: true })
})

function runtime() {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: REPO_ROOT, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: { PATH: `${join(root, 'bin')}:${join(root, 'node')}`, HOME: root, FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath, GIT_CONFIG_NOSYSTEM: '1', PROJECT_BOARD_RUN_LOOK_MS: '10' },
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 5_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

async function call(name: string, args: Record<string, unknown> = {}, caller: AppCaller = agent) {
  const out = await rt!.call(ref, name, args, caller)
  if (!out.result) throw new Error(`${name} did not answer: ${out.status} ${out.error}`)
  return { text: resultText(out.result), isError: out.result.isError === true, data: out.result.structuredContent as any }
}
const ghWrites = () =>
  readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string | null })
    .filter((c) => c.args[0] === 'api' && c.args[1] === '-X')
const patchState = (fn: (s: State) => void) => {
  const s = JSON.parse(readFileSync(statePath, 'utf8')) as State
  fn(s)
  writeFileSync(statePath, JSON.stringify(s))
}

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root } }).trim()
function commitAll(cwd: string, message: string) {
  g(cwd, 'add', '-A')
  g(cwd, 'commit', '-q', '-m', message)
  return g(cwd, 'rev-parse', 'HEAD')
}
const write = (base: string, path: string, text: string) => {
  mkdirSync(dirname(join(base, path)), { recursive: true })
  writeFileSync(join(base, path), text)
}

type Repo = { work: string; origin: string; released: string; tip: string }

/**
 * A repository like this one at release time: every file of this repository that carries the version
 * (copied as they are), released as v<APP_VERSION>, then two changes merged. `origin.git` stands for
 * GitHub; fetches reach it through `insteadOf` on GitHub's address, and pushes by `pushurl`, so not
 * even a broken rewrite could push anywhere real.
 *
 * - `bumped`: the bump to NEXT is merged too, untagged (the state before tag)
 */
function repo({ bumped = false }: { bumped?: boolean } = {}): Repo {
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  g(root, 'init', '-q', '--bare', '-b', 'main', origin)
  g(root, 'init', '-q', '-b', 'main', work)
  g(work, 'config', 'user.name', 'Tester')
  g(work, 'config', 'user.email', 'tester@example.test')
  g(work, 'config', 'commit.gpgsign', 'false')
  g(work, 'remote', 'add', 'origin', 'https://github.com/ijun17/centralu.git')
  g(work, 'config', `url.${origin}.insteadOf`, 'https://github.com/ijun17/centralu.git')
  g(work, 'config', 'remote.origin.pushurl', origin)
  for (const f of CARRIERS) write(work, f, readFileSync(join(REPO_ROOT, f), 'utf8'))
  write(work, 'docs/releasing.md', `Released ${APP_VERSION} on a Monday.\n`)
  const released = commitAll(work, `chore(release): ${APP_VERSION} (#541)`)
  g(work, 'tag', `v${APP_VERSION}`)
  write(work, 'a.txt', 'one\n')
  commitAll(work, 'feat(ui): one (#10)')
  write(work, 'b.txt', 'two\n')
  let tip = commitAll(work, 'fix: two (#11)')
  if (bumped) {
    for (const f of CARRIERS) write(work, f, bumpText(readFileSync(join(work, f), 'utf8'), APP_VERSION, NEXT).text)
    tip = commitAll(work, `chore(release): ${NEXT} (#900)`)
  }
  g(work, 'push', '-q', 'origin', 'main', `v${APP_VERSION}`)
  g(work, 'branch', '-q', '--set-upstream-to=origin/main')
  patchState((s) => (s.dispatchSha = tip))
  return { work, origin, released, tip }
}

/** The person's checkout: its branch, head and changes. Must not move. */
const checkout = (work: string) => ({ branch: g(work, 'branch', '--show-current'), head: g(work, 'rev-parse', 'HEAD'), status: g(work, 'status', '--porcelain'), refs: g(work, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/centralu-release') })
const remoteHas = (origin: string, refName: string) => {
  try {
    return g(origin, 'rev-parse', '--verify', '--quiet', refName)
  } catch {
    return null
  }
}
const run = (extra: Partial<Run>): Run => ({
  id: 50,
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: '0'.repeat(40),
  html_url: `https://github.com/ijun17/centralu/actions/runs/${extra.id ?? 50}`,
  created_at: '2026-10-12T10:00:00Z',
  ...extra,
})

describe.skipIf(process.platform === 'win32')('release', { timeout: 60_000 }, () => {
  it('passes check, with the status open to the screen and the steps to agents', async () => {
    const r = await runtime().check(ref)
    expect(r.text.split('\n').filter((l) => l.startsWith('- problem'))).toEqual([])
    expect(r.text).toContain('release_status — reads, model+app')
    expect(r.text).toContain('release — changes, model')
  })

  it('says where the release stands: released, what merged since, and that the next step is a bump', async () => {
    const s = repo()
    patchState((st) => st.runs.push(run({ id: 60, event: 'push', head_branch: `v${APP_VERSION}`, head_sha: s.released })))
    runtime()
    const r = await call('release_status', { path: s.work })
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ ok: true, phase: 'released', version: APP_VERSION, head: s.tip })
    expect(r.data.summary).toBe(`main at ${s.tip.slice(0, 7)} carries ${APP_VERSION}: released as v${APP_VERSION}. Next: ${APP_VERSION} is released. 2 changes since: bump with release step bump.`)
    expect(r.data.lines).toEqual([
      `CI on main at ${s.tip.slice(0, 7)}: green.`,
      `Checkout: clean, on main at ${s.tip.slice(0, 7)}.`,
      `Release run for v${APP_VERSION}: succeeded, https://github.com/ijun17/centralu/actions/runs/60.`,
      `Merged since v${APP_VERSION} (2):`,
      '- fix: two (#11)',
      '- feat(ui): one (#10)',
    ])
    expect(ghWrites()).toEqual([])
  })

  /*
   * The bump touches every file that carries the version, and only those. The files are this
   * repository's own: leave one out of release.versionFiles and the bump refuses (next test), so this
   * one fails.
   */
  it('bumps every version file, opens the pull request from the template, and leaves the checkout alone', async () => {
    const s = repo()
    const before = checkout(s.work)
    runtime()
    const plan = await call('release', { step: 'bump', path: s.work })
    expect(plan.isError).toBe(false)
    expect(plan.data.summary).toBe(
      `Ready to bump ${APP_VERSION} → ${NEXT} on main at ${s.tip.slice(0, 7)}, as chore/release-${NEXT}; nothing pushed yet. Call again with confirm: true to push the branch and open the pull request.`,
    )
    expect(remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)).toBeNull()
    expect(ghWrites()).toEqual([])

    const r = await call('release', { step: 'bump', path: s.work, confirm: true, notes: 'Ship the two changes.', closes: 'Refs #386' })
    expect(r.isError).toBe(false)
    expect(r.data.summary).toBe(`Opened the bump to ${NEXT}: https://github.com/ijun17/centralu/pull/900. Merge it once CI is green (merge_when_green), then rehearse and tag.`)
    const pushed = remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)!
    expect(g(s.origin, 'rev-parse', `${pushed}^`)).toBe(s.tip)
    expect(g(s.origin, 'log', '-1', '--format=%s', pushed)).toBe(`chore(release): ${NEXT}`)
    // Exactly the files that carry the version, and in each of them no old version left
    expect(g(s.origin, 'diff', '--name-only', s.tip, pushed).split('\n').sort()).toEqual(CARRIERS)
    const show = (p: string) => g(s.origin, 'show', `${pushed}:${p}`)
    for (const f of CARRIERS) {
      expect(show(f), f).not.toContain(`"${APP_VERSION}"`)
      expect(show(f), f).not.toContain(`'${APP_VERSION}'`)
    }
    // What tooling/brand.test.ts holds the files to, on the bumped commit
    const json = (p: string) => JSON.parse(show(p))
    expect(declaredVersion(show(RELEASE.source.path), RELEASE.source.pattern)).toBe(NEXT)
    expect(json('apps/desktop/src-tauri/tauri.conf.json').version).toBe(NEXT)
    expect(json('apps/desktop/package.json').version).toBe(NEXT)
    expect(show('apps/desktop/src-tauri/Cargo.toml')).toContain(`version = "${NEXT}"`)
    for (const f of CARRIERS.filter((p) => p.startsWith('packaging/npm/'))) expect(json(f).version, f).toBe(NEXT)
    expect(Object.values(json('packaging/npm/centralu/package.json').optionalDependencies)).toEqual(expect.arrayContaining([NEXT]))
    expect(Object.values(json('packaging/npm/centralu/package.json').optionalDependencies)).not.toContain(APP_VERSION)
    expect(show('docs/releasing.md')).toBe(`Released ${APP_VERSION} on a Monday.`)

    const [open] = ghWrites()
    expect(open!.args).toEqual(['api', '-X', 'POST', 'repos/ijun17/centralu/pulls', '--input', '-'])
    const body = JSON.parse(open!.stdin!)
    expect(body).toMatchObject({ title: `chore(release): ${NEXT}`, head: `chore/release-${NEXT}`, base: 'main', draft: false })
    expect(body.body).toContain(`## Why\n\nShip the two changes.\n\nMerged since v${APP_VERSION}:\n\n- fix: two (#11)\n- feat(ui): one (#10)`)
    expect(body.body).toContain(`## Not exercised\n\nThe release workflow, until v${NEXT} is tagged.`)
    expect(body.body).toContain('## Closes\n\nRefs #386')
    expect(checkout(s.work)).toEqual(before)
  })

  it('refuses a bump that would miss a file carrying the version, or names a file that lost it', async () => {
    const s = repo()
    write(s.work, 'packages/other/version.json', `{ "version": "${APP_VERSION}" }\n`)
    write(s.work, 'apps/desktop/package.json', readFileSync(join(s.work, 'apps/desktop/package.json'), 'utf8').replace(`"${APP_VERSION}"`, '"0.0.1"'))
    commitAll(s.work, 'chore: drift')
    g(s.work, 'push', '-q', 'origin', 'main')
    runtime()
    const r = await call('release', { step: 'bump', path: s.work, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.data.problems).toEqual([
      `apps/desktop/package.json is in release.versionFiles but does not carry "${APP_VERSION}"; it fell behind, or the list is wrong.`,
      `packages/other/version.json carries "${APP_VERSION}" but is not in project.json release.versionFiles; add it there (or to release.ignore if that string is not the version).`,
    ])
    expect(r.data.summary).toBe('Release bump refused (2 reasons); nothing was pushed, tagged, started or approved.')
    expect(remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)).toBeNull()
    expect(ghWrites()).toEqual([])
  })

  it.each([
    ['a dirty checkout', (w: string) => write(w, 'a.txt', 'edited\n'), /^The checkout at .* has 1 uncommitted change \(a\.txt\); commit or put them away first/],
    ['another branch', (w: string) => g(w, 'switch', '-q', '-c', 'topic'), /^The checkout at .* is on branch topic, not main; switch to main first\.$/],
    ['a checkout behind GitHub', (w: string) => g(w, 'reset', '-q', '--hard', 'HEAD~1'), /^The checkout's main \(\w{7}\) is behind main on origin \(\w{7}\); pull first\.$/],
    ['local commits GitHub lacks', (w: string) => (write(w, 'c.txt', 'c\n'), commitAll(w, 'local')), /^The checkout's main \(\w{7}\) has commits main on origin \(\w{7}\) does not/],
  ])('refuses to bump or tag from %s', async (_, spoil, why) => {
    const s = repo()
    spoil(s.work)
    runtime()
    for (const step of ['bump', 'tag']) {
      const r = await call('release', { step, path: s.work, confirm: true, skipRehearsal: true })
      expect(r.isError, step).toBe(true)
      expect(r.data.problems.some((p: string) => why.test(p)), `${step}: ${r.data.problems.join(' | ')}`).toBe(true)
    }
    expect(ghWrites()).toEqual([])
    expect(remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)).toBeNull()
  })

  it('refuses every step for an account without maintain or admin, before reading anything else', async () => {
    const s = repo()
    patchState((st) => (st.permissions = { push: true }))
    runtime()
    for (const step of ['bump', 'rehearse', 'tag', 'approve']) {
      const r = await call('release', { step, path: s.work, confirm: true })
      expect(r.data.problems, step).toEqual([
        "The GitHub account gh is logged in as has no maintain or admin permission on this repository, and releasing is the maintainer's act (#386). Nothing was changed.",
      ])
    }
    expect(ghWrites()).toEqual([])
  })

  it('refuses a bump while CI on main is not green, while the version is not released, or to a version not after it', async () => {
    const s = repo({ bumped: true })
    patchState((st) => (st.ci = 'failing'))
    runtime()
    const r = await call('release', { step: 'bump', path: s.work, version: APP_VERSION })
    expect(r.data.problems).toEqual([
      expect.stringMatching(new RegExp(`^CI on main at ${s.tip.slice(0, 7)} is not green: main at ${s.tip.slice(0, 7)}: failing\\.`)),
      `${NEXT} on main is not released yet (no tag v${NEXT}); release it (release step tag) before bumping past it.`,
      `${APP_VERSION} is not after ${NEXT}, the version on main.`,
      `${APP_VERSION} is not after v${APP_VERSION}, the latest release tag.`,
      `v${APP_VERSION} is tagged already.`,
    ])
  })

  it('refuses a bump whose branch or pull request exists already', async () => {
    const s = repo()
    g(s.work, 'push', '-q', 'origin', `HEAD:refs/heads/chore/release-${NEXT}`)
    patchState((st) => st.prs.push({ number: 950, state: 'OPEN', headRefName: `chore/release-${NEXT}` }))
    runtime()
    const r = await call('release', { step: 'bump', path: s.work, confirm: true })
    expect(r.data.problems).toEqual([
      `The branch chore/release-${NEXT} exists on origin already; a bump for ${NEXT} was started. Look at its pull request, or delete the branch.`,
      `Pull request #950 for chore/release-${NEXT} is open already.`,
    ])
  })

  it('rehearses on main with the dry-run input, and does not start a second rehearsal', async () => {
    const s = repo({ bumped: true })
    runtime()
    const plan = await call('release', { step: 'rehearse', path: s.work })
    expect(plan.data.summary).toBe(
      `Ready to rehearse ${NEXT} on main at ${s.tip.slice(0, 7)} (release.yml with dry_run=true; builds and packs, publishes nothing, asks no approval). Call again with confirm: true to start it.`,
    )
    expect(ghWrites()).toEqual([])
    const r = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(r.data.summary).toBe(`Started the rehearsal of ${NEXT} on ${s.tip.slice(0, 7)}: https://github.com/ijun17/centralu/actions/runs/77. Tag once it succeeds.`)
    expect(ghWrites()).toEqual([{ args: ['api', '-X', 'POST', 'repos/ijun17/centralu/actions/workflows/release.yml/dispatches', '--input', '-'], stdin: '{"ref":"main","inputs":{"dry_run":"true"}}' }])
    const again = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(again.data.summary).toBe(`A rehearsal on ${s.tip.slice(0, 7)} queued: https://github.com/ijun17/centralu/actions/runs/77; not starting another.`)
    expect(ghWrites()).toHaveLength(1)
  })

  it('refuses to tag without a successful rehearsal on the commit, unless told to skip it', async () => {
    const s = repo({ bumped: true })
    runtime()
    const none = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(none.data.problems).toEqual([`No rehearsal ran on ${s.tip.slice(0, 7)}: rehearse first (release step rehearse), or pass skipRehearsal: true to tag without one.`])
    patchState((st) => st.runs.push(run({ head_sha: s.tip, conclusion: 'failure' })))
    const failed = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(failed.data.problems).toEqual([`The rehearsal on ${s.tip.slice(0, 7)} ended failure (https://github.com/ijun17/centralu/actions/runs/50); fix that first, or pass skipRehearsal: true.`])
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
    const skipped = await call('release', { step: 'tag', path: s.work, skipRehearsal: true })
    expect(skipped.isError).toBe(false)
    expect(skipped.data.lines[1]).toBe('Rehearsal: skipped (skipRehearsal: true).')
  })

  it('tags main after a rehearsal, pushes only the tag, and answers the release run', async () => {
    const s = repo({ bumped: true })
    const before = checkout(s.work)
    patchState((st) => {
      st.runs.push(run({ head_sha: s.tip }))
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'waiting', conclusion: null, html_url: 'https://github.com/ijun17/centralu/actions/runs/61' }))
    })
    runtime()
    const plan = await call('release', { step: 'tag', path: s.work, version: `v${NEXT}` })
    expect(plan.data.summary).toBe(`Ready to tag v${NEXT} on ${s.tip.slice(0, 7)}; nothing pushed yet. The tag is the release: the workflow publishes after approval on npm-publish. Call again with confirm: true to push it.`)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
    const r = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(r.isError).toBe(false)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBe(s.tip)
    expect(r.data.summary).toBe(
      `Tagged v${NEXT} on ${s.tip.slice(0, 7)}. The release run: https://github.com/ijun17/centralu/actions/runs/61. It waits for approval on npm-publish: the platform jobs first, then the shim. Next: release step approve, or approve on GitHub.`,
    )
    // Pushed by commit: no tag or branch made in the checkout
    expect(checkout(s.work)).toEqual(before)
    expect(ghWrites()).toEqual([])
    const twice = await call('release', { step: 'tag', path: s.work, confirm: true, skipRehearsal: true })
    expect(twice.data.problems).toEqual([`v${NEXT} is tagged already; a release tag is never moved. Bump to the next version instead.`])
  })

  it('refuses to tag another version than main carries, or while CI on main is red', async () => {
    const s = repo({ bumped: true })
    patchState((st) => {
      st.ci = 'pending'
      st.runs.push(run({ head_sha: s.tip }))
    })
    runtime()
    const r = await call('release', { step: 'tag', path: s.work, version: '9.9.9', confirm: true })
    expect(r.data.problems).toEqual([
      expect.stringMatching(new RegExp(`^CI on main at ${s.tip.slice(0, 7)} is not green: main at ${s.tip.slice(0, 7)}: pending\\.`)),
      `main at ${s.tip.slice(0, 7)} carries ${NEXT}, not 9.9.9; merge its bump first.`,
    ])
    expect(remoteHas(s.origin, 'refs/tags/v9.9.9')).toBeNull()
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
  })

  it('approves only the tag release run, only what GitHub says this login may approve', async () => {
    const s = repo({ bumped: true })
    g(s.work, 'push', '-q', 'origin', `${s.tip}:refs/tags/v${NEXT}`)
    patchState((st) => {
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'waiting', conclusion: null, html_url: 'https://github.com/ijun17/centralu/actions/runs/61' }))
      st.jobs['61'] = [
        { name: 'check the tag against the repo', status: 'completed', conclusion: 'success' },
        { name: 'linux-x64', status: 'waiting', conclusion: null },
        { name: 'darwin-arm64', status: 'waiting', conclusion: null },
      ]
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: false, reviewers: [{ reviewer: { login: 'owner' } }] }]
    })
    runtime()
    const status = await call('release_status', { path: s.work })
    expect(status.data.phase).toBe('waiting-approval')
    expect(status.data.lines).toContain('Waiting for approval on npm-publish: linux-x64, darwin-arm64.')
    const cannot = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(cannot.data.problems).toEqual(['GitHub says this login may not approve npm-publish for this run (reviewers: owner). Approve on GitHub: https://github.com/ijun17/centralu/actions/runs/61'])

    patchState((st) => ((st.pending['61']![0] as { current_user_can_approve: boolean }).current_user_can_approve = true))
    const plan = await call('release', { step: 'approve', path: s.work })
    expect(plan.data.summary).toBe(
      `v${NEXT}'s release run waits for approval on npm-publish (linux-x64, darwin-arm64); nothing approved yet. Call again with confirm: true to approve, or approve on GitHub: https://github.com/ijun17/centralu/actions/runs/61`,
    )
    expect(ghWrites()).toEqual([])
    const r = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(r.data.summary).toBe(`Approved npm-publish for v${NEXT} (linux-x64, darwin-arm64): https://github.com/ijun17/centralu/actions/runs/61. The shim asks again once every platform job succeeds.`)
    expect(ghWrites()).toEqual([
      {
        args: ['api', '-X', 'POST', 'repos/ijun17/centralu/actions/runs/61/pending_deployments', '--input', '-'],
        stdin: JSON.stringify({ environment_ids: [7], state: 'approved', comment: `Approved through the project board's release tool for v${NEXT}.` }),
      },
    ])
  })

  it('refuses to approve a version with no tag, and says so when nothing waits', async () => {
    const s = repo({ bumped: true })
    runtime()
    const r = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(r.data.problems).toEqual([`v${NEXT} is not tagged; there is no release run to approve.`])
    patchState((st) => st.runs.push(run({ id: 60, event: 'push', head_branch: `v${APP_VERSION}`, head_sha: s.released })))
    const done = await call('release', { step: 'approve', path: s.work, version: APP_VERSION, confirm: true })
    expect(done.isError).toBe(false)
    expect(done.data.summary).toBe(`The release run for v${APP_VERSION} succeeded: https://github.com/ijun17/centralu/actions/runs/60; nothing waits for approval.`)
    expect(ghWrites()).toEqual([])
  })

  it('never writes into the app folder or leaves refs behind', async () => {
    const s = repo()
    runtime()
    await call('release_status', { path: s.work })
    await call('release', { step: 'bump', path: s.work })
    expect(g(s.work, 'for-each-ref', 'refs/centralu-release')).toBe('')
    expect(existsSync(join(APP, 'private-words.json'))).toBe(false)
  })
})

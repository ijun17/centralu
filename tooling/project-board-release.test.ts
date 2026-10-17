import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeExe, gitWrapper, linkNode, rmFakeDir, windowsSystemEnv } from '../packages/agent-host/src/fake-exe.test-helpers.js'
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
  versionLines,
  // @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
} from '../.centralu/apps/project-board/versions.mjs'
import { SLOW } from './test-timing.js'

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
const RELEASE = JSON.parse(readFileSync(join(APP, 'project.json'), 'utf8')).release as {
  source: { path: string; pattern: string }
  versionFiles: string[]
  ignore: string[]
}
const TEMPLATE = readFileSync(join(REPO_ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
const CONVENTIONS_DOC = readFileSync(join(REPO_ROOT, 'docs/commit-conventions.md'), 'utf8')

const inRepo = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
/** Scan every tracked text file, independently of the release tool's git prefilter. */
const TRACKED = inRepo('ls-files', '-z').split('\0').filter(Boolean)
const CARRIERS = filesNamed(RELEASE.versionFiles, TRACKED).sort() as string[]
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

  it.each(['1.0.0', '1.0.0-beta.21'])('matches %s itself and local/build extensions, not another prerelease', (version) => {
    for (const value of [version, `v${version}`, `${version}.local.1`, `${version}+build`, `${version}+build.123`, version + '.local.${n}']) {
      expect(versionLines(`const value = \`${value}\``, version), value).toEqual([1])
    }
    for (const suffix of ['-beta.21', '-rc', '-local.1', '+other', '+builder', '.1', '.local.0', '.local.01', '0', 'a']) {
      expect(versionLines(`"${version}${suffix}"`, version), suffix).toEqual([])
    }
    expect(versionLines(`Released ${version}.\n`, version)).toEqual([1])
  })

  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])('ignores ranges only in package.json %s values', (field) => {
    const ranges = { a: '^1.0.0', b: '~1.0.0', c: '>= 1.0.0', d: 'workspace:^1.0.0' }
    for (const space of [undefined, 2]) {
      const text = JSON.stringify({ [field]: ranges }, null, space)
      expect(versionLines(text, '1.0.0', 'nested/package.json')).toEqual([])
      expect(versionLines(text, '1.0.0', 'nested/config.json').length).toBeGreaterThan(0)
    }
    expect(versionLines(JSON.stringify({ [field]: { ...ranges, pinned: '1.0.0' } }), '1.0.0', 'package.json')).toEqual([1])
    expect(versionLines(JSON.stringify({ [field]: ranges, version: '1.0.0' }), '1.0.0', 'package.json')).toEqual([1])
    expect(versionLines(JSON.stringify({ scripts: { check: '^1.0.0' }, [field]: ranges }), '1.0.0', 'package.json')).toEqual([1])
    expect(versionLines(JSON.stringify({ nested: { [field]: ranges } }), '1.0.0', 'package.json')).toEqual([1])
    const multiline = JSON.stringify({ [field]: ranges, version: '1.0.0' }, null, 2)
    expect(versionLines(multiline, '1.0.0', 'package.json')).toEqual([8])
    expect(versionLines('{"dependencies":{"a":"^1.0.0"}', '1.0.0', 'package.json')).toEqual([1])
    expect(versionLines('{"dependencies":{"escaped":"\\u005e1.0.0","braces":"^1.0.0 {range}"}}', '1.0.0', 'package.json')).toEqual([])
  })

  it.each([
    ['docs/releasing.md', 'The steps by hand:'],
    ['docs/releasing.ko.md', '손으로 하는 단계:'],
  ])('keeps the release guide lead-in attached to step one in %s', (path, lead) => {
    expect(readFileSync(join(REPO_ROOT, path!), 'utf8')).toContain(`${lead}\n\n1. `)
  })

  it('keeps the Korean release explanation in Korean', () => {
    const korean = readFileSync(join(REPO_ROOT, 'docs/releasing.ko.md'), 'utf8')
    const section = korean.split('## 버전 릴리스하기')[1]!.split('\n1. ')[0]!
    for (const paragraph of section.trim().split(/\n\s*\n/)) {
      expect(paragraph.replace(/`[^`]*`/g, ''), paragraph).toMatch(/[가-힣]/)
    }
  })

  it('requires every listed repository version file to carry the current quoted version', () => {
    expect(CARRIERS.length).toBeGreaterThan(0)
    for (const path of CARRIERS) {
      expect(bumpText(readFileSync(join(REPO_ROOT, path), 'utf8'), APP_VERSION, NEXT).count, path).toBeGreaterThan(0)
    }
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
    const unlisted = TRACKED.filter((p) => !CARRIERS.includes(p) && !filesNamed(RELEASE.ignore, [p]).length)
    const hits = unlisted.flatMap((p) => {
      const text = readFileSync(join(REPO_ROOT, p), 'utf8')
      return text.includes('\0') ? [] : versionLines(text, APP_VERSION, p).map((line: number) => `${p}:${line}`)
    })
    expect(hits).toEqual([])
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
// A queue of answers per key (seq['ci:<sha>'], 'jobs:<run>', 'pending:<run>'): each request takes the
// next, the last one stays. What a waiting approve sees change between its reads.
const next = (key, fallback) => {
  const q = st.seq?.[key]
  if (!q || !q.length) return fallback
  const v = q.length > 1 ? q.shift() : q[0]
  save()
  return v
}
const association = (p) => ({ number: p.number, head: { sha: p.headRefOid, ref: p.headRefName }, base: { ref: p.baseRefName } })
if (args[0] === 'pr' && args[1] === 'list') {
  const head = args[args.indexOf('--head') + 1]
  json(st.prs.filter((p) => p.headRefName === head))
}
if (args[0] === 'api' && args[1] === '--paginate' && args[2] === '--slurp') {
  const [path, query] = args[3].split('?')
  const q = new URLSearchParams(query)
  if (path === R + '/actions/workflows/build.yml/runs') {
    const pr = st.prs.find((p) => p.headRefOid === q.get('head_sha'))
    const event = pr ? 'pull_request' : 'push'
    const branch = pr ? pr.headRefName : 'main'
    const current = { id: 1, check_suite_id: 11, head_sha: q.get('head_sha'), event, head_branch: branch, head_repository: { full_name: 'ijun17/centralu' }, status: 'completed', conclusion: 'success', run_attempt: 1, pull_requests: [], ...st.ciRunOverrides?.[q.get('head_sha')] }
    // Return mismatching metadata too, to exercise the client-side identity guard.
    json([{ workflow_runs: [current, ...(st.staleAttempt ? [{ ...current, run_attempt: 1, conclusion: 'cancelled' }] : [])] }])
  }
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
  if (method === 'POST' && /\/actions\/runs\/\d+\/cancel$/.test(path)) {
    st.cancelled = [...(st.cancelled || []), path]
    save()
    process.exit(0)
  }
  if (method === 'POST' && /\/actions\/runs\/\d+\/pending_deployments$/.test(path)) json([])
}
if (args[0] === 'api' && args[1] === '-H') {
  const m = /^repos\/[^/]+\/[^/]+\/contents\/([^?]+)(?:\?ref=(.*))?$/.exec(args[3])
  const text = m && (st.filesAt?.[decodeURIComponent(m[2] || '')]?.[decodeURIComponent(m[1])] ?? st.files[decodeURIComponent(m[1])])
  if (text === undefined || text === null) fail('gh: Not Found (HTTP 404)\n', 1, '{"message":"Not Found"}')
  process.stdout.write(text)
  process.exit(0)
}
if (args[0] === 'api') {
  const [path, query] = args[1].split('?')
  const q = new URLSearchParams(query || '')
  if (path === R + '/commits/main') json({ sha: st.dispatchSha })
  if (/\/commits\/[0-9a-f]+\/pulls$/.test(path)) json(st.commitPrOverrides || st.prs.map(association))
  if (path === R) json({ default_branch: 'main', permissions: st.permissions })
  if (path === R + '/branches/main/protection/required_status_checks') {
    if (st.noProtection) fail('gh: Branch not protected (HTTP 404)\n', 1, '{"message":"Branch not protected"}')
    json({ contexts: ['build'], checks: [] })
  }
  if (path === R + '/rules/branches/main') json([])
  if (/\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
    const sha = path.split('/').at(-2)
    const verdict = next('ci:' + sha, st.ciBySha?.[sha] || (st.prs.some((p) => p.headRefOid === sha) ? st.prCi : st.ci))
    const collision = st.collidingReleaseChecks === true || st.collidingReleaseChecks === (st.prs.some((p) => p.headRefOid === sha) ? 'PR' : 'main')
    const releaseChecks = collision ? [{ id: 99, name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-10-13T12:00:00Z', check_suite: { id: 99 }, app: { slug: 'github-actions' } }] : []
    if (verdict === 'none') json({ check_runs: releaseChecks })
    const c = { green: ['completed', 'success'], failing: ['completed', 'failure'], pending: ['in_progress', null], cancelled: ['completed', 'cancelled'] }[verdict]
    json({ check_runs: [{ id: 1, name: 'build', status: c[0], conclusion: c[1], html_url: 'https://github.com/ijun17/centralu/actions/runs/1/job/1', started_at: '2026-10-13T10:00:00Z', check_suite: { id: 11 }, app: { slug: st.ciApp || 'github-actions' } }, ...releaseChecks] })
  }
  if (/\/commits\/[0-9a-f]+\/status$/.test(path)) json({ statuses: [] })
  if (path === R + '/actions/runs') json({ workflow_runs: (st.activeRuns || []).filter((r) => r.status === q.get('status')) })
  if (path === R + '/actions/workflows/release.yml/runs' && q.get('event') === 'push' && st.seq?.tagRuns) json({ workflow_runs: next('tagRuns', []) })
  if (path === R + '/actions/workflows/release.yml/runs')
    json({ workflow_runs: st.runs.filter((r) => (!q.get('event') || r.event === q.get('event')) && (!q.get('head_sha') || r.head_sha === q.get('head_sha')) && (!q.get('branch') || r.head_branch === q.get('branch'))).reverse() })
  const jobs = /\/actions\/runs\/(\d+)\/jobs$/.exec(path)
  if (jobs) json({ jobs: next('jobs:' + jobs[1], st.jobs[jobs[1]] || []) })
  const pending = /\/actions\/runs\/(\d+)\/pending_deployments$/.exec(path)
  if (pending) json(next('pending:' + pending[1], st.pending[pending[1]] || []))
}
fail('fake gh: unexpected call ' + JSON.stringify(args) + '\n')
`

type Run = { id: number; status: string; conclusion: string | null; event: string; head_branch: string; head_sha: string; html_url: string; created_at: string }
type State = {
  permissions: Record<string, boolean>
  ci: 'green' | 'failing' | 'pending' | 'none'
  prCi?: 'green' | 'failing' | 'pending' | 'none'
  collidingReleaseChecks?: boolean | 'main' | 'PR'
  ciApp?: string
  ciBySha?: Record<string, string>
  ciRunOverrides?: Record<string, Record<string, unknown>>
  commitPrOverrides?: unknown[]
  staleAttempt?: boolean
  files: Record<string, string>
  prs: { number: number; state: string; headRefName: string; baseRefName?: string; headRefOid?: string; mergeCommit?: { oid: string } }[]
  runs: Run[]
  jobs: Record<string, { name: string; status: string; conclusion: string | null }[]>
  pending: Record<string, unknown[]>
  dispatchSha?: string
  cancelled?: string[]
  seq?: Record<string, unknown[]>
  /** No branch protection: the required set comes from the workflow files */
  noProtection?: boolean
  /** A file's text at one ref (the contents API's ?ref=), before `files` */
  filesAt?: Record<string, Record<string, string>>
  /** Every workflow's runs not completed, for how busy the runners are */
  activeRuns?: { id: number; status: string }[]
  /** The npm registry: package name → the commit it was published from; a name not here is absent */
  registry?: Record<string, string | null>
  /** How many more times the registry answers 404 for a name before it shows what `registry` holds */
  registryHidden?: Record<string, number>
}

/** What the shim needs on the registry: every package of packaging/npm but the shim */
const REGISTRY_NAMES = CARRIERS.filter((p) => /^packaging\/npm\/[^/]+\/package\.json$/.test(p) && p !== 'packaging/npm/centralu/package.json').map(
  (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), 'utf8')).name as string,
)
/** A local npm registry for the shim's gate, answering from the fake gh's state */
function registryServer() {
  const server = createServer(async (req, res) => {
    if (registryHold) {
      registryAsked?.()
      await registryHold
    }
    const st = JSON.parse(readFileSync(statePath, 'utf8')) as State
    const m = /^\/(.+)\/([^/]+)$/.exec(req.url ?? '')
    const name = m ? decodeURIComponent(m[1]!) : ''
    const hidden = st.registryHidden?.[name] ?? 0
    if (hidden > 0) {
      st.registryHidden![name] = hidden - 1
      writeFileSync(statePath, JSON.stringify(st))
    }
    if (!m || hidden > 0 || !st.registry || !(name in st.registry)) return void res.writeHead(404).end('{}')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, version: m[2], ...(st.registry[name] ? { gitHead: st.registry[name] } : {}) }))
  })
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) })),
  )
}
const published = (sha: string, names = REGISTRY_NAMES) => patchState((st) => (st.registry = Object.fromEntries(names.map((n) => [n, sha]))))

const ref: AppRef = { projectId: 'p1', appId: 'project-board' }
const agent: AppCaller = { kind: 'session', sessionId: 's1' }
let root = ''
/** Where git is, when the PATH has to be told (gitWrapper) */
let gitDirs: string[] = []
let rt: ExternalApps | null = null
let statePath = ''
let logPath = ''
let registry: { url: string; close: () => Promise<void> } | null = null
/** While set, the registry answers only once it settles; `registryAsked` is called on each request */
let registryHold: Promise<void> | null = null
let registryAsked: (() => void) | null = null

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-project-board-release-')))
  for (const d of ['bin', 'data', 'node']) mkdirSync(join(root, d))
  linkNode(join(root, 'node'))
  fakeExe(join(root, 'bin'), 'gh', FAKE_GH)
  gitDirs = gitWrapper(join(root, 'bin'))
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
  registry = await registryServer()
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  registryHold = null
  registryAsked = null
  await registry?.close()
  registry = null
  rmFakeDir(root)
})

function runtime(ignore?: string[]) {
  let projectPath = REPO_ROOT
  if (ignore) {
    projectPath = join(root, 'project')
    const app = join(projectPath, '.centralu/apps/project-board')
    cpSync(APP, app, { recursive: true })
    const config = JSON.parse(readFileSync(join(app, 'project.json'), 'utf8'))
    config.release.ignore = ignore
    writeFileSync(join(app, 'project.json'), JSON.stringify(config))
  }
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projectPath, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: { PATH: [join(root, 'bin'), join(root, 'node'), ...gitDirs].join(delimiter), HOME: root, ...windowsSystemEnv(), FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath, GIT_CONFIG_NOSYSTEM: '1', PROJECT_BOARD_RUN_LOOK_MS: '10', PROJECT_BOARD_CI_POLL_MS: '10', PROJECT_BOARD_NPM_REGISTRY: registry!.url },
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 5_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

async function call(name: string, args: Record<string, unknown> = {}, caller: AppCaller = agent, signal?: AbortSignal) {
  const out = await rt!.call(ref, name, args, caller, signal ? { signal } : {})
  if (signal?.aborted) return { text: out.status, isError: true, data: { status: out.status } as any }
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
function repo({ bumped = false, version = APP_VERSION }: { bumped?: boolean; version?: string } = {}): Repo {
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
  for (const f of CARRIERS) write(work, f, bumpText(readFileSync(join(REPO_ROOT, f), 'utf8'), APP_VERSION, version).text)
  write(work, 'docs/releasing.md', `Released ${version} on a Monday.\n`)
  const released = commitAll(work, `chore(release): ${version} (#541)`)
  g(work, 'tag', `v${version}`)
  write(work, '.github/workflows/build.yml', 'on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n')
  write(work, 'a.txt', 'one\n')
  commitAll(work, 'feat(ui): one (#10)')
  write(work, 'b.txt', 'two\n')
  let tip = commitAll(work, 'fix: two (#11)')
  if (bumped) {
    for (const f of CARRIERS) write(work, f, bumpText(readFileSync(join(work, f), 'utf8'), version, NEXT).text)
    tip = commitAll(work, `chore(release): ${NEXT} (#900)`)
  }
  g(work, 'push', '-q', 'origin', 'main', `v${version}`)
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

/** Distinct PR head and squash commit, with real trees and a fetchable remote PR head. */
function bumpEvidence(s: Repo, { differentTree = false } = {}) {
  const tree = g(s.work, 'rev-parse', `${differentTree ? s.released : s.tip}^{tree}`)
  const prHead = g(s.work, 'commit-tree', tree, '-p', s.released, '-m', 'chore(release): bump candidate')
  g(s.work, 'push', '-q', 'origin', `${prHead}:refs/pull/900/head`)
  patchState((st) => {
    st.ci = 'pending'
    st.prCi = 'green'
    st.prs.push({ number: 900, state: 'MERGED', headRefName: `chore/release-${NEXT}`, baseRefName: 'main', headRefOid: prHead, mergeCommit: { oid: s.tip } })
  })
  return prHead
}

describe('release', { timeout: 60_000 * SLOW }, () => {
  it.each(['pending', 'none'] as const)('accepts the bump PR same tree when main CI is %s, in both steps', async (ci) => {
    const s = repo({ bumped: true })
    // Release jobs can share CI names; their separate event is not PR CI evidence.
    write(s.work, '.github/workflows/release.yml', 'on:\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n')
    s.tip = commitAll(s.work, 'ci: add a separate release workflow')
    g(s.work, 'push', '-q', 'origin', 'main')
    patchState((st) => { st.dispatchSha = s.tip })
    const prHead = bumpEvidence(s)
    patchState((st) => { st.ci = ci })
    expect(prHead).not.toBe(s.tip)
    runtime()
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, r.text).toBe(false)
      expect(r.data.lines.join(' ')).toContain("CI: PR #900's run on the same tree")
    }
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBe(s.tip)
  })

  it('reports the same PR evidence in status and uses main green CI directly when it arrives', async () => {
    const s = repo({ bumped: true })
    bumpEvidence(s)
    runtime()
    const status = await call('release_status', { path: s.work })
    expect(status.data.lines.join(' ')).toContain("CI: PR #900's run on the same tree")
    patchState((st) => { st.ci = 'green'; st.prCi = 'failing' })
    for (const step of ['rehearse', 'tag', 'status']) {
      const r = await call(step === 'status' ? 'release_status' : 'release', { step, path: s.work, skipRehearsal: true })
      expect(r.isError, r.text).toBe(false)
      expect(r.data.lines.join(' ')).toContain("CI: main's own checks")
    }
  })

  it.each([
    ['different tree', 'different tree'],
    ['later merge', "merge commit is not main's head"],
    ['main failing', 'Main CI failed'],
    ['PR failing', 'head checks are not all green'],
    ['PR pending', 'head checks are not all green'],
    ['PR missing', 'head checks are not all green'],
    ['event job', 'uses event or branch context'],
    ['push-only job', 'does not run on both push and pull_request'],
  ])('refuses %s in both steps and reports the reason in status', async (scenario, reason) => {
    const s = repo({ bumped: true })
    if (scenario === 'event job' || scenario === 'push-only job') {
      const file = '.github/workflows/build.yml'
      const workflow = readFileSync(join(s.work, file), 'utf8')
      write(s.work, file, scenario === 'event job' ? workflow.replace('    runs-on:', "    if: github.event_name == 'push'\n    runs-on:") : workflow.replace('  pull_request:\n', ''))
      s.tip = commitAll(s.work, 'ci: change required build')
      g(s.work, 'push', '-q', 'origin', 'main')
    }
    bumpEvidence(s, { differentTree: scenario === 'different tree' })
    if (scenario === 'later merge') {
      // Even an empty subsequent merge with the identical tree invalidates the exemption.
      g(s.work, 'commit', '--allow-empty', '-q', '-m', 'docs: later merge (#901)')
      g(s.work, 'push', '-q', 'origin', 'main')
    }
    patchState((st) => {
      if (scenario === 'main failing') st.ci = 'failing'
      if (scenario === 'PR failing') st.prCi = 'failing'
      if (scenario === 'PR pending') st.prCi = 'pending'
      if (scenario === 'PR missing') st.prCi = 'none'
    })
    runtime()
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, r.text).toBe(true)
      expect(r.data.problems.join(' ')).toContain(reason)
    }
    const status = await call('release_status', { path: s.work })
    expect(status.data.lines.join(' ')).toContain(reason)
    expect(status.data.summary).toContain('Wait for green CI')
    expect(ghWrites()).toEqual([])
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
  })

  it('blocks tagging when pending main CI fails after rehearsal accepted the PR evidence', async () => {
    const s = repo({ bumped: true })
    bumpEvidence(s)
    runtime()
    const rehearsal = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(rehearsal.isError, rehearsal.text).toBe(false)
    patchState((st) => { st.ci = 'failing' })
    const tag = await call('release', { step: 'tag', path: s.work, skipRehearsal: true, confirm: true })
    expect(tag.isError, tag.text).toBe(true)
    expect(tag.data.problems.join(' ')).toContain('Main CI failed')
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
  })

  it.each(['main', 'PR'] as const)('ignores newer passing release checks with the same name as failing %s CI', async (source) => {
    const s = repo({ bumped: true })
    bumpEvidence(s)
    patchState((st) => {
      st.collidingReleaseChecks = source
      if (source === 'main') st.ci = 'failing'
      else st.prCi = 'failing'
    })
    runtime()
    const reason = source === 'main' ? 'Main CI failed' : 'head checks are not all green'
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, r.text).toBe(true)
      expect(r.data.problems.join(' ')).toContain(reason)
    }
    const status = await call('release_status', { path: s.work })
    expect(status.data.lines.join(' ')).toContain(reason)
    expect(ghWrites()).toEqual([])
  })

  it('refuses checks from another app even when their suite id and name match CI', async () => {
    const s = repo({ bumped: true })
    bumpEvidence(s)
    patchState((st) => { st.ci = 'green'; st.ciApp = 'another-app' })
    runtime()
    const r = await call('release', { step: 'tag', path: s.work, skipRehearsal: true, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(ghWrites()).toEqual([])
  })

  it.each(['multiple parents', 'different base'])('refuses bump PR evidence with %s', async (scenario) => {
    const s = repo({ bumped: true })
    if (scenario === 'multiple parents') {
      const merge = g(s.work, 'commit-tree', g(s.work, 'rev-parse', `${s.tip}^{tree}`), '-p', s.tip, '-p', s.released, '-m', 'chore(release): merge bump')
      g(s.work, 'reset', '--hard', merge)
      g(s.work, 'push', '-q', 'origin', 'main')
      s.tip = merge
    }
    bumpEvidence(s)
    if (scenario === 'different base') patchState((st) => { st.prs[0]!.baseRefName = 'other-base' })
    runtime()
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, r.text).toBe(true)
      expect(r.data.problems.join(' ')).toContain(scenario === 'multiple parents' ? 'did not land as a squash commit' : 'No merged bump PR')
    }
    expect(ghWrites()).toEqual([])
  })

  it.each(['pending', 'failing', 'none'] as const)('blocks every publication approval while main CI is %s despite green PR and release checks', async (ci) => {
    const s = repo({ bumped: true })
    bumpEvidence(s)
    g(s.work, 'push', '-q', 'origin', `${s.tip}:refs/tags/v${NEXT}`)
    patchState((st) => {
      st.ci = ci
      st.collidingReleaseChecks = true
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'waiting', conclusion: null }))
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: true, reviewers: [] }]
    })
    runtime()
    for (const job of ['linux-x64', 'centralu (shim)']) {
      patchState((st) => { st.jobs['61'] = [{ name: job, status: 'waiting', conclusion: null }] })
      for (const confirm of [false, true]) {
        const r = await call('release', { step: 'approve', path: s.work, confirm })
        expect(r.isError, r.text).toBe(true)
        expect(r.data.problems.join(' ')).toContain('must be green before npm-publish approval')
      }
    }
    const status = await call('release_status', { path: s.work })
    expect(status.data.summary).toContain('Wait for green CI')
    expect(status.data.summary).toContain('PR evidence cannot authorize publication')
    expect(status.data.lines.join(' ')).toContain(`The tagged commit's own CI at ${s.tip.slice(0, 7)}: ${ci}.`)
    expect(ghWrites()).toEqual([])
    patchState((st) => { st.ci = 'green' })
    published(s.tip)
    const approved = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(approved.isError, approved.text).toBe(false)
    expect(approved.data.approved).toBe(true)
    expect(ghWrites()).toHaveLength(1)
    // Every call rechecks CI, including the shim's later approval.
    patchState((st) => { st.ci = 'failing' })
    const again = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(again.isError, again.text).toBe(true)
    expect(ghWrites()).toHaveLength(1)
  })

  it('does not let a newer green main authorize a tag whose own main CI failed', async () => {
    const s = repo({ bumped: true })
    const tagged = s.tip
    g(s.work, 'push', '-q', 'origin', `${tagged}:refs/tags/v${NEXT}`)
    g(s.work, 'commit', '--allow-empty', '-q', '-m', 'docs: later change')
    g(s.work, 'push', '-q', 'origin', 'main')
    patchState((st) => {
      st.ci = 'green'
      st.ciBySha = { [tagged]: 'failing' }
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: tagged, status: 'waiting', conclusion: null }))
      st.jobs['61'] = [{ name: 'linux-x64', status: 'waiting', conclusion: null }]
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: true, reviewers: [] }]
    })
    runtime()
    const r = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(r.data.problems.join(' ')).toContain("The tagged commit's own CI")
    const status = await call('release_status', { path: s.work })
    expect(status.data.summary).toContain("The tagged commit's own CI")
    expect(ghWrites()).toEqual([])
  })

  it.each(['event', 'branch'])('rejects a CI suite with the wrong %s even when its jobs pass', async (field) => {
    const s = repo({ bumped: true })
    runtime()
    expect((await call('release', { step: 'rehearse', path: s.work })).isError).toBe(false)
    patchState((st) => { st.ciRunOverrides = { [s.tip]: field === 'event' ? { event: 'workflow_dispatch' } : { head_branch: 'another-branch' } } })
    const r = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(ghWrites()).toEqual([])
  })

  it.each(['number', 'base'])('requires the PR run to match the bump PR %s', async (field) => {
    const s = repo({ bumped: true })
    const prHead = bumpEvidence(s)
    patchState((st) => {
      st.ciRunOverrides = { [prHead]: { pull_requests: [{ number: field === 'number' ? 901 : 900, head: { sha: prHead, ref: `chore/release-${NEXT}` }, base: { ref: field === 'base' ? 'other-base' : 'main' } }] } }
    })
    runtime()
    const r = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(r.data.problems.join(' ')).toContain('head checks are not all green')
    expect(ghWrites()).toEqual([])
  })

  it('refuses ambiguous commit associations when GitHub drops the merged PR from its run', async () => {
    const s = repo({ bumped: true })
    const prHead = bumpEvidence(s)
    patchState((st) => { st.commitPrOverrides = [900, 901].map((number) => ({ number, head: { sha: prHead, ref: `chore/release-${NEXT}` }, base: { ref: 'main' } })) })
    runtime()
    const r = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(r.data.problems.join(' ')).toContain('head checks are not all green')
  })

  it('ci_status main ignores newer passing release checks with colliding build names', async () => {
    repo({ bumped: true })
    patchState((st) => { st.ci = 'failing'; st.collidingReleaseChecks = true })
    runtime()
    const r = await call('ci_status', { ref: 'main' })
    expect(r.data.verdict, r.text).toBe('failing')
    expect(r.data.checks.join(' ')).toContain('build: failed')
    expect(ghWrites()).toEqual([])
  })

  it('approves platforms and then the shim from the tag even after an unrelated red merge', async () => {
    const s = repo({ bumped: true })
    const tagged = s.tip
    g(s.work, 'push', '-q', 'origin', `${tagged}:refs/tags/v${NEXT}`)
    patchState((st) => {
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: tagged, status: 'waiting', conclusion: null }))
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: true, reviewers: [] }]
      st.jobs['61'] = [{ name: 'linux-x64', status: 'waiting', conclusion: null }]
    })
    runtime()
    expect((await call('release', { step: 'approve', path: s.work, confirm: true })).data.approved).toBe(true)
    g(s.work, 'commit', '--allow-empty', '-q', '-m', 'fix: unrelated merge')
    g(s.work, 'push', '-q', 'origin', 'main')
    patchState((st) => {
      st.ci = 'failing'
      st.ciBySha = { [tagged]: 'green' }
      st.jobs['61'] = [{ name: 'centralu (shim)', status: 'waiting', conclusion: null }]
    })
    published(tagged)
    const shim = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(shim.data.approved, shim.text).toBe(true)
    expect(ghWrites()).toHaveLength(2)
    const status = await call('release_status', { path: s.work })
    expect(status.data.summary).toContain('Approve with release step approve')
    expect(status.data.lines.join(' ')).toContain(`The tagged commit's own CI at ${tagged.slice(0, 7)}: green.`)
  })

  it('explains a cancelled tagged build with its rerun command and accepts the successful new attempt', async () => {
    const s = repo({ bumped: true })
    const tagged = s.tip
    g(s.work, 'push', '-q', 'origin', `${tagged}:refs/tags/v${NEXT}`)
    g(s.work, 'commit', '--allow-empty', '-q', '-m', 'fix: newer push cancels older build')
    g(s.work, 'push', '-q', 'origin', 'main')
    patchState((st) => {
      st.ciBySha = { [tagged]: 'cancelled' }
      st.ciRunOverrides = { [tagged]: { id: 42, status: 'completed', conclusion: 'cancelled', run_attempt: 1 } }
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: tagged, status: 'waiting', conclusion: null }))
      st.jobs['61'] = [{ name: 'linux-x64', status: 'waiting', conclusion: null }]
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: true, reviewers: [] }]
    })
    runtime()
    const recovery = `The build for ${tagged} was cancelled by a newer push; re-run it: gh run rerun 42`
    const blocked = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(blocked.isError).toBe(true)
    expect(blocked.data.problems.join(' ')).toContain(recovery)
    expect((await call('release_status', { path: s.work })).data.summary).toContain(recovery)
    expect(ghWrites()).toEqual([])
    patchState((st) => {
      st.ciBySha = { [tagged]: 'green' }
      st.ciRunOverrides![tagged] = { id: 42, status: 'completed', conclusion: 'success', run_attempt: 2 }
      st.staleAttempt = true
    })
    const approved = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(approved.data.approved, approved.text).toBe(true)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBe(tagged)
    expect(ghWrites()).toHaveLength(1)
  })

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
      `The tagged commit's own CI at ${s.released.slice(0, 7)}: green.`,
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
    expect(plan.data.lines).toContain(`Merged since v${APP_VERSION} (2):`)
    expect(remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)).toBeNull()
    expect(ghWrites()).toEqual([])

    const r = await call('release', { step: 'bump', path: s.work, confirm: true, notes: 'Ship the two changes.', closes: 'Refs #386' })
    expect(r.isError).toBe(false)
    expect(r.data.summary).toBe(`Opened the bump to ${NEXT}: https://github.com/ijun17/centralu/pull/900. Rehearse it now (release step rehearse) while its CI runs, merge it once CI is green (merge_when_green), then tag.`)
    expect(r.data.lines).not.toContain(`Merged since v${APP_VERSION} (2):`)
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

  it('dry-bumps a stable release past old prereleases and dependency ranges but refuses stable pins', async () => {
    const s = repo({ version: '1.0.0' })
    // This regression suite intentionally pins stable versions; its exact path is allowlisted.
    write(s.work, 'tooling/project-board-release.test.ts', "const stableFixture = '1.0.0'\n")
    write(s.work, 'old-prereleases', '1.0.0-beta.21\n1.0.0-rc\n1.0.0+other\n')
    write(s.work, 'other/package.json', JSON.stringify({
      dependencies: { a: '^1.0.0' }, devDependencies: { a: '~1.0.0' },
      peerDependencies: { a: '>=1.0.0' }, optionalDependencies: { a: 'workspace:1.0.0' },
    }))
    commitAll(s.work, 'test: stable release dependencies')
    g(s.work, 'push', '-q', 'origin', 'main')
    runtime()
    const plan = await call('release', { step: 'bump', bump: 'patch', path: s.work })
    expect(plan.isError, plan.text).toBe(false)
    expect(plan.data.next).toBe('1.0.1')
    expect(plan.data.pushed).toBe(false)

    write(s.work, 'e2e/stable.ts', "'1.0.0'\n'1.0.0.local.1'\n`1.0.0+build`\n")
    write(s.work, 'other/package.json', '{"dependencies":{"a":"^1.0.0"},\n"version":"1.0.0"}\n')
    commitAll(s.work, 'test: stable release pins')
    g(s.work, 'push', '-q', 'origin', 'main')
    const blocked = await call('release', { step: 'bump', bump: 'patch', path: s.work })
    expect(blocked.isError).toBe(true)
    expect(blocked.data.problems.map((p: string) => p.split(' carries ')[0])).toEqual([
      'e2e/stable.ts:1', 'e2e/stable.ts:2', 'e2e/stable.ts:3', 'other/package.json:2',
    ])
    expect(ghWrites()).toEqual([])
    expect(remoteHas(s.origin, 'refs/heads/chore/release-1.0.1')).toBeNull()
  })

  it('reports every embedded version by file and line in tracked text of any type', async () => {
    const s = repo()
    // A colon or a newline in a name is not allowed on Windows; spaces are, and need the same care
    const odd = process.platform === 'win32' ? 'custom/spaces and  more spaces' : 'custom/spaces and:colon\nnewline'
    const pins: Record<string, string> = {
      'e2e/control-loop.spec.ts': `// local update\nconst local = '${APP_VERSION}.local.1'\n`,
      'src/candidate.ts': `const candidate = "${APP_VERSION}.local.3"\n`,
      'src/build.ts': `const build = '${APP_VERSION}+build'\n`,
      'src/template.ts': 'const template = `release v' + APP_VERSION + '.local.${n}`\n',
      'scripts/check.sh': `#!/bin/sh\nversion=${APP_VERSION}\n`,
      '.release-version': `v${APP_VERSION}\n`,
      'custom/pin.unusual': `version: ${APP_VERSION}\n`,
      'fixtures/unlisted.json': `"${APP_VERSION}"\n`,
      [odd]: `header\n${APP_VERSION}.local.2\n`,
      'src/multiple.ts': `// one\r\n'${APP_VERSION}' + '${APP_VERSION}+build'\r\n// two\r\n'${APP_VERSION}.local.4'\r\n`,
    }
    for (const [path, text] of Object.entries(pins)) write(s.work, path, text)
    commitAll(s.work, 'test: embedded versions')
    g(s.work, 'push', '-q', 'origin', 'main')
    const before = checkout(s.work)
    runtime()
    for (const confirm of [false, true]) {
      const r = await call('release', { step: 'bump', path: s.work, confirm })
      expect(r.isError).toBe(true)
      expect(r.data.problems.map((p: string) => p.split(' carries ')[0]).sort()).toEqual(
        [
          'e2e/control-loop.spec.ts:2',
          'src/candidate.ts:1',
          'src/build.ts:1',
          'src/template.ts:1',
          'scripts/check.sh:2',
          '.release-version:1',
          'custom/pin.unusual:1',
          'fixtures/unlisted.json:1',
          `${odd}:2`,
          'src/multiple.ts:2',
          'src/multiple.ts:4',
        ].sort(),
      )
      expect(r.data.problems.every((p: string) => p.includes('release.ignore'))).toBe(true)
    }
    expect(checkout(s.work)).toEqual(before)
    expect(remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)).toBeNull()
    expect(ghWrites()).toEqual([])
  })

  it('exempts configured history and intentional pins, not every fixture or lockfile version declaration', async () => {
    const s = repo()
    for (const path of [
      'CHANGELOG.md',
      'packages/other/CHANGELOG.txt',
      'release-notes/recent/notes.md',
      'docs/history.md',
      'docs/releases/history.md',
      'pnpm-lock.yaml',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'nested/yarn.lock',
      'nested/Cargo.lock',
      'fixtures/pinned.json',
    ])
      write(s.work, path, `Released "${APP_VERSION}" and ${APP_VERSION}.local.1\n`)
    write(
      s.work,
      'different-versions',
      `${APP_VERSION}0\n${APP_VERSION}a\n1${APP_VERSION}\n1.${APP_VERSION}\n`,
    )
    write(s.work, 'binary.dat', `\0${APP_VERSION}.local.1\n`)
    write(s.work, '.gitignore', '/untracked\n')
    commitAll(s.work, 'test: historical versions')
    g(s.work, 'push', '-q', 'origin', 'main')
    write(s.work, 'untracked', `${APP_VERSION}.local.1\n`)
    runtime([...RELEASE.ignore, 'fixtures/pinned.json'])
    const r = await call('release', { step: 'bump', path: s.work })
    expect(r.isError, r.text).toBe(false)
    expect(r.data.lines).toContain('- apps/desktop/src-tauri/Cargo.lock: 2 places')
    expect(r.data.pushed).toBe(false)
    expect(ghWrites()).toEqual([])

    // An ignore entry must never conceal a broken declaration in versionFiles.
    write(s.work, 'apps/desktop/src-tauri/Cargo.lock', 'version = "0.0.1"\n')
    commitAll(s.work, 'test: stale declared lockfile')
    g(s.work, 'push', '-q', 'origin', 'main')
    const stale = await call('release', { step: 'bump', path: s.work })
    expect(stale.isError).toBe(true)
    expect(stale.data.problems).toEqual([
      `apps/desktop/src-tauri/Cargo.lock is in release.versionFiles but does not carry "${APP_VERSION}"; it fell behind, or the list is wrong.`,
    ])
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
      `packages/other/version.json:1 carries "${APP_VERSION}" but is not in project.json release.versionFiles; derive it from the version source, or add it to release.ignore if it intentionally pins a version.`,
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
      expect.stringMatching(new RegExp(`^CI on main at ${s.tip.slice(0, 7)} is not green: main at ${s.tip.slice(0, 7)}: failing —`)),
      `${NEXT} on main is not released yet (no tag v${NEXT}); release it (release step tag) before bumping past it.`,
      `${APP_VERSION} is not after ${NEXT}, the version on main.`,
      `${APP_VERSION} is not after v${APP_VERSION}, the latest release tag.`,
      `v${APP_VERSION} is tagged already.`,
    ])
  })

  it('warns at the bump, without refusing it, when other builds hold most runners', async () => {
    const s = repo()
    const jobs = (n: number, status: string) => Array.from({ length: n }, (_, i) => ({ name: `job ${i}`, status, conclusion: null }))
    patchState((st) => {
      st.activeRuns = [{ id: 81, status: 'in_progress' }, { id: 82, status: 'queued' }]
      st.jobs['81'] = [...jobs(8, 'in_progress'), ...jobs(3, 'completed'), ...jobs(2, 'waiting')]
      st.jobs['82'] = jobs(4, 'queued')
    })
    runtime()
    const quiet = await call('release', { step: 'bump', path: s.work })
    expect(quiet.isError, quiet.text).toBe(false)
    expect(quiet.data.warning).toBeNull()
    patchState((st) => (st.jobs['81'] = jobs(12, 'in_progress')))
    const busy = await call('release', { step: 'bump', path: s.work })
    expect(busy.isError, busy.text).toBe(false)
    const warning = "Runners are busy: 12 jobs of other builds running and 4 queued, against 20 runners (2 active runs). The bump PR's CI will wait for them; push it once they drain, or cancel builds that no longer matter."
    expect(busy.data.warning).toBe(warning)
    expect(busy.data.summary).toContain(warning)
    expect(busy.data.lines).toContain(warning)
    const r = await call('release', { step: 'bump', path: s.work, confirm: true })
    expect(r.data.pushed, r.text).toBe(true)
    expect(r.data.summary).toContain(warning)
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
    expect(none.data.problems).toEqual([`No rehearsal ran on ${s.tip.slice(0, 7)} or on its bump branch at the same tree: rehearse first (release step rehearse), or pass skipRehearsal: true to tag without one.`])
    patchState((st) => st.runs.push(run({ head_sha: s.tip, conclusion: 'failure' })))
    const failed = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(failed.data.problems).toEqual([`The rehearsal on ${s.tip.slice(0, 7)} ended failure (https://github.com/ijun17/centralu/actions/runs/50); fix that first, or pass skipRehearsal: true.`])
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
    const skipped = await call('release', { step: 'tag', path: s.work, skipRehearsal: true })
    expect(skipped.isError).toBe(false)
    expect(skipped.data.lines).toContain('Rehearsal: skipped (skipRehearsal: true).')
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

  /** main released at APP_VERSION, and the bump to NEXT open as PR #900 on its branch: answers its head */
  function openBump(s: Repo) {
    const branch = `chore/release-${NEXT}`
    g(s.work, 'checkout', '-q', '-b', branch)
    for (const f of CARRIERS) write(s.work, f, bumpText(readFileSync(join(s.work, f), 'utf8'), APP_VERSION, NEXT).text)
    const head = commitAll(s.work, `chore(release): ${NEXT}`)
    g(s.work, 'push', '-q', 'origin', branch)
    g(s.work, 'checkout', '-q', 'main')
    patchState((st) => {
      st.prs.push({ number: 900, state: 'OPEN', headRefName: branch, baseRefName: 'main', headRefOid: head })
      st.dispatchSha = head
    })
    return { branch, head }
  }
  /** The bump PR squashed onto main: a new commit with `tree` (default the PR head's) on main's head */
  function squash(s: Repo, head: string, tree = g(s.work, 'rev-parse', `${head}^{tree}`)) {
    const tip = g(s.work, 'commit-tree', tree, '-p', s.tip, '-m', `chore(release): ${NEXT} (#900)`)
    g(s.work, 'reset', '-q', '--hard', tip)
    g(s.work, 'push', '-q', 'origin', 'main')
    patchState((st) => {
      st.prs[0]!.state = 'MERGED'
      st.prs[0]!.mergeCommit = { oid: tip }
      for (const r of st.runs) if (r.id === 77) Object.assign(r, { status: 'completed', conclusion: 'success' })
    })
    s.tip = tip
    return tip
  }

  it('rehearses the open bump PR on its branch, and tags main after the squash on that rehearsal (same tree)', async () => {
    const s = repo()
    const { branch, head } = openBump(s)
    runtime()
    const plan = await call('release', { step: 'rehearse', path: s.work })
    expect(plan.isError, plan.text).toBe(false)
    expect(plan.data.summary).toBe(
      `Ready to rehearse ${NEXT} on bump PR #900's head ${head.slice(0, 7)} (release.yml on ${branch} with dry_run=true; builds and packs, publishes nothing, asks no approval). Call again with confirm: true to start it.`,
    )
    const r = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(r.data.started, r.text).toBe(true)
    expect(ghWrites()).toEqual([{ args: ['api', '-X', 'POST', 'repos/ijun17/centralu/actions/workflows/release.yml/dispatches', '--input', '-'], stdin: JSON.stringify({ ref: branch, inputs: { dry_run: 'true' } }) }])
    const again = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(again.data.summary).toBe(`A rehearsal of PR #900 at ${head.slice(0, 7)} queued: https://github.com/ijun17/centralu/actions/runs/77; not starting another.`)

    const tip = squash(s, head)
    expect(tip).not.toBe(head)
    const status = await call('release_status', { path: s.work })
    expect(status.data.lines).toContain(`Rehearsal on ${head.slice(0, 7)} on ${branch}, the same tree as main at ${tip.slice(0, 7)}: succeeded, https://github.com/ijun17/centralu/actions/runs/77.`)
    const tag = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(tag.isError, tag.text).toBe(false)
    expect(tag.data.lines).toContain(`Rehearsal: succeeded on ${head.slice(0, 7)} on ${branch}, the same tree as main at ${tip.slice(0, 7)}, https://github.com/ijun17/centralu/actions/runs/77.`)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBe(tip)
    // Main still needs no second rehearsal
    expect(ghWrites()).toHaveLength(1)
  })

  it('does not count a bump branch rehearsal once main after the squash has another tree', async () => {
    const s = repo()
    const { head } = openBump(s)
    runtime()
    expect((await call('release', { step: 'rehearse', path: s.work, confirm: true })).data.started).toBe(true)
    // Squashed onto a main that got one more change meanwhile: the files differ from what was rehearsed
    write(s.work, 'c.txt', 'three\n')
    s.tip = commitAll(s.work, 'fix: three (#12)')
    g(s.work, 'push', '-q', 'origin', 'main')
    g(s.work, 'checkout', '-q', head)
    write(s.work, 'c.txt', 'three\n')
    g(s.work, 'add', 'c.txt')
    const merged = g(s.work, 'write-tree')
    g(s.work, 'checkout', '-q', '-f', 'main')
    squash(s, head, merged)
    const tag = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(tag.isError).toBe(true)
    expect(tag.data.problems).toEqual([`No rehearsal ran on ${s.tip.slice(0, 7)} or on its bump branch at the same tree: rehearse first (release step rehearse), or pass skipRehearsal: true to tag without one.`])
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
  })

  it('refuses to rehearse a bump PR that is not on main head, or when none is open', async () => {
    const s = repo()
    runtime()
    const none = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(none.isError).toBe(true)
    expect(none.data.problems[0]).toContain(`${APP_VERSION} is released already (v${APP_VERSION}) and no bump pull request is open into main`)
    const { head } = openBump(s)
    write(s.work, 'c.txt', 'three\n')
    const tip = commitAll(s.work, 'fix: three (#12)')
    g(s.work, 'push', '-q', 'origin', 'main')
    const behind = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(behind.isError).toBe(true)
    expect(behind.data.problems).toEqual([
      `PR #900 (${head.slice(0, 7)}) is not on main's head ${tip.slice(0, 7)}: after its squash main's tree would differ from what was rehearsed, so the tag would not count the rehearsal. Bring the branch up to date with main first.`,
    ])
    expect(ghWrites()).toEqual([])
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
      expect.stringMatching(new RegExp(`^CI on main at ${s.tip.slice(0, 7)} is not green: main at ${s.tip.slice(0, 7)}: pending —`)),
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
    expect(r.data.summary).toBe(`Approved npm-publish for v${NEXT} (linux-x64, darwin-arm64): https://github.com/ijun17/centralu/actions/runs/61. The shim asks again once every platform job succeeds: approve with wait: true to approve it the moment it may go.`)
    expect(ghWrites()).toEqual([
      {
        args: ['api', '-X', 'POST', 'repos/ijun17/centralu/actions/runs/61/pending_deployments', '--input', '-'],
        stdin: JSON.stringify({ environment_ids: [7], state: 'approved', comment: `Approved through the project board's release tool for v${NEXT}.` }),
      },
    ])
  })

  it('selects the duplicate run waiting on the environment and offers a safe cancellation', async () => {
    const s = repo({ bumped: true })
    g(s.work, 'push', '-q', 'origin', `${s.tip}:refs/tags/v${NEXT}`)
    patchState((st) => {
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'waiting', conclusion: null }))
      st.runs.push(run({ id: 62, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'in_progress', conclusion: null }))
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: true, reviewers: [] }]
    })
    runtime()
    const status = await call('release_status', { path: s.work })
    expect(status.data.lines).toContain(`Release run for v${NEXT}: waiting for approval, https://github.com/ijun17/centralu/actions/runs/61.`)
    expect(status.data.lines).toContain(`Duplicate release runs for v${NEXT}: https://github.com/ijun17/centralu/actions/runs/62.`)
    expect(status.data.lines).toContain('Before anything publishes, cancel a duplicate with release step cancel_duplicate (run: 62, confirm: true).')
    const plan = await call('release', { step: 'cancel_duplicate', run: 62, path: s.work })
    expect(plan.data.summary).toContain('Ready to cancel duplicate run 62')
    const cancelled = await call('release', { step: 'cancel_duplicate', run: 62, path: s.work, confirm: true })
    expect(cancelled.data.summary).toContain('Cancelled duplicate run 62')
    expect((JSON.parse(readFileSync(statePath, 'utf8')) as State).cancelled).toEqual(['repos/ijun17/centralu/actions/runs/62/cancel'])
  })

  /** A tagged NEXT whose release run 61 waits on npm-publish with `jobs` */
  function waitingRelease(jobs: { name: string; status: string; conclusion: string | null }[]) {
    const s = repo({ bumped: true })
    g(s.work, 'push', '-q', 'origin', `${s.tip}:refs/tags/v${NEXT}`)
    patchState((st) => {
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'waiting', conclusion: null }))
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: true, reviewers: [] }]
      st.jobs['61'] = jobs
    })
    runtime()
    return s
  }
  const PLATFORMS_WAITING = [
    { name: 'check the tag against the repo', status: 'completed', conclusion: 'success' },
    { name: 'linux-x64', status: 'waiting', conclusion: null },
  ]
  const SHIM_WAITING = [
    { name: 'check the tag against the repo', status: 'completed', conclusion: 'success' },
    { name: 'linux-x64', status: 'completed', conclusion: 'success' },
    { name: 'centralu (shim)', status: 'waiting', conclusion: null },
  ]
  const approvals = () => ghWrites().filter((w) => w.args[3]?.endsWith('/pending_deployments'))

  it('with wait, approves the platforms the moment the tagged commit turns green, and not before', async () => {
    const s = waitingRelease(PLATFORMS_WAITING)
    patchState((st) => (st.seq = { [`ci:${s.tip}`]: ['pending', 'pending', 'pending', 'green'] }))
    const r = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true })
    expect(r.isError, r.text).toBe(false)
    expect(r.data.approved).toBe(true)
    expect(r.data.summary).toContain(`Approved npm-publish for v${NEXT} (linux-x64) after`)
    expect(r.data.lines).toContain(`The tagged commit's own CI at ${s.tip.slice(0, 7)}: green.`)
    expect(approvals()).toHaveLength(1)
    // Every pending answer was read before the one approval
    expect((JSON.parse(readFileSync(statePath, 'utf8')) as State).seq![`ci:${s.tip}`]).toEqual(['green'])
  })

  it('without wait, the same pending CI still refuses at once', async () => {
    const s = waitingRelease(PLATFORMS_WAITING)
    patchState((st) => (st.seq = { [`ci:${s.tip}`]: ['pending', 'green'] }))
    const r = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.data.problems.join(' ')).toContain('must be green before npm-publish approval')
    expect(approvals()).toEqual([])
  })

  it('with wait, refuses without approving when the tagged CI fails while it waits', async () => {
    const s = waitingRelease(PLATFORMS_WAITING)
    patchState((st) => (st.seq = { [`ci:${s.tip}`]: ['pending', 'failing'] }))
    const r = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true })
    expect(r.isError).toBe(true)
    expect(r.data.problems.join(' ')).toContain('must be green before npm-publish approval')
    expect(approvals()).toEqual([])
  })

  it('with wait, gives up after waitMinutes with what it still waits for, approving nothing', async () => {
    const s = waitingRelease(PLATFORMS_WAITING)
    patchState((st) => (st.ci = 'pending'))
    const r = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true, waitMinutes: 0.005 })
    expect(r.isError, r.text).toBe(false)
    expect(r.data.approved).toBe(false)
    expect(r.data.timedOut).toBe(true)
    expect(r.data.summary).toMatch(/^Not approved: the gate did not pass within \d+ s of waiting, so nothing was approved\. Still: The tagged commit's own CI/)
    expect(approvals()).toEqual([])
  })

  it('with wait, waits for the shim to be asked for, then approves it once its packages show on the registry', async () => {
    const s = waitingRelease(SHIM_WAITING)
    published(s.tip)
    patchState((st) => {
      // The platforms still building: nothing waits on the environment for the first reads
      st.seq = { 'pending:61': [[], [], [], [], st.pending['61']] }
      st.registryHidden = { [REGISTRY_NAMES[0]!]: 2 }
    })
    const r = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true })
    expect(r.isError, r.text).toBe(false)
    expect(r.data.approved).toBe(true)
    expect(r.data.lines).toContain('This is the shim: the last moment anything is reversible (docs/releasing.md).')
    expect(r.data.lines.join(' ')).toContain(`the ${REGISTRY_NAMES.length} packages it needs are on the registry at ${NEXT} from ${s.tip.slice(0, 7)}`)
    expect(approvals()).toHaveLength(1)
    expect((JSON.parse(readFileSync(statePath, 'utf8')) as State).registryHidden).toEqual({ [REGISTRY_NAMES[0]!]: 0 })
  })

  it('refuses the shim while a package is not on the registry, from another commit, or a platform job failed', async () => {
    const s = waitingRelease(SHIM_WAITING)
    published(s.tip, REGISTRY_NAMES.slice(1))
    const missing = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(missing.isError).toBe(true)
    expect(missing.data.problems).toEqual([`Not on the registry at ${NEXT} yet: ${REGISTRY_NAMES[0]}.`])

    published('f'.repeat(40))
    const other = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true })
    expect(other.isError).toBe(true)
    expect(other.data.problems[0]).toBe(`${REGISTRY_NAMES[0]}@${NEXT} is on the registry from fffffff, not from ${s.tip.slice(0, 7)}; the shim would pin other code. Bump to the next prerelease.`)

    published(s.tip)
    patchState((st) => (st.jobs['61'] = [SHIM_WAITING[0]!, { name: 'linux-x64', status: 'completed', conclusion: 'failure' }, SHIM_WAITING[2]!]))
    const failed = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true })
    expect(failed.isError).toBe(true)
    expect(failed.data.problems).toEqual(['Not every platform job succeeded (linux-x64: failure); the shim may not go out before all of them have.'])
    expect(approvals()).toEqual([])

    patchState((st) => (st.jobs['61'] = SHIM_WAITING))
    const ok = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(ok.data.approved, ok.text).toBe(true)
  })

  /** build.yml with these jobs, by name */
  const buildYml = (...names: string[]) => `on:\n  push:\n  pull_request:\njobs:\n${names.map((n, i) => `  job${i}:\n    name: ${n}\n    runs-on: ubuntu-24.04\n`).join('')}`

  it("judges the tagged commit by its own workflow's checks, not main's newer ones", async () => {
    const s = waitingRelease(PLATFORMS_WAITING)
    patchState((st) => {
      st.noProtection = true
      // main's workflow gained a job after the tag; the tagged commit's run never had it
      st.files['.github/workflows/build.yml'] = buildYml('build', 'windows tests (vitest 1/2)')
      st.filesAt = { [s.tip]: { '.github/workflows/build.yml': buildYml('build') } }
    })
    const r = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(r.isError, r.text).toBe(false)
    expect(r.data.approved).toBe(true)
  })

  it('with wait, refuses at once when the build runs completed without a required check', async () => {
    const s = waitingRelease(PLATFORMS_WAITING)
    patchState((st) => {
      st.noProtection = true
      st.filesAt = { [s.tip]: { '.github/workflows/build.yml': buildYml('build', 'never reported') } }
    })
    const r = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true, waitMinutes: 0.05 })
    expect(r.isError, r.text).toBe(true)
    expect(r.data.problems.join(' ')).toContain('Its build runs have all completed without reporting never reported, so waiting will not bring them')
    expect(approvals()).toEqual([])
  })

  it('does not approve the shim past its gate while GitHub lists no waiting job yet', async () => {
    const s = waitingRelease(SHIM_WAITING)
    // Nothing on the registry: only the shim gate stands in the way
    patchState((st) => (st.seq = { 'jobs:61': [[SHIM_WAITING[0], SHIM_WAITING[1], { ...SHIM_WAITING[2], status: 'queued' }], SHIM_WAITING] }))
    const first = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(first.isError).toBe(true)
    expect(first.data.problems).toEqual([`GitHub says the release run for v${NEXT} waits on npm-publish but lists no waiting job yet, so which approval it is cannot be told.`])
    const second = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(second.isError).toBe(true)
    expect(second.data.problems[0]).toContain(`Not on the registry at ${NEXT} yet`)
    expect(approvals()).toEqual([])
  })

  it('with wait, approves nothing once the call is cancelled, even when the gate then passes', async () => {
    const s = waitingRelease(SHIM_WAITING)
    published(s.tip)
    let release!: () => void
    registryHold = new Promise((r) => (release = r))
    const asked = new Promise<void>((r) => (registryAsked = r))
    const abort = new AbortController()
    const answer = call('release', { step: 'approve', path: s.work, confirm: true, wait: true }, agent, abort.signal)
    await asked
    abort.abort()
    expect((await answer).data.status).toBe('cancelled')
    // Let the cancellation reach the app before the registry answers and the gate passes
    await new Promise((r) => setTimeout(r, 1_000 * SLOW))
    registryHold = null
    release()
    await new Promise((r) => setTimeout(r, 2_000 * SLOW))
    expect(approvals()).toEqual([])
  })

  it('with wait, refuses when the release run changes under it', async () => {
    const s = waitingRelease(PLATFORMS_WAITING)
    const at = (id: number, status: string) => run({ id, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status, conclusion: null })
    patchState((st) => {
      st.seq = { tagRuns: [[at(61, 'in_progress')], [at(62, 'waiting'), at(61, 'in_progress')]], 'pending:61': [[]] }
      st.pending['62'] = st.pending['61']!
      st.jobs['62'] = PLATFORMS_WAITING
    })
    const r = await call('release', { step: 'approve', path: s.work, confirm: true, wait: true })
    expect(r.isError, r.text).toBe(true)
    expect(r.data.problems).toEqual([`The release run for v${NEXT} is now 62, not run 61 this wait started on; nothing was approved. Look at both runs before approving.`])
    expect(approvals()).toEqual([])
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

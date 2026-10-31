import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitWrapper, removeFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { ExternalApps, resultText, type AppCaller, type AppRef } from '../packages/agent-host/src/apps/external/runtime.js'
import {
  compareVersions,
  declaredVersion,
  nextVersion,
  pathMatches,
  releaseNotes,
  sourceScheme,
  // @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
} from '../.centralu/apps/project-board/versions.mjs'
import { endLeftoverFakes, fakeGh, type FakeGh } from './fake-gh.test-helpers.js'
import { SLOW } from './test-timing.js'

/**
 * The project board's release tool (#386 step 3): docs/releasing.md as `release_status` and
 * `release` (rehearse, tag, approve). First the version rules (versions.mjs); then the app under the real external-app runtime, against
 * a fake `gh` that records every write and never reaches GitHub, and real git on repositories made
 * here, with a bare one standing for GitHub's. Pushes go to that bare repository by `pushurl`, so
 * nothing here can tag, push or publish anything real.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP = join(REPO_ROOT, '.centralu/apps/project-board')
const RELEASE = JSON.parse(readFileSync(join(APP, 'project.json'), 'utf8')).release as {
  source: { path: string; pattern: string; marker: string; name: string }
}
const TEMPLATE = readFileSync(join(REPO_ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
const CONVENTIONS_DOC = readFileSync(join(REPO_ROOT, 'docs/commit-conventions.md'), 'utf8')

/**
 * The fixture's last release: this repository's last under the brand scheme, whose commits the fixture still has
 * before the switch (`switchAt`), the ones the tag scheme passes over.
 */
const BRAND_VERSION = '0.1.0-beta.37'
const NEXT = nextVersion(BRAND_VERSION) as string

describe('the version rules', () => {
  it('counts up the prerelease', () => {
    expect(nextVersion('2.3.0-beta.16')).toBe('2.3.0-beta.17')
    expect(nextVersion('0.1.0-beta.9')).toBe('0.1.0-beta.10')
    expect(nextVersion('1.0.0-rc.1.2')).toBe('1.0.0-rc.1.3')
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

  it('reads this repository as the tag scheme: no declaration in brand.ts (#1501)', () => {
    const own = readFileSync(join(REPO_ROOT, RELEASE.source.path), 'utf8')
    expect(declaredVersion(own, RELEASE.source.pattern)).toBeNull()
    expect(sourceScheme(own, RELEASE.source)).toEqual({ scheme: 'tag' })
    expect(declaredVersion(`export const APP_VERSION = '${BRAND_VERSION}'\n`, RELEASE.source.pattern)).toBe(BRAND_VERSION)
  })
})

// --- The app, against a fake gh and real git ---------------------------------------------------------

/** How the fake gh answers (fake-gh.test-helpers.ts gives it args, stdin, st and save, and logs each call) */
const FAKE_GH = String.raw`
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
    // release.yml's run-name: a rehearsal is named after the version input (#1501)
    st.runs.push({ id: 77, status: 'queued', conclusion: null, event: 'workflow_dispatch', head_branch: body.ref, head_sha: st.dispatchSha, html_url: 'https://github.com/ijun17/centralu/actions/runs/77', created_at: new Date().toISOString(), display_title: 'rehearse ' + (body.inputs?.version || 'next') })
    st.dispatched = [...(st.dispatched || []), body]
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
    json({ contexts: st.requiredContexts || ['build'], checks: [] })
  }
  if (path === R + '/rules/branches/main') json([])
  if (/\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
    const sha = path.split('/').at(-2)
    const verdict = next('ci:' + sha, st.ciBySha?.[sha] || (st.prs.some((p) => p.headRefOid === sha) ? st.prCi : st.ci))
    const collision = st.collidingReleaseChecks === true || st.collidingReleaseChecks === (st.prs.some((p) => p.headRefOid === sha) ? 'PR' : 'main')
    const releaseChecks = collision ? [{ id: 99, name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-10-13T12:00:00Z', check_suite: { id: 99 }, app: { slug: 'github-actions' } }] : []
    if (verdict === 'none') json({ check_runs: releaseChecks })
    const c = { green: ['completed', 'success'], failing: ['completed', 'failure'], pending: ['in_progress', null], cancelled: ['completed', 'cancelled'] }[verdict]
    // build.yml's full tier job, when a test names its conclusion on this commit (two tiers of CI)
    const tier = st.fullTierBySha?.[sha] ? [{ id: 2, name: 'full tier', status: 'completed', conclusion: st.fullTierBySha[sha], html_url: 'https://github.com/ijun17/centralu/actions/runs/1/job/2', started_at: '2026-10-13T10:00:00Z', check_suite: { id: 11 }, app: { slug: 'github-actions' } }] : []
    json({ check_runs: [{ id: 1, name: 'build', status: c[0], conclusion: c[1], html_url: 'https://github.com/ijun17/centralu/actions/runs/1/job/1', started_at: '2026-10-13T10:00:00Z', check_suite: { id: 11 }, app: { slug: st.ciApp || 'github-actions' } }, ...tier, ...releaseChecks] })
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

type Run = { id: number; status: string; conclusion: string | null; event: string; head_branch: string; head_sha: string; html_url: string; created_at: string; display_title?: string }
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
  /** The required set branch protection names (default ['build']) */
  requiredContexts?: string[]
  /** The `full tier` check's conclusion per commit (none reported when absent) */
  fullTierBySha?: Record<string, string>
  /** A file's text at one ref (the contents API's ?ref=), before `files` */
  filesAt?: Record<string, Record<string, string>>
  /** Every workflow's runs not completed, for how busy the runners are */
  activeRuns?: { id: number; status: string }[]
  /** The npm registry: package name → the commit it was published from; a name not here is absent */
  registry?: Record<string, string | null>
  /** How many more times the registry answers 404 for a name before it shows what `registry` holds */
  registryHidden?: Record<string, number>
  /** What each dispatch of the release workflow asked for: the ref and the inputs */
  dispatched?: { ref: string; inputs: Record<string, string> }[]
}

/** What the shim needs on the registry: every package of packaging/npm but the shim */
const REGISTRY_NAMES = readdirSync(join(REPO_ROOT, 'packaging/npm'))
  .filter((d) => d !== 'centralu')
  .map((d) => JSON.parse(readFileSync(join(REPO_ROOT, 'packaging/npm', d, 'package.json'), 'utf8')).name as string)
/** A local npm registry for the shim's gate, answering from the fake gh's state */
function registryServer() {
  const server = createServer(async (req, res) => {
    if (registryHold) {
      registryAsked?.()
      await registryHold
    }
    const st = gh.state<State>()
    const m = /^\/(.+)\/([^/]+)$/.exec(req.url ?? '')
    const name = m ? decodeURIComponent(m[1]!) : ''
    const hidden = st.registryHidden?.[name] ?? 0
    if (hidden > 0) {
      st.registryHidden![name] = hidden - 1
      gh.setState(st)
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
let gh: FakeGh
let registry: { url: string; close: () => Promise<void> } | null = null
/** While set, the registry answers only once it settles; `registryAsked` is called on each request */
let registryHold: Promise<void> | null = null
let registryAsked: (() => void) | null = null

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-project-board-release-')))
  mkdirSync(join(root, 'data'))
  gh = fakeGh(root, FAKE_GH, { inProcess: true })
  gitDirs = gitWrapper(gh.bin)
  const state: State = {
    permissions: { admin: true, maintain: true, push: true },
    ci: 'green',
    files: { '.github/PULL_REQUEST_TEMPLATE.md': TEMPLATE, 'docs/commit-conventions.md': CONVENTIONS_DOC },
    prs: [],
    runs: [],
    jobs: {},
    pending: {},
  }
  gh.setState(state)
  registry = await registryServer()
})

// Waiting for the app trees can take a while on a loaded Windows machine: grace, kill, the process listing and
// a taskkill per leftover, past the default 10 s hook limit (#1312)
afterEach(async () => {
  // Until the app and what it left running have ended: they run Node from this folder and write in it
  await rt?.dispose({ awaitTree: true })
  rt = null
  registryHold = null
  registryAsked = null
  await registry?.close()
  registry = null
  await removeFakeDir(root)
}, 30_000 * SLOW)

// A gh that the app was starting when the test ended its tree stays suspended on Windows, for ever (fake-gh.test-helpers.ts)
afterAll(() => {
  endLeftoverFakes()
}, 60_000 * SLOW)

/** The app on this repository's project.json */
function runtime() {
  const projectPath = join(root, 'project')
  cpSync(APP, join(projectPath, '.centralu/apps/project-board'), { recursive: true })
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projectPath, trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    env: gh.env({ GIT_CONFIG_NOSYSTEM: '1', PROJECT_BOARD_RUN_LOOK_MS: '10', PROJECT_BOARD_CI_POLL_MS: '10', PROJECT_BOARD_NPM_REGISTRY: registry!.url }, gitDirs),
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
const ghWrites = () => gh.calls().filter((c) => c.args[0] === 'api' && c.args[1] === '-X')
const patchState = (fn: (s: State) => void) => gh.patchState<State>(fn)

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
 * A repository like this one at release time: brand.ts declaring the last release of the brand scheme, released as
 * v<BRAND_VERSION>, then two changes merged. `origin.git` stands for GitHub; fetches reach it through `insteadOf` on
 * GitHub's address, and pushes by `pushurl`, so not even a broken rewrite could push anywhere real.
 *
 * `switchAt`: brand.ts loses its literal from that commit on ("one" by default, or the tip "two"), as on the tag scheme's
 * switch; "none" never does, so every commit since the tag still declares the version.
 */
const BRAND_PATH = 'packages/protocol/src/brand.ts'
const BRAND_LITERAL = (version: string) => `export const APP_VERSION = '${version}'\n`
const BRAND_IMPORT = "export { APP_VERSION } from './version.generated.js'\n"

function repo({ version = BRAND_VERSION, switchAt = 'one' }: { version?: string; switchAt?: 'one' | 'two' | 'none' } = {}): Repo {
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
  write(work, BRAND_PATH, BRAND_LITERAL(version))
  // The packages the shim needs on the registry (release.registry.packages)
  for (const d of readdirSync(join(REPO_ROOT, 'packaging/npm'))) write(work, `packaging/npm/${d}/package.json`, readFileSync(join(REPO_ROOT, 'packaging/npm', d, 'package.json'), 'utf8'))
  write(work, 'docs/releasing.md', `Released ${version} on a Monday.\n`)
  const released = commitAll(work, `chore(release): ${version} (#541)`)
  g(work, 'tag', `v${version}`)
  write(work, '.github/workflows/build.yml', 'on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n')
  write(work, 'a.txt', 'one\n')
  if (switchAt === 'one') write(work, BRAND_PATH, BRAND_IMPORT)
  commitAll(work, 'feat(ui): one (#10)')
  write(work, 'b.txt', 'two\n')
  if (switchAt === 'two') write(work, BRAND_PATH, BRAND_IMPORT)
  const tip = commitAll(work, 'fix: two (#11)')
  g(work, 'push', '-q', 'origin', 'main', `v${version}`)
  g(work, 'branch', '-q', '--set-upstream-to=origin/main')
  patchState((s) => (s.dispatchSha = tip))
  return { work, origin, released, tip }
}

/** v<BRAND_VERSION> is released: its shim is on the registry (its run is not listed here), so the next release may go ahead */
const releasedBefore = (s: Repo) => patchState((st) => (st.registry = { centralu: s.released }))

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

describe('release', { timeout: 60_000 * SLOW }, () => {
  it('ignores newer passing release checks with the same name as failing CI', async () => {
    const s = repo()
    releasedBefore(s)
    patchState((st) => {
      st.collidingReleaseChecks = true
      st.ci = 'failing'
    })
    runtime()
    const reason = 'has a fully green push run of its own yet'
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, r.text).toBe(true)
      expect(r.data.problems.join(' ')).toContain(reason)
    }
    const status = await call('release_status', { path: s.work })
    expect(status.data.summary).toContain(reason)
    expect(ghWrites()).toEqual([])
  })

  it('refuses checks from another app even when their suite id and name match CI', async () => {
    const s = repo()
    patchState((st) => { st.ci = 'green'; st.ciApp = 'another-app' })
    runtime()
    const r = await call('release', { step: 'tag', path: s.work, skipRehearsal: true, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(ghWrites()).toEqual([])
  })

  it.each(['failing'] as const)('blocks every publication approval while main CI is %s despite green release checks', async (ci) => {
    const s = repo()
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
    const s = repo()
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
    const s = repo()
    releasedBefore(s)
    runtime()
    expect((await call('release', { step: 'rehearse', path: s.work })).isError).toBe(false)
    const wrong = field === 'event' ? { event: 'workflow_dispatch' } : { head_branch: 'another-branch' }
    patchState((st) => { st.ciRunOverrides = { [s.tip]: wrong, [g(s.work, 'rev-parse', `${s.tip}^`)]: wrong } })
    const r = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(ghWrites()).toEqual([])
  })

  it('ci_status main ignores newer passing release checks with colliding build names', async () => {
    repo()
    patchState((st) => { st.ci = 'failing'; st.collidingReleaseChecks = true })
    runtime()
    const r = await call('ci_status', { ref: 'main' })
    expect(r.data.verdict, r.text).toBe('failing')
    expect(r.data.checks.join(' ')).toContain('build: failed')
    expect(ghWrites()).toEqual([])
  })

  it('approves platforms and then the shim from the tag even after an unrelated red merge', async () => {
    const s = repo()
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
    const s = repo()
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

  // A tag is pushed by commit from GitHub's history (#1350), so where the checkout is does not matter to it
  it.each([
    ['another branch', (w: string) => g(w, 'switch', '-q', '-c', 'topic')],
    ['a checkout behind GitHub', (w: string) => g(w, 'reset', '-q', '--hard', 'HEAD~1')],
    ['local commits GitHub lacks', (w: string) => (write(w, 'c.txt', 'c\n'), commitAll(w, 'local'))],
  ])('tags what GitHub has from %s', async (_, spoil) => {
    const s = repo()
    releasedBefore(s)
    spoil(s.work)
    runtime()
    const r = await call('release', { step: 'tag', path: s.work, confirm: true, skipRehearsal: true })
    expect(r.isError, r.text).toBe(false)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}^{commit}`)).toBe(s.tip)
  })

  it('refuses every step for an account without maintain or admin, before reading anything else', async () => {
    const s = repo()
    patchState((st) => (st.permissions = { push: true }))
    runtime()
    for (const step of ['rehearse', 'tag', 'approve']) {
      const r = await call('release', { step, path: s.work, confirm: true })
      expect(r.data.problems, step).toEqual([
        "The GitHub account gh is logged in as has no maintain or admin permission on this repository, and releasing is the maintainer's act (#386). Nothing was changed.",
      ])
    }
    expect(ghWrites()).toEqual([])
  })

  it('rehearses on main with the dry-run input and the version, and does not start a second rehearsal', async () => {
    const s = repo()
    releasedBefore(s)
    runtime()
    const plan = await call('release', { step: 'rehearse', path: s.work })
    expect(plan.data.summary).toBe(
      `Ready to rehearse ${NEXT} on main at ${s.tip.slice(0, 7)} (release.yml with dry_run=true, version=${NEXT}; builds and packs, publishes nothing, asks no approval). Call again with confirm: true to start it.`,
    )
    expect(ghWrites()).toEqual([])
    const r = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(r.data.summary).toBe(`Started the rehearsal of ${NEXT} on ${s.tip.slice(0, 7)}: https://github.com/ijun17/centralu/actions/runs/77. Tag once it succeeds.`)
    expect(ghWrites()).toEqual([{ args: ['api', '-X', 'POST', 'repos/ijun17/centralu/actions/workflows/release.yml/dispatches', '--input', '-'], stdin: JSON.stringify({ ref: 'main', inputs: { dry_run: 'true', version: NEXT } }) }])
    const again = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(again.data.summary).toBe(`A rehearsal on ${s.tip.slice(0, 7)} queued: https://github.com/ijun17/centralu/actions/runs/77; not starting another.`)
    expect(ghWrites()).toHaveLength(1)
  })

  it('refuses to tag without a successful rehearsal on the commit, unless told to skip it', async () => {
    const s = repo()
    releasedBefore(s)
    runtime()
    const none = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(none.data.problems).toEqual([`No rehearsal ran on ${s.tip.slice(0, 7)} or on its rehearsal branch at the same tree: rehearse first (release step rehearse), or pass skipRehearsal: true to tag without one.`])
    patchState((st) => st.runs.push(run({ head_sha: s.tip, conclusion: 'failure', display_title: `rehearse ${NEXT}` })))
    const failed = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(failed.data.problems).toEqual([`The rehearsal on ${s.tip.slice(0, 7)} ended failure (https://github.com/ijun17/centralu/actions/runs/50); fix that first, or pass skipRehearsal: true.`])
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
    const skipped = await call('release', { step: 'tag', path: s.work, skipRehearsal: true })
    expect(skipped.isError).toBe(false)
    expect(skipped.data.lines).toContain('Rehearsal: skipped (skipRehearsal: true).')
  })

  it('tags main after a rehearsal, pushes only the tag, and answers the release run', async () => {
    const s = repo()
    const before = checkout(s.work)
    releasedBefore(s)
    patchState((st) => {
      st.runs.push(run({ head_sha: s.tip, display_title: `rehearse ${NEXT}` }))
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'waiting', conclusion: null, html_url: 'https://github.com/ijun17/centralu/actions/runs/61' }))
    })
    runtime()
    const plan = await call('release', { step: 'tag', path: s.work, version: `v${NEXT}` })
    expect(plan.data.summary).toBe(`Ready to tag v${NEXT} on ${s.tip.slice(0, 7)}; nothing pushed yet. The tag is the release: the workflow publishes after approval on npm-publish. Call again with confirm: true to push it.`)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
    const r = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(r.isError).toBe(false)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}^{commit}`)).toBe(s.tip)
    expect(r.data.summary).toBe(
      `Tagged v${NEXT} on ${s.tip.slice(0, 7)}. The release run: https://github.com/ijun17/centralu/actions/runs/61. It waits for approval on npm-publish: the platform jobs first, then the shim. Next: release step approve, or approve on GitHub.`,
    )
    // Pushed by commit: no tag or branch made in the checkout
    expect(checkout(s.work)).toEqual(before)
    expect(ghWrites()).toEqual([])
    const twice = await call('release', { step: 'tag', path: s.work, confirm: true, skipRehearsal: true })
    expect(twice.data.problems).toEqual([`Nothing landed on main since v${NEXT}; there is nothing to release.`])
  })

  /** n more changes merged after the release commit: answers main's new head (GitHub's main moves with it) */
  function landMore(s: Repo, n = 2) {
    for (let i = 1; i <= n; i++) {
      write(s.work, `later-${i}.txt`, `${i}\n`)
      s.tip = commitAll(s.work, `fix: later ${i} (#${20 + i})`)
    }
    g(s.work, 'push', '-q', 'origin', 'main')
    patchState((st) => (st.dispatchSha = s.tip))
    return s.tip
  }
  const short7 = (sha: string) => sha.slice(0, 7)

  it("rehearses on a left-over rehearsal branch only when it holds the release commit's tree", async () => {
    const s = repo()
    const at = s.tip
    releasedBefore(s)
    const head = landMore(s)
    // Their own runs have not passed: the release stays on the commit before them
    patchState((st) => (st.ciBySha = { [head]: 'pending', [g(s.work, 'rev-parse', `${head}^`)]: 'pending' }))
    const branch = `chore/release-${NEXT}`
    // Another commit with the same tree: the rehearsal runs on it
    const same = g(s.work, 'commit-tree', g(s.work, 'rev-parse', `${at}^{tree}`), '-p', s.released, '-m', 'rehearsal candidate')
    g(s.work, 'push', '-q', 'origin', `${same}:refs/heads/${branch}`)
    runtime()
    patchState((st) => (st.dispatchSha = same))
    const started = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(started.isError, started.text).toBe(false)
    expect(remoteHas(s.origin, `refs/heads/${branch}`)).toBe(same)
    // The run is on the branch's commit, not the release commit: it is found and reported
    expect(started.data.run).toBe('https://github.com/ijun17/centralu/actions/runs/77')
    expect(started.data.summary).toContain(': https://github.com/ijun17/centralu/actions/runs/77.')
    expect(started.data.summary).not.toContain('does not list the run yet')
    // Tagged on that rehearsal; the branch is not at the release commit, so the tag leaves it
    patchState((st) => Object.assign(st.runs[0]!, { status: 'completed', conclusion: 'success' }))
    const tagged = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(tagged.isError, tagged.text).toBe(false)
    expect(remoteHas(s.origin, `refs/heads/${branch}`)).toBe(same)
    g(s.origin, 'tag', '-d', `v${NEXT}`)
    // Another tree on it: nothing is started, and nothing is moved
    g(s.work, 'push', '-q', '-f', 'origin', `${s.released}:refs/heads/${branch}`)
    patchState((st) => (st.runs.length = 0))
    const other = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(other.isError).toBe(true)
    expect(other.data.problems).toEqual([`The branch ${branch} on origin (${short7(s.released)}) holds another tree than the release commit ${short7(at)}; delete it, then rehearse again.`])
    expect(remoteHas(s.origin, `refs/heads/${branch}`)).toBe(s.released)
    expect(ghWrites()).toHaveLength(1)
  })

  // #1259: changes land after the fast tier, so main's own push run (the full tier) is the only evidence for a release
  it("refuses to tag a commit whose only green run is a batch's quick run, until main's own full run on it passes", async () => {
    const s = repo()
    releasedBefore(s)
    const batch = { event: 'workflow_dispatch', head_branch: 'queue/batch-1' }
    patchState((st) => {
      st.ci = 'green'
      // The runs GitHub has on the commits since the tag are the merge queue's batches' (workflow_dispatch on queue/batch-1), not main's push runs
      st.ciRunOverrides = { ...st.ciRunOverrides, [s.tip]: batch, [g(s.work, 'rev-parse', `${s.tip}^`)]: batch }
    })
    runtime()
    const refused = await call('release', { step: 'tag', path: s.work, version: NEXT, skipRehearsal: true, confirm: true })
    expect(refused.data.problems.join(' ')).toContain('has a fully green push run of its own yet')
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
    // Main's own push run on it passed: CI is no longer a reason
    patchState((st) => (st.ciRunOverrides = {}))
    const status = await call('release', { step: 'tag', path: s.work, version: NEXT, skipRehearsal: true })
    expect(status.isError, status.text).toBe(false)
  })

  it('approves only the tag release run, only what GitHub says this login may approve', async () => {
    const s = repo()
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
    const s = repo()
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
    expect(gh.state<State>().cancelled).toEqual(['repos/ijun17/centralu/actions/runs/62/cancel'])
  })

  /** A tagged NEXT whose release run 61 waits on npm-publish with `jobs` */
  function waitingRelease(jobs: { name: string; status: string; conclusion: string | null }[]) {
    const s = repo()
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
    expect(gh.state<State>().seq![`ci:${s.tip}`]).toEqual(['green'])
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
    expect(gh.state<State>().registryHidden).toEqual({ [REGISTRY_NAMES[0]!]: 0 })
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
    const s = repo()
    runtime()
    const r = await call('release', { step: 'approve', path: s.work, version: NEXT, confirm: true })
    expect(r.data.problems).toEqual([`v${NEXT} is not tagged; there is no release run to approve.`])
    patchState((st) => st.runs.push(run({ id: 60, event: 'push', head_branch: `v${BRAND_VERSION}`, head_sha: s.released })))
    const done = await call('release', { step: 'approve', path: s.work, version: BRAND_VERSION, confirm: true })
    expect(done.isError).toBe(false)
    expect(done.data.summary).toBe(`The release run for v${BRAND_VERSION} succeeded: https://github.com/ijun17/centralu/actions/runs/60; nothing waits for approval.`)
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

/*
 * release.scheme "tag" (#1501): no file carries the release version and there is no bump. The next release is the next
 * prerelease after the newest tag, cut from the newest commit of main since it whose own push run is fully green;
 * the rehearsal is dispatched with the version as an input and counts only for that version (its run name), and the
 * tag is annotated with the notes, their only record.
 */
describe('the next release is cut from the newest fully green commit (#1501)', { timeout: 60_000 * SLOW }, () => {
  /** repo(): v<BRAND_VERSION> on `released`, then "feat(ui): one (#10)", then the tip "fix: two (#11)" */
  const one = (s: Repo) => g(s.work, 'rev-parse', `${s.tip}^`)
  const fullTier = (s: Repo, onOne: string, onTip: string) =>
    patchState((st) => {
      st.requiredContexts = ['build', 'full tier']
      st.fullTierBySha = { [one(s)]: onOne, [s.tip]: onTip }
      st.dispatchSha = one(s)
      st.registry = { centralu: s.released }
    })

  it('cuts the next prerelease from the newest fully green commit, rehearses it by version, and tags it annotated with the notes', async () => {
    const s = repo()
    const at = one(s)
    // The tip's own run passed only the quick tier; the commit before it ran the full tier
    fullTier(s, 'success', 'skipped')
    runtime()
    const before = checkout(s.work)

    const status = await call('release_status', { path: s.work })
    expect(status.isError, status.text).toBe(false)
    expect(status.data).toMatchObject({ phase: 'ready-to-tag', version: NEXT, tag: `v${NEXT}`, releaseCommit: at, behind: 1, notes: ['feat(ui): one (#10)'], after: ['fix: two (#11)'] })
    expect(status.data.summary).toContain(`the next release is ${NEXT} from ${at.slice(0, 7)}`)

    // A rehearsal on the same commit of another version is not one of this version
    patchState((st) => st.runs.push(run({ id: 60, head_sha: at, head_branch: `chore/release-${NEXT}`, display_title: 'rehearse 9.9.9' })))
    const early = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(early.isError).toBe(true)
    expect(early.data.problems.join(' ')).toContain('No rehearsal ran')
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()

    const rehearse = await call('release', { step: 'rehearse', path: s.work, confirm: true })
    expect(rehearse.isError, rehearse.text).toBe(false)
    expect(gh.state<State>().dispatched).toEqual([{ ref: `chore/release-${NEXT}`, inputs: { dry_run: 'true', version: NEXT } }])
    expect(remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)).toBe(at)

    patchState((st) => Object.assign(st.runs.find((r) => r.id === 77)!, { status: 'completed', conclusion: 'success' }))
    const tag = await call('release', { step: 'tag', path: s.work, confirm: true })
    expect(tag.isError, tag.text).toBe(false)
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}^{commit}`)).toBe(at)
    expect(g(s.origin, 'cat-file', '-t', `refs/tags/v${NEXT}`)).toBe('tag')
    const message = g(s.origin, 'for-each-ref', '--format=%(contents)', `refs/tags/v${NEXT}`)
    expect(message).toContain(`Centralu ${NEXT}`)
    expect(message).toContain(`Merged since v${BRAND_VERSION}:`)
    expect(message).toContain('- feat(ui): one (#10)')
    expect(message).not.toContain('fix: two')
    // The branch made to rehearse on is gone; the person's checkout did not move
    expect(remoteHas(s.origin, `refs/heads/chore/release-${NEXT}`)).toBeNull()
    expect(checkout(s.work)).toEqual(before)
  })

  it('refuses while no commit since the newest tag has a fully green run of its own, and names a commit given that is not releasable', async () => {
    const s = repo()
    fullTier(s, 'skipped', 'skipped')
    patchState((st) => (st.ciBySha = { [s.tip]: 'pending' }))
    runtime()
    const status = await call('release_status', { path: s.work })
    expect(status.data.summary).toContain('Not releasable yet')
    expect(status.data.summary).toContain('has a fully green push run of its own yet')
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, `${step}: ${r.text}`).toBe(true)
      expect(r.data.problems.join(' ')).toContain('has a fully green push run of its own yet')
    }
    const named = await call('release', { step: 'tag', path: s.work, commit: s.released, skipRehearsal: true, confirm: true })
    expect(named.data.problems.join(' ')).toContain(`is not a commit of main's history (first parents) after v${BRAND_VERSION}`)
    const quick = await call('release', { step: 'tag', path: s.work, commit: one(s), skipRehearsal: true, confirm: true })
    expect(quick.data.problems.join(' ')).toContain('did not run the full tier')
    const older = await call('release', { step: 'tag', path: s.work, version: BRAND_VERSION, skipRehearsal: true, confirm: true })
    expect(older.data.problems.join(' ')).toContain('tagged already')
    expect(ghWrites()).toEqual([])
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
  })

  it('follows the newest tag until its release run succeeded, then says nothing landed since', async () => {
    const s = repo()
    g(s.work, 'push', '-q', 'origin', `${s.tip}:refs/tags/v${NEXT}`)
    patchState((st) => st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'in_progress', conclusion: null })))
    runtime()
    expect((await call('release_status', { path: s.work })).data).toMatchObject({ phase: 'publishing', version: NEXT, releaseCommit: s.tip })
    patchState((st) => Object.assign(st.runs.find((r) => r.id === 61)!, { status: 'completed', conclusion: 'success' }))
    const done = await call('release_status', { path: s.work })
    expect(done.data.phase).toBe('released')
    expect(done.data.summary).toContain(`released as v${NEXT}`)
    expect(done.data.summary).toContain('nothing landed on main since')
  })

  it("approves only on the tagged commit's own CI: no bump PR's run stands for it", async () => {
    const s = repo()
    g(s.work, 'push', '-q', 'origin', `${s.tip}:refs/tags/v${NEXT}`)
    // A merged PR whose head has the tip's tree: its run does not stand for the tagged commit's own
    const prHead = g(s.work, 'commit-tree', g(s.work, 'rev-parse', `${s.tip}^{tree}`), '-p', one(s), '-m', 'pr head')
    g(s.work, 'push', '-q', 'origin', `${prHead}:refs/pull/900/head`)
    patchState((st) => {
      st.ci = 'pending'
      st.prCi = 'green'
      st.prs.push({ number: 900, state: 'MERGED', headRefName: `chore/release-${NEXT}`, baseRefName: 'main', headRefOid: prHead, mergeCommit: { oid: s.tip } })
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: s.tip, status: 'waiting', conclusion: null }))
      st.pending['61'] = [{ environment: { id: 7, name: 'npm-publish' }, current_user_can_approve: true, reviewers: [] }]
      st.jobs['61'] = [{ name: 'linux-x64', status: 'waiting', conclusion: null }]
    })
    runtime()
    const r = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(r.isError, r.text).toBe(true)
    expect(r.data.problems.join(' ')).toContain('must be green before npm-publish approval')
    expect(ghWrites()).toEqual([])
    patchState((st) => (st.ci = 'green'))
    const approved = await call('release', { step: 'approve', path: s.work, confirm: true })
    expect(approved.isError, approved.text).toBe(false)
    expect(approved.data.approved).toBe(true)
  })

  it('passes over a commit whose brand.ts still declares the version, read as the release guard reads it', async () => {
    // Right after the switch merges, the newest fully green commit can be one from before it: a tag there is refused by the
    // guard, and the number is spent on a tag that never publishes (#1501 review item 1)
    const s = repo({ switchAt: 'two' })
    fullTier(s, 'success', 'skipped')
    runtime()
    const status = await call('release_status', { path: s.work })
    expect(status.data.summary).toContain('Not releasable yet')
    expect(status.data.summary).toContain('1 of them still declaring the version')
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, `${step}: ${r.text}`).toBe(true)
    }
    const named = await call('release', { step: 'tag', path: s.work, commit: one(s), skipRehearsal: true, confirm: true })
    expect(named.data.problems.join(' ')).toContain(`${one(s).slice(0, 7)} still declares ${BRAND_VERSION} in ${BRAND_PATH} (the brand scheme)`)
    expect(ghWrites()).toEqual([])
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
    // Once the switch's own commit has its full run, it is the release
    patchState((st) => (st.fullTierBySha = { [one(s)]: 'success', [s.tip]: 'success' }))
    const ready = await call('release_status', { path: s.work })
    expect(ready.data).toMatchObject({ phase: 'ready-to-tag', version: NEXT, releaseCommit: s.tip })
  })

  it('says no commit is under the tag scheme yet while every one since the newest tag declares the version', async () => {
    const s = repo({ switchAt: 'none' })
    fullTier(s, 'success', 'success')
    runtime()
    const r = await call('release', { step: 'tag', path: s.work, skipRehearsal: true, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.data.problems.join(' ')).toContain(`No commit of main since v${BRAND_VERSION} is under the tag scheme yet`)
    expect(r.data.problems.join(' ')).toContain("would be refused by the release workflow's guard")
    expect(remoteHas(s.origin, `refs/tags/v${NEXT}`)).toBeNull()
  })

  it('refuses to rehearse or tag the next version while the newest tag is still being released', async () => {
    // The guard refuses a newer tag until the previous version is on the registry (#1501 review item 4)
    const s = repo()
    fullTier(s, 'success', 'success')
    g(s.work, 'push', '-q', 'origin', `${one(s)}:refs/tags/v${NEXT}`)
    patchState((st) => {
      st.registry = {}
      st.runs.push(run({ id: 61, event: 'push', head_branch: `v${NEXT}`, head_sha: one(s), status: 'waiting', conclusion: null }))
    })
    runtime()
    expect((await call('release_status', { path: s.work })).data).toMatchObject({ version: NEXT, releaseCommit: one(s) })
    for (const step of ['rehearse', 'tag']) {
      const r = await call('release', { step, path: s.work, skipRehearsal: true, confirm: true })
      expect(r.isError, `${step}: ${r.text}`).toBe(true)
      expect(r.data.problems.join(' ')).toContain(`v${NEXT}, the newest release tag, is not released yet`)
    }
    expect(ghWrites()).toEqual([])
    // Its shim on the registry: released, and the next one goes ahead on the tip
    patchState((st) => (st.registry = { centralu: one(s) }))
    const next = await call('release', { step: 'tag', path: s.work, skipRehearsal: true })
    expect(next.isError, next.text).toBe(false)
    expect(next.data.lines.join(' ')).toContain(nextVersion(NEXT) as string)
  })
})

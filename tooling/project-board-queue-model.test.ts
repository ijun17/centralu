import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { MOVED_CAP, activeBatch } from '../.centralu/apps/project-board/batch.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { GitHubError } from '../.centralu/apps/project-board/github.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { dequeue, enqueue } from '../.centralu/apps/project-board/queue.mjs'
// @ts-expect-error — plain .mjs of a Centralu app (no installs, no types, by the app rules)
import { readQueue, tick, updateQueue } from '../.centralu/apps/project-board/queue-driver.mjs'
import { SLOW } from './test-timing.js'

/*
 * The merge queue against a model of GitHub (#1538, #1548; the review of #1563).
 *
 * The queue's own code runs for real: `tick` of queue-driver.mjs, and through it the batch steps (building, the
 * judge of what a batch changes, reading CI, landing, stopping when main moved, building again). Only github.mjs is
 * replaced, by a model that holds what GitHub holds: the pull requests with the files they change, main and its tree,
 * the batch branches, and the workflow runs with their checks and jobs, which take time (a run is in progress for a while,
 * its checks finish a moment before the run is marked completed), fail, are cancelled and rerun, skip a shard, or have a
 * stand-in report a shard's name. The model never decides what the queue should do; it only answers what GitHub would,
 * and records what the queue asked GitHub to do. What must hold is checked on those records:
 *
 *  - nothing lands unless the run that proved it was complete: a batch holding a change to the screen (by the model's own
 *    table of files, not by the judge) lands only from a finished full run in which the full tier and every shard
 *    of both browsers succeeded and ran their scenarios; any other batch from a finished run that passed the fast tier;
 *  - nothing lands on a main that is not the tree the batch tested;
 *  - main moving under a batch never reaches a session until a pull request has been stopped by it MOVED_CAP times
 *    on one head, and no pull request is built again more than that;
 *  - nothing loops: once the world is calm, every pull request lands or needs a session within a bounded number of ticks.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const R = 'ijun17/centralu'
const CI_CHANGES = readFileSync(join(REPO_ROOT, '.github/scripts/ci-changes.mjs'), 'utf8')

const hoisted = vi.hoisted(() => {
  // Every poll due at once: the model's clock is the ticks'
  process.env.PROJECT_BOARD_QUEUE_POLL_MS = '1'
  const world: { current?: unknown } = {}
  return { world }
})

/** What the model answers for github.mjs: the world as it is, set for each sequence */
vi.mock('../.centralu/apps/project-board/github.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const w = () => hoisted.world.current as World
  return {
    ...actual,
    readRepo: async () => ({ permissions: { admin: false, maintain: true, push: true }, defaultBranch: 'main' }),
    readPr: async (_repo: string, n: number) => w().readPr(n),
    readCommit: async () => w().readMain(),
    readRequired: async () => ({ names: w().required, unresolved: [], added: 0, source: 'the model' }),
    readWorkflowChecks: async (_repo: string, sha: string, o: { branch?: string }) => w().readWorkflowChecks(sha, o?.branch),
    readChecks: async (_repo: string, sha: string) => w().readWorkflowChecks(sha).reported,
    runJobSteps: async (_repo: string, runId: number) => w().runJobSteps(runId),
    jobNotes: async () => [],
    readJobLog: async () => '',
    dispatchWorkflow: async (_repo: string, _file: string, ref: string, inputs: Record<string, string> | undefined) => w().dispatch(ref, inputs ?? null),
    rerunRun: async (_repo: string, runId: number, o: { failedOnly?: boolean }) => w().rerun(runId, o?.failedOnly === true),
    cancelWorkflowRun: async (_repo: string, runId: number) => w().cancel(runId),
    createBranch: async (_repo: string, name: string, sha: string) => w().createBranch(name, sha),
    mergeInto: async (_repo: string, branch: string, head: string) => w().mergeInto(branch, head),
    deleteBranch: async (_repo: string, name: string) => w().deleteBranch(name),
    mergePr: async (_repo: string, n: number, sha: string) => w().mergePr(n, sha),
    postStatus: async () => undefined,
    readRepoFile: async (_repo: string, path: string) => w().readFile(path),
    readCompareFiles: async (_repo: string, _base: string, head: string) => w().compareFiles(head),
    openPrsOnBase: async () => [],
    prsWithHead: async () => [],
    containsCommit: async () => true,
    closePr: async () => null,
    markDraft: async () => undefined,
    markReady: async () => undefined,
    setPrBase: async () => undefined,
  }
})

const REQUIRED = [
  'changes',
  'full tier',
  'verify',
  'windows tests (vitest 1/2)',
  'windows tests (vitest 2/2)',
  'macos tests',
  'e2e (webkit 1/2)',
  'e2e (webkit 2/2)',
  'e2e (chromium 1/2)',
  'e2e (chromium 2/2)',
]
const SHARDS = REQUIRED.filter((n) => n.startsWith('e2e ('))
/**
 * build.yml's stand-in for the Chromium shards (e2e-chromium-skipped) is skipped on every full run whose files reach the
 * shards, and GitHub reports a matrix job skipped before its matrix was expanded under its unexpanded name (run
 * 40247598237, queue/batch-220: the batch was dropped for it though every shard passed). Every full run here reports it.
 */
const STAND_IN_SKIPPED = 'e2e (chromium ${{ matrix.shard }}/${{ matrix.shards }})'
/** The jobs of run 40247598237 (queue/batch-220, #1562), as GitHub listed them */
const RUN_220 = JSON.parse(readFileSync(join(REPO_ROOT, 'tooling/fixtures/project-board/run-40247598237-jobs.json'), 'utf8')) as { jobs: { name: string; conclusion: string; steps: { name: string; conclusion: string | null }[] }[] }

/** The model's own idea of which files the UI scenarios see (not the queue's judge: that is what is under test) */
const SCREEN_FILES = [
  'packages/ui/src/App.tsx',
  'apps/desktop/src/build-bar.tsx',
  'apps/desktop/src-tauri/tauri.conf.json',
  '.centralu/apps/project-board/ui/index.html',
  'packages/agent-host/src/sessions/x.ts',
  'e2e/fixtures/linked-hosts.ts',
  'scripts/e2e-web-server.mjs',
]
const QUIET_FILES = ['docs/guide.md', 'README.md', 'tooling/project-board-queue.test.ts', 'packages/ui/src/App.test.tsx', '.centralu/apps/project-board/queue.mjs', 'apps/desktop/src-tauri/src/main.rs']

type Plan = 'green' | 'red' | 'infra' | 'skip-shard' | 'stand-in' | 'no-shard'
type CheckRow = { name: string; status: string; conclusion: string | null; id: number; standIn?: boolean; steps?: { name: string; conclusion: string | null }[] }
type Run = {
  id: number
  sha: string
  branch: string
  event: 'pull_request' | 'workflow_dispatch'
  tier: 'quick' | 'full'
  attempt: number
  suite: number
  plan: Plan
  /** world steps since this attempt started, the steps until its checks finish, and the steps its run stays in progress after that */
  age: number
  duration: number
  lag: number
  createdAt: string
  status: 'in_progress' | 'completed'
  conclusion: string | null
  checks: CheckRow[]
}
type Branch = { sha: string; tree: string; members: { n: number; head: string; files: string[] }[]; steps: Map<string, string>; olderBoard: boolean }
type Pr = { n: number; head: string; file: string; state: 'OPEN' | 'MERGED'; mergeCommit: string | null }
type Landing = { n: number; head: string; branch: string }

/** Whether a finished run proves what lands, by the model's own rules (the check on every landing, and tested below on made-up runs) */
function proof(run: Run | undefined, { heavy, shards = SHARDS }: { heavy: boolean; shards?: string[] }): string | null {
  if (!run) return 'no run at all'
  if (run.status !== 'completed') return `the run is ${run.status}`
  if (run.conclusion !== 'success') return `the run concluded ${run.conclusion}`
  const by = (name: string) => run.checks.find((c) => c.name === name)
  const ok = (name: string) => by(name)?.status === 'completed' && by(name)?.conclusion === 'success'
  for (const n of ['changes', 'verify', 'windows tests (vitest 1/2)', 'windows tests (vitest 2/2)', 'macos tests']) if (!ok(n)) return `${n} did not succeed`
  if (!heavy) return null
  if (run.tier !== 'full') return 'the heavy jobs were needed and the run was the fast tier'
  if (!ok('full tier')) return 'the full tier did not pass'
  for (const s of shards) {
    const c = by(s)
    if (!c) return `${s} was never reported`
    if (c.conclusion !== 'success') return `${s} concluded ${c.conclusion}`
    if (c.standIn) return `${s} is a stand-in that only echoed`
  }
  return null
}

class World {
  main = { sha: 'm0', tree: 'T0' }
  prs = new Map<number, Pr>()
  branches = new Map<string, Branch>()
  runs: Run[] = []
  landings: Landing[] = []
  /** Landings from a batch that holds a change to the screen */
  heavyLandings = 0
  violations: string[] = []
  trees = new Map<string, string>()
  counter = 0
  clock = Date.UTC(2026, 9, 26)
  judgeMissing = false
  compareNull = false
  /** The judge on the default branch crashes (a change that broke it, or an older one that does not know --screen) */
  judgeBroken = false
  calm = false
  /** Ticks left of a busy main: something else lands on it every tick (a release, merges by hand) */
  storm = 0
  /** The required set, the shards a heavy landing needs, and a recorded job list every full run reports instead of the model's */
  required = REQUIRED
  shards = SHARDS
  jobList: typeof RUN_220 | null = null
  /** A pull request's title when it is not the usual one (a person edited it) */
  titles = new Map<number, string>()
  constructor(public rand: () => number) {}

  tree(a: string, b: string) {
    const key = `${a}|${b}`
    if (!this.trees.has(key)) this.trees.set(key, `T${this.trees.size + 1}`)
    return this.trees.get(key)!
  }
  iso = () => new Date(this.clock).toISOString()
  pr(n: number) {
    const p = this.prs.get(n)
    if (!p) throw new Error(`no pull request ${n}`)
    return p
  }

  // --- the pull requests
  open(n: number) {
    this.prs.set(n, { n, head: this.newHead(n), file: this.pick(this.rand() < 0.45 ? SCREEN_FILES : QUIET_FILES), state: 'OPEN', mergeCommit: null })
    this.startOwnRun(this.pr(n))
  }
  push(n: number) {
    const p = this.pr(n)
    p.head = this.newHead(n)
    p.file = this.pick(this.rand() < 0.45 ? SCREEN_FILES : QUIET_FILES)
    this.startOwnRun(p)
  }
  newHead = (n: number) => `${n}${(++this.counter).toString(16)}`.padEnd(40, 'a')
  pick = <T>(list: T[]) => list[Math.floor(this.rand() * list.length)]!
  readPr(n: number) {
    const p = this.pr(n)
    return {
      number: n,
      title: this.titles.get(n) ?? `feat(apps): change ${n}`,
      body: '## Why\n\nBecause.\n\n## Closes\n\nRefs #956\n',
      state: p.state,
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRefOid: p.head,
      headRefName: `feat/b${n}`,
      baseRefName: 'main',
      isCrossRepository: false,
      url: `https://github.com/${R}/pull/${n}`,
      mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
      labels: [],
    }
  }

  // --- main, branches and files
  readMain = () => ({ sha: this.main.sha, tree: this.main.tree })
  /** Something merges into main that the queue did not (a release bump through merge_when_green) */
  externalMerge() {
    this.main = { sha: `m${++this.counter}`, tree: this.tree(this.main.tree, `external${this.counter}`) }
  }
  createBranch(name: string, sha: string) {
    if (this.branches.has(name)) throw new (this.errorClass())('github', `Reference already exists: ${name}`)
    if (sha !== this.main.sha) throw new (this.errorClass())('github', `the branch ${name} was to be made at ${sha}, which is not main`)
    this.branches.set(name, { sha, tree: this.main.tree, members: [], steps: new Map(), olderBoard: false })
  }
  deleteBranch(name: string) {
    this.branches.delete(name)
    return null
  }
  mergeInto(name: string, head: string) {
    const b = this.branches.get(name)
    if (!b) throw new (this.errorClass())('github', `no branch ${name}`)
    const p = [...this.prs.values()].find((x) => x.head === head)
    if (!p) throw new (this.errorClass())('github', `no commit ${head}`)
    b.tree = this.tree(b.tree, head)
    b.sha = `b${++this.counter}`
    b.members.push({ n: p.n, head, files: [p.file] })
    b.steps.set(head, b.tree)
    return { sha: b.sha, tree: b.tree }
  }
  readFile(path: string) {
    if (path !== '.github/scripts/ci-changes.mjs' || this.judgeMissing) return null
    return this.judgeBroken ? 'process.exit(3)' : CI_CHANGES
  }
  compareFiles(name: string) {
    const b = this.branches.get(name)
    if (!b || this.compareNull) return null
    return b.members.flatMap((m) => m.files)
  }
  errorClass(): new (kind: string, message: string) => Error {
    return this.githubError
  }
  githubError!: new (kind: string, message: string) => Error

  /** The squash of a pull request into main, and what the model checks about it before it happens */
  mergePr(n: number, sha: string): string | null {
    const p = this.prs.get(n)
    if (!p || p.state !== 'OPEN') return `pull request ${n} is not open`
    if (p.head !== sha) return `its head is ${p.head}, not ${sha}`
    const branch = [...this.branches.entries()].find(([, b]) => b.members.some((m) => m.n === n && m.head === sha))
    if (!branch) {
      this.violations.push(`#${n} was merged from its own run, which is only the fast tier: nothing lands but through a batch's run`)
    } else {
      const [name, b] = branch
      const heavy = b.members.some((m) => m.files.some((f) => SCREEN_FILES.includes(f))) || b.olderBoard
      const run = this.runs.filter((r) => r.branch === name && r.sha === b.sha).sort((x, y) => y.attempt - x.attempt)[0]
      const why = proof(run, { heavy, shards: this.shards })
      if (why) this.violations.push(`#${n} landed from ${name}${heavy ? ', which holds a change to the screen,' : ''} but ${why}`)
      if (heavy) this.heavyLandings++
      const expected = b.steps.get(sha)
      const squashed = this.tree(this.main.tree, sha)
      if (squashed !== expected) this.violations.push(`#${n} landed on ${this.main.tree}, not on the tree its batch tested before it`)
      this.landings.push({ n, head: sha, branch: name })
    }
    p.state = 'MERGED'
    p.mergeCommit = `c${++this.counter}`.padEnd(40, 'c')
    this.main = { sha: p.mergeCommit, tree: this.tree(this.main.tree, sha) }
    return null
  }

  // --- CI
  private plan(tier: 'quick' | 'full', attempt: number): Plan {
    if (this.calm) return 'green'
    const r = this.rand()
    if (attempt > 1) return r < 0.75 ? 'green' : 'infra'
    if (tier === 'quick') return r < 0.8 ? 'green' : r < 0.9 ? 'red' : 'infra'
    return r < 0.5 ? 'green' : r < 0.6 ? 'red' : r < 0.7 ? 'infra' : r < 0.8 ? 'skip-shard' : r < 0.9 ? 'stand-in' : 'no-shard'
  }
  private startRun(sha: string, branch: string, event: Run['event'], tier: Run['tier'], id: number | null = null, attempt = 1): Run {
    const run: Run = {
      id: id ?? 1000 + this.runs.length,
      sha,
      branch,
      event,
      tier,
      attempt,
      suite: 5000 + this.runs.length,
      plan: this.plan(tier, attempt),
      age: 0,
      duration: this.calm ? 1 : 1 + Math.floor(this.rand() * 3),
      lag: this.rand() < 0.5 ? 0 : 1,
      createdAt: this.iso(),
      status: 'in_progress',
      conclusion: null,
      checks: [],
    }
    this.fill(run)
    return run
  }
  private startOwnRun(p: Pr) {
    this.runs.push(this.startRun(p.head, `feat/b${p.n}`, 'pull_request', 'quick'))
  }
  /** The checks a run reports at its age: in progress until its duration, then as its plan says */
  private fill(run: Run) {
    const done = run.age >= run.duration
    if (this.jobList && run.tier === 'full') return this.fillRecorded(run, done)
    const names = ['changes', 'full tier', 'verify', 'windows tests (vitest 1/2)', 'windows tests (vitest 2/2)', 'macos tests', ...(run.tier === 'full' ? SHARDS : [])]
    const id = (n: string) => run.id * 100 + REQUIRED.indexOf(n) + 1
    const rows: CheckRow[] = []
    if (run.tier === 'full') rows.push({ name: STAND_IN_SKIPPED, status: 'completed', conclusion: 'skipped', id: run.id * 100 + 99, steps: [] })
    for (const name of names) {
      let conclusion: string | null = run.tier === 'quick' && name === 'full tier' ? 'skipped' : null
      let standIn = false
      if (done) {
        conclusion = 'success'
        if (name === 'full tier' && run.tier === 'quick') conclusion = 'skipped'
        if (run.plan === 'red' && name === 'verify') conclusion = 'failure'
        if (run.plan === 'infra' && name === 'windows tests (vitest 1/2)') conclusion = 'cancelled'
        if (run.plan === 'skip-shard' && name === SHARDS[3]) conclusion = 'skipped'
        if (run.plan === 'stand-in' && name === SHARDS[2]) standIn = true
        if (run.plan === 'no-shard' && name === SHARDS[1]) continue
      }
      rows.push({ name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, id: id(name), ...(standIn ? { standIn } : {}) })
    }
    run.checks = rows
    if (done && run.age >= run.duration + run.lag) {
      run.status = 'completed'
      run.conclusion = run.plan === 'red' ? 'failure' : run.plan === 'infra' ? 'cancelled' : 'success'
    }
  }
  /** A full run that reports the recorded job list: each job in progress until the run's checks finish, then as recorded */
  private fillRecorded(run: Run, done: boolean) {
    run.checks = this.jobList!.jobs.map((j, i) => {
      const settled = done || j.conclusion === 'skipped'
      return { name: j.name, status: settled ? 'completed' : 'in_progress', conclusion: settled ? j.conclusion : null, id: run.id * 100 + i + 1, steps: settled ? j.steps : [] }
    })
    if (done && run.age >= run.duration + run.lag) Object.assign(run, { status: 'completed', conclusion: 'success' })
  }
  /** Time passes: every run in progress gets older */
  advance() {
    for (const r of this.runs) {
      if (r.status !== 'in_progress') continue
      r.age++
      this.fill(r)
    }
    this.clock += 20_000
    if (this.storm > 0) {
      this.storm--
      this.externalMerge()
    }
  }
  dispatch(branch: string, inputs: Record<string, string> | null) {
    const b = this.branches.get(branch)
    if (!b) throw new (this.errorClass())('github', `no branch ${branch}`)
    this.runs.push(this.startRun(b.sha, branch, 'workflow_dispatch', inputs?.tier === 'quick' ? 'quick' : 'full'))
    this.dispatches.push({ branch, inputs })
  }
  dispatches: { branch: string; inputs: Record<string, string> | null }[] = []
  rerun(runId: number, failedOnly: boolean) {
    const old = this.runs.find((r) => r.id === runId)
    if (!old) throw new (this.errorClass())('github', `no run ${runId}`)
    const next = this.startRun(old.sha, old.branch, old.event, old.tier, old.id, old.attempt + 1)
    next.suite = old.suite
    void failedOnly
    this.runs.splice(this.runs.indexOf(old), 1, next)
  }
  cancel(runId: number) {
    const r = this.runs.find((x) => x.id === runId)
    if (r && r.status !== 'completed') Object.assign(r, { status: 'completed', conclusion: 'cancelled' })
  }
  readWorkflowChecks(sha: string, branch?: string) {
    const runs = this.runs.filter((r) => r.sha === sha && (!branch || r.branch === branch))
    return {
      runs: runs.map((r) => ({
        id: r.id,
        run_attempt: r.attempt,
        head_sha: r.sha,
        head_branch: r.branch,
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        check_suite_id: r.suite,
        created_at: r.createdAt,
        html_url: `https://github.com/${R}/actions/runs/${r.id}`,
        workflow_id: 1,
      })),
      reported: runs.flatMap((r) =>
        r.checks.map((c) => ({ kind: 'run', appSlug: 'github-actions', suiteId: r.suite, name: c.name, status: c.status, conclusion: c.conclusion, id: c.id, jobId: String(c.id), url: `https://github.com/${R}/actions/runs/${r.id}/job/${c.id}`, at: r.createdAt })),
      ),
    }
  }
  runJobSteps(runId: number) {
    const r = this.runs.find((x) => x.id === runId)
    return (r?.checks ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      steps: c.steps
        ? c.steps
        : c.conclusion === 'failure'
          ? [{ name: 'Set up job', conclusion: 'success' }, { name: 'pnpm test', conclusion: 'failure' }]
          : c.name.startsWith('e2e (')
            ? [{ name: 'Set up job', conclusion: 'success' }, c.standIn ? { name: 'Run echo "Only documents changed"', conclusion: 'success' } : { name: `pnpm e2e (shard ${c.name.match(/(\d)\/\d/)?.[1] ?? 1}/2)`, conclusion: c.conclusion }]
            : [],
    }))
  }
}

const rng = (seed: number) => {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

const ref = (_repo: string, n: number) => `#${n}`

/** One generated sequence against the real queue: events, ticks, then a calm world until the queue is quiet */
async function simulate(
  seed: number,
  { steps = 70, busyMain = false, judge = null, setup, during }: { steps?: number; busyMain?: boolean; judge?: 'broken' | 'missing' | 'compare' | null; setup?: (world: World, dir: string) => void; during?: (world: World, q: any) => void } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-queue-model-'))
  const world = new World(rng(seed))
  world.githubError = GitHubError
  hoisted.world.current = world
  // The judge cannot answer for the whole sequence: every batch has to be taken for one that changes the screen
  if (judge === 'broken') world.judgeBroken = true
  if (judge === 'missing') world.judgeMissing = true
  if (judge === 'compare') world.compareNull = true
  setup?.(world, dir)
  const holder = `model-${seed}`
  let now = world.clock
  const fail = (what: string) => new Error(`seed ${seed}: ${what}`)
  const stops = new Map<string, number>()
  const seenEvents = new Set<number>()
  const judged = new Set<number>()
  const told = new Set<number>()
  let ticks = 0
  const oneTick = async () => {
    ticks++
    during?.(world, readQueue(dir))
    world.advance()
    now += 20_000
    await tick(dir, { holder, now, ref })
    // The records of the queue: what stopped for main moving, and who was told what
    const q = readQueue(dir)
    for (const e of q.events as { seq: number; text: string; notify?: boolean; kind: string }[]) {
      if (seenEvents.has(e.seq)) continue
      seenEvents.add(e.seq)
      const m = /That is no fault of ([^:]+):/.exec(e.text)
      if (m)
        for (const [, n] of m[1]!.matchAll(/#(\d+)/g)) {
          const key = `${n}@${world.prs.get(Number(n))?.head}`
          stops.set(key, (stops.get(key) ?? 0) + 1)
        }
    }
    for (const e of q.events as { seq: number; text: string; notify?: boolean; kind: string }[]) {
      if (!e.notify || !/something else landed|batched again/.test(e.text) || told.has(e.seq)) continue
      told.add(e.seq)
      // A session hears of main moving only past the cap, for a pull request that was stopped that often on its head
      const n = /#(\d+)/.exec(e.text)?.[1]
      const past = [...stops.entries()].some(([k, c]) => k.startsWith(`${n}@`) && c > MOVED_CAP)
      if (!past) throw fail(`a session was told about main moving before #${n} had been stopped ${MOVED_CAP + 1} times: ${e.text}`)
    }
    // A batch is never dropped for what the run lacks while the run is still going: all of its checks may have reported a
    // moment before GitHub marks it completed, and a batch dropped then loses a full run and tells its session it failed
    for (const e of q.events as { seq: number; text: string }[]) {
      const m = /^Batch (queue\/batch-\d+): (its run passed|its run passed without)/.exec(e.text)
      if (!m || judged.has(e.seq)) continue
      judged.add(e.seq)
      const latest = world.runs.filter((r) => r.branch === m[1]).sort((x, y) => y.attempt - x.attempt)[0]
      if (latest && latest.status !== 'completed') throw fail(`${m[1]} was dropped for what its run lacks while the run was ${latest.status}: ${e.text.slice(0, 120)}`)
    }
    // Stopped by main moving more often than the cap allows for: MOVED_CAP times batched again, then once more in a batch with
    // others and once alone, and a session hears of it
    for (const [key, c] of stops) if (c > MOVED_CAP + 2) throw fail(`${key} was stopped ${c} times by main moving, more than the cap of ${MOVED_CAP} (and the two stops after it) allows`)
    for (const it of q.items as { pr: number; head: string; alone?: { head: string; text: string } }[]) {
      if (it.alone && /something else landed/.test(it.alone.text) && (stops.get(`${it.pr}@${it.head}`) ?? 0) <= MOVED_CAP) throw fail(`#${it.pr} was marked alone for main moving after ${stops.get(`${it.pr}@${it.head}`)} stop(s), within the cap`)
    }
    if (world.violations.length) throw fail(world.violations[0]!)
  }
  try {
    for (let i = 0; i < steps; i++) {
      // A busy main: something else lands on it every tick for the whole sequence, and nobody pushes (a new head starts the count over)
      if (busyMain && i === 2) world.storm = steps
      const r = world.rand()
      const n = 1 + Math.floor(world.rand() * 5)
      if (busyMain && r >= 0.16 && r < 0.5) {
        await oneTick()
        continue
      }
      if (r < 0.16) {
        const p = world.prs.get(n)
        if (!p) world.open(n)
        if (!p || p.state === 'OPEN') {
          updateQueue(dir, (q: unknown) => enqueue(q, { repo: R, pr: n, owner: 'me', at: world.iso() }, ref))
          // Queued again, as its session is told to do: it is looked at afresh, and what was counted for it starts over
          for (const k of [...stops.keys()]) if (k.startsWith(`${n}@`)) stops.delete(k)
        }
      } else if (r < 0.24) {
        if (world.prs.get(n)?.state === 'OPEN') world.push(n)
      } else if (r < 0.32) world.externalMerge()
      else if (r < 0.36) updateQueue(dir, (q: unknown) => dequeue(q, { repo: R, pr: n, at: world.iso() }, ref))
      else if (r < 0.4) {
        // A batch made by an older board has no tier
        updateQueue(dir, (q: unknown) => {
          const b = activeBatch(q)
          if (b && b.state === 'ci') {
            delete b.tier
            const branch = world.branches.get(b.branch)
            if (branch) branch.olderBoard = true
          }
        })
      } else if (r < 0.43 && !judge) world.judgeMissing = !world.judgeMissing
      else if (r < 0.46 && !judge) world.compareNull = !world.compareNull
      else if (r < 0.48 && !judge) world.judgeBroken = !world.judgeBroken
      else if (r < 0.52 && world.storm === 0) world.storm = 12 + Math.floor(world.rand() * 12)
      await oneTick()
    }
    // Calm: no new events, CI as it should be. Every pull request lands or needs a session, and the queue is quiet
    world.calm = true
    world.storm = 0
    if (!judge) {
      world.judgeMissing = false
      world.judgeBroken = false
      world.compareNull = false
    }
    for (const r of world.runs) if (r.status === 'in_progress') r.plan = 'green'
    let quiet = 0
    for (let i = 0; i < 300 && quiet < 3; i++) {
      await oneTick()
      const q = readQueue(dir)
      // An item whose title is too long is work too: the board app keeps polling it (queueBusy), for the title to be shortened
      const working = q.items.some((it: { state: string; reason?: { kind: string } | null }) => ['ci', 'waiting'].includes(it.state) || (it.state === 'attention' && it.reason?.kind === 'subject')) || activeBatch(q)
      quiet = working ? 0 : quiet + 1
    }
    const q = readQueue(dir)
    if (activeBatch(q) || q.items.some((it: { state: string }) => ['ci', 'waiting'].includes(it.state))) throw fail('the queue was still working 300 ticks after the world went calm')
    for (const it of q.items as { pr: number; state: string }[]) if (!['merged', 'attention'].includes(it.state)) throw fail(`#${it.pr} is ${it.state} and nothing is left to do for it`)
    return { world, q, stops, ticks }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the merge queue against a model of GitHub: queueing, pushes, main moving, CI taking time, failing and lying, in any order (#1538, #1548)', { timeout: 600_000 * SLOW }, () => {
  it('holds the invariants for generated sequences', async () => {
    const totals = { landed: 0, landedHeavy: 0, dispatchedFull: 0, dispatchedQuick: 0, stops: 0, stoppedPastCap: 0 }
    for (let seed = 1; seed <= 40; seed++) {
      const r = await simulate(seed)
      totals.landed += r.world.landings.length
      totals.landedHeavy += r.world.heavyLandings
      for (const d of r.world.dispatches) totals[d.inputs?.tier === 'full' ? 'dispatchedFull' : 'dispatchedQuick']++
      totals.stops += [...r.stops.values()].reduce((x, y) => x + y, 0)
      totals.stoppedPastCap += [...r.stops.values()].filter((c) => c > MOVED_CAP).length
    }
    // The sequences reach what the invariants are about: landings, both kinds of batch, and main moving under batches
    expect(totals.landed).toBeGreaterThan(40)
    // Batches that change the screen land too, though every full run also reports the stand-in skipped under its template name
    expect(totals.landedHeavy).toBeGreaterThan(10)
    expect(totals.dispatchedFull).toBeGreaterThan(20)
    expect(totals.dispatchedQuick).toBeGreaterThan(20)
    expect(totals.stops).toBeGreaterThan(20)
  })

  // A judge that cannot answer (it is missing, it crashes, GitHub lists too many files) is no reason to land after the fast tier:
  // every batch runs the heavy jobs, whatever it holds
  it.each([
    ['broken', 301],
    ['missing', 311],
    ['compare', 321],
  ] as const)('runs the heavy jobs for every batch when the judge cannot answer: %s', async (judge, first) => {
    let batches = 0
    for (let seed = first; seed < first + 6; seed++) {
      const r = await simulate(seed, { judge })
      for (const d of r.world.dispatches) {
        batches++
        expect(d.inputs, `seed ${seed}`).toEqual({ tier: 'full', everything: 'false' })
      }
    }
    expect(batches).toBeGreaterThan(5)
  })

  // queue/batch-220 (#1562): its run's jobs, as GitHub listed them (every shard passed, the Chromium stand-in skipped under its
  // unexpanded matrix name), reported by the batch's full run. The batch changes the screen, so it needs the heavy jobs: it lands
  it('lands a batch that changes the screen from the job list of run 40247598237', async () => {
    const r = await simulate(1, {
      steps: 0,
      setup: (world, dir) => {
        // The recorded run predates the macOS job (#1704): its job list gains the check the quick tier now asks for
        world.jobList = { ...RUN_220, jobs: [...RUN_220.jobs, { ...RUN_220.jobs.find((j: { name: string }) => j.name === 'verify')!, name: 'macos tests' }] }
        world.required = RUN_220.jobs.map((j) => j.name).filter((n) => !n.includes('${{'))
        world.shards = world.required.filter((n) => /^e2e \((webkit|chromium) \d+\/\d+\)$/.test(n))
        world.open(1)
        world.pr(1).file = 'packages/ui/src/App.tsx'
        updateQueue(dir, (q: unknown) => enqueue(q, { repo: R, pr: 1, owner: 'me', at: world.iso() }, ref))
      },
    })
    expect(r.world.shards).toHaveLength(10)
    expect(r.world.dispatches.map((d) => d.inputs)).toEqual([{ tier: 'full', everything: 'false' }])
    expect(r.world.violations).toEqual([])
    expect((r.q.events as { text: string }[]).filter((e) => /not every heavy job/.test(e.text))).toEqual([])
    expect(r.world.landings.map((l) => l.n)).toEqual([1])
  })

  // #1593: the title is lengthened while the batch's CI runs, so landing stops it, and then shortened. It must be neither `alone` nor
  // `batchless` (its session was told the queue carries on by itself) and lands in a second batch, with no new queue_merge
  it('lands a pull request whose title was lengthened during its batch and shortened again, with no new queue_merge', async () => {
    const LONG = `feat(apps): ${'x'.repeat(60)}` // 77 characters with " (#1)"
    let lengthened = false
    let shortened = false
    const seen: { state: string; alone: unknown; batchless: unknown }[] = []
    const r = await simulate(7, {
      steps: 0,
      setup: (world, dir) => {
        world.open(1)
        world.pr(1).file = 'docs/guide.md'
        updateQueue(dir, (q: unknown) => enqueue(q, { repo: R, pr: 1, owner: 'me', at: world.iso() }, ref))
      },
      during: (world, q) => {
        const it = q.items.find((i: { pr: number }) => i.pr === 1)
        if (!lengthened && world.dispatches.length === 1) {
          world.titles.set(1, LONG)
          lengthened = true
        } else if (lengthened && !shortened && it?.state === 'attention' && it.reason?.kind === 'subject') {
          seen.push({ state: it.state, alone: it.alone ?? null, batchless: it.batchless ?? null })
          world.titles.delete(1)
          shortened = true
        }
      },
    })
    // It reached attention `subject` with nothing marking it, and landed from a second batch
    expect(seen).toEqual([{ state: 'attention', alone: null, batchless: null }])
    expect(r.world.dispatches).toHaveLength(2)
    expect(r.world.landings.map((l) => l.n)).toEqual([1])
    expect(r.world.violations).toEqual([])
    expect((r.q.events as { text: string }[]).some((e) => /squash subject is over 72/.test(e.text))).toBe(true)
    expect(r.q.items.find((i: { pr: number }) => i.pr === 1)).toMatchObject({ state: 'merged' })
  })

  // The cap: with something landing on main every tick, no batch can land, and each pull request is stopped again and again.
  // It is built again MOVED_CAP times, then once with others and once alone, and then its session is told, once; nothing loops
  it('stops building a pull request again after the cap when main never stops moving, and then tells its session once', async () => {
    let told = 0
    let past = 0
    for (let seed = 101; seed <= 110; seed++) {
      const r = await simulate(seed, { steps: 90, busyMain: true })
      told += (r.q.events as { notify?: boolean; text: string }[]).filter((e) => e.notify && /something else landed/.test(e.text)).length
      past += [...r.stops.values()].filter((c) => c > MOVED_CAP).length
      for (const it of r.q.items as { pr: number; state: string; reason?: { text: string } }[]) {
        if (it.state === 'attention' && /something else landed/.test(it.reason?.text ?? '')) expect(told).toBeGreaterThan(0)
      }
    }
    // Some pull request was stopped past the cap, was given up on, and its session heard of it
    expect(past).toBeGreaterThan(0)
    expect(told).toBeGreaterThan(0)
  })

  // The checks on every landing must be able to fail: made-up runs, one for each way the first versions let a landing through
  describe('what a landing is checked against', () => {
    const quick = (extra: Partial<Run> = {}): Run => ({
      id: 1,
      sha: 's',
      branch: 'queue/batch-1',
      event: 'workflow_dispatch',
      tier: 'quick',
      attempt: 1,
      suite: 1,
      plan: 'green',
      age: 3,
      duration: 1,
      lag: 0,
      createdAt: '',
      status: 'completed',
      conclusion: 'success',
      checks: ['changes', 'full tier', 'verify', 'windows tests (vitest 1/2)', 'windows tests (vitest 2/2)', 'macos tests'].map((name, id) => ({ name, status: 'completed', conclusion: name === 'full tier' ? 'skipped' : 'success', id })),
      ...extra,
    })
    const full = (patch: (rows: CheckRow[]) => CheckRow[] = (r) => r, extra: Partial<Run> = {}): Run => {
      const base = quick({ tier: 'full' })
      const rows = base.checks.map((c) => (c.name === 'full tier' ? { ...c, conclusion: 'success' } : c))
      return { ...base, checks: patch([...rows, ...SHARDS.map((name, id) => ({ name, status: 'completed', conclusion: 'success', id: 50 + id }))]), ...extra }
    }
    it('lets a finished run that passed what the batch needs land, and nothing less', () => {
      expect(proof(quick(), { heavy: false })).toBeNull()
      expect(proof(full(), { heavy: true })).toBeNull()
      expect(proof(undefined, { heavy: false })).not.toBeNull()
      expect(proof(quick(), { heavy: true })).toContain('fast tier')
      expect(proof(quick({ status: 'in_progress', conclusion: null }), { heavy: false })).toContain('in_progress')
      expect(proof(full((r) => r, { status: 'in_progress', conclusion: null }), { heavy: true })).toContain('in_progress')
      expect(proof(full((r) => r.filter((c) => c.name !== SHARDS[1])), { heavy: true })).toContain('never reported')
      expect(proof(full((r) => r.map((c) => (c.name === SHARDS[3] ? { ...c, conclusion: 'skipped' } : c))), { heavy: true })).toContain('skipped')
      expect(proof(full((r) => r.map((c) => (c.name === SHARDS[2] ? { ...c, standIn: true } : c))), { heavy: true })).toContain('stand-in')
      expect(proof(full((r) => r.map((c) => (c.name === 'full tier' ? { ...c, conclusion: 'skipped' } : c))), { heavy: true })).toContain('full tier')
    })
  })
})

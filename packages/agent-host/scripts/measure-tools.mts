/**
 * What Centralu's MCP tools cost a session (#513): resident tokens per session kind, cache reads and
 * writes per request and which event caused a rebuild, tool selection, first-try argument validity,
 * and how much tool results add over a longer session. One repeatable run, so a change to how tools
 * are exposed (#419, #512) is decided on a before and an after. How to run it and read it, and the
 * baseline: docs/tool-cost.md.
 *
 *   pnpm measure:tools                      dry: no model calls (definitions, and the real Claude CLI's
 *                                           requests against a fake API: the prefix through attach,
 *                                           detach and a deferred load)
 *   pnpm measure:tools --live               live: real models, small by default (haiku; Codex's smallest)
 *   pnpm measure:tools --compare a.json b.json
 *
 * Options: --cli claude,codex  --reps 2  --model haiku  --codex-model <id>  --change-model <id|none>
 *          --phases resident,cache,results,selection  --prompts <file>  --out <file>  --keep
 *          --rare resident|deferred|commands (#512: how the orchestrator's rare commands are exposed)
 *          --kinds none,reader,orchestrator,manager,builder (the session kinds the resident phase starts)
 *          --preamble (#512 round 2: the orchestrator's role starts with the preamble, CC_ORCHESTRATOR_PREAMBLE)
 *          --only <id,id> (run only these prompts of the set)
 *
 * Every host it starts runs on a temporary data folder (`CC_DATA_DIR` and `--db`), never `~/.centralu`.
 * Live runs use the person's own CLI logins, as the earlier probes did.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ORCHESTRATOR_TOOLS, commandsFor, rareTierFrom, setRareTier, toolDefsFor } from '../src/sessions/orchestrator-tools.js'
import { TOOL_PROFILES, residentCost, type ResidentCost } from '../src/sessions/tool-cost.js'
import { MeasuredHost, bareName, toolCalls, toolResults, type Call, type Json } from './measure-tools/host.mjs'
import { ApiRecorder, call, say, type RecordedRequest, type Usage } from './measure-tools/recorder.mjs'
import { REBUILD_TOKENS, compare, median, printSummary, total, withLoss, type Cli, type RequestRow, type SelectionRun, type Summary } from './measure-tools/report.mjs'

const { values: opt, positionals } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    compare: { type: 'boolean', default: false },
    cli: { type: 'string', default: 'claude,codex' },
    reps: { type: 'string', default: '2' },
    model: { type: 'string', default: 'haiku' },
    'codex-model': { type: 'string' },
    'change-model': { type: 'string' },
    phases: { type: 'string' },
    prompts: { type: 'string' },
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
    rare: { type: 'string', default: 'resident' },
    preamble: { type: 'boolean', default: false },
    only: { type: 'string' },
    kinds: { type: 'string', default: 'none,reader,orchestrator,manager,builder' },
  },
  allowPositionals: true,
})

if (opt.compare) {
  const [a, b] = positionals
  if (!a || !b) throw new Error('--compare takes two JSON files: before and after')
  const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { summary: Summary; meta: Json }
  const before = read(a)
  const after = read(b)
  console.log(`before: ${a} (${before.meta.mode}, ${before.meta.commit}, ${JSON.stringify(before.meta.versions)})`)
  console.log(`after:  ${b} (${after.meta.mode}, ${after.meta.commit}, ${JSON.stringify(after.meta.versions)})`)
  compare(before.summary, after.summary)
  process.exit(0)
}

const LIVE = opt.live
const REPS = Math.max(1, Number(opt.reps))
const CLIS = opt.cli.split(',').map((s) => s.trim()) as Cli[]
const PHASES = new Set((opt.phases ?? (LIVE ? 'resident,cache,results,selection' : 'resident,cache,results')).split(','))
const PROMPTS_FILE = opt.prompts ?? fileURLToPath(new URL('./measure-tools/prompts.json', import.meta.url))
const PROMPTS = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8')) as {
  seed: string
  /**
   * The permission preset of every selection session, when not the default `normal`. #512's prompts ask for
   * things to be done, and under `normal` the person's own bypass applies, so `safe` keeps the agent's own
   * tools (and the person's skills) to a declined card while Centralu's run under every preset
   */
  preset?: 'safe' | 'normal' | 'auto'
  /** fresh: the orchestrator's prompt runs in a new orchestrator every repetition, with nothing it made before left over */
  selection: { id: string; profile: 'reader' | 'orchestrator'; prompt: string; expect: string[]; fresh?: boolean }[]
}
/*
 * The arm (#512): the host this run starts exposes the orchestrator's rare commands this way (CC_RARE_COMMANDS),
 * and this process reads the definitions the same way, for the resident table and for checking arguments
 */
const RARE = rareTierFrom(opt.rare)
if (RARE !== opt.rare) throw new Error(`--rare takes resident, deferred or commands, not ${opt.rare}`)
setRareTier(RARE)
if (opt.only) {
  const only = opt.only.split(',').map((x) => x.trim())
  PROMPTS.selection = PROMPTS.selection.filter((p) => only.includes(p.id))
}
const KINDS = opt.kinds.split(',').map((s) => s.trim())
const FIXTURE = fileURLToPath(new URL('../src/apps/external/test-fixtures/app.mjs', import.meta.url))
const OK = 'Reply with the single word OK.'
const log = (...a: unknown[]) => console.error('[measure]', ...a)

function version(cmd: string): string | null {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

const versions = { claude: version('claude'), codex: version('codex'), node: process.version }
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
})()

const definitions = Object.fromEntries(
  (['claude', 'codex'] as const).map((cli) => [cli, Object.fromEntries(TOOL_PROFILES.map((p) => [p, residentCost(p, cli)]))]),
) as Record<Cli, Record<string, ResidentCost>>
const summary: Summary = { definitions }
const raw: { claudeRequests: RecordedRequest[]; approvals: unknown[]; models: Json } = { claudeRequests: [], approvals: [], models: {} }

/** The scratch world of one host: two trusted git projects, the second sharing a counter app */
async function world(cli: Cli, recorder: ApiRecorder | null) {
  const root = mkdtempSync(join(tmpdir(), `cc-measure-tools-${cli}-`))
  const data = join(root, 'data')
  mkdirSync(data)
  const here = join(root, 'website')
  const there = join(root, 'ops')
  for (const d of [here, there]) {
    mkdirSync(d)
    writeFileSync(join(d, 'README.md'), `# ${basename(d)}\n\nA scratch project for the tool measurement.\n`)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d })
    execFileSync('git', ['-c', 'user.name=measure', '-c', 'user.email=measure@localhost', 'add', '.'], { cwd: d })
    execFileSync('git', ['-c', 'user.name=measure', '-c', 'user.email=measure@localhost', 'commit', '-q', '-m', 'init'], { cwd: d })
  }
  const appDir = join(there, '.centralu', 'apps', 'counter')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    join(appDir, 'centralu.app.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'counter',
      name: 'Counter',
      version: '0.1.0',
      description: 'Keeps one shared number for the team: peek reads it, poke sets it.',
      server: { command: process.execPath, args: [FIXTURE, '--mode', 'attach'] },
    }),
  )
  const env: Record<string, string> = { CC_RARE_COMMANDS: RARE, ...(opt.preamble ? { CC_ORCHESTRATOR_PREAMBLE: '1' } : {}) }
  if (recorder) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${recorder.port}`
    /*
     * Claude Code turns tool search off when the API is not first-party, which a local base URL is
     * (measured, CLI 2.1.289: every MCP tool loaded, no ToolSearch). On is its default against the real API.
     */
    env.ENABLE_TOOL_SEARCH = 'true'
  }
  // The account's claude.ai connectors come up at different moments run to run and moved the baseline (#320's probe)
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'
  /*
   * Claude Code's auto memory off (#512): asked to keep a procedure, a trial's orchestrator wrote it to
   * ~/.claude/projects/<the scratch folder>/memory, and every later orchestrator of the run starts in the same
   * folder and would read it, so one repetition answered the next
   */
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  // Dry: no credential leaves for the fake API, and none is needed
  if (recorder && !LIVE) env.ANTHROPIC_API_KEY = 'sk-ant-measure-dry-run'
  const host = new MeasuredHost(data, env)
  await host.start()
  const pHere = await host.rpc('projects.add', { path: here })
  const pThere = await host.rpc('projects.add', { path: there })
  for (const p of [pHere, pThere]) await host.rpc('projects.setTrusted', { projectId: p.id, trusted: true })
  await host.rpc('apps.setShared', { appId: 'counter', projectId: pThere.id, shared: true })
  return { root, here, there, host, pHere, pThere }
}

type World = Awaited<ReturnType<typeof world>>

/** The model a measured session runs on */
async function modelsFor(cli: Cli, host: MeasuredHost): Promise<{ model: string | undefined; change: string | undefined }> {
  if (cli === 'claude') return { model: opt.model, change: opt['change-model'] === 'none' ? undefined : (opt['change-model'] ?? 'sonnet') }
  const list = ((await host.rpc('agents.models', { tool: 'codex' }).catch(() => ({ models: [] }))).models ?? []) as { id: string }[]
  log(`codex models: ${list.map((m) => m.id).join(', ') || '(none listed)'}`)
  // The account's default unless told otherwise: Codex's model names do not say which is small
  const model = opt['codex-model']
  const change = opt['change-model'] === 'none' ? undefined : (opt['change-model'] ?? list.find((m) => m.id !== (model ?? list[0]?.id))?.id)
  return { model, change }
}

/** One measured CLI: its host, its recorder (Claude), and the per-request rows of what it drives */
class Driver {
  private lastCodex = new Map<string, Usage>()
  model: string | undefined
  changeModel: string | undefined

  constructor(
    readonly cli: Cli,
    readonly w: World,
    readonly recorder: ApiRecorder | null,
  ) {}

  get host() {
    return this.w.host
  }

  async session(kind: 'none' | 'reader' | 'orchestrator' | 'manager' | 'builder'): Promise<Json> {
    const { host, pHere, pThere, here } = this.w
    let s: Json
    if (kind === 'orchestrator') {
      await host.rpc('orchestrator.configure', { tool: this.cli })
      s = await host.rpc('orchestrator.get', {})
    } else if (kind === 'manager') {
      s = await host.rpc('worktrees.createManager', { projectId: pHere.id, baseBranch: 'main' })
    } else if (kind === 'builder') {
      s = await host.rpc('apps.createBuilder', { appId: 'counter', projectId: pThere.id, tool: this.cli })
    } else {
      s = await host.rpc('agents.createSession', { projectId: pHere.id, cwd: here, tool: this.cli, ...(this.model ? { model: this.model } : {}), permissionPreset: 'normal' })
    }
    if (s.tool !== this.cli) s = await host.rpc('agents.switchTool', { sessionId: s.id, tool: this.cli })
    /*
     * A seat created by its own RPC takes no model, so it is set before the first turn. On Codex that once broke the
     * seat (#524: the restart resumed a thread with nothing written yet); the first baseline measured those seats on
     * their default model instead.
     */
    if (this.model && s.model !== this.model) await host.rpc('agents.updateSettings', { sessionId: s.id, model: this.model })
    return s
  }

  async remove(sessionId: string): Promise<boolean> {
    return this.host
      .rpc('agents.deleteSession', { sessionId })
      .then(() => true)
      .catch(() => false)
  }

  /** One turn, and its requests as rows: the recorder's for Claude, the usage the host reports for Codex */
  async turn(key: string, sessionId: string, step: string, event: string, text: string, opts: { fake?: Parameters<ApiRecorder['queue']> } = {}) {
    const since = this.recorder?.requests.length ?? 0
    this.recorder?.mark(key, step, event)
    if (this.recorder && !LIVE) this.recorder.queue(...(opts.fake ?? []))
    const events = await this.host.turn(sessionId, text)
    // A Codex thread restarts through resume when a turn that attached or detached an app ends (apps.md §9.4)
    if (this.cli === 'codex') await new Promise((r) => setTimeout(r, 3000))
    let rows: RequestRow[]
    let calls: Call[]
    if (this.recorder) {
      await this.recorder.settle()
      /*
       * The CLI's own errands (a title) are left out; a request that failed has no usage. So are other sessions':
       * every Claude session of the host goes through the recorder, and a turn can start one (#512: create_app's
       * builder, handed work by send_to_session, made its requests inside the orchestrator's window)
       */
      const window = this.recorder.requests.slice(since).filter((r) => r.main)
      const listed = ((await this.host.rpc('sessions.list', {}).catch(() => [])) as unknown as Json[]).find((x) => x.id === sessionId)
      const own = typeof listed?.externalId === 'string' ? listed.externalId : (window[0]?.cliSession ?? null)
      const mine = own && window.some((r) => r.cliSession === own) ? window.filter((r) => r.cliSession === own) : window
      rows = mine.map(rowOf)
      const results = toolResults(events)
      calls = mine.flatMap((r) => r.toolUses).map((t) => ({ name: t.name, args: t.input, callId: t.id, ok: results.get(t.id) ?? null }))
    } else {
      calls = toolCalls(events)
      rows = []
      let first = true
      for (const e of events.filter((x) => x.type === 'usage_update')) {
        const t = e.tokens as { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number }
        // Codex reports the thread's running totals: one request is the difference from the last report
        const now: Usage = { input: t.inputTokens, cacheRead: t.cacheReadTokens, cacheWrite: t.cacheCreationTokens, output: t.outputTokens }
        const prev = this.lastCodex.get(key)
        this.lastCodex.set(key, now)
        const d = prev ? { input: now.input - prev.input, cacheRead: now.cacheRead - prev.cacheRead, cacheWrite: now.cacheWrite - prev.cacheWrite, output: now.output - prev.output } : now
        const usage = Object.values(d).some((v) => v < 0) ? now : d
        // The same totals reported again (a resumed thread repeats its last report) are not a request
        if (prev && Object.values(d).every((v) => v === 0)) continue
        rows.push({ step, event: first ? event : 'same turn', usage, ...(first ? { toolCalls: calls.map((c) => bareName(c.name)) } : {}) })
        first = false
      }
    }
    return { events, rows, calls }
  }
}

function rowOf(r: RecordedRequest): RequestRow {
  return {
    step: r.step,
    event: r.event,
    usage: r.usage,
    tools: r.tools,
    deferredEntries: r.deferredEntries,
    deferredEntryNames: r.deferredEntryNames,
    system: r.system,
    history: r.history,
    loadedCentralu: r.centraluLoaded,
    appLoaded: r.appLoaded,
    deferred: r.deferredNames.filter((n) => n.startsWith('mcp__centralu__') || n.startsWith('mcp__app-')),
    resultChars: r.resultChars,
    toolCalls: r.toolUses.map((t) => t.name),
    chars: { tools: r.toolsChars, centralu: r.centraluChars, system: r.systemChars },
    ...(r.counted ? { counted: r.counted } : {}),
  }
}

/** Resident context: a fresh session of each kind, one short turn, its first request */
async function residentPhase(d: Driver): Promise<void> {
  const kinds = (['none', 'reader', 'orchestrator', 'manager', 'builder'] as const).filter((k) => KINDS.includes(k))
  const out: NonNullable<Summary['resident']>[Cli] = {}
  const walk: RequestRow[] = []
  for (const kind of kinds) {
    const runs: number[] = []
    const ours: number[] = []
    let chars: RequestRow['chars']
    for (let rep = 0; rep < REPS; rep++) {
      if (kind === 'none') await d.host.rpc('prefs.set', { patch: { sessionTools: false } })
      const s = await d.session(kind)
      const { rows } = await d.turn(`resident:${kind}:${rep}`, s.id, kind, 'first', OK)
      if (kind === 'none') await d.host.rpc('prefs.set', { patch: { sessionTools: true } })
      const first = rows[0]
      if (first) {
        runs.push(total(first.usage))
        if (first.counted) ours.push(first.counted.sent - first.counted.withoutOurs)
        chars = first.chars
        if (rep === 0) walk.push(first)
      }
      log(`${d.cli} resident ${kind} #${rep + 1}: ${first ? total(first.usage) : 'no request'}`)
      if (!(await d.remove(s.id))) {
        log(`${d.cli} could not delete the ${kind} session; one repetition only`)
        break
      }
    }
    out[kind] = { runs, median: median(runs), delta: null, ...(ours.length ? { ours: median(ours) } : {}), centraluChars: chars?.centralu, toolsChars: chars?.tools, systemChars: chars?.system }
  }
  const none = out.none?.median
  for (const r of Object.values(out)) r.delta = LIVE && none ? r.median - none : null
  if (LIVE) (summary.resident ??= {})[d.cli] = out
  else (summary.prefixWalk ??= {})['first request per session kind'] = walk
}

/** The scripted session for the cache: every event the issue names that a driver can cause */
async function cachePhase(d: Driver): Promise<void> {
  const reps: RequestRow[][] = []
  const ops = d.w.pThere.name as string
  const app = `${ops}/counter`
  for (let rep = 0; rep < (LIVE ? REPS : 1); rep++) {
    const key = `cache:${rep}`
    const rows: RequestRow[] = []
    d.host.approvals = (e) => (e.detail?.kind === 'project_access' ? 'always' : 'deny')
    const s = await d.session('reader')
    const step = async (name: string, event: string, text: string, fake?: Parameters<ApiRecorder['queue']>) => {
      const r = await d.turn(key, s.id, name, event, text, { fake })
      rows.push(...r.rows)
      log(`${d.cli} cache #${rep + 1} ${name}: ${r.rows.map((x) => total(x.usage)).join(', ') || 'no request'}`)
    }
    await step('first', 'first', OK)
    await step('steady', 'next turn', OK)
    await step('deferred load', 'next turn', 'Look up the Centralu guide with app_guide and tell me in one sentence what it covers.', [
      call('ToolSearch', { query: 'select:mcp__centralu__app_guide', max_results: 1 }),
      call('mcp__centralu__app_guide', {}),
      say('It covers Centralu.'),
    ])
    await step('attach', 'next turn', `Use find_apps to find the counter app from my other project, then attach it with attach_app. Do not call its tools yet; just say it is attached.`, [
      call('ToolSearch', { query: 'select:mcp__centralu__find_apps,mcp__centralu__attach_app', max_results: 2 }),
      call('mcp__centralu__find_apps', {}),
      call('mcp__centralu__attach_app', { app }),
      say('Attached.'),
    ])
    await step('after attach', 'app attached', "Call the counter app's peek tool and tell me what it says.", [
      call('ToolSearch', { query: 'select:mcp__app-counter__peek', max_results: 1 }),
      call('mcp__app-counter__peek', {}),
      say('It says peeked.'),
    ])
    await step('detach', 'next turn', 'Detach the counter app with detach_app.', [
      call('ToolSearch', { query: 'select:mcp__centralu__detach_app', max_results: 1 }),
      call('mcp__centralu__detach_app', { app }),
      say('Detached.'),
    ])
    await step('after detach', 'app detached', OK)
    await d.host.rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })
    await step('preset change', 'preset changed (normal → auto)', OK)
    await d.host.rpc('agents.restartSession', { sessionId: s.id })
    await step('restart', 'session restarted', OK)
    await d.host.stop()
    await d.host.start()
    await step('woken', 'woken (host restarted, session resumed)', OK)
    if (d.changeModel) {
      await d.host.rpc('agents.updateSettings', { sessionId: s.id, model: d.changeModel })
      await step('model change', `model changed (→ ${d.changeModel})`, OK)
      if (d.model) await d.host.rpc('agents.updateSettings', { sessionId: s.id, model: d.model })
    }
    reps.push(rows)
    await d.remove(s.id)
  }
  if (LIVE) (summary.cache ??= {})[d.cli] = reps.map((rows) => withLoss(rows))
  else (summary.prefixWalk ??= {})['scripted session (cache)'] = reps[0] ?? []
}

/** Tool results over a longer session: what each result adds to every later request */
async function resultsPhase(d: Driver, seed: Json): Promise<void> {
  d.host.approvals = () => 'deny'
  const s = await d.session('reader')
  const key = 'results'
  const rows: RequestRow[] = []
  const steps: [string, string, Parameters<ApiRecorder['queue']>][] = [
    ['first', OK, []],
    ['list sessions', 'List the other sessions in this project with read_session. One line each.', [call('mcp__centralu__read_session', {}), say('Listed.')]],
    ['read a session', `Read the conversation of the session "${seed.name}" with read_session and summarise it in one line.`, [call('mcp__centralu__read_session', { sessionId: seed.id }), say('Read.')]],
    ['recall', "Search this project's past conversations with recall for backup, and tell me what you found in one line.", [call('mcp__centralu__recall', { query: 'backup' }), say('Found.')]],
    ['recall again', 'Search with recall for pg_dump too, one line.', [call('mcp__centralu__recall', { query: 'pg_dump' }), say('Found.')]],
    ['guide', 'Read the Centralu guide with app_guide (no topic) and name its sections in one line.', [
      call('ToolSearch', { query: 'select:mcp__centralu__app_guide', max_results: 1 }),
      call('mcp__centralu__app_guide', {}),
      say('Sections.'),
    ]],
    ['last', OK, []],
  ]
  for (const [name, text, fake] of steps) {
    const r = await d.turn(key, s.id, name, name === 'first' ? 'first' : 'next turn', text, { fake })
    rows.push(...r.rows)
  }
  await d.remove(s.id)
  let prev: Usage | null = null
  const out = rows.map((r) => {
    const added = prev && r.usage ? total(r.usage) - total(prev) - prev.output : null
    if (r.usage) prev = r.usage
    return { ...r, total: total(r.usage), added }
  })
  if (LIVE) (summary.results ??= {})[d.cli] = out
  else (summary.prefixWalk ??= {})['tool results (characters)'] = out
}

/** The calls that look for a tool rather than use one: Claude's tool search and the commands tier's list and help (#512) */
const DISCOVERY = new Set(['ToolSearch', 'centralu_commands', 'centralu_help'])

type Resolved = Call & { bare: string; viaRun: boolean; runOutcome?: string }

/**
 * Each call as the command it stands for (#512): a centralu_run as its command and that command's arguments,
 * every other call as itself. The host's `[commands]` lines say which command a run ran and whether its
 * arguments passed. A Codex run arrives named as its command already (normalize.ts reads the run's arguments
 * off the item), and the host's events carry no arguments, so a command of the arm's tier (`runOnly`: the seat
 * cannot call it by name) is a run, and the host's line is all there is to say how it went.
 */
function resolveCalls(calls: Call[], runs: { command: string; outcome: string }[], runOnly: readonly string[]): Resolved[] {
  let next = 0
  const logged = (command: string | null) => {
    const at = command === null ? next : runs.findIndex((r, i) => i >= next && r.command === command)
    if (at < 0 || at >= runs.length) return undefined
    next = at + 1
    return runs[at]
  }
  return calls.map((c) => {
    const bare = bareName(c.name)
    const a = typeof c.args === 'object' && c.args !== null ? (c.args as Json) : {}
    const named = runOnly.includes(bare)
    const run = bare === 'centralu_run' || named || (typeof a.command === 'string' && a.command === bare && 'args' in a)
    if (!run) return { ...c, bare, viaRun: false }
    const command = typeof a.command === 'string' ? a.command : named ? bare : null
    const line = logged(command)
    if (named && a.command === undefined) return { ...c, bare, viaRun: true, args: undefined, runOutcome: line?.outcome }
    let inner: unknown = a.args ?? {}
    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner)
      } catch {
        /* kept as written: the host answered it with the schema */
      }
    }
    return { ...c, bare: command ?? line?.command ?? 'centralu_run', viaRun: true, args: command !== null ? inner : undefined, runOutcome: line?.outcome }
  })
}

/**
 * Leaves the world as a fresh orchestrator prompt found it (#512): every session but the seed, every app but the
 * counter, and every proposal waiting on the person go. What one run made (an app id, a skill name) would
 * otherwise turn the next run's first call into a refusal.
 */
async function tidy(d: Driver, keep: string[]): Promise<void> {
  const host = d.host
  /*
   * Stopped before they are deleted: a builder create_app stood up and the orchestrator handed work to runs on the
   * CLI's default model under the person's own settings, and in the first runs one went on working after its turn
   */
  const others = ((await host.rpc('sessions.list', {}).catch(() => [])) as unknown as Json[]).filter((s) => !keep.includes(s.id))
  for (const s of others) await host.rpc('agents.interrupt', { sessionId: s.id }).catch(() => {})
  for (const s of others) await d.remove(s.id)
  for (const a of (await host.rpc('apps.list', {}).catch(() => [])) as unknown as Json[]) {
    if (a.appId === 'counter') continue
    // A project's app is part of its repository, which the host does not delete: the scratch project's folder goes instead
    if (a.projectId) {
      const project = [d.w.pHere, d.w.pThere].find((p) => p.id === a.projectId)
      if (project) rmSync(join(project.path as string, '.centralu', 'apps', String(a.appId)), { recursive: true, force: true })
      continue
    }
    await host.rpc('apps.remove', { appId: a.appId, projectId: null }).catch((e) => log(`could not remove app ${a.appId}: ${e}`))
  }
  for (const p of ((await host.rpc('agents.skillProposals', {}).catch(() => ({ proposals: [] }))).proposals ?? []) as Json[]) {
    await host.rpc('agents.resolveSkillProposal', { name: p.name, approve: false }).catch(() => {})
  }
  for (const p of ((await host.rpc('agents.mcpProposals', {}).catch(() => ({ proposals: [] }))).proposals ?? []) as Json[]) {
    await host.rpc('agents.resolveMcpProposal', { name: p.name, approve: false }).catch(() => {})
  }
}

/** Tool selection on the fixed prompts: right tool, none, wrong; steps; first-try argument validity */
async function selectionPhase(d: Driver, seed: Json): Promise<void> {
  const out: NonNullable<Summary['selection']>[Cli] = {}
  const fill = (t: string) => t.replaceAll('{project}', d.w.pHere.name).replaceAll('{other}', d.w.pThere.name).replaceAll('{seed}', seed.name)
  // Nothing a selection turn asks for is carried out beyond the tool call itself: consent and other approvals are declined
  d.host.approvals = () => 'deny'
  let orchestrator: Json | null = null
  for (const p of PROMPTS.selection) {
    // Every name the seat can reach, whichever arm: a command behind centralu_run is still the seat's
    const defs = toolDefsFor(p.profile, 'resident')
    const ours = new Set([...defs, ...toolDefsFor(p.profile)].map((t) => t.name))
    const isOurs = (name: string) => name.startsWith('mcp__centralu__') || name.startsWith('mcp__app-') || ours.has(name)
    const runs: SelectionRun[] = []
    for (let rep = 0; rep < REPS; rep++) {
      let s: Json
      if (p.profile === 'orchestrator' && p.fresh && orchestrator) {
        await d.remove(orchestrator.id)
        orchestrator = null
      }
      if (p.profile === 'orchestrator') s = orchestrator ??= await d.session('orchestrator')
      else s = await d.session('reader')
      if (PROMPTS.preset && s.permissionPreset !== PROMPTS.preset) {
        await d.host.rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: PROMPTS.preset })
        s.permissionPreset = PROMPTS.preset
      }
      const mark = d.host.commandRuns.length
      const { calls: made, rows } = await d.turn(`select:${p.id}:${rep}`, s.id, p.id, 'selection', fill(p.prompt))
      const calls = resolveCalls(made, d.host.commandRuns.slice(mark).filter((r) => r.sessionId === s.id), commandsFor(p.profile))
      const mine = calls.filter((c) => isOurs(c.name) && !DISCOVERY.has(c.bare))
      const firstExpected = calls.findIndex((c) => p.expect.includes(c.bare))
      const first = firstExpected >= 0 ? calls[firstExpected]! : null
      const schema = first ? (defs.find((t) => t.name === first.bare)?.schema ?? ORCHESTRATOR_TOOLS.find((t) => t.name === first.bare)?.schema) : undefined
      const verdict: SelectionRun['verdict'] =
        p.expect.length === 0 ? (mine.length ? 'wrong' : 'right') : !mine.length ? 'none' : p.expect.includes(mine[0]!.bare) ? 'right' : 'wrong'
      const lossy = withLoss(rows)
      runs.push({
        called: calls.filter((c) => isOurs(c.name) || DISCOVERY.has(c.bare)).map((c) => (c.viaRun ? `run:${c.bare}` : c.bare)),
        calls: calls.length,
        verdict,
        steps: first ? firstExpected + 1 : null,
        /*
         * Against the schema as the model is shown it (strict: a key it does not list is wrong), the check
         * centralu_run makes on the host. Claude's arguments are read from the API (recorder). Codex (codex-cli
         * 0.160.0) calls MCP tools from inside its `exec` tool, as JavaScript, and the host's event for such a
         * call carries no arguments, so for Codex only a centralu_run's own outcome (the host's line) says;
         * `firstOk` covers both
         */
        firstArgsValid:
          first && first.viaRun && first.runOutcome !== undefined && first.args === undefined
            ? first.runOutcome === 'ran'
            : first && schema && first.args !== undefined && d.cli === 'claude'
              ? schema.strict().safeParse(first.args).success
              : null,
        firstArgs: first?.args ?? null,
        firstOk: first ? first.ok : null,
        reached: first !== null,
        viaRun: first ? first.viaRun : null,
        discovery: calls.filter((c) => DISCOVERY.has(c.bare)).length,
        requests: rows.length,
        tokens: rows.reduce((n, r) => n + total(r.usage), 0),
        output: rows.reduce((n, r) => n + (r.usage?.output ?? 0), 0),
        cacheWrite: rows.reduce((n, r) => n + (r.usage?.cacheWrite ?? 0), 0),
        uncached: rows.reduce((n, r) => n + (r.usage?.input ?? 0), 0),
        rebuilds: lossy.filter((r, i) => i > 0 && r.lost !== null && r.lost > REBUILD_TOKENS).length,
      })
      log(`${d.cli} select ${p.id} #${rep + 1}: ${verdict} [${calls.map((c) => (c.viaRun ? `run:${c.bare}` : c.bare)).join(' > ')}]`)
      if (p.profile !== 'orchestrator') await d.remove(s.id)
      else if (p.fresh) await tidy(d, [seed.id as string, s.id as string])
    }
    out[p.id] = { profile: p.profile, expect: p.expect, runs }
  }
  if (orchestrator && PROMPTS.selection.some((p) => p.fresh)) await d.remove(orchestrator.id)
  ;(summary.selection ??= {})[d.cli] = out
}

async function measure(cli: Cli): Promise<void> {
  if (!versions[cli]) {
    log(`${cli}: not installed, skipped`)
    return
  }
  if (cli === 'codex' && !LIVE) {
    // There is no fake API for Codex to talk to: its dry numbers are the definitions above (#513, docs/tool-cost.md)
    log('codex: dry mode measures its definitions only')
    return
  }
  const recorder = cli === 'claude' ? new ApiRecorder(LIVE ? 'forward' : 'fake') : null
  await recorder?.start()
  const w = await world(cli, recorder)
  const d = new Driver(cli, w, recorder)
  try {
    const m = await modelsFor(cli, w.host)
    d.model = m.model
    d.changeModel = m.change
    raw.models[cli] = m
    log(`${cli}: ${LIVE ? 'live' : 'dry'}, model ${d.model ?? '(default)'}, model change to ${d.changeModel ?? '(none)'}, ${REPS} repetitions`)
    // The conversation the reading tools find: one short turn in the project
    const seed = await d.session('reader')
    await w.host.rpc('sessions.rename', { sessionId: seed.id, name: 'backup-notes' })
    await d.turn('seed', seed.id, 'seed', 'first', PROMPTS.seed)
    seed.name = 'backup-notes'
    if (PHASES.has('resident')) await residentPhase(d)
    if (PHASES.has('cache')) await cachePhase(d)
    if (PHASES.has('results')) await resultsPhase(d, seed)
    if (PHASES.has('selection') && LIVE) await selectionPhase(d, seed)
    raw.approvals.push(...w.host.answered.map((a) => ({ cli, ...a })))
  } finally {
    await w.host.stop()
    await recorder?.stop()
    if (recorder) raw.claudeRequests.push(...recorder.requests)
    if (!opt.keep) rmSync(w.root, { recursive: true, force: true })
    else log(`kept ${w.root}`)
  }
}

for (const cli of CLIS) await measure(cli)

printSummary(summary)
const out = opt.out ?? join(tmpdir(), `measure-tools-${LIVE ? 'live' : 'dry'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(
  out,
  JSON.stringify({ meta: { mode: LIVE ? 'live' : 'dry', at: new Date().toISOString(), commit, versions, reps: REPS, clis: CLIS, rare: RARE, preamble: opt.preamble, prompts: PROMPTS }, summary, raw }, null, 1),
)
console.log(`\nwrote ${out}`)
process.exit(0)

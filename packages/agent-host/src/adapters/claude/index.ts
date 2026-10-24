import { tmpdir } from 'node:os'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AdapterCapabilities, NormalizedEvent, ToolDescriptor, UsageSnapshot } from '@cc/protocol'
import { dataRoot } from '../../data-dir.js'
import { whichTool } from '../../env-path.js'
import { launchFor, toolCommand, toolExecutable, type ToolLaunch } from '../../tool-launch.js'
import { installedCliVersion } from '../../cli-version.js'
import { claudeAutoCompactWindow } from './sdk-query.js'
import { ClaudeLinks, ClaudePlaceholderError, windowsStart, type ExeFs } from './exe-link.js'
import { StartGate } from './start-gate.js'
import { deleteClaudeSession, forkClaudeSession, listClaudeSessions, readClaudeHistory } from './history.js'
import { accountFingerprint, readUsageFromAny, UNSUPPORTED, type UsageQuery } from './usage.js'
import { readClaudeModels, type ModelQuery } from './models.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { raceTimeout } from '../../timing.js'
import { liveQueries, probeIds, querySessions } from './live-queries.js'
import { ClaudeSession, type ClaudeLaunch } from './session.js'
import { personsDefaultMode } from './permissions.js'
import { CLAUDE_SURFACE } from './surface.js'

export { personsDefaultMode }

const exec = promisify(execFile)

/** How long a usage probe may take to get its answer, and the wait between its asks (#726) */
const PROBE_USAGE_MS = 20_000
const PROBE_USAGE_RETRY_MS = 500
const ACCOUNT_CACHE_MS = 60_000
/**
 * How long a probe's answer, or its failure, stands before another process is started for it. The meter asks every 5
 * minutes, so the manager's minute would start one on every ask; this makes it one per ask at most, and a broken CLI
 * is not retried for 12 s each time.
 */
const PROBE_CACHE_MS = 5 * 60_000
/** The folder a probe runs in, so a sweep can tell its own leftovers from anyone else's */
const PROBE_DIR_PREFIX = 'centralu-usage-probe-'
/** A leftover older than this is no probe's still running */
const PROBE_DIR_STALE_MS = 10 * 60_000
/** How long a stopped probe's process may take to leave before its folder is removed anyway */
const PROBE_EXIT_WAIT_MS = 10_000

/**
 * The Claude Code adapter (reflects M0 validation — docs/spikes/m0-findings.md).
 * Three constraints:
 *  1. Bare tool names are not allowed in allowedTools (it would shadow canUseTool).
 *  2. `includePartialMessages: true` (streaming deltas).
 *  3. In a trusted project, `settingSources` is left unspecified, which means **the user's
 *     settings, project settings, hooks and CLAUDE.md are all loaded.** (A comment here once said
 *     the opposite. Measured: omitting it actually ran three global hooks.) This is intentional —
 *     this app does not force a workflow. Settings a person tuned for their own tool have to keep
 *     working the same way inside this app.
 *     There are two exceptions (`settingSourcesFor`): orchestrator/coordination sessions
 *     (`settingSources: []` — an instruction arriving through a file is itself a privilege-
 *     escalation channel) and untrusted projects (`['user']` — files from the repo must not be
 *     able to decide approvals, #92).
 */

/**
 * Asks the CLI **directly** whether it is logged in (`claude auth status --json`).
 *
 * `claude --version` does not check authentication at all — it succeeds with zero credentials
 * configured. So this used to treat "installed" as "logged in", and the UI always drew a Claude
 * that was not logged in as a green dot. The failure only showed up once a session was actually
 * started (#11).
 *
 * **Why this does not fire a real query with `claude -p`:**
 * `detect()` runs every time the app starts and every time the new-session dialog opens. Firing
 * even one inference call here would mean **simply launching the app gets billed.** That is not a
 * price worth paying to learn whether the person is authenticated.
 *
 * **Why this does not check for a credentials file, the way the codex adapter does:**
 * Claude Code's credentials do not live in one place — they can be the macOS keychain, an OAuth
 * token, `ANTHROPIC_API_KEY`, `apiKeyHelper`, or Bedrock/Vertex, and `CLAUDE_CONFIG_DIR` can move
 * that whole location elsewhere. If we tried to reimplement that list ourselves, our own judgment
 * would go wrong every time the CLI changed. **What the CLI knows is asked of the CLI.**
 *
 * Measured (2.1.223): this never touches the network — the answer is the same even with a dead
 * proxy configured, and it finishes in 0.2 seconds. The CLI picks up both `CLAUDE_CONFIG_DIR` and
 * `ANTHROPIC_API_KEY` on its own.
 *
 * When not logged in, it exits with **code 1**, but the JSON still comes out on stdout as usual.
 * So this also reads the stdout attached to the thrown error.
 *
 * When the answer cannot be determined, this **passes it through** (true). A wrong "not logged
 * in" would push the person to fix something that is not broken, which is worse than the status
 * quo. An old CLI without an `auth` subcommand prints an error message instead of JSON, and that
 * means "unknown", not "not logged in".
 */
async function claudeAuthStatus(bin: ToolLaunch): Promise<unknown> {
  let out = ''
  try {
    out = (await exec(bin.command, [...bin.args, 'auth', 'status', '--json'], { timeout: 5000, windowsHide: true })).stdout
  } catch (e) {
    // Even with exit code 1 (= not logged in), the JSON on stdout can still be trusted.
    out = typeof (e as { stdout?: unknown }).stdout === 'string' ? (e as { stdout: string }).stdout : ''
  }
  try {
    return JSON.parse(out) as unknown
  } catch {
    return null // If it is not JSON, this CLI does not know about auth status.
  }
}

async function claudeLoggedIn(bin: ToolLaunch): Promise<boolean> {
  const flag = (await claudeAuthStatus(bin) as { loggedIn?: unknown } | null)?.loggedIn
  return typeof flag === 'boolean' ? flag : true // When unknown, pass it through.
}

/**
 * Removes the folders usage probes left in the temp folder (#726): a probe whose process was still running on Windows
 * when its folder was removed, or a host that stopped mid-probe. Only this prefix, and only when old enough that no
 * probe is still using it.
 */
async function sweepProbeDirs(now = Date.now()): Promise<void> {
  try {
    const root = tmpdir()
    for (const name of await readdir(root)) {
      if (!name.startsWith(PROBE_DIR_PREFIX)) continue
      const path = join(root, name)
      const old = await stat(path).then((s) => now - s.mtimeMs > PROBE_DIR_STALE_MS, () => false)
      if (old) await rm(path, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    // The temp folder cannot be listed: nothing to sweep
  }
}

/** What a test can change about how the adapter starts Claude; the host passes nothing */
export type ClaudeAdapterOptions = {
  platform?: NodeJS.Platform
  /** The data folder; the Windows links live under `<data>/tools/claude` */
  dataRoot?: () => string
  /** The `claude` on PATH, as the SDK takes it */
  executable?: () => string | null
  fs?: ExeFs
  /** Time between two Claude process starts. Default: 1.5 s on Windows, none elsewhere */
  startGapMs?: number
  /** Delay before resending a turn that lost the sign-in refresh race. Default: 3 to 6 s */
  retryDelay?: () => number
  /** How long `settle` waits on Windows. Default: 1.5 s, inside the app's 3 s stop grace */
  exitGraceMs?: number
  /** How long a Stop waits for the CLI to confirm it before saying it could not stop. Default: 10 s */
  stopConfirmMs?: number
  /** How long a usage probe is asked, and the wait between two asks. Default: 20 s and 0.5 s (#726) */
  probeAskMs?: number
  probeRetryMs?: number
}

/**
 * Why 1.5 s between starts on Windows (#353): a refresh is one request to the sign-in server and a
 * file write, well under a second on a working connection, and a Claude process takes about as
 * long to start on a laptop before it looks at the sign-in. Five sessions started together are all
 * running within six seconds. macOS keeps the sign-in in the keychain and has not shown the race,
 * so nothing waits there.
 */
const WINDOWS_START_GAP_MS = 1500

/**
 * How long a Stop waits for the CLI's answer to the interrupt (`ClaudeSession.interrupt`). The CLI answers a control
 * request as it reads it, mid-turn or not, so a wait this long means the request is lost; past it the person is told
 * the turn could not be stopped, rather than left looking at a turn that never ends.
 */
const STOP_CONFIRM_MS = 10_000

export class ClaudeAdapter implements AgentAdapter {
  readonly tool = 'claude' as const
  /** `shouldQuery: false` (sdk.d.ts, measured on the Mac 2026-10-20: no turn, merged into the next message) */
  readonly quietInput = true
  readonly cacheBilling = 'anthropic' as const
  /** What Claude Code offers against what this adapter limits (#270) */
  readonly surface = CLAUDE_SURFACE
  private readonly launch: ClaudeLaunch
  private readonly probeAskMs: number
  private readonly probeRetryMs: number

  constructor(options: ClaudeAdapterOptions = {}) {
    const platform = options.platform
    const windows = windowsStart(platform)
    const executable = options.executable ?? (() => toolExecutable('claude'))
    this.launch = {
      windows,
      executable,
      links: new ClaudeLinks({ platform, root: options.dataRoot ?? dataRoot, fs: options.fs }),
      gate: new StartGate(options.startGapMs ?? (windows ? WINDOWS_START_GAP_MS : 0)),
      retryDelay: options.retryDelay ?? (() => 3000 + Math.floor(Math.random() * 3000)),
      closing: new Set(),
      exitGraceMs: options.exitGraceMs ?? 1500,
      stopConfirmMs: options.stopConfirmMs ?? STOP_CONFIRM_MS,
    }
    this.probeAskMs = options.probeAskMs ?? PROBE_USAGE_MS
    this.probeRetryMs = options.probeRetryMs ?? PROBE_USAGE_RETRY_MS
    /*
     * Host start (Windows): links an earlier run left behind go, except the one the installed Claude
     * Code would start from. Nothing runs from them any more — the processes of the previous host
     * ended with it, and removing a name never disturbs a process still running from it.
     */
    if (windows) {
      this.launch.links.keep(executable())
      this.launch.links.sweep()
    }
  }

  readonly descriptor: ToolDescriptor = {
    name: 'claude',
    label: 'Claude Code',
    mark: 'C',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  }
  /** The live queries, probes and their sessions (claude/live-queries.ts), kept here for the adapter's callers */
  static readonly liveQueries = liveQueries
  static readonly probeIds = probeIds
  static readonly querySessions = querySessions
  /** The most recently started query that is still alive. */
  static get lastQuery(): (UsageQuery & ModelQuery) | null {
    let last: (UsageQuery & ModelQuery) | null = null
    for (const q of ClaudeAdapter.liveQueries) last = q
    return last
  }
  /** The CLI reports min(model window, `autoCompactWindow`) (measured, CLI 2.1.296; #1376) */
  windowCeilingFor(autoCompactTokens: number): number {
    return claudeAutoCompactWindow(autoCompactTokens)
  }
  /** The CLI's `/compact [instructions]` takes a focus for the summary */
  compactCommand(focus: string | null): string {
    return focus ? `/compact ${focus}` : '/compact'
  }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, // M0 validation: the global bypass can be overridden per session.
    contextUsage: 'exact',
    resume: true,
    autoTitle: true,
    attachments: ['image', 'file'],
    // The SDK 0.3.231 type has no response-length knob at all (only effortLevel — measured in #54).
    // If one appears, only this needs to be filled in — the UI draws its rows from this array.
    verbosities: [],
    // The conversation file (JSONL) has no lock — while we hold a session, a `claude` in a
    // terminal can still write into the same conversation. So there is no way to stamp "everything
    // up to the moment I set it down is mine." Reading history here already means the SDK reading
    // the local file anyway, so skipping it would only save a few milliseconds regardless.
    exclusiveWriter: false,
    // background_tasks_changed and the task messages (#290, ClaudeBackgroundTracker)
    backgroundTasks: true,
    toolDeferral: true,
    instructionChannel: 'server',
    processModel: 'per-session',
    builtInSubagents: true,
    peerMessaging: true,
    // The query's prompt iterator reads queued user messages while the current turn continues.
    midTurnInput: true,
    /*
     * An idle session may be put to sleep (#568): a resumed process read the prompt cache as the live one did (~100% at
     * 2, 6 and 10 min on the 1 h lifetime, CLI 2.1.29x with haiku, #561) for +0.7 s (p50) / +1.8 s (p95) before the first
     * token, and ending the process frees all of its memory (240-300 MB after a few turns, growing while idle).
     * `scripts/probe-resume-cache.mts` re-measures it on a CLI update.
     */
    sleep: true,
  }

  launchSettingsFingerprint(settings: import('../contract.js').LaunchSettings): string {
    // Keep this alongside the query option construction. Bump the version when a setting the
    // adapter derives (including cross-session controls) changes without changing these inputs.
    // Normal v2 retires kept processes launched without an explicit mode (#578); safe's flags are unchanged.
    // Auto v3 retires the ones an older host started without the cross-session controls (#1347 slice 0): they are restarted once, at the safe boundary (#589).
    // Code intelligence (#686) only when off, so every fingerprint stored before it reads the same
    return JSON.stringify({ v: settings.permissionPreset === 'safe' ? 1 : settings.permissionPreset === 'auto' ? 3 : 2, cwd: settings.cwd, permission: settings.permissionPreset, trusted: !!settings.projectTrusted, noSettings: !!settings.noSettingFiles, ...(settings.noCodeIntelligence ? { noLsp: true } : {}) })
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('claude')
    try {
      /*
       * On Windows the version and sign-in are asked of the program sessions will start (#353): the
       * link, placed here already, so the first session does not wait for it, and npm's file is never
       * the one held. npm's placeholder is named as what it is, with the fix, rather than "not found".
       */
      let launch: ToolLaunch
      try {
        launch = this.statusLaunch()
      } catch (err) {
        if (!(err instanceof ClaudePlaceholderError)) throw err
        return { tool: 'claude', installed: false, loggedIn: false, detail: err.message }
      }
      const { stdout } = await exec(launch.command, [...launch.args, '--version'], { timeout: 5000, windowsHide: true })
      // Shows which install is actually being used — reduces confusion in an environment with several versions installed.
      const version = `${stdout.trim()} · ${path ?? 'PATH'}`
      const loggedIn = await claudeLoggedIn(launch)
      return {
        tool: 'claude',
        installed: true,
        loggedIn,
        detail: loggedIn ? version : `${version} · login required`,
      }
    } catch {
      return {
        tool: 'claude',
        installed: false,
        loggedIn: false,
        detail: 'claude CLI not found (check with `which claude` in a terminal)',
      }
    }
  }

  /**
   * The installed Claude Code (#297), from npm's `package.json` where it came from npm. On Windows
   * this never runs npm's `claude.exe` (#353: sessions start from the host's own link, and running
   * npm's file would hold it against the next update).
   */
  installedVersion(): Promise<string | null> {
    return installedCliVersion('claude', '@anthropic-ai/claude-code')
  }

  listExternalSessions(cwd: string, limit: number) {
    return listClaudeSessions(cwd, limit)
  }

  /**
   * A copy of the conversation to continue apart from the original (#677, a fork of a busy session). Claude never
   * locks a conversation, so this is not the way around a lock it is for Codex: it is the fork a requester chose.
   */
  forkConversation(externalId: string, cwd: string) {
    return forkClaudeSession(externalId, cwd)
  }

  /** Deletes the original conversation ("actually delete") — the SDK's deleteSession knows its own file layout. */
  deleteExternalConversation(externalId: string, cwd: string) {
    return deleteClaudeSession(externalId, cwd)
  }

  /**
   * Account usage (FR-9).
   *
   * **The SDK puts this method only on a Query**, so a running session answers it. With none running, a short-lived
   * probe session is started for the read and stopped right after (#726): it sends no message, so nothing is billed,
   * and the manager keeps the answer for a minute. Without it a linked machine nobody had a session on showed no usage
   * at all.
   */
  async listUsage() {
    const live = [...ClaudeAdapter.liveQueries].reverse()
    if (live.length > 0) return readUsageFromAny(live.map((query) => ({ query, sessionId: ClaudeAdapter.querySessions.get(query) ?? null })))
    // What a probe just found, or failed at, stands for a while; asked twice at once, the second waits for the first's probe
    if (this.probed && Date.now() - this.probed.at < PROBE_CACHE_MS) {
      if (this.probed.failure) throw this.probed.failure
      return this.probed.snapshot!
    }
    return (this.probing ??= this.probeUsage().finally(() => (this.probing = null)))
  }
  private probing: Promise<UsageSnapshot> | null = null
  private probed: { at: number; snapshot?: UsageSnapshot; failure?: Error } | null = null
  private swept = false

  private async probeUsage(): Promise<UsageSnapshot> {
    try {
      const snapshot = await this.runProbe()
      this.probed = { at: Date.now(), snapshot }
      return snapshot
    } catch (e) {
      const failure = e instanceof Error ? e : new Error(String(e))
      this.probed = { at: Date.now(), failure }
      console.error(`[usage] claude: a probe session could not read usage: ${failure.message}`)
      throw failure
    }
  }

  private async runProbe(): Promise<UsageSnapshot> {
    // Not signed in: a process would only fail to start a reading, and say less than this does
    if ((await this.account()).loggedIn === false) throw new Error('Claude Code is not logged in on this computer')
    if (!this.swept) {
      this.swept = true
      await sweepProbeDirs()
    }
    const dir = await mkdtemp(join(tmpdir(), PROBE_DIR_PREFIX))
    const sessionId = `usage-probe-${randomUUID()}`
    ClaudeAdapter.probeIds.add(sessionId)
    let probe: ClaudeSession | null = null
    try {
      probe = (await this.createSession({ sessionId, cwd: dir, permissionPreset: 'safe', noSettingFiles: true, noCodeIntelligence: true }, () => {})) as ClaudeSession
      /*
       * The query exists at once but the CLI behind it is still starting; asked too early it fails or stays quiet
       * (smoke-usage waits 7 s). Asked again until the bound, every ask bounded by readUsageFromAny's. An SDK
       * without the call is final: asking longer cannot change it.
       */
      const until = Date.now() + this.probeAskMs
      let failure: unknown
      for (;;) {
        const query = probe.usageQuery
        if (query) {
          try {
            return await readUsageFromAny([{ query, sessionId }], { log: () => {} })
          } catch (e) {
            failure = e
            if (e instanceof Error && e.message === UNSUPPORTED) break
          }
        }
        if (Date.now() >= until) break
        await new Promise((r) => setTimeout(r, this.probeRetryMs))
      }
      throw failure instanceof Error ? failure : new Error('Claude Code did not answer a usage reading in time')
    } finally {
      await probe?.dispose().catch(() => {})
      /*
       * On Windows the process still holds its folder until it has left (the SDK waits 2 s, then 5 s, before it kills
       * one), and removing the folder then fails. So the folder goes once the process has ended, or after a bound with
       * retries, and a leftover is swept by the next run.
       */
      if (probe) await raceTimeout(probe.ended, PROBE_EXIT_WAIT_MS, undefined)
      ClaudeAdapter.probeIds.delete(sessionId)
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {})
    }
  }

  /** Which account Claude Code is logged in to here, from the CLI itself (`claude auth status`), cached a minute (#726) */
  async account(): Promise<{ loggedIn: boolean | null; fingerprint: string | null }> {
    if (this.accountCache && Date.now() - this.accountCache.at < ACCOUNT_CACHE_MS) return this.accountCache.value
    let value: { loggedIn: boolean | null; fingerprint: string | null }
    try {
      const status = await claudeAuthStatus(this.statusLaunch())
      const flag = (status as { loggedIn?: unknown } | null)?.loggedIn
      value = { loggedIn: typeof flag === 'boolean' ? flag : null, fingerprint: accountFingerprint(status) }
    } catch {
      value = { loggedIn: null, fingerprint: null }
    }
    this.accountCache = { value, at: Date.now() }
    return value
  }
  private accountCache: { value: { loggedIn: boolean | null; fingerprint: string | null }; at: number } | null = null

  /** The program the sign-in is asked of: what sessions start (on Windows the link), else the one on PATH */
  private statusLaunch(): ToolLaunch {
    const exe = this.launch.windows ? this.launch.executable() : null
    if (exe && /\.exe$/i.test(exe)) return { command: this.launch.links.prepare(exe).path, args: [] }
    return launchFor(toolCommand('claude'))
  }

  async listModels() {
    // The same situation as usage — the SDK also puts this method only on a Query.
    const q = ClaudeAdapter.lastQuery
    if (!q) throw new Error('A running session is required to list models')
    return readClaudeModels(q)
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readClaudeHistory(externalId, cwd, limit)
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const s = new ClaudeSession(opts.sessionId, opts, emit, this.launch)
    await s.start()
    return s
  }

  /**
   * The host is on its way out (#353). On Windows a Node process takes its children with it when it
   * exits (libuv puts them in a job object that kills on close), so a Claude process that just got
   * EOF from `dispose` would be ended at once, possibly in the middle of writing a refreshed sign-in
   * — which leaves the next Claude process with a lock it waits out or fails on. This gives the
   * closed processes up to `exitGraceMs` to leave by themselves. Measured on Windows 11 (#353, CLI
   * 2.1.289, Node 24): a child PING.EXE was gone the moment its Node parent exited, and an idle
   * `claude -p --input-format stream-json` left 0.6 to 0.9 s after its stdin closed. Elsewhere
   * nothing waits: the SDK sends them SIGTERM on the host's exit, which they handle.
   */
  async settle(): Promise<void> {
    if (!this.launch.windows || this.launch.closing.size === 0) return
    await raceTimeout(Promise.allSettled([...this.launch.closing]), this.launch.exitGraceMs, undefined)
  }
}

export type { NormalizedEvent }

import { execFile } from 'node:child_process'
import { bridgePath } from './bridge-path.js'
/** Name of our MCP server attached via the bridge — elicitation acceptance judges by this name (defined in one place, #93) */
import { ORCHESTRATOR_MCP_NAME } from '../../sessions/orchestrator-tools.js'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { CLIENT_INFO, parseCliVersion } from '@cc/protocol'
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalScope,
  PermissionPreset,
  SessionActivity,
  ToolDescriptor,
} from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import { launchFor } from '../../tool-launch.js'
import { installedCliVersion } from '../../cli-version.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { CodexClient } from './client.js'
import { lastCompactSummary as rolloutLastCompactSummary } from './rollout.js'
import type { Verbosity } from './generated/Verbosity.js'
import { listCodexThreads, readCodexHistory } from './history.js'
import { imageEventFromDisk } from './images.js'
import { readCodexUsage } from './usage-client.js'
import { listCodexModels } from './models.js'
import {
  approvalDetailFrom,
  childSteps,
  CodexChildTracker,
  CODEX_KNOWN_NOTIFICATIONS,
  CompactionMarks,
  fileChangesOf,
  goalFromCodex,
  normalizeNotification,
  threadSettingsChanged,
  threadSettingsOf,
  toCodexDecision,
  type CodexThreadSettings,
} from './normalize.js'
import { UnmappedTypes } from '../unmapped.js'

const exec = promisify(execFile)

/**
 * Codex adapter (protocol and approval-override verification completed in M0).
 *
 * Design verification target (A-4): does adding only this directory leave the UI and core
 * unchanged? Rule: Codex types end here — the only thing that leaves is NormalizedEvent.
 */

/**
 * Permission preset to Codex permission options.
 *
 * **Same principle** as the Claude side: for normal, we do not decide anything and defer to
 * the tool's own settings (`~/.codex/config.toml`). So we set no key at all — codex fills in
 * whatever is missing from its own settings.
 *
 * It matters that there were two things being overridden. Not just approvalPolicy — **sandbox
 * was also pinned** to 'workspace-write'. That meant even if the user had written
 * danger-full-access into config.toml, anything outside the working folder was still blocked —
 * it failed without even asking.
 */
/*
 * "My settings" means the user's own `~/.codex/config.toml` — the repository's
 * `.codex/config.toml` only enters the picture when the project is trusted (repoFilesConfig, #92).
 */
function permissionOptionsFor(preset: PermissionPreset): Record<string, unknown> {
  if (preset === 'safe') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } // asks about everything
  if (preset === 'auto') return { approvalPolicy: 'never', sandbox: 'workspace-write' } // asks about nothing
  return {} // defer to the user's own settings
}

/**
 * Keeps files in the repository from being able to alter this thread (M4 decision 3, #92, #152) —
 * for untrusted projects, and for sessions that must not read any files at all (`noSettingFiles`:
 * orchestrator and coordination sessions — that folder is a spot a worker can write into). This
 * mirrors Claude's `settingSources: ['user']` versus `[]`. In a trusted folder (a trusted project,
 * or a user-folder app) nothing is loaded here — same as before. The manager decides which case
 * applies from the session kind and the project, and passes that down: it is not decided by
 * whether the session receives tools (the worktree manager and the session that creates the
 * worktree also receive tools, but they are sessions of the project).
 *
 * Codex has its own separate project trust (`projects."<path>".trust_level` in
 * `~/.codex/config.toml`). In an untrusted folder, Codex loads the repository's
 * `.codex/config.toml` (which can change approval policy, sandbox and MCP servers), hooks and
 * exec policy, but disables them. The problem is a folder whose trust is **unset**: if
 * `thread/start` received a cwd, trust is empty, and the sandbox can write to that folder, the
 * app-server **writes trust into the user's settings file, marking the folder as trusted**
 * (`set_project_trust_level(…, Trusted)` in codex source `app-server/thread_processor.rs`). So
 * every repository opened through this app ended up trusted on the Codex side.
 *
 * The per-thread `config` sits at the same layer as the CLI's `-c` (SessionFlags), and the trust
 * decision reads `projects` from the settings merged up through that layer (`project_trust_context`
 * in codex source config `loader/mod.rs`). So writing "untrusted" for that folder in this thread
 * only:
 *   - leaves the repository's `.codex/config.toml`, hooks and exec policy in the disabled layer
 *     (`disabled_reason_for_decision`)
 *   - stops app-server from writing trust in (the auto-trust above only fires when
 *     `trust_level.is_none()`), because trust is now already set
 *   - stops AGENTS.md from being read (`agents_md.rs` skips it when `active_project.is_untrusted()`)
 * The decision looks at **that folder's own key first**, per folder (`decision_for_dir`) — it
 * writes every ancestor from the cwd up to the root. Even if the user has trusted one ancestor,
 * that entry does not win. Both the path as written and the real path (with symlinks resolved)
 * are written, because Codex looks up both spellings (`normalized_project_trust_keys`).
 *
 * `project_doc_max_bytes: 0` is loaded alongside it. We could not confirm from the binary whether
 * installed 0.153.4 has the line that filters AGENTS.md by trust. This key is here because it was
 * measured on the orchestrator (a planted AGENTS.md that had been followed stopped being followed).
 * The user's own `~/.codex/AGENTS.md` is read through a different path and is unaffected.
 *
 * What remains: repository skills (`.codex/skills`, `.agents/skills`) are read regardless of trust
 * ("skills still load" — a warning string in the installed 0.153.4 binary). There is no key that
 * turns off only repository-scoped skills per thread (`skills.include_instructions` also turns off
 * the user's own skills). Skills are only instructions, so whatever the model does after following
 * a skill still goes through approval.
 *
 * **Confirmed from source and binary only** (Codex was logged out, so we could not re-verify by
 * running it): the keys and decisions were read from codex source (main 75e0e0a, 2026-09-25), and
 * we confirmed the same strings exist in the installed 0.153.4 binary —
 * "failed to persist trusted project state for", "is marked as untrusted in the effective configuration",
 * "Project-local config, hooks, and exec policies are disabled … but skills still load".
 */
export function repoFilesConfig(opts: Pick<CreateSessionOpts, 'cwd' | 'projectTrusted' | 'noSettingFiles'>): Record<string, unknown> {
  if (opts.projectTrusted === true && !opts.noSettingFiles) return {}
  const keys = new Set<string>()
  for (const start of [resolve(opts.cwd), realPathOr(opts.cwd)]) {
    for (let dir = start; ; dir = dirname(dir)) {
      keys.add(dir)
      if (dirname(dir) === dir) break
    }
  }
  return {
    project_doc_max_bytes: 0,
    projects: Object.fromEntries([...keys].map((k) => [k, { trust_level: 'untrusted' }])),
  }
}

function realPathOr(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * How an external app server's tool calls get approved (M4 decision 5) — session preset to
 * Codex's per-server `default_tools_approval_mode`.
 *
 *   auto    approve  asks about nothing. Our auto uses `approvalPolicy: never`, so if this
 *                    value is not set, Codex **rejects an unannotated MCP tool on its own**
 *                    ("requires approval, but approval policy is never")
 *   normal  writes   asks only about tools that lack a read-only annotation — the same rule
 *                    the Claude side uses
 *   safe    prompt   asks about everything. Read-only tools are handled separately per tool
 *                    with `approve` (appBridgeConfig)
 *
 * **Confirmed from source only** (Codex was logged out, so we could not re-verify by running it,
 * plan S-3/S-7): the vocabulary of the values comes from the installed 0.153.4's generated type
 * (`AppToolApproval = "auto" | "prompt" | "writes" | "approve"`) and the binary's settings field
 * names (`default_tools_approval_mode`, per-tool `tools.<name>.approval_mode`); the meaning of
 * each value was read from codex source (`requires_mcp_tool_approval_for_mode` in
 * `core/src/mcp_tool_call.rs`).
 *
 * One trap in normal: since normal defers to the user's own config.toml (permissionOptionsFor),
 * if the user has written `approval_policy = "never"`, Codex rejects a tool that `writes` should
 * have prompted for. We do not read the user's settings — in that combination, a write tool
 * comes back rejected.
 */
const APP_APPROVAL_MODE: Record<PermissionPreset, 'approve' | 'writes' | 'prompt'> = {
  auto: 'approve',
  normal: 'writes',
  safe: 'prompt',
}

/**
 * The ceiling for a single MCP tool call — **pinned in writing** to Codex's own code default
 * (300 seconds since 0.145). Relying on the default means that the day Codex changes the value,
 * our handling of long calls (returning early at 240 seconds) would silently go out of sync.
 * The field name (`tool_timeout_sec`) was confirmed only from the binary and source.
 */
export const CODEX_TOOL_TIMEOUT_SEC = 300
/**
 * If an app call takes longer than this, we return the run id and "still running" first (plan
 * "long-running calls"). This is 60 seconds shorter than the ceiling above — the round trip
 * between the bridge and the host, plus Codex's own processing, has to fit inside that margin
 * for "still running" to reach the model before the timeout does. The result is then followed
 * up through each app server's own `run_status`.
 */
export const APP_CALL_WAIT_MS = 240_000
/**
 * The ceiling for how long it can take from the app bridge starting to it producing a tool list.
 * We read the list ahead of time before starting the thread (mcpConfig), so this is usually
 * instant. For an app whose list we do not already know, we wait while the host starts the app
 * and reads it (up to 15 seconds).
 */
const APP_STARTUP_TIMEOUT_SEC = 30

/** How long we let a resume wait in front of the person — a lock error ("active writer") arrives within this window (measured ~0.3s) */
export const LAZY_RESUME_WAIT_MS = 3_000
/**
 * How many child items wait for their launch call at most (#222, `unlinked`). The wait is milliseconds long (measured:
 * the link came in the same millisecond as the child's first notification), so this only bounds a thread that is
 * never named.
 */
const UNLINKED_CAP = 2_000
/** The ceiling for a background resume — the same value as the manager's step limit (150s). Past this, it is considered stuck */
const BACKGROUND_RESUME_CAP_MS = 150_000

class CodexSession implements SessionHandle {
  readonly sessionId: string
  externalId: string | null = null
  private closed = false

  private client: CodexClient
  private threadId: string | null = null
  /**
   * The id of the turn currently running — **needed in order to stop it** (dogfooding
   * 2026-09-07: stop did not work).
   *
   * `turn/interrupt` does not work with only a threadId. Measured behavior: the server rejects
   * it with `Invalid request: missing field \`turnId\``(-32600), and we were only piping that
   * rejection into an error event — the screen looked stopped but the turn ran to completion.
   * So we capture this **from both** the turn/started notification and the turn/start response:
   * if stop is pressed very quickly, the response can arrive before the notification.
   */
  private turnId: string | null = null
  /** Our requestId to the Codex server's request id */
  private approvals = new Map<string, number | string>()
  /**
   * Cards raised for app tool approval (M4 A-5) — the answer has a different shape (elicitation's
   * `{ action }`, not `{ decision }`). Only a requestId in this set gets answered as an elicitation.
   */
  private elicitations = new Set<string>()
  /** App servers loaded onto this thread through the bridge — only elicitations under those names go to our cards */
  private appServers = new Set<string>()
  private reqCounter = 0
  private alwaysAllow = new Set<string>()
  /**
   * The changes of each file-change item still open, by item id (#169). The approval request for that item
   * names it and carries nothing else (measured — see approvalDetailFrom), so the card's path and diff come
   * from here. Forgotten when the item completes.
   */
  private fileChanges = new Map<string, { path: string; diff: string }[]>()
  /**
   * Messages that arrived while a compact/review turn was running (measured while dogfooding,
   * 2026-09-02, MGH session).
   *
   * In codex 0.147.0, turn/start **answers success while dropping the input** while a compact
   * turn is running — the rollout kept only the settings application (thread_settings_applied)
   * and not a single line of the user message, and since no error came back either, our screen
   * made it look sent. Upstream also pins these turns as unsteerable ("cannot steer a compact
   * turn" — turn_processor.rs). A normal turn is different: codex core merges input into a turn
   * that is running, so we just send it as usual. So we only queue here during compact/review
   * **that we ourselves started**, and flush the queue as a single turn once that turn ends.
   */
  private pendingInputs: string[] = []
  /** An unsteerable turn (compact/review) is running — we know because we are the ones who started it */
  private blockingTurn = false
  /**
   * The count of messages sent, and the count reclaimed by a Stop pressed before the thread was
   * up (#168).
   *
   * Before resume finishes there is no turn to stop (there is no threadId or turnId yet). The old
   * Stop did nothing in that window, and a message queued up behind ready went out as turn/start
   * once resume finished — the turn started after the person had already stopped it. Now that
   * Stop reclaims whatever was sent up to that point. Anything sent after that still goes through.
   */
  private sendsIssued = 0
  private sendsStopped = 0
  /**
   * Codex is reconnecting on its own (#168): the `retrying` activity is up, and `activityBefore`
   * is what was showing before it (compacting, reviewing or nothing). Codex sends no "reconnected"
   * notification — the next item is the sign that output flows again, so that is where the
   * previous activity is put back.
   */
  private retrying = false
  private activityBefore: SessionActivity | null = null
  /**
   * The thread never came up. Only possible after a lazy resume handed the handle out:
   * watchBackgroundStart reports that once, counting the messages it swallowed (#168, item 5).
   */
  private startFailed = false
  /**
   * Child threads (#222): a child's thread id, to the `spawnAgent` item that launched it. Its steps are kept under
   * that card. Learned from the item's `receiverThreadIds` on `item/completed` (the `item/started` has an empty list).
   */
  private childCalls = new Map<string, string>()
  /**
   * A child's items that arrived before its launch call named it. The child starts before the parent's `spawnAgent`
   * completes: measured (codex-cli 0.160.0), the child's first `thread/status/changed` came in the same millisecond
   * as, and before, the `item/completed` that names it. Held, not dropped, and replayed once the link arrives. What is
   * still unlinked when the parent's turn ends belonged to no launch call this session saw (one from before a restart),
   * and is let go with a log line.
   */
  private unlinked = new Map<string, { method: string; params?: unknown }[]>()
  private unlinkedCount = 0
  /** Notification methods this session received that nothing maps or ignores on purpose, said once each in host.log (#58) */
  private readonly unmapped: UnmappedTypes
  /** The child agents running in the background (#290, see `CodexChildTracker`). */
  private readonly children: CodexChildTracker
  /** One compaction marker per compaction, from the item, the deprecated notification, or both (#303) */
  private readonly compactions = new CompactionMarks()
  /** What the thread said it runs with — a `thread/settings/updated` is measured against this (#304, `threadSettingsChanged`) */
  private threadSettings: CodexThreadSettings | null = null
  /**
   * MCP servers whose failed start was already said (#304). Codex tries a failing server twice on one thread start
   * (measured, codex-cli 0.160.0), and one line per server is enough; a server that starts again may fail again later.
   */
  private mcpFailed = new Set<string>()
  /** Thread ready — awaited at construction time to obtain externalId */
  readonly ready: Promise<void>

  constructor(
    private opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.sessionId = opts.sessionId
    this.unmapped = new UnmappedTypes('codex', opts.sessionId, CODEX_KNOWN_NOTIFICATIONS)
    this.children = new CodexChildTracker(opts.sessionId)
    this.client = new CodexClient(
      {
        onNotification: (n) => this.onNotification(n),
        onServerRequest: (r) => this.onServerRequest(r),
        /*
         * **Do not report a process we closed ourselves as having crashed.**
         *
         * This is the spot that ate an entire day of investigation. When resuming a locked
         * thread failed, the manager cleaned the session up (dispose), and that ordinary
         * shutdown came back through here and raised `adapter_crashed`. The screen showed only
         * "codex app-server exited", and the real reason ("already has an active writer") was
         * buried underneath, out of sight. Calling a process that never crashed a crash left no
         * way to find the actual cause.
         */
        onExit: (code, expected) => {
          // The child threads lived in that process (#290) — closed by us or not, they are gone
          this.releaseChildren()
          if (expected) return
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: {
              code: 'adapter_crashed',
              message: `codex app-server exited (code ${code ?? 'null'})`,
              retryable: true,
            },
          })
        },
      },
      {
        cwd: opts.cwd,
        command: whichTool('codex') ?? 'codex',
        // Under the keeper (#280 step 2) the app-server is spawned there, or adopted from a previous host
        process: opts.processSource
          ? (opts.processSource.adopt?.process ??
            opts.processSource.spawn({ command: whichTool('codex') ?? 'codex', args: ['app-server'], cwd: opts.cwd, env: process.env }))
          : undefined,
      },
    )
    this.ready = this.start()
    // Registered before any send's continuation, so the flag is set by the time a send's catch runs
    this.ready.catch(() => {
      this.startFailed = true
    })
  }

  private async start(): Promise<void> {
    const adopted = !!this.opts.processSource?.adopt
    try {
      const init = await this.client.request<{ userAgent?: unknown }>('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: null,
      })
      this.client.notify('initialized')
      /*
       * The app-server's version, for moving the session to a newer install (#297). Codex reports it only here, in
       * `userAgent`: `<our client name>/<server version> (<os>) …` (measured, codex-cli 0.160.0, 2026-10-05:
       * "centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)"). An adopted app-server is not
       * initialized again; its version comes from the keeper's tag instead (manager.adoptKept).
       */
      const ua = typeof init?.userAgent === 'string' ? init.userAgent : ''
      const version = parseCliVersion(ua.slice(ua.indexOf('/') + 1))
      if (version) this.emit({ type: 'agent_version', sessionId: this.sessionId, version })
    } catch (err) {
      /*
       * An app-server adopted from a previous host (#280 step 2) is the same stdio connection, already
       * initialized. Measured (codex-cli 0.160.0, gpt-5.6-luna, 2026-10-04): the second `initialize`
       * is rejected with -32600 "Already initialized" and nothing else changes; `thread/resume` then
       * answers with the running turn and re-sends a pending approval under the same request id.
       */
      if (!adopted || !/already initialized/i.test((err as Error).message)) throw err
    }

    if (this.opts.resumeExternalId) {
      // Resume (FR-10). If it fails, the session manager guides the person through the fallback
      let res: Record<string, unknown>
      try {
        res = await this.client.request<Record<string, unknown>>('thread/resume', {
          threadId: this.opts.resumeExternalId,
          /*
           * Metadata only, not the whole history (#342). Nothing here reads the history the resume used to return
           * except the running turn's id, and that has its own one-turn query below. Measured (codex-cli 0.160.0,
           * gpt-5.6-luna, a five-turn scratch thread, 2026-10-05): 1,206 KB / 761 ms and a `deprecationNotice`
           * ("Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`…") that #304 put
           * in the conversation, against 1.9 KB / 351 ms and no notice. One long thread's answer was 23 MB
           * (client.ts). A Codex that predates the flag ignores it and answers with the turns, as before.
           */
          excludeTurns: true,
          /*
           * Verbosity has to be carried through on resume too (#54). turn/start has no place for
           * it (unlike effort), so these two spots where the thread is started are the only
           * place — leaving it out here becomes the quiet kind of loss where settings reset every
           * time the session wakes back up.
           *
           * Reasoning summary is the same case (measured for #58): unless this switch is turned
           * on, the item/reasoning/* stream **never arrives, not once** — the kind of feature
           * where wiring it up without flipping the switch does nothing at all.
           */
          config: {
            model_reasoning_summary: 'auto',
            ...(this.opts.verbosity ? { model_verbosity: this.opts.verbosity } : {}),
            ...(this.opts.serviceTier ? { service_tier: this.opts.serviceTier } : {}),
            /*
             * MCP servers are loaded **on resume too** (M4 A-5, plan "to confirm separately" 1).
             *
             * The old resume sent no servers at all — if the initial settings do not survive on
             * the thread, a Codex orchestrator that wakes back up loses the centralu tools.
             * Whether they actually survive can only be known by running it (S-7), and we could
             * not re-check because Codex was logged out. So we load them again without waiting
             * for that confirmation: resume's `config` is a settings override (generated type
             * ThreadResumeParams — "Configuration overrides for the resumed thread"), so the same
             * name lands in the same slot, and overwriting it loses nothing if it had survived.
             * For apps, resume is effectively "starting the next thread" — an app attached while
             * the thread was running gets attached here.
             */
            ...(await this.mcpConfig()),
            // Files in the repository only reach this thread in a trusted project — resume follows the same rule (#92)
            ...repoFilesConfig(this.opts),
          },
        })
      } catch (err) {
        /*
         * The raw message ("already has an active writer") explains nothing to the user.
         *
         * And **a sentence meant for a human is not enough on its own** — if the layer above has
         * to re-parse that sentence with a regular expression, that is not a contract. We surface
         * a machine-readable code alongside it: the UI needs this code to be able to offer
         * "split off and continue" (codex's thread/fork works fine even on a locked thread —
         * confirmed by measurement).
         */
        const msg = (err as Error).message
        if (/active writer/i.test(msg)) {
          /*
           * Measurement (#57) narrowed down what this error actually means: the lock is a flock,
           * not a file's mere existence, so a file left behind by a dead process **cannot**
           * produce this error. Landing here means a live process is holding the flock at this
           * exact moment — codex running in a terminal, another app, or an orphan that survived
           * without being cleaned up, having inherited only the fd.
           */
          throw Object.assign(
            new Error(
              'This conversation is already open elsewhere (codex in a terminal, another app, or a process left behind by an unclean shutdown)',
            ),
            { code: 'conversation_locked' },
          )
        }
        throw err
      }
      this.threadId = threadIdOf(res) ?? this.opts.resumeExternalId
      this.threadSettings = threadSettingsOf(res)
      // An adopted thread may be mid-turn: Stop needs that turn's id (#313)
      if (adopted) this.turnId ??= runningTurnOf(res) ?? (await this.latestRunningTurn(res))
      /*
       * The goal is a live field (2026-09-07) — for the badge to stay accurate after a restart,
       * we ask again on resume. Older codex has no such method: a failure lies down quietly as
       * "no goal", same as having none.
       */
      void this.client
        .request<{ goal: Record<string, unknown> | null }>('thread/goal/get', { threadId: this.threadId })
        .then((r) => {
          // goalFromCodex folds complete into null — the default state is already null, so there is nothing to emit then
          const g = r.goal ? goalFromCodex(r.goal) : null
          if (g) this.emit({ type: 'goal', sessionId: this.sessionId, goal: g })
        })
        .catch(() => {})
    } else {
      const res = await this.client.request<Record<string, unknown>>('thread/start', {
        cwd: this.opts.cwd,
        ...permissionOptionsFor(this.opts.permissionPreset),
        model: this.opts.model,
        /*
         * The following two are attached only for the orchestrator.
         *
         * The role is given directly through developerInstructions — the same slot as Claude's
         * systemPrompt append. The reason we avoid a file (AGENTS.md) is the same: if a
         * lower-privilege session could edit that file, it would become able to instruct every
         * session.
         *
         * Tools are attached through the stdio bridge. What we confirmed by measurement:
         *   per-thread config.mcp_servers  works (our command actually runs)
         *   the url (HTTP) approach        does not — not a single request ever arrives
         * So one extra process ends up running — a cost that does not exist on the Claude path.
         */
        ...(this.opts.systemPromptAppend ? { developerInstructions: this.opts.systemPromptAppend } : {}),
        /*
         * config is **assembled in this one place only.** There used to be a trap where the
         * verbosity spread and the orchestrator spread each built their own config keys, and one
         * would silently overwrite the other entirely — once there were three contributors
         * (summary, verbosity, orchestrator), it became cheaper to remove the trap than to keep
         * remembering it.
         */
        config: {
          // The reasoning-summary switch (measured for #58): without it, the item/reasoning/* stream never arrives
          model_reasoning_summary: 'auto',
          ...(this.opts.verbosity ? { model_verbosity: this.opts.verbosity } : {}),
          // Response speed (measured: priority = "Fast, 1.5x speed, increased usage")
          ...(this.opts.serviceTier ? { service_tier: this.opts.serviceTier } : {}),
          // MCP servers — the orchestrator's bridge and any attached external app's bridge (including approved MCP servers) (see mcpConfig)
          ...(await this.mcpConfig()),
          // Files in the repository (.codex/ settings, hooks, rules, AGENTS.md) only in a trusted project (#92, repoFilesConfig)
          ...repoFilesConfig(this.opts),
        },
      })
      this.threadId = threadIdOf(res)
      this.threadSettings = threadSettingsOf(res)
    }
    this.externalId = this.threadId
  }

  /**
   * The MCP settings loaded onto the thread — start and resume use **the exact same assembly**
   * (so nothing is missing on resume).
   *
   * There are two:
   *   1. The bridge for Centralu's own tools (FR-11). Since #320 every ordinary session gets it
   *      too (the reader set), so a Codex session starts one small node process for it (about
   *      40 MB resident, measured idle) unless the person turned the set off in Settings.
   *   2. The bridge for an external app (M4 A-5) — one per app. This is only produced **for a
   *      session that has an app attached**: a session with neither starts no bridge. An MCP
   *      server the person approved (propose_mcp_server) also becomes a user-folder app and
   *      arrives here (A-7). It used to be loaded raw, but Codex's elicitation asking whether to
   *      use that server's tools was likely being rejected by us (we only accept `ours`), so it
   *      probably never ran even once (plan "to confirm separately" 2). Tool approval for an app
   *      bridge goes to our own approval cards.
   *
   * The app bridge is an stdio process that Codex starts (one of the three in plan S-3). HTTP
   * (`url`) never received a single request in 0.147.0, and we could not re-check in 0.153.4.
   * The bridge is the same file as the orchestrator's (they are split by `CC_APP_SERVER`).
   */
  private async mcpConfig(): Promise<Record<string, unknown>> {
    const bridge = this.opts.orchestratorBridge
    const servers: Record<string, unknown> = {}
    const orchestrator = !!(this.opts.orchestratorTools && bridge)
    if (orchestrator) {
      servers[ORCHESTRATOR_MCP_NAME] = {
        command: process.execPath,
        args: [bridgePath()],
        env: { CC_HOST_URL: bridge!.url, CC_HOST_TOKEN: bridge!.token, CC_SESSION_ID: this.opts.sessionId },
        /*
         * Our own tools are never asked about, under any preset — the same as Claude, where they
         * skip canUseTool (isOrchestratorTool). Without this, auto (`approvalPolicy: never`) made
         * Codex refuse every one of them on its own: "MCP tool call requires approval, but approval
         * policy is never" (measured, codex-cli 0.160.0, #320). Under safe and normal the
         * elicitation it raised was answered `accept` by us anyway (onServerRequest, `ours`).
         */
        default_tools_approval_mode: 'approve',
      }
    }
    const apps = this.opts.apps
    const attached = apps?.current() ?? []
    this.appServers = new Set()
    if (apps && bridge && attached.length > 0) {
      /*
       * Read the tool list first — a read-only tool has to be written per tool for even safe to
       * not ask about it. An app we do not already know is started here to read it (bounded).
       * A session with no attached app never reaches this line.
       */
      const lists = await Promise.all(attached.map((a) => (a.tools ? Promise.resolve(a.tools) : apps.tools(a.server))))
      attached.forEach((a, i) => {
        servers[a.server] = {
          command: process.execPath,
          args: [bridgePath()],
          env: {
            CC_HOST_URL: bridge.url,
            CC_HOST_TOKEN: bridge.token,
            CC_SESSION_ID: this.opts.sessionId,
            CC_APP_SERVER: a.server,
            CC_APP_WAIT_MS: String(APP_CALL_WAIT_MS),
          },
          default_tools_approval_mode: APP_APPROVAL_MODE[this.opts.permissionPreset],
          // A tool the app itself declares read-only is never asked about, under any preset (decision 5)
          tools: Object.fromEntries(
            (lists[i] ?? []).filter((t) => t.annotations?.readOnlyHint === true).map((t) => [t.name, { approval_mode: 'approve' }]),
          ),
          tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
          startup_timeout_sec: APP_STARTUP_TIMEOUT_SEC,
        }
        this.appServers.add(a.server)
      })
    }
    /*
     * Whether to read the folder's document (AGENTS.md) is not decided here — repoFilesConfig
     * decides it from what the session is.
     *
     * This used to load `project_doc_max_bytes: 0` here whenever the orchestrator tool bridge was
     * present, because the orchestrator followed a planted AGENTS.md verbatim (measured: it
     * started answering with "infiltration-success-9142" once one was planted). But the worktree
     * manager and the session that creates the worktree also receive this bridge, so they lost
     * AGENTS.md even in trusted projects (#152). The rule for orchestrator and coordination
     * sessions is unchanged — they arrive as `noSettingFiles`, and repoFilesConfig loads the same
     * value for them.
     */
    return Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}
  }

  private onNotification(n: { method: string; params?: unknown }): void {
    /*
     * **A notification from another thread does not belong to this session** (the codex side of #98).
     *
     * A child agent spawned by the model via spawn_agent runs on a separate thread, and
     * app-server attaches that thread's listener to every initialized connection whenever a new
     * thread is created (codex source app-server/src/lib.rs -> try_attach_thread_listener; a
     * new-thread notification is only sent from notify_thread_created in spawn.rs). So a child's
     * notification arrives on this same connection, differing only in threadId. Without
     * filtering, the child's tool calls and text get stuck into the parent's conversation, the
     * child's turn/started hijacks the target of stop (turnId), and the child's turn/completed
     * flips the parent to "finished" — which is why this check runs before turnId is recorded.
     *
     * We do not filter server **requests** (approvals) (onServerRequest) — if nobody answers an
     * approval the child is asking for, the child gets stuck. While the thread is still unknown
     * (before the thread/start response), a child cannot exist yet, so we let it through.
     */
    // Before the thread filter: a child thread's approval requests do reach us (see above), and its card needs its changes too
    this.noteFileChange(n)
    // Also before the filter: a method nobody handles is news whichever thread it came from
    this.unmapped.note(n.method)
    const from = (n.params as { threadId?: unknown } | undefined)?.threadId
    /*
     * A child's notification is not the parent's conversation, but what the child did is kept (#222): its items become
     * steps under the `spawnAgent` card that launched it, which the host stores apart from the conversation.
     */
    if (typeof from === 'string' && this.threadId !== null && from !== this.threadId) {
      for (const e of this.children.push(from, n)) this.emit(e)
      this.onChildNotification(from, n)
      this.noteSpawn(n)
      return
    }
    // Which turn is running (Turn.id — generated/v2/Turn.ts). Cleared once it ends: trying to
    // stop a turn that has already ended gets rejected by the server, and that rejection becomes a false "did not stop" signal
    if (n.method === 'turn/started') this.turnId = turnIdOf(n.params)
    if (n.method === 'turn/completed' || n.method === 'turn/failed') this.turnId = null

    // Output flows again after a reconnect — the retrying activity gives way to what was showing before it
    if (this.retrying && n.method.startsWith('item/')) {
      this.retrying = false
      this.emit({ type: 'activity', sessionId: this.sessionId, activity: this.activityBefore })
    }
    // A finished turn takes its activity with it (the state machine clears it on leaving working)
    if (n.method === 'turn/completed') {
      this.retrying = false
      this.activityBefore = null
    }

    this.noteAppCall(n)

    // Where compact/review ends — if messages piled up during it, they go out now
    if (n.method === 'turn/completed' && this.blockingTurn) {
      this.blockingTurn = false
      this.flushPending()
    }
    if (n.method === 'thread/settings/updated') {
      const { next, events } = threadSettingsChanged(this.sessionId, this.threadSettings, n.params, {
        model: this.opts.model ?? null,
        effort: this.opts.effort ?? null,
        verbosity: this.opts.verbosity ?? null,
        serviceTier: this.opts.serviceTier ?? null,
      })
      this.threadSettings = next
      for (const e of events) this.emit(e)
      return
    }
    if (n.method === 'mcpServer/startupStatus/updated' && !this.firstMcpFailure(n.params)) return
    for (const e of normalizeNotification(this.sessionId, n)) {
      /*
       * An image that arrived carrying only a path gets its bytes filled in here (#40). normalize
       * is a pure function and cannot read files — IO is the adapter's job. The read is async,
       * but an image is not sensitive to conversation ordering (the tool line has already gone
       * out), so it is fine for it to arrive later.
       */
      if (e.type === 'message_image' && !e.data && e.path) {
        void imageEventFromDisk(this.sessionId, e.path).then((filled) => this.emit(filled))
        continue
      }
      if (e.type === 'compaction' && !this.compactions.admit(n)) continue
      if (e.type === 'activity') {
        // Each attempt sends its own notice; one indication is enough
        if (e.activity === 'retrying' && this.retrying) continue
        if (e.activity === 'retrying') this.retrying = true
        else this.activityBefore = e.activity
      }
      this.emit(e)
    }
    this.noteSpawn(n)
    if (n.method === 'turn/completed' && this.unlinked.size > 0) {
      console.error(`[codex] ${this.sessionId.slice(0, 8)} let go of ${this.unlinkedCount} items from ${this.unlinked.size} threads no spawnAgent call named`)
      this.unlinked.clear()
      this.unlinkedCount = 0
    }
  }

  /** Whether this MCP status is one to say: a failure not yet said since the server last started (see `mcpFailed`). */
  private firstMcpFailure(params: unknown): boolean {
    const p = (params ?? {}) as { name?: unknown; status?: unknown }
    const name = typeof p.name === 'string' ? p.name : ''
    if (p.status === 'ready') this.mcpFailed.delete(name)
    if (p.status !== 'failed') return false
    if (this.mcpFailed.has(name)) return false
    this.mcpFailed.add(name)
    return true
  }

  /**
   * A child thread's notification (#222): its items become steps under the `spawnAgent` card that launched it, or wait
   * for that card to name the thread (`unlinked`). Only items are kept — the child's turn, status and deltas carry
   * nothing `childSteps` reads.
   */
  private onChildNotification(thread: string, n: { method: string; params?: unknown }): void {
    if (n.method !== 'item/started' && n.method !== 'item/completed') return
    const call = this.childCalls.get(thread)
    if (call) {
      for (const e of childSteps(this.sessionId, call, n)) this.emit(e)
      return
    }
    if (this.unlinkedCount >= UNLINKED_CAP) return
    this.unlinked.set(thread, [...(this.unlinked.get(thread) ?? []), n])
    this.unlinkedCount += 1
  }

  /**
   * A `spawnAgent` call completed and named the threads it started (#222) — from the parent, or from a child that
   * started its own. Those threads' steps go under this card from now on, starting with whatever arrived before it.
   */
  private noteSpawn(n: { method: string; params?: unknown }): void {
    if (n.method !== 'item/completed') return
    const item = (n.params as { item?: Record<string, unknown> } | undefined)?.item
    if (!item || item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent' || typeof item.id !== 'string') return
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    for (const thread of receivers) {
      if (typeof thread !== 'string' || this.childCalls.has(thread)) continue
      this.childCalls.set(thread, item.id)
      for (const e of this.children.link(thread, item.id, typeof item.prompt === 'string' ? item.prompt : '')) this.emit(e)
      const held = this.unlinked.get(thread) ?? []
      this.unlinked.delete(thread)
      this.unlinkedCount -= held.length
      for (const early of held) this.onChildNotification(thread, early)
    }
  }

  /** Keeps a file-change item's changes until it completes — see `fileChanges` */
  private noteFileChange(n: { method: string; params?: unknown }): void {
    const p = (n.params ?? {}) as { item?: Record<string, unknown>; itemId?: unknown; changes?: unknown }
    // The patch can be revised before it is approved (generated/v2/FileChangePatchUpdatedNotification.ts) — not measured
    if (n.method === 'item/fileChange/patchUpdated' && typeof p.itemId === 'string') {
      this.fileChanges.set(p.itemId, fileChangesOf(p))
      return
    }
    const item = p.item
    if (!item || item.type !== 'fileChange' || typeof item.id !== 'string') return
    if (n.method === 'item/started') this.fileChanges.set(item.id, fileChangesOf(item))
    else if (n.method === 'item/completed') this.fileChanges.delete(item.id)
  }

  /**
   * Tells the attachment layer when an attached app's tool call starts and ends (M4 B-1 —
   * matching cards to calls on the in-conversation screen).
   *
   * A call coming in through the bridge does not know the card id (`item.id`) — we found no
   * evidence that Codex carries that id on the MCP request. So we record here what we observed
   * ("card X calls server S's tool T with argument A"), and the attachment layer matches it
   * against the call that follows. A card that has ended (including a rejection) is removed from
   * matching. A notification from another thread (a child agent) was already filtered out above —
   * a child's call is not the parent's card.
   */
  private noteAppCall(n: { method: string; params?: unknown }): void {
    const apps = this.opts.apps
    if (!apps || (n.method !== 'item/started' && n.method !== 'item/completed')) return
    const item = (n.params as { item?: Record<string, unknown> } | undefined)?.item
    if (!item || item.type !== 'mcpToolCall' || typeof item.id !== 'string') return
    if (n.method === 'item/completed') return apps.callEnded(item.id)
    const server = typeof item.server === 'string' ? item.server : ''
    const tool = typeof item.tool === 'string' ? item.tool : ''
    if (!this.appServers.has(server) || !tool) return
    apps.noteCall(item.id, server, tool, item.arguments ?? (item.invocation as { arguments?: unknown } | undefined)?.arguments ?? {})
  }

  private onServerRequest(r: { id: number | string; method: string; params?: unknown }): void {
    /*
     * **elicitation has a different response shape from an approval.**
     *
     * When asking whether to use an MCP server, codex sends an elicitation and waits for an
     * `{ action }`. We were passing an unknown server request through as `{}`, which made codex
     * fail to deserialize it with "missing field `action`" and **treat it as a rejection** — the
     * screen only showed "permission denied", with no way to know the actual cause (measured).
     *
     * We accept our own server and reject unknown ones. Silently approving when there is no
     * screen to ask on would mean deciding on the user's behalf.
     */
    if (r.method.toLowerCase().includes('elicitation')) {
      const p = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as {
        serverName?: string
        message?: unknown
        _meta?: unknown
      }
      /*
       * **Tool approval for an attached app goes to our own approval card** (M4 A-5, decision 5).
       *
       * Codex asks whether to use an MCP tool through this same elicitation, and marks in `_meta`
       * that it is a tool approval. Rejecting it as before would mean the app tool never runs on
       * Codex, not even once (the same shape as plan "to confirm separately" 2). We only route to
       * a card for **tool approval on an app server we ourselves loaded onto this thread** — a
       * third party's server whose name happens to start with `app-` (from the user's
       * config.toml), and any elicitation that is not a tool approval (an input form), are still
       * rejected as before.
       *
       * Confirmed from source only (logged out, S-3): the string in the installed 0.153.4 binary
       * is `codex_approval_kind`, while current codex source uses `codex/approval_kind` — we read both.
       */
      if (typeof p.serverName === 'string' && this.appServers.has(p.serverName) && approvalKindOf(p._meta) === 'mcp_tool_call') {
        const requestId = `codex-req-${++this.reqCounter}`
        this.approvals.set(requestId, r.id)
        this.elicitations.add(requestId)
        this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId, detail: appApprovalDetail(p.serverName, p.message, p._meta) })
        return
      }
      const ours = p.serverName === ORCHESTRATOR_MCP_NAME
      this.client.respond(r.id, { action: ours ? 'accept' : 'decline', content: null, _meta: null })
      return
    }

    /*
     * **A permissions request is not answered with a decision** (#169). Its response is
     * `{ permissions: GrantedPermissionProfile, scope }` (generated/v2/PermissionsRequestApprovalResponse.ts),
     * so the general path below, which answers `{ decision }`, sent Codex a reply of the wrong shape whatever
     * the person chose. There is no card that can show a permission profile yet, so it is refused the way
     * that type allows — nothing granted, for this turn only — and said in the log, so a request that
     * should have been asked about is one grep away. It only arrives with Codex's `request_permissions_tool`
     * feature turned on; not measured.
     */
    if (r.method === 'item/permissions/requestApproval') {
      console.error('[codex] permissions request refused, no card for it yet:', JSON.stringify(r.params ?? {}).slice(0, 500))
      this.client.respond(r.id, { permissions: {}, scope: 'turn' })
      return
    }

    if (!r.method.includes('requestApproval') && !r.method.endsWith('Approval')) {
      /*
       * A server request that is not an approval is passed through with an empty response (so we
       * do not stall as the protocol grows). But **we do log what was passed through** (#58) — when
       * an elicitation broke because of this empty {}, there was not a single log line to go on,
       * and finding the cause turned into a maze. A request is not a notification: our answer
       * changes what happens on the other side. The next time this happens, it should take one grep.
       */
      console.error('[codex] unknown server request answered with {}:', r.method)
      this.client.respond(r.id, {})
      return
    }
    const params = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as Record<
      string,
      unknown
    >

    const itemId = typeof params.itemId === 'string' ? params.itemId : ''
    const detail = approvalDetailFrom(r.method, params, this.fileChanges.get(itemId))

    // Does not ask if it matches a saved "always allow" rule (the same rule as C-2)
    const key = detail.kind === 'command' ? detail.command : detail.kind === 'file_edit' ? detail.path : ''
    if (key && this.isAlwaysAllowed(key)) {
      this.client.respond(r.id, { decision: 'accept' })
      return
    }

    const requestId = `codex-req-${++this.reqCounter}`
    this.approvals.set(requestId, r.id)
    this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId, detail })
  }

  private isAlwaysAllowed(key: string): boolean {
    for (const m of this.alwaysAllow) {
      if (m.endsWith('*') ? key.startsWith(m.slice(0, -1)) : key === m) return true
    }
    return false
  }

  applyRules(matchers: readonly string[]): void {
    for (const m of matchers) this.alwaysAllow.add(m)
  }

  send(text: string): void {
    const nth = ++this.sendsIssued
    void this.ready
      .then(() => {
        // A Stop pressed before the thread was up already reclaimed this message (sendsStopped) — do not send it
        if (nth <= this.sendsStopped) return
        if (!this.threadId) throw new Error('Thread is not ready')
        /*
         * While compact/review is running, we do not send but queue instead — the measurement in
         * the pendingInputs comment is the reason (if sent, codex answers success while
         * **dropping** it). This leaves a limitation where a slash command hitting this path is
         * delivered as literal text, but /compact during a compact is meaningless anyway.
         */
        if (this.blockingTurn) {
          this.pendingInputs.push(text)
          return
        }
        /*
         * **compact is a function, not a message** (a dogfooding observation nailed it exactly —
         * "it does not work by sending a message"). In the codex CLI, /compact runs compaction
         * without going into the conversation, but the app-server path has no such slash-command
         * handler — sending it through turn/start makes the model **read the literal characters**
         * "/compact". There is a dedicated RPC instead: thread/compact/start
         * (generated/ClientRequest.ts). Measured: it answers {} immediately and proceeds
         * turn/started -> contextCompaction item started -> completed -> turn/completed, which our
         * existing normalize plumbing (the compacting indicator, the completion marker) already
         * receives as-is. (No `thread/compacted` on 0.147.0, 0.153.4 or 0.160.0 — #303.)
         */
        if (text.trim() === '/compact') {
          this.blockingTurn = true
          return this.client
            .request('thread/compact/start', { threadId: this.threadId })
            .catch((e: unknown) => {
              // Waiting on a turn that failed to start would lock the queue forever — unblock and flush what piled up
              this.blockingTurn = false
              this.flushPending()
              throw e
            })
        }
        /*
         * /review is the same kind of thing (the review/start RPC). Measured: with no argument it
         * is the same "review what has changed right now" default as the codex CLI; with an
         * argument it follows that instruction instead (custom). The result usually arrives like a
         * turn — the review body streams as agentMessage (existing plumbing), and its start and end
         * arrive as enteredReviewMode/exitedReviewMode items (normalize turns these into activity).
         * Since upstream also classifies review turns as unsteerable ("cannot steer a review turn"),
         * we guard it with the same queue as compact.
         */
        if (text.trim() === '/review' || text.trim().startsWith('/review ')) {
          const instructions = text.trim().slice('/review'.length).trim()
          this.blockingTurn = true
          return this.client
            .request('review/start', {
              threadId: this.threadId,
              target: instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' },
            })
            .catch((e: unknown) => {
              this.blockingTurn = false
              this.flushPending()
              throw e
            })
        }
        /*
         * /goal is also a function (2026-09-07 — the same #58 family as /compact and /review).
         * Sending it through turn/start makes the model read the literal characters "/goal". There
         * are three dedicated RPCs: thread/goal/set, get and clear. The state change comes back as
         * a thread/goal/updated|cleared notification, which is what draws the badge — here we only
         * leave a one-line confirmation in the chat (if a local command's answer is invisible,
         * there is no way to know it ran — a lesson from claude's local_command_output). This is
         * not a turn, so blockingTurn is not set.
         */
        if (text.trim() === '/goal' || text.trim().startsWith('/goal ')) {
          const arg = text.trim().slice('/goal'.length).trim()
          const say = (line: string) =>
            this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: line })
          if (!arg) {
            return this.client
              .request<{ goal: { objective?: string; status?: string } | null }>('thread/goal/get', {
                threadId: this.threadId,
              })
              .then((r) =>
                say(
                  r.goal ? `Goal (${r.goal.status ?? 'active'}): ${r.goal.objective ?? ''}` : 'No goal set.',
                ),
              )
          }
          if (arg === 'clear') {
            return this.client
              .request('thread/goal/clear', { threadId: this.threadId })
              .then(() => say('Goal cleared.'))
          }
          /*
           * **State the status the response actually gave, verbatim** (dogfooding 2026-09-08:
           * "it looks registered but does not do anything").
           *
           * Measured: if the thread already has a finished goal, setting a new objective made
           * codex leave status as complete while only swapping in the new objective. If we had
           * just answered "Goal set" at that point, the screen would say it worked while the goal
           * loop never actually ran — and no badge would appear either, since our own rule is that
           * a completed goal does not raise a badge.
           */
          const setGoal = () =>
            this.client.request<{ goal?: { status?: string } }>('thread/goal/set', {
              threadId: this.threadId as string,
              objective: arg,
            })
          const statusOf = (r: { goal?: { status?: string } }) =>
            typeof r?.goal?.status === 'string' ? r.goal.status : 'active'
          return setGoal().then(async (first) => {
            /*
             * **Setting a new goal on top of a finished one leaves it finished** (measured 2026-09-08).
             *
             * That thread had a goal the model had marked complete on its own two days earlier, and
             * setting a new objective made codex swap in only the objective while leaving status at
             * complete. A completed goal drives nothing, so to a person it looks like "it is
             * registered but does not do anything".
             *
             * The person writing a new goal **means to start over**. So we clear it once and set it
             * again — and if it is still not active after that, we state that status rather than
             * making one up.
             */
            let status = statusOf(first)
            if (status !== 'active') {
              await this.client.request('thread/goal/clear', { threadId: this.threadId }).catch(() => {})
              status = statusOf(await setGoal())
            }
            say(status === 'active' ? `Goal set: ${arg}` : `Goal set (${status}): ${arg}`)
          })
        }
        return (
          this.client
            .request('turn/start', {
              threadId: this.threadId,
              input: [{ type: 'text', text }],
              /*
               * Reasoning effort is passed per turn — this is the slot codex documents as applying
               * to "this turn and turns after it". It is cheaper this way, since it can be changed
               * without restarting the session.
               */
              ...(this.opts.effort ? { effort: this.opts.effort } : {}),
              ...this.outputSchemaParam(),
            })
            // The turn also rides along on the response — this covers the case where it arrives before the notification (the target of stop)
            .then((res) => {
              this.turnId ??= turnIdOf(res)
            })
        )
      })
      .catch((e: Error) => {
        // The thread never came up — watchBackgroundStart says so once, counting this message (#168, item 5)
        if (this.startFailed) return
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: e.message, retryable: true },
        })
      })
  }

  /** Sends the messages that were queued out as one turn — each message as its own input item (does not blur the boundary) */
  private flushPending(): void {
    if (this.pendingInputs.length === 0 || !this.threadId) return
    const input = this.pendingInputs.map((text) => ({ type: 'text', text }))
    this.pendingInputs = []
    void this.client
      .request('turn/start', {
        threadId: this.threadId,
        input,
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        ...this.outputSchemaParam(),
      })
      .then((res) => {
        this.turnId ??= turnIdOf(res)
      })
      .catch((e: Error) => {
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: e.message, retryable: true },
        })
      })
  }

  /**
   * A turn belonging to an agent that an app gave a schema and asked for (M4 D-1). Codex receives
   * the schema **per turn** — the installed 0.153.4's generated type is
   * `TurnStartParams.outputSchema` ("Optional JSON Schema used to constrain the final assistant
   * message for this turn"). So it is loaded onto every turn of this session: leaving it out even
   * once means that turn's last message is free text outside the schema. The answer is the last
   * message itself — the manager reads and validates that text as JSON. We could not re-verify by
   * running it while logged out (confirmed only from the generated type).
   */
  private outputSchemaParam(): Record<string, unknown> {
    return this.opts.outputSchema ? { outputSchema: this.opts.outputSchema } : {}
  }

  respondApproval(
    requestId: string,
    decision: ApprovalDecision,
    _scope?: ApprovalScope,
    matcher?: string,
  ): boolean {
    const serverId = this.approvals.get(requestId)
    // This map is empty when the thread has been started fresh — a card raised before that has no id here
    if (serverId === undefined) return false
    this.approvals.delete(requestId)

    if (this.elicitations.delete(requestId)) {
      /*
       * The answer to an app tool approval (M4 A-5). `always` is passed to Codex as "remember
       * this for the rest of the session" (`_meta.persist: "session"` -> ApprovedForSession).
       * Confirmed from source only (logged out, S-3): codex's
       * `parse_mcp_tool_approval_elicitation_response` reads accept together with this value.
       */
      this.client.respond(serverId, {
        action: decision === 'deny' ? 'decline' : 'accept',
        content: null,
        _meta: decision === 'always' ? { persist: 'session' } : null,
      })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
      return true
    }
    if (decision === 'always' && matcher) this.alwaysAllow.add(matcher)
    this.client.respond(serverId, { decision: toCodexDecision(decision) })
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    return true
  }

  /** Slash commands (skills) — the app-server's official RPC */
  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    const res = await this.client.request<{ data?: unknown }>('skills/list', {})
    const groups = Array.isArray(res?.data) ? res.data : []
    /*
     * compact is a built-in command, not a skill, so it does not appear in skills/list — but
     * autocomplete is drawn from this list, so leaving it out makes it a command that **exists but
     * is invisible** (hiding something that exists is also a lie the list tells). If codex ever
     * starts including it in the list, the dedupe below removes our own entry.
     */
    const out: { name: string; description?: string; argumentHint?: string }[] = [
      { name: 'compact', description: 'Summarizes the conversation to shrink context (built into codex)' },
      {
        name: 'review',
        description: 'Reviews the changed code (built into codex). If given an argument, reviews following that instruction instead',
        argumentHint: '[instruction]',
      },
    ]
    for (const g of groups) {
      const skills = (g as { skills?: unknown }).skills
      if (!Array.isArray(skills)) continue
      for (const s of skills) {
        const skill = (s ?? {}) as { name?: unknown; description?: unknown; enabled?: unknown }
        if (typeof skill.name !== 'string' || skill.enabled === false) continue
        if (out.some((c) => c.name === skill.name)) continue
        out.push({
          name: skill.name,
          description: typeof skill.description === 'string' ? skill.description : '',
        })
      }
    }
    return out
  }

  interrupt(): void {
    /*
     * Stops app calls made by this session (M4 A-5) — **even without a turn.** A call that had
     * already returned early past 240 seconds keeps running even after the turn ends. Work from a
     * session the person pressed stop on must not keep running in the background. The bridge does
     * not make this decision, so it is cut off here, at the host. The cancellation is carried by
     * the runtime down through the app and whatever it started.
     */
    this.opts.apps?.cancelAll()
    /*
     * The thread has not come up yet (a lazy resume is in progress) — reclaim the queued message
     * and go back to waiting for input (#168, sendsStopped). No turn/completed(interrupted) will
     * arrive either, since no turn was ever started — the state is flipped here instead.
     */
    if (!this.threadId && this.sendsIssued > this.sendsStopped) {
      this.sendsStopped = this.sendsIssued
      this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
      return
    }
    // Nothing to stop if no turn is running (this is the case of a stop pressed right after a turn just ended)
    if (!this.threadId || !this.turnId) return
    // Swallowing a failure here would leave us assuming it stopped and waiting — if it did not stop, say so
    void this.client
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch((err: Error) => {
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: `Could not stop: ${err.message}`, retryable: true },
        })
      })
  }

  /**
   * Stops one child agent (#290) by interrupting its own turn — measured to stop it (`turn/completed {interrupted}`
   * on the child), where interrupting the parent's turn leaves it running. Its ending arrives through the child's
   * notifications like any other. A command the child was running is not killed by Codex's interrupt (measured: its
   * process outlived the interrupt), which is Codex's own behaviour for every interrupted turn.
   */
  async stopBackgroundTask(taskId: string): Promise<void> {
    const turnId = this.children.turnOf(taskId)
    if (!turnId) throw new Error('That child agent has no running turn to stop')
    await this.client.request('turn/interrupt', { threadId: taskId, turnId })
  }

  /** The app-server is gone, and the child threads with it — each still listed ends as stopped. */
  private releaseChildren(): void {
    for (const e of this.children.release('Ended with the session process')) this.emit(e)
  }

  /**
   * The watchdog for a background resume (lazy resume only). If resume fails or exceeds the
   * ceiling after the handle has already been handed out, we cannot just go quietly to sleep — we
   * raise adapter_crashed so the manager retires the handle and the "resend if missing" automatic
   * recovery path can kick in.
   */
  watchBackgroundStart(): void {
    const timer = setTimeout(() => {
      if (this.closed) return
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'adapter_crashed',
          message: `Resuming codex did not finish within ${BACKGROUND_RESUME_CAP_MS / 1000}s`,
          retryable: true,
        },
      })
      void this.dispose().catch(() => {})
    }, BACKGROUND_RESUME_CAP_MS)
    this.ready.then(
      () => clearTimeout(timer),
      (e: Error & { code?: string }) => {
        clearTimeout(timer)
        if (this.closed) return
        /*
         * A lock error keeps its code (#168, item 5). Arriving here instead of inside the 3-second
         * window used to turn it into adapter_crashed, so the screen could not offer "continue in
         * a fork". Measured on 0.153.4: a second app-server resuming a held thread is refused with
         * -32600 "thread <id> already has an active writer" in 35 ms to 1.3 s, so this is rare,
         * but a slow start can push it past the window.
         *
         * Messages sent meanwhile were never delivered (send stays quiet about them, so the
         * failure is said once): the person is told, since the screen shows them as sent.
         */
        const unsent = this.sendsIssued - this.sendsStopped
        const note = unsent > 0 ? ` — ${unsent} message(s) sent while it was opening were not delivered` : ''
        const locked = e.code === 'conversation_locked'
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: locked ? 'conversation_locked' : 'adapter_crashed', message: e.message + note, retryable: true },
        })
        void this.dispose().catch(() => {})
      },
    )
  }

  /** Does not silently drop a pending approval (same reason as the claude adapter — the screen would be stuck holding the card) */
  async dispose(): Promise<void> {
    this.closed = true
    // App attachment closes together with the handle — a new handle gets its own
    this.opts.apps?.close()
    for (const requestId of this.approvals.keys()) {
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision: 'deny' })
    }
    this.approvals.clear()
    // Said before the process goes, while this handle is still the session's (the manager drops a stale handle's events)
    this.releaseChildren()
    /*
     * The case of dying together with messages that were waiting for a compact to finish — the
     * screen already shows them as sent (the manager records them first), so dropping them
     * silently would just resurrect the original bug at shutdown time. We have to say delivery
     * failed, so the user can resend.
     */
    if (this.pendingInputs.length > 0) {
      const n = this.pendingInputs.length
      this.pendingInputs = []
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'internal',
          message: `${n} message(s) sent during compaction were not delivered — please resend`,
          retryable: false,
        },
      })
    }
    await this.client.dispose()
  }

  /**
   * The turn an adopted thread is still running, asked for on its own (#342): a resume with `excludeTurns` answers
   * with no turns. Measured (codex-cli 0.160.0, 2026-10-05), a second `thread/resume` on the same connection while a
   * turn ran said `status: {type: 'active'}` and `turns: []`; `thread/turns/list` with `limit: 1`, newest first and
   * `itemsView: 'notLoaded'` named that turn as `inProgress` in 0.5 KB. Asked only for an active thread. A Codex
   * without the method answers with the turns in the resume itself, which `runningTurnOf` read first.
   */
  private async latestRunningTurn(res: Record<string, unknown>): Promise<string | null> {
    const status = (res.thread as { status?: { type?: unknown } } | undefined)?.status
    if (status?.type !== 'active' || !this.threadId) return null
    try {
      const page = await this.client.request<{ data?: unknown }>('thread/turns/list', {
        threadId: this.threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      })
      return runningTurnOf({ thread: { turns: page?.data } })
    } catch (err) {
      console.error(`[codex] ${this.sessionId.slice(0, 8)} could not ask for the running turn: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Lets go of the app-server without closing it (#280 step 2). No deny for a waiting approval —
   * the next host's `thread/resume` gets it re-sent under the same id — and no EOF, which would make
   * codex exit. The bridge processes codex started for this thread stay with codex.
   */
  async detach(): Promise<void> {
    this.opts.apps?.close()
    await this.client.detach()
    this.closed = true
  }
}

/** The approval kind named by an elicitation's `_meta` — 0.153.4 uses `codex_approval_kind`, current source uses `codex/approval_kind` */
function approvalKindOf(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null
  const m = meta as Record<string, unknown>
  const kind = m.codex_approval_kind ?? m['codex/approval_kind']
  return typeof kind === 'string' ? kind : null
}

/**
 * The content of an app tool approval card — which app's tool, with what arguments. Uses the tool
 * title (`tool_title`) and arguments (`tool_params`) that Codex loads into `_meta`, and falls back
 * to Codex's own sentence (`message`) when those are absent.
 */
function appApprovalDetail(server: string, message: unknown, meta: unknown): ApprovalDetail {
  const m = (typeof meta === 'object' && meta !== null ? meta : {}) as Record<string, unknown>
  const title = typeof m.tool_title === 'string' && m.tool_title ? m.tool_title : typeof message === 'string' ? message : ''
  const params = m.tool_params === undefined ? '' : ` ${JSON.stringify(m.tool_params).slice(0, 1000)}`
  return { kind: 'other', raw: `${server} · ${title}${params}` }
}

/** The turn reported as still running, if any (`thread.turns[].status === 'inProgress'`) — a resume's, or a turns page's */
function runningTurnOf(res: Record<string, unknown> | undefined): string | null {
  const turns = (res?.thread as { turns?: unknown } | undefined)?.turns
  if (!Array.isArray(turns)) return null
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] as { id?: unknown; status?: unknown }
    if (t?.status === 'inProgress' && typeof t.id === 'string') return t.id
  }
  return null
}

/** `{turn: {id}}` — the turn/started notification and the turn/start response give it in the same shape */
function turnIdOf(payload: unknown): string | null {
  const turn = (payload as { turn?: { id?: unknown } } | undefined)?.turn
  return typeof turn?.id === 'string' ? turn.id : null
}

function threadIdOf(res: Record<string, unknown> | undefined): string | null {
  if (!res) return null
  const thread = res.thread as Record<string, unknown> | undefined
  const id = (thread?.id ?? res.threadId) as string | undefined
  return typeof id === 'string' ? id : null
}

/**
 * Codex's settings folder.
 *
 * The codex CLI itself honors `CODEX_HOME` — if we alone hard-code the home path, we end up
 * answering whether a person using `CODEX_HOME` is logged in **by looking at the wrong folder**
 * (showing "login required" while actually logged in, or the reverse).
 */
function codexHome(): string {
  const custom = process.env.CODEX_HOME?.trim()
  return custom ? custom : join(homedir(), '.codex')
}

/**
 * The verbosity levels (#54). `model/list` does not report them per model, so we write them here
 * instead — but tied to the generated type (generated/Verbosity.ts, extracted by ts-rs from codex
 * source): if codex adds or removes a level, one of the two checks below **fails at compile time**.
 * Measured (codex exec, same question): low 82 words, high 269 words — the names earn their keep.
 */
const CODEX_VERBOSITIES = ['low', 'medium', 'high'] as const satisfies readonly Verbosity[]
// Checks that no level is missing — satisfies only catches a "wrong value", not a "missing value"
type MissingVerbosity = Exclude<Verbosity, (typeof CODEX_VERBOSITIES)[number]>
const _allVerbositiesListed: MissingVerbosity extends never ? true : never = true
void _allVerbositiesListed

export class CodexAdapter implements AgentAdapter {
  readonly tool = 'codex' as const

  readonly descriptor: ToolDescriptor = {
    name: 'codex',
    label: 'Codex',
    mark: 'X',
    install: 'npm i -g @openai/codex',
    login: 'codex login',
  }

  readonly capabilities: AdapterCapabilities = {
    approvals: true, // Measured in M0: thread/start's approvalPolicy overrides the global setting
    contextUsage: 'exact', // thread/tokenUsage/updated
    resume: true, // thread/resume
    autoTitle: true, // thread/name/updated
    attachments: ['image', 'file'],
    verbosities: [...CODEX_VERBOSITIES],
    // The app-server's writer lock ("already has an active writer" — the error client.ts
    // translates). This is a guarantee that every record change while we hold the handle is ours,
    // and the manager marks a catch-up skip on top of it (the basis for skipping a 48.6MB/8-second thread/read).
    exclusiveWriter: true,
    // Child agents, from their threads' status and turns (#290, CodexChildTracker)
    backgroundTasks: true,
  }

  /** The installed Codex CLI (#297), from npm's `package.json` where it came from npm, else `codex --version` */
  installedVersion(): Promise<string | null> {
    return installedCliVersion('codex', '@openai/codex')
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('codex')
    try {
      const launch = launchFor(path ?? 'codex')
      const { stdout } = await exec(launch.command, [...launch.args, '--version'], { timeout: 5000 })
      const version = `${stdout.trim()} · ${path ?? 'PATH'}`
      // Login status is judged by whether the auth file exists (cheap — no need to start the CLI)
      const loggedIn = existsSync(join(codexHome(), 'auth.json'))
      return {
        tool: 'codex',
        installed: true,
        loggedIn,
        detail: loggedIn ? version : `${version} · login required`,
      }
    } catch {
      return {
        tool: 'codex',
        installed: false,
        loggedIn: false,
        detail: 'codex CLI not found (check with `which codex` in a terminal)',
      }
    }
  }

  listExternalSessions(cwd: string, limit: number) {
    return listCodexThreads(cwd, limit, whichTool('codex') ?? 'codex')
  }

  /**
   * Splits off a new thread from a locked conversation (`thread/fork`).
   *
   * Uses a **short-lived client**, for the same reason as the usage lookup — this happens
   * **before** a session is created, not as part of one, so there is no thread yet to hold onto.
   *
   * The original is left untouched. Codex leaves the provenance on the new thread as `forkedFromId`.
   */
  async forkConversation(externalId: string, cwd: string): Promise<string> {
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
      { cwd, command: whichTool('codex') ?? 'codex' },
    )
    try {
      await client.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: null,
      })
      client.notify('initialized')
      // Only the new id is read: the forked history stays with Codex (#342, the same deprecation as resume's)
      const res = await client.request<Record<string, unknown>>('thread/fork', { threadId: externalId, excludeTurns: true })
      const forked = threadIdOf(res)
      // Claiming a fork happened without giving a new id leaves nothing to continue from — falling back to the original silently would just be locked again
      if (!forked) throw new Error('codex forked the conversation but returned no thread id')
      return forked
    } finally {
      await client.dispose()
    }
  }

  /**
   * Deletes the original thread (the thread/delete RPC). A short-lived client, for the same reason
   * as fork — the session has already been disposed of, so there is no process left to hold onto.
   * This call is what makes the tool itself reclaim the rollout file (measured: a 550MB one
   * disappears here).
   */
  async deleteExternalConversation(externalId: string, cwd: string): Promise<void> {
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
      { cwd, command: whichTool('codex') ?? 'codex' },
    )
    try {
      await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
      client.notify('initialized')
      await client.request('thread/delete', { threadId: externalId })
    } catch (e) {
      /*
       * **Asking to delete something that does not exist is not a failure** (dogfooding
       * 2026-09-07: trying to delete a worktree session that had been created by mistake gave
       * "Could not delete: no rollout found for thread id …").
       *
       * Measured: codex only issues the thread id at thread/start and writes the rollout file on
       * **the first turn**. So a session that never had a single message exchanged has no file to
       * delete, and thread/delete rejects it with -32600. Throwing that rejection as-is would stop
       * the manager here and leave neither the session row nor the worktree deleted — the more
       * mistaken the session, the less deletable it would become.
       *
       * The goal ("make sure nothing is left on the tool side") is already achieved, so we treat
       * this as success. Any other failure is still thrown — the rule that answering "deleted"
       * while the original still exists is the worst outcome (per the manager's own comment) still
       * holds.
       */
      if (!/no rollout found/i.test((e as Error).message)) throw e
    } finally {
      await client.dispose()
    }
  }

  /** The last compact summary of a dead codex process (#78) — read from the rollout file, with no binary involved (rollout.ts) */
  async lastCompactSummary(externalId: string): Promise<string | null> {
    return rolloutLastCompactSummary(externalId)
  }

  /**
   * Account usage (FR-9).
   * Asked with a short-lived client, since it has nothing to do with any session — we do not
   * pile the lookup onto a thread that is mid-conversation.
   */
  async listUsage() {
    return readCodexUsage(whichTool('codex') ?? 'codex')
  }

  async listModels() {
    return listCodexModels(whichTool('codex') ?? 'codex')
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readCodexHistory(externalId, cwd, limit, whichTool('codex') ?? 'codex')
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const session = new CodexSession(opts, emit)
    /*
     * **Resume works like Claude's — we do not make the person wait for it** (dogfooding: the same
     * thread took 3 seconds in the CLI, 13+ seconds on our path. We cannot remove the cost of
     * thread/resume re-reading the whole file, but there is no reason to make the person pay that
     * cost in front of a "Waking…" screen — resume already knows the thread id, so handing out the
     * handle early loses nothing. send gets queued on ready). Since #342 the answer no longer carries
     * the history (`excludeTurns`); what Codex itself spends loading a long rollout was not measured
     * again, so the early handle stays.
     *
     * We do wait synchronously for 3 seconds, though: a lock error ("already has an active writer")
     * arrives immediately (measured ~0.3s), so it has to be thrown within this window for the
     * "open elsewhere -> split off and continue" fork-in-the-road UI to keep working as it does now.
     * A brand-new thread (thread/start) still waits all the way to completion as before — resume is
     * only possible once an id exists (a lesson from M1.5 defect 5).
     */
    if (opts.resumeExternalId) {
      session.externalId = opts.resumeExternalId
      const outcome = await Promise.race([
        session.ready.then(
          () => 'ready' as const,
          (err: unknown) => ({ err }),
        ),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), LAZY_RESUME_WAIT_MS)),
      ])
      if (outcome === 'pending') {
        session.watchBackgroundStart()
        return session
      }
      if (outcome !== 'ready') {
        await session.dispose().catch(() => {})
        throw outcome.err
      }
      return session
    }
    try {
      await session.ready
    } catch (err) {
      /*
       * A session that failed to become ready never has its handle handed out — there is nobody
       * left to call dispose on it. If we did not reclaim the app-server the constructor already
       * started here, a child process would leak silently, one at a time, every time resuming a
       * locked thread failed.
       */
      await session.dispose().catch(() => {})
      throw err
    }
    return session
  }
}

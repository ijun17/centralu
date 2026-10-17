import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { PermissionPreset } from '@cc/protocol'
import { toolCommand } from '../../tool-launch.js'
import { codexLaunch } from './native.js'
import type { AgentProcess, CreateSessionOpts, ProcessSource } from '../contract.js'

/**
 * Permission preset to Codex permission options.
 *
 * **Same principle** as the Claude side: for normal, we do not decide anything and defer to
 * the tool's own settings (`~/.codex/config.toml`) for approval and sandbox mode. Workspace-write
 * details follow the preset separately (sandboxConfig). Auto runs without a sandbox, matching
 * Claude's bypass permissions; safe and normal workspace-write keep network disabled (#582, #585).
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
export function permissionOptionsFor(preset: PermissionPreset): Record<string, unknown> {
  if (preset === 'safe') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } // asks about everything
  if (preset === 'auto') return { approvalPolicy: 'never', sandbox: 'danger-full-access' } // asks about nothing
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
 * Normal follows the person's own policy (#382, owner decision 2026-10-11). Normal defers to the
 * person's config.toml (permissionOptionsFor), and with their `approval_policy = "never"` Codex
 * refuses a tool that `writes` would have asked about ("requires approval, but approval policy is
 * never"), where Claude lets the same call through under the person's bypass. So under normal the
 * mode comes from that policy (`appApprovalModeFor`, read by `CodexSession.personsApprovalPolicy`):
 * `never` → `approve`, anything else → `writes`.
 */
export const APP_APPROVAL_MODE: Record<PermissionPreset, 'approve' | 'writes' | 'prompt'> = {
  auto: 'approve',
  normal: 'writes',
  safe: 'prompt',
}

export type AppApprovalMode = 'approve' | 'writes' | 'prompt'

/**
 * The mode for an app bridge, given the policy the person's own Codex settings resolve to (#382). Only normal
 * reads it: safe and auto set the thread's policy themselves (permissionOptionsFor). Only `never` is a bypass; a
 * granular policy or an unreadable one keeps `writes`, which asks where Codex can ask and refuses where the
 * person's policy refuses, as before.
 */
export function appApprovalModeFor(preset: PermissionPreset, personsPolicy: unknown): AppApprovalMode {
  if (preset !== 'normal') return APP_APPROVAL_MODE[preset]
  return personsPolicy === 'never' ? 'approve' : 'writes'
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
export const APP_STARTUP_TIMEOUT_SEC = 30

/**
 * An app-server spawned in the keeper (#280 step 2), from the same program a direct spawn uses: the platform binary
 * rather than npm's `node` wrapper (#568, native.ts).
 */
export function spawnInKeeper(source: ProcessSource, cwd: string): AgentProcess {
  const launch = codexLaunch(toolCommand('codex'))
  return source.spawn({ command: launch.command, args: [...launch.args, 'app-server'], cwd, env: launch.env(process.env) })
}

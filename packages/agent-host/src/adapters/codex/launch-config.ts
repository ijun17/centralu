import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { PermissionPreset } from '@cc/protocol'
import { readsRepoFiles, type CreateSessionOpts } from '../contract.js'

/**
 * Permission preset to Codex permission options.
 *
 * **Same principle** as the Claude side: for normal, we do not decide anything and defer to
 * the tool's own settings (`~/.codex/config.toml`) for approval and sandbox mode. Workspace-write
 * details follow the preset separately (sandboxConfig). Auto runs without a sandbox, matching
 * Claude's bypass permissions; safe and normal workspace-write keep network disabled (#582, #585).
 *
 * Both approvalPolicy and **sandbox** are left alone: a pinned 'workspace-write' blocks anything outside the working
 * folder without asking, even when the user's config.toml says danger-full-access.
 */
/*
 * "My settings" means the user's own `~/.codex/config.toml` — the repository's
 * `.codex/config.toml` only enters the picture when the project is trusted (repoFilesConfig, #92).
 */
export function permissionOptionsFor(preset: PermissionPreset): Record<string, unknown> {
  // `edits` (#1525) launches as `normal` does: the person's own policy and sandbox. Its one grant, a patch inside the
  // folder, is answered by the adapter (`server-requests.ts`, `edit-grant.ts`), since Codex has no mode that
  // accepts patches and asks for commands
  if (preset === 'safe') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } // asks about everything
  if (preset === 'auto') return { approvalPolicy: 'never', sandbox: 'danger-full-access' } // asks about nothing
  return {} // defer to the user's own settings
}

/**
 * Keeps the repository's files from altering this thread (M4 decision 3, #92, #152; docs/security-boundaries/project-trust.md
 * "Repository configuration and project trust"): an untrusted project, or `noSettingFiles` (the manager decides from the
 * session kind and project, not from whether it receives tools). Read from codex source (main 75e0e0a, 2026-09-25) and
 * the installed 0.153.4 binary's strings, not by a logged-in run:
 *   - with trust **unset** and a writable cwd, app-server persists the folder as trusted in `~/.codex/config.toml`
 *     (`set_project_trust_level`, `thread_processor.rs`, only when `trust_level.is_none()`); `untrusted` also disables the
 *     repository's config, hooks and exec policy (`disabled_reason_for_decision`) and AGENTS.md (`agents_md.rs`)
 *   - the per-thread `config` is the CLI's `-c` layer, which `project_trust_context` reads; a folder's own key wins
 *     (`decision_for_dir`), so every ancestor is written, as written and real (`normalized_project_trust_keys`)
 *   - `project_doc_max_bytes: 0`: measured on the Assistant (a planted AGENTS.md stopped being followed); `~/.codex/AGENTS.md` still loads
 */
export function repoFilesConfig(opts: Pick<CreateSessionOpts, 'cwd' | 'projectTrusted' | 'noSettingFiles'>): Record<string, unknown> {
  if (readsRepoFiles(opts)) return {}
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

/** The presets that leave the thread's approval policy and sandbox to the person's own Codex settings: `normal`, and `edits` (#1525), which is `normal` plus a grant */
export const followsPersonsPolicy = (preset: PermissionPreset): boolean => preset === 'normal' || preset === 'edits'

/**
 * The ceiling for a single MCP tool call — **pinned in writing** to Codex's own code default
 * (300 seconds since 0.145). Relying on the default means that the day Codex changes the value,
 * our handling of long calls (answering at 240 seconds, `BRIDGE_ANSWER_MS`) would silently go out of sync.
 * The field name (`tool_timeout_sec`) was confirmed only from the binary and source.
 */
export const CODEX_TOOL_TIMEOUT_SEC = 300

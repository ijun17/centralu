import { resolveSettings, filterEscalatingDefaultMode, type PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import type { Question } from '@cc/protocol'
import { APP_MCP_PREFIX } from '../../apps/contract.js'
import type { CreateSessionOpts } from '../contract.js'
import { ORCHESTRATOR_MCP_NAME } from './orchestrator-mcp.js'

/**
 * AskUserQuestion's arguments to our own `Question[]`.
 *
 * This reads the raw shape directly rather than trusting the SDK's type (a boundary rule). If the
 * shape is off, it returns an empty array and **lets it fall through the ordinary path** — better
 * than presenting a half-drawn set of choices.
 */
export function parseQuestions(input: unknown): Question[] {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const q of raw) {
    const o = (q ?? {}) as Record<string, unknown>
    const opts = Array.isArray(o.options) ? o.options : []
    const options = opts
      .map((x) => {
        const t = (x ?? {}) as Record<string, unknown>
        return { label: String(t.label ?? ''), description: String(t.description ?? '') }
      })
      .filter((x) => x.label !== '')
    if (typeof o.question !== 'string' || options.length === 0) continue
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      options,
      multiSelect: o.multiSelect === true,
    })
  }
  return out
}

/**
 * Is this tool one belonging to **our own in-process server** (the judgment behind the approval
 * exception)?
 *
 * An MCP tool name has the shape `mcp__<server>__<tool>`, with `__` as the separator. So a prefix
 * check (`startsWith('mcp__centralu__')`) cannot see the server name itself — a server named
 * `centralu__pw` producing `mcp__centralu__pw__navigate` also passed that check, and that tool
 * bypassed `canUseTool` entirely (measured, #93).
 *
 * This counts segments and judges by **the full server name** instead. None of our own tool
 * names contain `__` (list_sessions, propose_mcp_server, and so on all use a single underscore),
 * so there are exactly three segments. The name is already blocked on the naming side
 * (`mcpServerNameError`), but a place that grants trust must not rely on another layer's check —
 * it has to be correct on its own.
 */
export function isOrchestratorTool(toolName: string): boolean {
  const parts = toolName.split('__')
  return parts.length === 3 && parts[0] === 'mcp' && parts[1] === ORCHESTRATOR_MCP_NAME
}

/**
 * If this tool belongs to an external app's proxy server, its server and tool name (M4 A-5) —
 * `mcp__app-<id>__<tool>`.
 *
 * This counts segments for the same reason as above. An app id never contains an underscore and
 * an app's own tool names never contain `__` (two rules enforced in manifest.ts), so a tool that
 * is ours has exactly three segments. This never grants anything based on the name alone —
 * whether it is read-only is asked of the attached app's own list (`SessionApps.readOnly`).
 */
export function appToolOf(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split('__')
  if (parts.length !== 3 || parts[0] !== 'mcp' || !parts[1]!.startsWith(APP_MCP_PREFIX)) return null
  return { server: parts[1]!, tool: parts[2]! }
}

/** The tools that only read — the ones a read grant (#371, `CreateSessionOpts.mayRead`) lets through without a card */
export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/** The path a read tool reads: Read's file, or the folder Glob and Grep search in (absent means the working folder) */
export function readTarget(toolName: string, input: Record<string, unknown>): string | null {
  const p = toolName === 'Read' ? input.file_path : input.path
  return typeof p === 'string' && p ? p : null
}

/**
 * Normal follows the selected settings, with manual approvals when no mode was chosen.
 * Since SDK 0.3.286, omitting permissionMode can select the CLI's automatic classifier
 * instead. Resolve with the SDK's own merge engine and trust filter, then pass the mode
 * explicitly on start and resume. In particular, a committed project file cannot turn
 * normal into bypassPermissions; only a trusted settings choice can (#92, #578).
 */
export async function permissionOptionsFor(opts: CreateSessionOpts): Promise<{ permissionMode: PermissionMode }> {
  if (opts.permissionPreset === 'auto') return { permissionMode: 'bypassPermissions' }
  if (opts.permissionPreset === 'safe') return { permissionMode: 'default' }
  if (opts.noSettingFiles) return { permissionMode: (await personsDefaultMode()) ?? 'default' }
  try {
    const resolved = await resolveSettings({ cwd: opts.cwd, ...settingSourcesFor(opts) })
    const mode = filterEscalatingDefaultMode(resolved).permissions?.defaultMode
    if (typeof mode === 'string' && (PERMISSION_MODES as readonly string[]).includes(mode)) {
      return { permissionMode: mode as PermissionMode }
    }
  } catch {
    // A settings read failure must not silently select the CLI's automatic mode.
  }
  return { permissionMode: 'default' }
}

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

/**
 * The person's own default mode, for a session that reads no settings files (#382, owner decision 2026-10-11).
 *
 * The orchestrator and coordinators read no files (`settingSourcesFor`: `[]`), so under normal the CLI found no
 * `defaultMode` and the person's global bypass did not reach them: app tools and their own commands asked. On Codex
 * the same sessions load `~/.codex` and the bypass applies. The owner chose the direction of decision 1 (the person's
 * policy applies), so the two now agree: the person's mode is carried, and nothing else is. Their `CLAUDE.md`, hooks
 * and rules stay out, because an instruction arriving through a file is what `[]` exists to keep away from a session
 * that directs others.
 *
 * Read with the SDK's own merge engine (`resolveSettings`, "the same engine as the CLI") from the user tier only,
 * which honours `CLAUDE_CONFIG_DIR` and the managed policy tier the way the CLI does. A mode the SDK does not know,
 * or a read that fails, falls back to explicit manual approvals.
 */
export async function personsDefaultMode(): Promise<PermissionMode | null> {
  try {
    const resolved = await resolveSettings({ cwd: homedir(), settingSources: ['user'] })
    const mode = resolved.effective.permissions?.defaultMode
    return typeof mode === 'string' && (PERMISSION_MODES as readonly string[]).includes(mode) ? (mode as PermissionMode) : null
  } catch {
    return null
  }
}

/**
 * Which settings files get read (M4 decision 3, #92, #152) — **so that a file committed to the
 * repo cannot be able to decide an approval.**
 *
 *   orchestrator/coordination sessions (noSettingFiles)   []        reads no files at all (see the comment on the query option below)
 *   trusted project / a user-folder app's session          omitted   user, project and local, all of it — the CLI's own default
 *   untrusted project                                       ['user'] only the user's own settings (~/.claude)
 *
 * **Which row applies is decided by the manager, based on the session's kind and project, and
 * passed down** (the manager's `settingFilesFor`). This must never be inferred from whether the
 * session receives tools — it once was: `orchestratorTools` being set used to mean `[]`, but the
 * worktree manager and builder sessions also receive those tools. A builder session in a trusted
 * project could then read neither CLAUDE.md nor the user's own ~/.claude (the global bypass),
 * which popped an approval card the person had turned off everywhere else. Measured (launching a
 * builder session through this adapter and having it run `touch`, normal, CLI 2.1.282, haiku,
 * 2026-09-25): before (`[]`) — card popped up, project hooks did not run, CLAUDE.md was not read;
 * now (omitted) — no card (the user's own bypass), hooks ran, CLAUDE.md was read. The orchestrator
 * still reads nothing; since #382 it is given the person's own mode instead (`personsDefaultMode`), so it
 * no longer pops a card the person turned off everywhere else.
 *
 * A `.claude/` planted in the repo was able to disable our own approval card. Measured
 * (probe-project-trust.mts, CLI 2.1.282, SDK 0.3.263, planted into a temp folder standing in for
 * a checked-out repo and had it run `touch`; the user's own settings were left untouched):
 *
 *   planted                                    preset  omitted (reads everything)    ['user']
 *   permissions.allow in settings.json          safe    callback called               callback called
 *   allow in settings.local.json                safe    **not called**                callback called
 *   PreToolUse hook (allow) in settings.json    safe    **not called**, hook runs      callback called, hook does not run
 *   the same hook                               normal  not called                    not called ← decided by the user's own settings (bypass)
 *   CLAUDE.md, .claude/commands                 -       read, shows up in the list     not read, does not show up
 *
 * The CLI already did not honor allow rules from a committed settings.json. The actual holes were
 * settings.local.json (usually excluded from git, but it can still be committed) and hooks, and
 * both disabled the card **even in safe**. A hook is itself an arbitrary command as well.
 *
 * Why normal still follows the person's settings in an untrusted project: decision 3
 * disables files from the repo, not the person's own choice. If the user set bypass in their own
 * ~/.claude, that wins (see the last row of the table) — that is the person's own decision, made
 * to apply everywhere. Overriding even the user's own `defaultMode` to force 'default' and always
 * ask, just because the folder is untrusted, would turn this app into something that forces a
 * workflow. Someone who wants a card everywhere already has safe for that.
 */
export function settingSourcesFor(opts: Pick<CreateSessionOpts, 'noSettingFiles' | 'projectTrusted'>): Record<string, unknown> {
  if (opts.noSettingFiles) return { settingSources: [] }
  if (opts.projectTrusted === true) return {}
  return { settingSources: ['user'] }
}

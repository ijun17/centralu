import { resolveSettings, filterEscalatingDefaultMode, type PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import { mcpNameParts, type Question } from '@cc/protocol'
import type { CreateSessionOpts } from '../contract.js'
import { CENTRALU_MCP_NAME } from './centralu-mcp.js'

/**
 * AskUserQuestion's arguments to our own `Question[]`, read from the raw shape (a boundary rule). A shape that is off
 * gives `[]` and **falls through the ordinary path** rather than a half-drawn set of choices.
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

/** A Claude tool name's server and tool, when the tool part holds no `__`: with one, the name is another server's, however it begins (#93) */
function ownServerTool(toolName: string): { server: string; tool: string } | null {
  const parts = mcpNameParts(toolName)
  return parts && !parts.tool.includes('__') ? parts : null
}

/**
 * Is this tool one belonging to **our own in-process server** (the judgment behind the approval exception)?
 *
 * Not a prefix check (`startsWith('mcp__centralu__')`): a server named `centralu__pw` makes `mcp__centralu__pw__navigate`,
 * which passes it and bypasses `canUseTool` (measured, #93). This reads the name as the screen does (`mcpNameParts`) and
 * judges by **the full server name**; none of our tool names contain `__`, so a tool part with one is another server's
 * (`ownServerTool`). The naming side blocks such names too (`mcpServerNameError`), but a place that grants trust must
 * be correct on its own.
 */
export function isCentraluToolName(toolName: string): boolean {
  return ownServerTool(toolName)?.server === CENTRALU_MCP_NAME
}

/** The tools that only read — the ones a read grant (#371, `CreateSessionOpts.mayRead`) lets through without a card */
export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/** The path a read tool reads: Read's file, or the folder Glob and Grep search in (absent means the working folder) */
export function readTarget(toolName: string, input: Record<string, unknown>): string | null {
  const p = toolName === 'Read' ? input.file_path : input.path
  return typeof p === 'string' && p ? p : null
}

/**
 * Normal (and `edits`, which differs only in `canUseTool`) follows the selected settings, with manual approvals when no mode was chosen.
 * Since SDK 0.3.286, omitting permissionMode can select the CLI's automatic classifier
 * instead. Resolve with the SDK's own merge engine and trust filter, then pass the mode
 * explicitly on start and resume. In particular, a committed project file cannot turn
 * normal into bypassPermissions; only a trusted settings choice can (#92, #578).
 */
export async function permissionOptionsFor(opts: CreateSessionOpts): Promise<{ permissionMode: PermissionMode }> {
  if (opts.permissionPreset === 'auto') return { permissionMode: 'bypassPermissions' }
  if (opts.permissionPreset === 'safe') return { permissionMode: 'default' }
  // `edits` (#1525) launches as `normal` does; its one grant, edits inside the folder, is `canUseTool`'s (not `acceptEdits`)
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

/** The tools a settings rule `Edit(...)`, `Write(...)` and the like names: the ones the `edits` grant answers for */
const EDIT_RULE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Whether the person's (or the policy's) settings have an `ask` rule for a file-editing tool (#1525). The person's own ask
 * rules win over `edits`: a rule they wrote to be asked about `Write(secret/**)` is their stated intent, and the CLI hands
 * such an ask to `canUseTool` like any other. The rule's path pattern is not matched here (its syntax is the CLI's); a
 * session with any such rule gets no `edits` grant at all, and so does one whose settings cannot be read.
 */
export async function editAskRuleExists(opts: Pick<CreateSessionOpts, 'cwd' | 'noSettingFiles' | 'projectTrusted'>): Promise<boolean> {
  try {
    const resolved = await resolveSettings({ cwd: opts.cwd, ...settingSourcesFor(opts) })
    const ask: unknown = resolved.effective.permissions?.ask
    if (ask === undefined) return false
    if (!Array.isArray(ask)) return true
    return ask.some((rule: unknown) => typeof rule !== 'string' || EDIT_RULE_TOOLS.has((rule.split('(')[0] ?? '').trim()))
  } catch {
    return true
  }
}

const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

/**
 * The person's own default mode, for a session that reads no settings files (#382, owner decision 2026-10-11).
 *
 * The Assistant and coordinators read no files (`settingSourcesFor`: `[]`), so the CLI would find no `defaultMode` and
 * the person's global bypass would not reach them, while Codex's same sessions load `~/.codex`. The person's policy
 * applies (decision 1): their mode is carried and nothing else. Their `CLAUDE.md`, hooks and rules stay out: an
 * instruction arriving through a file is what `[]` keeps away from a session that directs others.
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
 * Which settings files get read (M4 decision 3, #92, #152): **a file committed to the repo must not decide an approval**.
 * The rules and the measured holes: docs/security-boundaries/project-trust.md "Repository configuration and project trust"
 * (a planted hook is itself an arbitrary command, and `settings.local.json` can be committed).
 *   assistant/coordination sessions (noSettingFiles)   []        no files (only the person's mode: `personsDefaultMode`)
 *   trusted project / a user-folder app's session      omitted   user, project and local: the CLI's own default
 *   untrusted project                                   ['user'] only the user's own settings (~/.claude)
 * The row is the manager's (launch-inputs.ts `settingFilesFor`), never inferred from whether the session receives tools:
 * builder and worktree-manager sessions get them too, and with `[]` in a trusted project they read no CLAUDE.md or hooks
 * and popped a card the person's own bypass had turned off (measured, normal, CLI 2.1.282, haiku, 2026-09-25).
 * Normal still follows the person's own ~/.claude in an untrusted project (their bypass wins, measured): decision 3
 * disables the repo's files, not the person's choice, and safe is there for a card everywhere.
 */
export function settingSourcesFor(opts: Pick<CreateSessionOpts, 'noSettingFiles' | 'projectTrusted'>): Record<string, unknown> {
  if (opts.noSettingFiles) return { settingSources: [] }
  if (opts.projectTrusted === true) return {}
  return { settingSources: ['user'] }
}

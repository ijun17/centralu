import { z } from 'zod'
import { PermissionPreset, ToolName } from './ids.js'

/**
 * Everything a screen needs to *present* a tool: its name, its mark, and the two
 * commands that fix a tool that isn't ready.
 *
 * Why the shape lives here. Both sides read it — the host names the tool in its "no
 * record of this conversation" message, and `@cc/agent-host` depends on this package and
 * not on `@cc/core`. This is the only shelf both sides can reach.
 *
 * **Why the values do not.** They used to: a `TOOL_META` record right here held the
 * labels, the glyphs, and the install and login commands for two named vendors. Adding a
 * tool meant editing the shared protocol, which is the opposite of what an adapter is
 * for. Each adapter now carries its own descriptor, and they reach the UI through
 * `agents.detect`.
 *
 * This is presentation, not capability. What a tool can *do* is declared by its adapter
 * (`AdapterCapabilities`, `ModelOption`) and must never be listed here — that split is
 * what keeps a new knob from having to be taught to the UI twice.
 */
export const ToolDescriptor = z.object({
  name: ToolName,
  label: z.string(),
  /** One glyph, because the session chip is 14px square and a word does not fit */
  mark: z.string(),
  install: z.string(),
  login: z.string(),
})
export type ToolDescriptor = z.infer<typeof ToolDescriptor>

/**
 * A descriptor and whether that tool can actually be used on this machine right now.
 *
 * One type rather than two lists to join: the screens that draw a row per tool need both
 * halves at once, and a join done in a component is a join that can be done wrong.
 */
export const ToolStatus = ToolDescriptor.extend({
  installed: z.boolean(),
  loggedIn: z.boolean(),
  detail: z.string(),
})
export type ToolStatus = z.infer<typeof ToolStatus>

/**
 * How hard a job start_agent hands over is (#729): what a calling agent says instead of naming a model, so the
 * person's own choice of model per tool applies (`UiPreferences.agentModels`). Light: lookups, small fixes, reviews of
 * small changes. Heavy: design, security boundaries, data-loss risk, large refactors. Standard: the rest.
 */
export const AgentDifficulty = z.enum(['light', 'standard', 'heavy'])
export type AgentDifficulty = z.infer<typeof AgentDifficulty>

/** One difficulty's model for one tool (#729). The effort belongs to the model, as a project's remembered one does (#107) */
export const AgentModelChoice = z.object({ model: z.string().min(1).max(200), effort: z.string().min(1).max(80).optional() })
export type AgentModelChoice = z.infer<typeof AgentModelChoice>

/** Per tool (a registry name), per difficulty: what start_agent runs when a caller names a difficulty and no model */
export const AgentModels = z.record(z.string().max(80), z.object({
  light: AgentModelChoice.optional(),
  standard: AgentModelChoice.optional(),
  heavy: AgentModelChoice.optional(),
}))
export type AgentModels = z.infer<typeof AgentModels>

/**
 * An adapter's capability declaration — the UI enables or disables features based on this
 * (architecture §6.2).
 *
 * **Anything knowable from whether an optional method exists does not go here.** A flag and the
 * implementation can drift apart: there used to be a listExternal flag, and when it was true but
 * the method did not exist, nothing happened, silently. The answer to "can it do this?" has to
 * be single-sourced — if the method exists, it can. What remains here is only the properties a
 * method cannot express (whether approvals are supported, context accuracy, and so on).
 */
export const AdapterCapabilities = z.object({
  approvals: z.boolean(),
  contextUsage: z.enum(['exact', 'estimate', 'none']),
  resume: z.boolean(),
  autoTitle: z.boolean(),
  attachments: z.array(z.enum(['image', 'file'])).default([]),
  /**
   * The response-length (verbosity) tiers. Empty means this tool has no such knob (#54).
   *
   * Why this is not attached to the model instead: codex's `model/list` does not report
   * verbosity per model (that field is absent from generated/v2/Model.ts — measured). Attaching
   * it to the model would mean inventing it ourselves, which breaks the rule against hardcoding
   * the list. A per-tool property belongs in the adapter's capability declaration.
   */
  verbosities: z.array(z.string()).default([]),
  /**
   * The guarantee that while we hold the handle, **nobody else can write to this conversation**
   * (2026-09-02).
   *
   * True for codex — the app-server puts a writer lock on the thread, and opening it a second
   * time is rejected with "already has an active writer" (the adapter even translates that
   * error). Not true for claude: its conversation file has no lock, so in principle something
   * outside can write to it concurrently.
   *
   * Only on top of this guarantee does the manager stamp "the moment the handle is released
   * equals everything up to here is something I already know" (the skip in
   * syncImportedHistory). Stamping it on a tool without this guarantee would mean anything
   * written from outside while the session was alive never gets pulled in — which is why the
   * default is false.
   */
  exclusiveWriter: z.boolean().default(false),
  /**
   * Whether this tool reports its background work (#290, the `background_tasks` event). Not an optional method:
   * reporting is a stream of events, and nothing else says whether silence means "none running" or "cannot see".
   * The idle check (#297) needs that difference — a session whose background work is invisible is never called idle.
   */
  backgroundTasks: z.boolean().default(false),
  /** Whether send accepts input during a running turn without interrupting it (#592). Absent is unsupported. */
  midTurnInput: z.boolean().optional(),
  /**
   * Whether the adapter can put every step of the CLI's own that is not a read to the host's card in a turn the host names, whatever the session's
   * preset (#1447, a session's request to the orchestrator). Claude: a `PreToolUse` hook, which sees every tool call in every permission mode
   * (measured: a narrower mode alone leaves out the tools that need no permission). Absent is false: a session of the tool cannot be asked for by
   * another session
   */
  gatesSteps: z.boolean().optional(),
  /**
   * Whether this tool can defer individual Centralu tool definitions until the model asks for
   * them. This is a serving property, not a list of tool names: the host uses it when it counts
   * the prefix a kept process was started with.
   */
  toolDeferral: z.boolean().optional(),
  /** Where Centralu's tool instructions reach the model. */
  instructionChannel: z.enum(['server', 'developer']).optional(),
  /** How the adapter owns agent processes. A shared server may host several conversations. */
  processModel: z.enum(['per-session', 'shared-server']).optional(),
  /** Whether the CLI has child agents whose events the adapter normalizes for the host. */
  builtInSubagents: z.boolean().optional(),
  /** Whether the CLI has a direct peer-to-peer messaging path outside Centralu's own session tools. */
  peerMessaging: z.boolean().optional(),
  /**
   * Whether an idle session of this tool may be put to sleep (#568): its process ended, the conversation resumed by
   * the next message. True only where that was measured to lose nothing a person would notice. Claude: a resumed
   * process reads the prompt cache as a live one does (~100% at 2, 6 and 10 minutes on the 1 h lifetime), for +0.7 s
   * (p50) before the first token (#561). Absent is false: a tool whose resume is slow or untested keeps its process.
   */
  sleep: z.boolean().optional(),
  /**
   * The permission presets this tool can keep (docs/plans/acp-adapter.md §5.3). Absent: every preset. Cursor's ACP
   * server has no switch that makes it ask before every change, so it does not list `safe`, and a session asked to run
   * it under `safe` is refused (`launchRefusal`) rather than run under a promise it cannot keep.
   */
  presets: z.array(PermissionPreset).optional(),
  /**
   * Whether the tool can be kept from reading the repository's own files (`.cursor/rules`, `AGENTS.md`, its config)
   * when the project is not trusted (#92). Absent: true. False: it runs only in trusted projects.
   */
  keepsRepoFilesOut: z.boolean().optional(),
  /**
   * Whether the tool takes Centralu's role text (`systemPromptAppend`). Absent: true. False: it cannot be a session that
   * is given one (the orchestrator, a coordinator, an app's agent), nor one that must read no setting files.
   */
  roleText: z.boolean().optional(),
})
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>

/** What a launch asks of a tool that `launchRefusal` checks: the part of a session's start settings a tool may not keep */
export type LaunchDemands = {
  permissionPreset: PermissionPreset
  /** Absent means untrusted, as for the adapters (`CreateSessionOpts.projectTrusted`) */
  projectTrusted?: boolean
  noSettingFiles?: boolean
  /** Whether the session is given role text (`systemPromptAppend`) */
  roleText?: boolean
}

/**
 * Why `label`'s tool cannot run a session that demands this, or null when it can. The one rule for both sides: the host
 * refuses a launch with it, and a picker shows the same words beside a tool it greys out.
 */
export function launchRefusal(caps: AdapterCapabilities, label: string, demands: LaunchDemands): string | null {
  if (caps.roleText === false && (demands.roleText || demands.noSettingFiles)) {
    return `${label} cannot take Centralu's role instructions yet, so it cannot run the orchestrator, a coordinator or an app's agent.`
  }
  if (caps.keepsRepoFilesOut === false && !demands.projectTrusted) {
    return `${label} cannot be kept from reading a project's own files (such as AGENTS.md and its rules), so it runs only in trusted projects.`
  }
  if (caps.presets && !caps.presets.includes(demands.permissionPreset)) {
    return `${label} has no way to ask before every change, so it cannot run under ${PRESET_LABEL[demands.permissionPreset]}.`
  }
  return null
}

const PRESET_LABEL: Record<PermissionPreset, string> = { safe: 'Safe', normal: 'Normal', edits: 'Edits', auto: 'Auto' }

/**
 * One selectable model.
 *
 * **We never write down this list ourselves.** It carries exactly what the tool reports through
 * its official API (Claude: `supportedModels()`, Codex: `model/list`). Hardcoding it would leave
 * this app silently falling behind every time a new model ships — Fable actually shipped once
 * and could not be selected because it was missing from a hardcoded list.
 *
 * Reasoning effort also arrives attached to the model, since which levels are supported differs
 * by model. Keeping it as a separate flag would give two different answers to "does this model
 * support this," and they could disagree.
 */
export const ModelOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** The reasoning efforts this model supports. Empty means this model has no effort selection */
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
  /**
   * Response-speed tiers (codex's serviceTiers — measured: gpt-5.4+ has exactly one, "Fast, 1.5x
   * speed, increased usage"). Unlike verbosity, model/list reports this **per model**, so it
   * attaches to the model — putting it in the adapter's capability declaration would give two
   * different answers to "can this model do this." The name and description are carried
   * verbatim: the wording that usage costs more is codex's own, and it is accurate.
   */
  tiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).default([]),
})
export type ModelOption = z.infer<typeof ModelOption>

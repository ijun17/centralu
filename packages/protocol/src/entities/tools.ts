import { z } from 'zod'
import { PermissionPreset, ToolName } from './ids.js'

/**
 * How a screen presents a tool. Here because both sides read it and agent-host does not depend on core; the values stay
 * in each adapter and reach the UI through `agents.detect`, so a new tool is no protocol edit. Presentation only: what a
 * tool can do is its adapter's (`AdapterCapabilities`, `ModelOption`; docs/agent-host/adapters/adding-a-tool.md).
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
 * Where a tool stands on this machine, one shape for every tool (#59). A window that predates it reads `installed` and
 * `loggedIn`.
 * - `installing`: Centralu downloads or unpacks it (`progress`), only where `install` is `centralu`
 * - `signed_out`: the tool says it is not signed in (or a session found so: `-32000` on ACP)
 * - `signing_in`: Centralu's sign-in runs (the browser is open on that machine), only where `signIn` is `centralu`
 * - `unknown`: installed, and its sign-in cannot be told without a session (OpenCode, whose providers each keep their own)
 */
export const ToolSetupState = z.enum(['not_installed', 'installing', 'signed_out', 'signing_in', 'ready', 'unknown'])
export type ToolSetupState = z.infer<typeof ToolSetupState>

/** Why Centralu's install or sign-in of a tool stopped, as a word a screen can act on; `message` says it in words */
export const ToolSetupFailureReason = z.enum([
  'network',
  'checksum',
  'disk_space',
  'unpack',
  'unsupported_platform',
  'cancelled',
  'timed_out',
  'ineligible',
  'failed',
])
export type ToolSetupFailureReason = z.infer<typeof ToolSetupFailureReason>

export const ToolSetup = z.object({
  state: ToolSetupState,
  /** `centralu` (an `agents.installTool` action), or the person from a terminal (`ToolDescriptor.install`) */
  install: z.enum(['centralu', 'terminal']),
  /** Centralu's own action (`agents.signIn`, on the host's machine), a terminal (`ToolDescriptor.login`), or none */
  signIn: z.enum(['centralu', 'terminal', 'none']),
  /** While `installing`: bytes received of the archive, and its size when known */
  progress: z.object({ received: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable() }).optional(),
  /**
   * The last install or sign-in that did not finish; cleared by the next start. `verifyUri`, with `ineligible`: the
   * Google page to verify the account (always `https` on a Google host), kept out of `message`, host.log and the stores
   */
  failure: z.object({ reason: ToolSetupFailureReason, message: z.string(), verifyUri: z.string().optional() }).optional(),
  /** The plan the tool said at its last sign-in (Antigravity's `_meta.antigravity.tier`), with its upgrade link when it gave one */
  plan: z.object({ name: z.string(), upgradeUri: z.string().optional() }).optional(),
  /** While `not_installed`: the tool's own app is on that machine though Centralu's connection to it is not */
  appFound: z.literal(true).optional(),
})
export type ToolSetup = z.infer<typeof ToolSetup>

/** The setup of a tool whose detection is all there is (Claude, Codex, Cursor): its two booleans in the one shape */
export function setupOfDetection(installed: boolean, loggedIn: boolean | null): ToolSetup {
  const state: ToolSetupState = !installed ? 'not_installed' : loggedIn === null ? 'unknown' : loggedIn ? 'ready' : 'signed_out'
  return { state, install: 'terminal', signIn: 'terminal' }
}

/** A descriptor and whether the tool is usable here now: one type, since a join done in a component can be done wrong */
export const ToolStatus = ToolDescriptor.extend({
  installed: z.boolean(),
  loggedIn: z.boolean(),
  detail: z.string(),
  setup: ToolSetup.optional(),
})
export type ToolStatus = z.infer<typeof ToolStatus>

/**
 * How hard a job start_agent hands over is: said instead of a model, so the person's model per tool applies
 * (`UiPreferences.agentModels`). Light: lookups, small fixes, small reviews. Heavy: design, security boundaries,
 * data-loss risk, large refactors. Standard: the rest.
 */
export const AgentDifficulty = z.enum(['light', 'standard', 'heavy'])
export type AgentDifficulty = z.infer<typeof AgentDifficulty>

/** The effort belongs to the model, as a project's remembered one does */
export const AgentModelChoice = z.object({
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(80).optional(),
})
export type AgentModelChoice = z.infer<typeof AgentModelChoice>

/** Per tool (a registry name), per difficulty: what start_agent runs when a caller names a difficulty and no model */
export const AgentModels = z.record(
  z.string().max(80),
  z.object({
    light: AgentModelChoice.optional(),
    standard: AgentModelChoice.optional(),
    heavy: AgentModelChoice.optional(),
  }),
)
export type AgentModels = z.infer<typeof AgentModels>

/**
 * What the UI enables features by (docs/agent-host/adapters/contract.md). Nothing an optional method's presence already
 * says goes here: a flag can drift from the method, and a true flag for a missing method silently does nothing.
 */
export const AdapterCapabilities = z.object({
  approvals: z.boolean(),
  contextUsage: z.enum(['exact', 'estimate', 'none']),
  resume: z.boolean(),
  autoTitle: z.boolean(),
  attachments: z.array(z.enum(['image', 'file'])).default([]),
  /**
   * Empty: no such knob. Per tool, not per model: Codex's `model/list` does not report verbosity per model (measured),
   * and the list is never made up here.
   */
  verbosities: z.array(z.string()).default([]),
  /**
   * Nobody else can write to the conversation while we hold the handle. Codex: the app-server locks the thread ("already
   * has an active writer"); Claude's file has no lock. Only with it may the manager read a release as "everything up to
   * here is known" (the skip in syncImportedHistory); without it, outside writes would never be pulled in.
   */
  exclusiveWriter: z.boolean().default(false),
  /**
   * It reports its background work (`background_tasks`). A flag, not a method: silence cannot say "none running" from
   * "cannot see", and the idle check needs that (a session whose background work is invisible is never idle).
   */
  backgroundTasks: z.boolean().default(false),
  /** Whether send accepts input during a running turn without interrupting it (#592). Absent is unsupported. */
  midTurnInput: z.boolean().optional(),
  /** Sent by older hosts and read by nobody; it stays because removing a field is a version increment (docs/protocol.md §4) */
  gatesSteps: z.boolean().optional(),
  /** Can defer single Centralu tool definitions until the model asks; the host counts a kept process's prefix by it */
  toolDeferral: z.boolean().optional(),
  instructionChannel: z.enum(['server', 'developer']).optional(),
  processModel: z.enum(['per-session', 'shared-server']).optional(),
  builtInSubagents: z.boolean().optional(),
  /**
   * The CLI's own subagent tool as the model calls it (Claude `Agent`, Codex `spawn_agent`), named in the instruction
   * line that sends long or watched work to `start_agent` instead. Absent: the CLI has none.
   */
  subagentTool: z.string().optional(),
  peerMessaging: z.boolean().optional(),
  /**
   * An idle session may be put to sleep (process ended, resumed by the next message), only where measured to lose
   * nothing. Claude: a resumed process reads the prompt cache as a live one does (~100% at 2, 6 and 10 minutes on the
   * 1 h lifetime), for +0.7 s (p50) before the first token. Absent: false
   */
  sleep: z.boolean().optional(),
  /**
   * The presets it can keep (docs/plans/acp-adapter.md §5.3); absent: all. Cursor's ACP server cannot be made to ask
   * before every change, so it lacks `safe`, and a `safe` session of it is refused (`launchRefusal`).
   */
  presets: z.array(PermissionPreset).optional(),
  /** Can be kept from the repository's own files (`.cursor/rules`, `AGENTS.md`) when untrusted. Absent: true; false: trusted only */
  keepsRepoFilesOut: z.boolean().optional(),
  /**
   * Takes Centralu's role text (`systemPromptAppend`). Absent: true. False: it cannot run a session given one (the
   * Assistant, a coordinator, an app's agent), nor one that must read no setting files.
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
  /** Role text is `systemPromptAppend` */
  roleText?: boolean
}

/** What the Assistant asks of its tool: Normal, no project's files, and Centralu's role text (`AssistantSlot`) */
export const ASSISTANT_DEMANDS: LaunchDemands = {
  permissionPreset: 'normal',
  projectTrusted: false,
  noSettingFiles: true,
  roleText: true,
}

/**
 * Why `label`'s tool cannot run a session that demands this, or null when it can. The one rule for both sides: the host
 * refuses a launch with it, and a picker shows the same words beside a tool it greys out.
 */
export function launchRefusal(
  caps: AdapterCapabilities,
  label: string,
  demands: LaunchDemands,
): string | null {
  if (caps.roleText === false && (demands.roleText || demands.noSettingFiles)) {
    return `${label} cannot take Centralu's role instructions yet, so it cannot run the Assistant, a coordinator or an app's agent.`
  }
  if (caps.keepsRepoFilesOut === false && !demands.projectTrusted) {
    return `${label} cannot be kept from reading a project's own files (such as AGENTS.md and its rules), so it runs only in trusted projects.`
  }
  if (caps.presets && !caps.presets.includes(demands.permissionPreset)) {
    const kept = caps.presets.map((p) => PRESET_LABEL[p]).join(' or ')
    const asked = PRESET_LABEL[demands.permissionPreset]
    return `${label} cannot be made to ask before a change as ${asked} does, so it cannot run under ${asked}${kept ? ` (only under ${kept})` : ''}.`
  }
  return null
}

const PRESET_LABEL: Record<PermissionPreset, string> = {
  safe: 'Safe',
  normal: 'Normal',
  edits: 'Edits',
  auto: 'Auto',
}

/**
 * One model, exactly as the tool's official API reports it (Claude `supportedModels()`, Codex `model/list`), never a
 * list of ours: a model missing from a hardcoded list cannot be picked. Efforts ride on the model, as they differ by model.
 */
export const ModelOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** Empty: this model has no effort selection */
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
  /**
   * Codex's serviceTiers, reported per model (measured: gpt-5.4+ has one, "Fast, 1.5x speed, increased usage"), so on
   * the model, not the adapter. Name and description verbatim: the wording that usage costs more is Codex's own.
   */
  tiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).default([]),
  /** The model's own id an alias entry (`opus`) names now (`claude-opus-5-5`), as the tool reports it; absent for a plain id */
  resolved: z.string().optional(),
})
export type ModelOption = z.infer<typeof ModelOption>

/**
 * The list's entry a model id names: the entry with that id, else the one alias that names it (`ModelOption.resolved`). Claude's
 * `default` row names the same model as the alias beside it, so it does not count; two other aliases naming one model leave the id as it is.
 */
export function listedModel(models: readonly ModelOption[], model: string | null | undefined): ModelOption | undefined {
  if (!model) return undefined
  const named = models.find((m) => m.id === model)
  if (named) return named
  const aliases = models.filter((m) => m.resolved === model && m.id !== 'default')
  return aliases.length === 1 ? aliases[0] : undefined
}

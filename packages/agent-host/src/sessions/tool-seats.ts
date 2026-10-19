import { z } from 'zod'
import { ORCHESTRATOR_MCP_NAME, type ToolProfile } from '../apps/contract.js'
import type { GuideSeats, GuideTool } from './app-guide.js'
import { trustedJsonText } from './tool-answers.js'
import {
  AGENT_TOOLS,
  APP_ACCESS_TOOLS,
  BUILDER_INSTRUCTIONS,
  BUILDER_TOOL_NAMES,
  COMMAND_TOOLS,
  COMMANDS_INSTRUCTION,
  DELEGATE_TOOLS,
  ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_TOOLS,
  READER_INSTRUCTIONS,
  READER_INSTRUCTIONS_WITH_APPS,
  READER_TOOLS,
  SCOPED_INSTRUCTIONS,
  SCOPED_TOOL_NAMES,
  type AgentToolName,
  type AppAccessToolName,
  type OrchestratorToolName,
} from './tool-definitions.js'

/** A command a seat may reach through centralu_run */
export type CommandName = OrchestratorToolName | AgentToolName | AppAccessToolName

let readerInstructions = true

/**
 * `CC_READER_INSTRUCTIONS=0` (read once at start, main.ts): ordinary sessions get their tools without the
 * instructions, as before #564. For measuring the instructions against their absence; on by default.
 */
export function setReaderInstructions(on: boolean): void {
  readerInstructions = on
}

/**
 * How a seat's rarely used commands reach the model (#512, chosen by `CC_RARE_COMMANDS`; the comparison of the
 * three is in docs/tool-cost.md §9). `commands` is the default since the owner's decision of 2026-10-12 (no loss
 * on Sonnet, 835 tokens fewer per orchestrator request, and a tool list that does not grow with the commands);
 * the other two stay selectable for measurement.
 *
 *   - `resident`: every tool in every request, as before #512.
 *   - `deferred`: the rare ones wait behind Claude's tool search, the way the reader's app_guide does.
 *     Codex reaches every MCP tool through its own `exec` anyway (tool-cost.md §6.2), so this is Claude's alone.
 *   - `commands`: the rare ones leave the tool list. Three fixed tools stand in for them (COMMAND_TOOLS):
 *     list, describe, run. The host checks a run against the command's own schema and the seat's
 *     profile, the same gates the command has as a tool.
 *
 * One host-wide setting, read once at start (main.ts), because the tool list a session starts with is
 * its prompt prefix: a session that changed tier mid-run would rebuild its cache.
 */
export const RARE_TIERS = ['resident', 'deferred', 'commands'] as const
export type RareTier = (typeof RARE_TIERS)[number]

/** The tier a host runs with when `CC_RARE_COMMANDS` names none (#512, decision of 2026-10-12) */
export const DEFAULT_RARE_TIER: RareTier = 'commands'

let rareTier: RareTier = DEFAULT_RARE_TIER

/** The tier from `CC_RARE_COMMANDS`: anything else is the default */
export function rareTierFrom(value: string | undefined): RareTier {
  return (RARE_TIERS as readonly string[]).includes(value ?? '') ? (value as RareTier) : DEFAULT_RARE_TIER
}

export function setRareTier(tier: RareTier): void {
  rareTier = tier
}

export function currentRareTier(): RareTier {
  return rareTier
}

/**
 * Which commands are rare, per seat. The orchestrator's alone: the other directing seats carry a few tools
 * each, all of them their reason to exist.
 *
 * In: create_app, propose_skill and propose_mcp_server (1,462, 1,144 and 1,098 characters, a third of the
 * orchestrator's every request, asked for a few times in a seat's life). The instructions name each of them
 * and say when, which is what a model that cannot see them goes looking with.
 * Out: propose_worktree_session, before it went with the worktree manager (#561 part 3): asked for a branch, the
 * orchestrator reached it 3 of 3 times as a tool and 0 of 3 deferred or behind centralu_run (tool-cost.md §9).
 * In since #853: start_agent and agent_session. The orchestrator hands light work outside any project (a web search, a
 * lookup) to a child the person can watch rather than its CLI's own subagent; their 1,357 characters would put its
 * every request over its ceiling, and the instructions name start_agent.
 * In since #1220: add_project and list_machines, asked for when the person names a folder or a machine, and named in
 * the instructions; the first of the orchestrator's window functions to come as commands (#1219). In since #1219's
 * second slice: the six machine commands, which the instructions name in one line. In since the preferences (#1219):
 * get_preferences and set_preferences; the line now says "the other *_machine commands" and names them (32 characters less).
 * In since #1205: find_apps, attach_app and detach_app, for the root apps it attaches when it needs one rather than
 * carrying each as a server (session-apps.ts `givesApp`). As tools they would put its every request over its ceiling
 * (find_apps alone is 294 characters, and the seat had 219 to spare); the instructions name find_apps.
 * Out: app_guide. It answers the person's own questions about the app, which come often and
 * without warning; deferred, a reader found it 4 of 5 times and never for a question about a setting (§8). Out
 * too: everything the instructions tell the orchestrator to reach for first (list, read, recall, send, create
 * a session or a project).
 */
export const RARE_COMMANDS: Partial<Record<ToolProfile, readonly CommandName[]>> = {
  orchestrator: [
    'create_app',
    'propose_skill',
    'propose_mcp_server',
    'update_centralu',
    'answer_question',
    'handoff_session',
    'start_agent',
    'agent_session',
    'add_project',
    'list_machines',
    'add_machine',
    'install_machine',
    'remove_machine',
    'reconnect_machine',
    'set_machine_connect',
    'set_machine_autostart',
    'get_preferences',
    'set_preferences',
    'find_apps',
    'attach_app',
    'detach_app',
  ],
}

/** The commands this seat reaches through centralu_run in this tier: never one its profile does not allow */
export function commandsFor(profile: ToolProfile | 'human', tier: RareTier = rareTier): CommandName[] {
  if (tier !== 'commands' || profile === 'human') return []
  return (RARE_COMMANDS[profile] ?? []).filter((n) => baseAllows(profile, n))
}

/** An argument the caller fills in itself, written `…` in a call an answer names */
export const FILL = Symbol('fill')

/**
 * The call an answer names, in the form this seat can make it (#850): the tool itself, or centralu_run when it is one of
 * the seat's rare commands in the `commands` tier; undefined when the seat cannot call it at all (and for the person,
 * who has no tools). Every answer that tells the model to call a tool names it through this: a bare name the seat
 * reaches only through centralu_run is refused as "Not a tool of this session".
 */
export function callForm(
  profile: ToolProfile | 'human' | null,
  tool: string,
  args: Record<string, string | number | boolean | typeof FILL>,
  tier: RareTier = rareTier,
): string | undefined {
  if (profile === null || profile === 'human') return undefined
  const value = (v: string | number | boolean | typeof FILL) => (v === FILL ? '…' : typeof v === 'string' ? trustedJsonText(v) : JSON.stringify(v))
  const entries = Object.entries(args)
  if ((commandsFor(profile, tier) as string[]).includes(tool)) {
    return `centralu_run(command="${tool}", args={${entries.map(([k, v]) => `${k}: ${value(v)}`).join(', ')}})`
  }
  if (!profileAllows(profile, tool, tier)) return undefined
  return `${tool}(${entries.map(([k, v]) => `${k}=${value(v)}`).join(', ')})`
}

/**
 * `callForm`, or the plain call when the seat is not known or not given the tool: what an answer that tells its reader
 * to make a call writes. The orchestrator reaches start_agent and agent_session only through centralu_run in the
 * `commands` tier, so an answer that named them bare sent it to a refusal first (#850).
 */
export function namedCall(
  profile: ToolProfile | 'human' | null,
  tool: string,
  args: Record<string, string | number | boolean | typeof FILL>,
  tier: RareTier = rareTier,
): string {
  const value = (v: string | number | boolean | typeof FILL) => (v === FILL ? '…' : typeof v === 'string' ? trustedJsonText(v) : JSON.stringify(v))
  return callForm(profile, tool, args, tier) ?? `${tool}(${Object.entries(args).map(([k, v]) => `${k}=${value(v)}`).join(', ')})`
}

/**
 * For an answer that names tools in prose: how this seat runs those it reaches only as commands, as one sentence ('' when
 * it calls them all directly, or is not known). A prose name the seat copies bare is refused as "Not a tool" (#850).
 */
export function commandsSentence(profile: ToolProfile | 'human' | null, tools: readonly string[], tier: RareTier = rareTier): string {
  if (profile === null) return ''
  const commands = commandsFor(profile, tier) as string[]
  const named = tools.filter((t) => commands.includes(t))
  if (!named.length) return ''
  const list = named.join(' and ')
  return `${list} ${named.length === 1 ? 'is one' : 'are'} of this session's commands: centralu_run(command="${named[0]}", args={…}) runs ${named.length === 1 ? 'it' : 'each'}.`
}

/**
 * The refusal of a tool this seat was not given (#69). A name that is one of the seat's rare commands in the
 * `commands` tier says how it runs (#850): the model named it bare, most likely from words that did.
 */
export function notAToolText(profile: ToolProfile | 'human', name: string, tier: RareTier = rareTier): string {
  const refused = `Not a tool of this session: ${name}`
  if (!(commandsFor(profile, tier) as string[]).includes(name)) return refused
  return `${refused}. It is one of this session's commands: centralu_run(command="${name}", args={…}) runs it, and centralu_help(command="${name}") gives its arguments.`
}

/** The tools this seat's Claude server defers behind tool search in this tier (the reader set marks its own) */
function deferredFor(profile: ToolProfile, tier: RareTier): readonly string[] {
  return tier === 'deferred' ? (RARE_COMMANDS[profile] ?? []) : []
}

/**
 * Whether this profile allows the tool — both exposure (schemas) and execution (run) are decided by this.
 *
 * In the `commands` tier a rare command is not a tool of the seat: it is refused by name, as any tool the
 * seat was not shown, and runs only through centralu_run, which `commandsFor` gates with the same rule.
 */
export function profileAllows(profile: ToolProfile, name: string, tier: RareTier = rareTier): boolean {
  if (COMMAND_TOOLS.some((t) => t.name === name)) return commandsFor(profile, tier).length > 0
  if ((commandsFor(profile, tier) as string[]).includes(name)) return false
  return baseAllows(profile, name)
}

/** The profile rule itself, whatever the tier: who may use which of Centralu's commands */
function baseAllows(profile: ToolProfile, name: string): boolean {
  if (profile === 'reader') {
    return (
      name === 'update_centralu' ||
      READER_TOOLS.some((t) => t.name === name) ||
      DELEGATE_TOOLS.some((t) => t.name === name) ||
      AGENT_TOOLS.some((t) => t.name === name) ||
      APP_ACCESS_TOOLS.some((t) => t.name === name)
    )
  }
  // ask_project is a reader's alone: every directing seat already works inside its own view. start_agent's pair (#561) is
  // the orchestrator's too (#853), for children outside any project, and so are the app-access tools (#1205), for the
  // root apps it attaches when it needs one
  if (AGENT_TOOLS.some((t) => t.name === name) || APP_ACCESS_TOOLS.some((t) => t.name === name)) return profile === 'orchestrator'
  if (DELEGATE_TOOLS.some((t) => t.name === name)) return false
  if (profile === 'orchestrator') return !(BUILDER_TOOL_NAMES as readonly string[]).includes(name)
  if (profile === 'scoped') return (SCOPED_TOOL_NAMES as readonly string[]).includes(name)
  return (BUILDER_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * The built-in tool definitions this profile is given — the one list the in-process MCP, the
 * bridge's schemas and the guide all read. The reader set (#320) has its own words; every other
 * profile is a filter over the orchestrator's.
 */
export function toolDefsFor(
  profile: ToolProfile,
  tier: RareTier = rareTier,
): readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; deferred?: boolean }[] {
  if (profile === 'reader') return [...READER_TOOLS, ...DELEGATE_TOOLS, ...AGENT_TOOLS, ...APP_ACCESS_TOOLS]
  const deferred = deferredFor(profile, tier)
  return [
    ...[...ORCHESTRATOR_TOOLS, ...AGENT_TOOLS, ...APP_ACCESS_TOOLS].filter((t) => profileAllows(profile, t.name, tier)).map((t) => (deferred.includes(t.name) ? { ...t, deferred: true } : t)),
    ...(commandsFor(profile, tier).length ? COMMAND_TOOLS : []),
  ]
}

/**
 * The server instructions for a profile, or undefined for none. In one place so the size test
 * measures the exact text the adapter sends.
 */
export function instructionsFor(profile: ToolProfile, tier: RareTier = rareTier, appsAttached = false): string | undefined {
  switch (profile) {
    case 'scoped': return SCOPED_INSTRUCTIONS
    case 'builder': return BUILDER_INSTRUCTIONS
    // With an app attached at the start, the line on repository work (#957, #992 review)
    case 'reader': return readerInstructions ? (appsAttached ? READER_INSTRUCTIONS_WITH_APPS : READER_INSTRUCTIONS) : undefined
    default: return commandsFor(profile, tier).length ? `${ORCHESTRATOR_INSTRUCTIONS}\n${COMMANDS_INSTRUCTION}` : ORCHESTRATOR_INSTRUCTIONS
  }
}

/**
 * The same instructions as a Codex thread's developer instructions carry them (#525).
 *
 * Claude Code shows a server's `instructions` to the model; codex-cli 0.160.0 does not. Measured
 * (`scripts/probe-codex-mcp-instructions.mts`, 2026-10-12): a stdio server whose `initialize` answered with
 * `instructions` started, its tool was listed and reached, yet the model could not name a phrase from them, and the
 * thread's rollout had no trace of them, in four runs; the phrase in `developerInstructions` was named every time,
 * and the rollout holds it as a developer message. So the bridge sends none, and the adapter appends this to the
 * thread's developer instructions. The header says whose they are: Codex shows these tools to the model as
 * `mcp__centralu__<tool>`, and the text names them bare, as Claude Code's section heading (the server's name) does.
 */
export function codexToolInstructionsFor(profile: ToolProfile, tier: RareTier = rareTier, appsAttached = false): string | undefined {
  const text = instructionsFor(profile, tier, appsAttached)
  return text ? `# How to use the ${ORCHESTRATOR_MCP_NAME} tools (mcp__${ORCHESTRATOR_MCP_NAME}__*)\n\n${text}` : undefined
}

/** The adapter decides the channel; this module only owns the shared wording. */
export function toolInstructionsFor(
  profile: ToolProfile,
  channel: 'server' | 'developer',
  tier: RareTier = rareTier,
): string | undefined {
  return channel === 'developer' ? codexToolInstructionsFor(profile, tier) : instructionsFor(profile, tier)
}

/**
 * The tools this profile can call **right now** — the same decision as the exposure logic
 * (orchestratorToolSchemas). The guide uses this when it states what each seat can do (M4 P-4):
 * writing the list out by hand would let the guide fall behind every time a tool is added or
 * removed. Read in the `resident` tier: the guide says what a seat can do, not how its tools are packed (#512).
 */
function toolsFor(profile: ToolProfile): GuideTool[] {
  return toolDefsFor(profile, 'resident').map((t) => ({ name: t.name, description: t.description }))
}

export function guideSeats(): GuideSeats {
  return { orchestrator: toolsFor('orchestrator'), scoped: toolsFor('scoped'), reader: toolsFor('reader') }
}

export function orchestratorToolSchemas(
  profile: ToolProfile = 'orchestrator',
): { name: string; description: string; inputSchema: unknown }[] {
  return toolDefsFor(profile).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.schema),
  }))
}

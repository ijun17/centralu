import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ToolProfile } from '../apps/contract.js'
import { ORCHESTRATOR_MCP_NAME, codexToolInstructionsFor, instructionsFor, toolDefsFor } from './orchestrator-tools.js'

/**
 * What a session's Centralu tools cost before a word is said (#513): the definitions as each CLI
 * is handed them, which of them ride in every request, and a fingerprint of that resident part.
 *
 * One function for the budget tests and the measurement script (`scripts/measure-tools.mts`), so the
 * number a test pins and the number a baseline records are the same number.
 */

export type AgentCli = 'claude' | 'codex'

/** Every profile, in the order tables list them */
export const TOOL_PROFILES = ['orchestrator', 'manager', 'scoped', 'builder', 'reader'] as const satisfies readonly ToolProfile[]

export type ServedDefinition = {
  /** The name the model sees: `mcp__<server>__<tool>` on both CLIs */
  name: string
  description: string
  inputSchema: unknown
  /**
   * In every request (`true`) or a name behind tool search until the model loads it. Claude defers
   * what the in-process server does not mark `alwaysLoad` (adapters/claude/orchestrator-mcp.ts).
   * Centralu cannot mark anything for Codex, so here every Codex tool counts as resident: the most
   * Codex could load. What it does load is Codex's own choice, and a live run measures it (codex-cli
   * 0.160.0 kept MCP tools out of the first request and found them on demand: docs/tool-cost.md).
   */
  resident: boolean
  /** Characters of `{ name, description, input_schema }`, the shape the Messages API takes */
  chars: number
}

export function definitionChars(name: string, description: string, inputSchema: unknown): number {
  return JSON.stringify({ name, description, input_schema: inputSchema }).length
}

export function servedDefinitions(profile: ToolProfile, cli: AgentCli): ServedDefinition[] {
  return toolDefsFor(profile).map((t) => {
    const name = `mcp__${ORCHESTRATOR_MCP_NAME}__${t.name}`
    const inputSchema = z.toJSONSchema(t.schema)
    // The same rule as orchestratorMcp: a directing profile's server is alwaysLoad, the reader set is loaded tool by tool
    const deferred = cli === 'claude' && profile === 'reader' && 'deferred' in t && t.deferred === true
    return { name, description: t.description, inputSchema, resident: !deferred, chars: definitionChars(name, t.description, inputSchema) }
  })
}

/**
 * The server instructions that reach the model. Claude Code puts an MCP server's instructions in a
 * `<system-reminder>` of the first user message (measured, CLI 2.1.289: "# MCP Server Instructions"),
 * so they ride in every request like the definitions. Codex shows a server's instructions to no model
 * (#525), so a Codex thread gets the same text in its developer instructions, under a header
 * (`codexToolInstructionsFor`), next to its role where it has one; they ride in every request too.
 */
export function servedInstructions(profile: ToolProfile, cli: AgentCli): string {
  return (cli === 'claude' ? instructionsFor(profile) : codexToolInstructionsFor(profile)) ?? ''
}

export type ResidentCost = {
  profile: ToolProfile
  cli: AgentCli
  tools: number
  residentTools: number
  /** Characters of the resident definitions */
  residentChars: number
  /** Characters of the deferred definitions: not in a request until loaded, only their names are */
  deferredChars: number
  instructionsChars: number
  /** sha256 (12 hex) of the resident definitions and instructions, in the order they are served */
  prefixHash: string
}

export function residentCost(profile: ToolProfile, cli: AgentCli): ResidentCost {
  const defs = servedDefinitions(profile, cli)
  const resident = defs.filter((d) => d.resident)
  const instructions = servedInstructions(profile, cli)
  return {
    profile,
    cli,
    tools: defs.length,
    residentTools: resident.length,
    residentChars: resident.reduce((n, d) => n + d.chars, 0),
    deferredChars: defs.filter((d) => !d.resident).reduce((n, d) => n + d.chars, 0),
    instructionsChars: instructions.length,
    prefixHash: shortHash([resident.map((d) => ({ name: d.name, description: d.description, input_schema: d.inputSchema })), instructions]),
  }
}

export function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12)
}

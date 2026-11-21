import { z } from 'zod'
import { ToolName } from '../entities.js'
import { machineField } from './machine-fields.js'

/** Characters: they ride in every start_agent task of the project, so a pasted log cannot; briefs ran to about 3,000 */
export const AGENT_INSTRUCTIONS_MAX = 8_000

/** `command` is the identity (run ledger, PTY registry, log buffer); `label` only shows, always beside the command */
export const SavedCommand = z.object({
  command: z.string(),
  label: z.string().optional(),
})
export type SavedCommand = z.infer<typeof SavedCommand>

/** The values last chosen for one tool; verbosity and serviceTier are not remembered as a project default */
export const ToolDefaults = z.object({
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
})
export type ToolDefaults = z.infer<typeof ToolDefaults>

export const ProjectInfo = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  /** No default: only the host knows which tools exist; screens fall back to what the machine has */
  defaultTool: ToolName.nullable().default(null),
  /** Per tool, as model names are a tool's own: measured, a Codex session given `opus[1m]` failed every turn with a 400 */
  defaultModels: z.record(ToolName, ToolDefaults).default({}),
  /** Sent with the project, so the Run menu need not tell "none saved" from "not loaded" (`agents.commands`' `ready`) */
  commands: z.array(SavedCommand).default([]),
  /**
   * A new worktree has only tracked files (no node_modules, no ignored .env). Order: worktree, copy files, setup (as
   * Vibe Kanban validated). Null runs nothing. Kept in our store, never written into the repo (#50).
   */
  worktreeSetup: z
    .object({ command: z.string(), copyFiles: z.array(z.string()) })
    .nullable()
    .default(null),
  /**
   * The person's standing instructions, appended to every task start_agent gives in this project. Each machine keeps
   * its own for its copy of the project, so a linked Windows machine holds its own paths and shell.
   */
  agentInstructions: z.string().default(''),
  /** Null: no manager yet (the screen offers one). baseBranch is where worktrees branch off and the merge baseline */
  worktreeManager: z.object({ sessionId: z.string(), baseBranch: z.string() }).nullable().default(null),
  /**
   * Whether the project's code may run on this machine: apps start and project settings apply only when true. A new
   * project starts false, and absent reads false, as reading it true would be a silent grant.
   */
  trusted: z.boolean().default(false),
  /**
   * Set by the host, only `true`: an app folder of the user folder (`<data folder>/apps/<id>/`) registered in place as
   * the project's root app. Deleting it moves the folder to `<data folder>/app-trash/` once nothing in Centralu's trash
   * can restore it, as the Delete project dialog says; any other project's folder stays.
   */
  fromUserFolder: z.boolean().optional(),
  git: z
    .object({
      branch: z.string(),
      changedFiles: z.number(),
      isRepo: z.boolean(),
      /** The OS blocked access, told apart from "not a repository" (measured) */
      denied: z.boolean().optional(),
      /** More files changed than `changedFiles`: the host stops counting at its cap */
      more: z.boolean().optional(),
      /** git did not answer in time: the count is not known, and the last known one still stands */
      unknown: z.boolean().optional(),
    })
    .nullable()
    .default(null),
  ...machineField,
  /** As `SessionInfo.unreachable`: last heard, not current */
  unreachable: z.boolean().optional(),
})
export type ProjectInfo = z.infer<typeof ProjectInfo>

/** A slash command (skill) */
export const CommandInfo = z.object({
  name: z.string(),
  description: z.string().default(''),
  argumentHint: z.string().default(''),
})
export type CommandInfo = z.infer<typeof CommandInfo>

export const TerminalInfo = z.object({
  terminalId: z.string(),
  cwd: z.string(),
  title: z.string(),
  /** Output so far, which restores the screen on reattach */
  history: z.string(),
  alive: z.boolean(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

/** A saved command's latest run, kept until it runs again; its output rides the terminal lane, runId for terminalId */
export const CommandRunInfo = z.object({
  command: z.string(),
  /** Fresh per run, so the screen can switch which output stream it follows */
  runId: z.string(),
  running: z.boolean(),
  /** Null: still running, or the process never started (history says why) */
  exitCode: z.number().nullable(),
  startedAt: z.number(),
})
export type CommandRunInfo = z.infer<typeof CommandRunInfo>

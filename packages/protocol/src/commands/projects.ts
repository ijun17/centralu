import { z } from 'zod'
import { ToolName } from '../entities.js'
import { machineField } from './machine-fields.js'

/**
 * The most a project's instructions for started agents may hold (#1161 item 2), in characters: they go into every task
 * start_agent gives there, so a pasted log cannot ride along in each one. The briefs they replace ran to about 3,000.
 */
export const AGENT_INSTRUCTIONS_MAX = 8_000

/**
 * A single saved shell command (#44, the alias was requested by the person on 2026-09-06).
 * `command` is the identity — the run ledger (commandRuns), the host's PTY registry and the log
 * buffer all key off this string. `label` is display-only, and wherever it is shown, the command
 * is always shown alongside it (to prevent the name from drifting into secretly meaning a
 * different command).
 */
export const SavedCommand = z.object({
  command: z.string(),
  label: z.string().optional(),
})
export type SavedCommand = z.infer<typeof SavedCommand>

/**
 * The values last chosen for one tool (#107).
 *
 * verbosity and serviceTier are not here — they have never been remembered as a project
 * default (there is no column for them either), and there is no reason to invent that memory now.
 * If they are added, they go into the same envelope.
 */
export const ToolDefaults = z.object({
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
})
export type ToolDefaults = z.infer<typeof ToolDefaults>

export const ProjectInfo = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  /**
   * The tool this project reached for last, if it ever did.
   *
   * It defaulted to `'claude'`, which was the last vendor name left in this package after
   * the tool list became data: a project created on a machine without Claude Code still
   * claimed to prefer it. There is no sensible default here — only the host knows which
   * tools exist — so the absence is now recorded as one, and the screens fall back to
   * whatever the machine actually has.
   */
  defaultTool: ToolName.nullable().default(null),
  /**
   * The last-chosen model and effort — **kept separately per tool** (#107).
   *
   * This used to be one value per project (the scalars `defaultModel` and `defaultEffort`). But
   * a model name is a tool's own vocabulary, so a Codex session started in a project that had
   * once had a Claude model chosen inherited that name wholesale — measured: a project with
   * `default_tool=codex` held `default_model=opus[1m]`, and that session died with a 400 on
   * every turn. The rule "the act of choosing becomes the default" was correct; the storage
   * shape just failed to express it: **a choice is always a choice for some particular tool.**
   */
  defaultModels: z.record(ToolName, ToolDefaults).default({}),
  /**
   * The shell commands saved on this project — what the Run menu offers (issue #44).
   *
   * They arrive **with the project** rather than being asked for when the menu opens. A
   * separate fetch would force the menu to tell "none saved yet" from "not loaded yet"
   * (which is why `agents.commands` carries a `ready` flag), and the project is already
   * in the store in one piece, so there is no reason to invent that distinction here.
   *
   * A row used to be the bare command string so that "there is no label that can drift
   * away from it". The label came back by user request (2026-09-06) — `pnpm dev` reads
   * worse than "Dev server" at a glance — but the drift argument still shapes the rule:
   * every surface that shows the label **also shows the command**, so a name can never
   * silently mean something else. The command string stays the identity everywhere
   * (run ledger, host PTY registry); the label is display-only.
   */
  commands: z.array(SavedCommand).default([]),
  /**
   * Worktree provisioning (#69). A new worktree is an empty workbench — it has only the tracked
   * files, no node_modules, no gitignored .env. Creation order: worktree, then copy files, then
   * setup (the order Vibe Kanban validated). Null means nothing runs — it is never forced.
   * This lives in our own database, not the repo (#50: nothing is ever written into the repo).
   */
  worktreeSetup: z
    .object({ command: z.string(), copyFiles: z.array(z.string()) })
    .nullable()
    .default(null),
  /**
   * The person's standing instructions for the agents start_agent starts in this project (#1161 item 2), appended to
   * every such task: the rules a parent otherwise repeats in each brief (make your own worktree, stack the pull
   * requests, never use git stash). Kept by each machine for its own copy of the project, so a linked Windows machine
   * holds its own paths and shell. Empty when none are set; an older host answers without it.
   */
  agentInstructions: z.string().default(''),
  /**
   * This project's worktree manager slot and trunk (#76). Null means there is not one yet — the
   * screen then offers "start manager." baseBranch is both where a worktree branches off from
   * and the baseline for merge judgment.
   */
  worktreeManager: z.object({ sessionId: z.string(), baseBranch: z.string() }).nullable().default(null),
  /**
   * Whether this project's code is allowed to run on this machine (M4, plan decision 3) — this
   * one field decides whether apps start and whether project settings are honored. A newly
   * registered project starts as "no" (`projects.setTrusted`). Missing reads as "no" too: if an
   * old host's answer that does not know about trust were filled in as "yes," that would be a
   * silent grant of permission.
   */
  trusted: z.boolean().default(false),
  /**
   * Whether this project is an app folder of the user folder registered in place (#1141): `<data folder>/apps/<id>/`,
   * now the project's root app. Set by the host, only ever `true` (absent for every other project, and from a host
   * before #1301, which a window reads as an ordinary project). Deleting such a project moves its folder to
   * `<data folder>/app-trash/` once nothing in Centralu's trash can restore it (#1204), which the Delete project dialog
   * says; for any other project the folder stays where it is.
   */
  fromUserFolder: z.boolean().optional(),
  git: z
    .object({
      branch: z.string(),
      changedFiles: z.number(),
      isRepo: z.boolean(),
      /** The OS blocked access — reported distinctly from "not a repository" (measured in F-1) */
      denied: z.boolean().optional(),
      /** More files changed than `changedFiles`: the host stops counting at its cap (#850 review) */
      more: z.boolean().optional(),
      /** git did not answer in time: the count is not known, and the last known one still stands (#850 review) */
      unknown: z.boolean().optional(),
    })
    .nullable()
    .default(null),
  ...machineField,
  /** The same mark as `SessionInfo.unreachable`: last heard, not current (#82) */
  unreachable: z.boolean().optional(),
})
export type ProjectInfo = z.infer<typeof ProjectInfo>

/** A single slash command (skill) */
export const CommandInfo = z.object({
  name: z.string(),
  description: z.string().default(''),
  /** Argument hint (e.g. "<file>") */
  argumentHint: z.string().default(''),
})
export type CommandInfo = z.infer<typeof CommandInfo>

/** One terminal (listing, creation and restart all return this shape) */
export const TerminalInfo = z.object({
  terminalId: z.string(),
  cwd: z.string(),
  title: z.string(),
  /** Output so far — restores the screen on reattach */
  history: z.string(),
  alive: z.boolean(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

/**
 * One run of a frequently used command (#60). Only the **latest run** per command is kept —
 * it is replaced only when that same command runs again (the person's decision; kept for the
 * host's lifetime). The output stream rides the same terminal frame lane: runId takes the place
 * of terminalId.
 */
export const CommandRunInfo = z.object({
  command: z.string(),
  /** A fresh id per run — the basis for the screen to switch which output stream it follows */
  runId: z.string(),
  running: z.boolean(),
  /** Null means either still running, or the process never even started (history states the reason) */
  exitCode: z.number().nullable(),
  startedAt: z.number(),
})
export type CommandRunInfo = z.infer<typeof CommandRunInfo>

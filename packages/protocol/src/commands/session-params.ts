import { z } from 'zod'
import { PermissionPreset, ProjectId, SessionId, ToolName } from '../entities.js'

/** What the host validates when a session is created or its settings change; a client only builds them, so the UI's bundle leaves them out. */

export const CreateSessionParams = z.object({
  projectId: ProjectId,
  cwd: z.string(),
  tool: ToolName,
  model: z.string().optional(),
  effort: z.string().optional(),
  /** codex's model_verbosity; the adapter's capability declaration names the tiers */
  verbosity: z.string().optional(),
  /** codex's service_tier; the model list (ModelOption.tiers) names the tiers */
  serviceTier: z.string().optional(),
  permissionPreset: PermissionPreset.default('normal'),
  initialPrompt: z.string().optional(),
  /** Pinned as a marker, not sent as the first message (which carries its path): it is lost once its author is gone */
  handoff: z
    .object({
      from: z.string(),
      note: z.string(),
      /** The predecessor's id, which names the note's file: by it the host tells an owned note from an orphan */
      fromSessionId: SessionId.optional(),
      /** The window then removes the predecessor, so its unsettled mail and once-allowed apps move too (docs/protocol.md §3.3) */
      removesOriginal: z.boolean().optional(),
    })
    .optional(),
  resumeExternalId: z.string().optional(),
  /** With resumeExternalId: also restore the prior conversation on screen */
  importHistory: z.boolean().optional(),
  worktree: z.boolean().optional(),
  /** Omitted: `centralu/<id's first 8>`. Also the session's and folder's lasting name; `git check-ref-format` checks it */
  worktreeBranch: z.string().optional(),
  /** Where the worktree branches off; omitted: the project's trunk (the manager's baseBranch), else the current HEAD */
  worktreeBase: z.string().optional(),
  /** Depth below a person-started session, from another machine's caller; it can only deepen, so sending it gains nothing */
  agentDepth: z.number().int().min(1).max(100).optional(),
  /**
   * From a session on a computer this host is hub to: `auto` only when `callerPreset` is and `UiPreferences.hubAuto` is
   * on, else `permissionPreset` (a hub sends `normal` at most), as an older host does. Sets `startedFromHub`.
   */
  fromHub: z.object({ callerPreset: PermissionPreset }).optional(),
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>
/** Named so the port uses it: a hand copy drifts, as excess properties go unchecked on params passed as a variable */
export const UpdateSettingsParams = z.object({
  sessionId: SessionId,
  model: z.string().nullable().optional(),
  /** effort, verbosity and serviceTier are raw strings: the supported tiers differ by model */
  effort: z.string().nullable().optional(),
  verbosity: z.string().nullable().optional(),
  serviceTier: z.string().nullable().optional(),
  permissionPreset: PermissionPreset.optional(),
  /**
   * Absent: a person's client, no toast. A linked machine's Assistant tool sends `orchestrator` (later `assistant`,
   * docs/plans/assistant-rename.md), toasted as the Assistant's; an older host strips it. This build sends the first.
   */
  by: z.enum(['orchestrator', 'assistant']).optional(),
})
export type UpdateSettingsParams = z.infer<typeof UpdateSettingsParams>

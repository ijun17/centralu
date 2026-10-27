import { z } from 'zod'
import { PermissionPreset, ProjectId, SessionId, ToolName } from '../entities.js'

/** What the host validates when a session is created or its settings change. A client only builds them, so the UI's bundle leaves them out (#1648). */

export const CreateSessionParams = z.object({
  projectId: ProjectId,
  cwd: z.string(),
  tool: ToolName,
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Response length (codex's model_verbosity). Which tiers are supported is stated by the adapter's capability declaration (#54) */
  verbosity: z.string().optional(),
  /** Response speed (codex's service_tier). Which tiers are supported is stated by the model list (ModelOption.tiers) */
  serviceTier: z.string().optional(),
  permissionPreset: PermissionPreset.default('normal'),
  initialPrompt: z.string().optional(),
  /**
   * The handoff note this session inherited (#102) — enters as a **record**, not as the first
   * message.
   *
   * A note the agent wrote is the one piece of material that cannot be recreated once its
   * author is gone. Once the first message came to carry only a path, that text had nowhere to
   * live in the conversation, so it is pinned as a marker on the session instead (the file
   * after that point is a pure derivative and can be deleted at any time).
   */
  handoff: z
    .object({
      from: z.string(),
      note: z.string(),
      /**
       * The id of the predecessor session (#106). Despite the name, this is **the name of a
       * file** — the note lives at `<data>/handoff/<project id>/<predecessor session id>.md`
       * (#142), and the host needs this value to tell a "note that still has an owner" apart
       * from an orphan, and to open that folder for the successor to read. It is optional for
       * old frames and for calls made outside a handoff: without it, the note is claimed by
       * nobody.
       */
      fromSessionId: SessionId.optional(),
      /**
       * The window removes the predecessor right after this session is created (when the person leaves its delete box checked, #738). The
       * host then gives this session **every** child of the predecessor, settled ones too, and lists them all in the
       * note: a settled child left with a session about to be removed would belong to nobody. Without it (a handoff
       * that keeps the predecessor, or an old frame) only the live children move (#693); the settled ones follow
       * later if the predecessor is removed after all.
       */
      removesOriginal: z.boolean().optional(),
    })
    .optional(),
  resumeExternalId: z.string().optional(),
  /** When resuming, also restore the prior conversation on screen (used together with resumeExternalId) */
  importHistory: z.boolean().optional(),
  /**
   * Run only this session **in a git worktree** (FR-2's lower-priority option).
   *
   * The default is to work directly in the original directory — a worktree is never forced.
   * Only someone who wants to eliminate file conflicts outright, when several sessions share a
   * directory, turns this on.
   */
  worktree: z.boolean().optional(),
  /**
   * The worktree branch name (#69). If omitted, an automatic name is used
   * (`centralu/<first 8 characters of the id>`).
   *
   * The branch name doubles as the session name and the worktree directory name — since it is
   * effectively permanent (changing it later means recreating the tree), the person has to be
   * able to choose it here. Validation is done by the host (`git check-ref-format` — we do not
   * re-implement that rule ourselves).
   */
  worktreeBranch: z.string().optional(),
  /**
   * Where to branch off from (the person pointed this out on 2026-09-07: "when creating a
   * worker, there is no way to pick which branch to pull from").
   *
   * If omitted, this is the project's trunk (the baseBranch the manager set), and if that is
   * also missing, the current HEAD. Even someone who has set a trunk sometimes needs "just this
   * one time, from that other branch," and if the only workaround were swapping branches in the
   * original folder, there would be no reason left to use a worktree.
   */
  worktreeBase: z.string().optional(),
  /**
   * How deep below a session the person started this one is (#867), when another machine's session starts it (#1038:
   * start_agent on a linked machine). Kept as the new session's own depth, so it starts agents and asks projects here
   * only as far as the setting allows; it can only make the session deeper, never shallower, so a caller that sends it
   * gains nothing. Absent: a session the person started.
   */
  agentDepth: z.number().int().min(1).max(100).optional(),
  /**
   * A session on another computer, linked to this one as its hub, starts this one (#1273: start_agent with a machine):
   * the preset the hub carries from that session. The new session runs under `auto` only when `callerPreset` is `auto`
   * and this host's "Allow auto from a linked computer" switch is on (`UiPreferences.hubAuto`); otherwise under
   * `permissionPreset`, `normal` at most. The session is marked as started from a linked computer
   * (`SessionInfo.startedFromHub`). A host from before this field drops it, and the session runs under
   * `permissionPreset`, which a hub sends as `normal` at most.
   */
  fromHub: z.object({ callerPreset: PermissionPreset }).optional(),
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>
/**
 * Change a session's settings. **The reason this has its own name** is so the port can use this
 * exact type too.
 *
 * The port used to re-declare `{ model?, permissionPreset? }` by hand, and when `effort` was
 * added later it was left out there. It still worked anyway — because when the store passes it
 * as a **variable**, TypeScript does not check for excess properties. A field the type said did
 * not exist was flowing through in practice.
 */
export const UpdateSettingsParams = z.object({
  sessionId: SessionId,
  model: z.string().nullable().optional(),
  /** Reasoning effort. Carried as a raw string since supported tiers differ by model */
  effort: z.string().nullable().optional(),
  /** Response length. Carried as a raw string under the same rule as effort (#54) */
  verbosity: z.string().nullable().optional(),
  /** Response speed. Same rule — which tiers are supported is stated by the model list */
  serviceTier: z.string().nullable().optional(),
  permissionPreset: PermissionPreset.optional(),
  /**
   * Whose hand makes the call (#659). Absent means a person's client, which is announced without a toast. The
   * orchestrator's settings tool on a linked machine sends `orchestrator`, so the machine broadcasts the change as the
   * orchestrator's and the window still toasts it. A host from before this field strips it, and then says nothing.
   */
  by: z.literal('orchestrator').optional(),
})
export type UpdateSettingsParams = z.infer<typeof UpdateSettingsParams>

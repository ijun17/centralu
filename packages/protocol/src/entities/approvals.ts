import { z } from 'zod'
import { GitSource } from './git.js'
import { AppId } from './ids.js'
import { AgentDifficulty } from './tools.js'

/** Permission preset — overrides the CLI's global setting on a per-session basis (validated at M0) */
export const PermissionPreset = z.enum(['safe', 'normal', 'auto'])
export type PermissionPreset = z.infer<typeof PermissionPreset>

export const ApprovalDecision = z.enum(['allow', 'deny', 'always'])
export type ApprovalDecision = z.infer<typeof ApprovalDecision>

/**
 * How one project may reach another (#371): 'delegate' is ask_project (part B), 'apps' another project's app tools (part A).
 * 'agents' (#561) is a project's sessions starting other agents in that same project (start_agent): its row names the
 * project on both sides.
 */
export const ProjectConsentKind = z.enum(['delegate', 'apps', 'agents'])
export type ProjectConsentKind = z.infer<typeof ProjectConsentKind>

export const ApprovalScope = z.enum(['session', 'project'])
export type ApprovalScope = z.infer<typeof ApprovalScope>

/**
 * The detail of an approval request. Adapters normalize a tool's raw format into these three
 * kinds. core/approval looks only at kind to judge whether inline approval from the banner is
 * possible (FR-3).
 *
 * `capability` is a card raised by **the host**, not an adapter (M4 D-4) — an app called by this
 * session is trying to use a capability (running an agent, another app, host data) for the first
 * time. The answer is remembered for this app and this capability (asked again if the manifest's
 * `uses` changes). This is why there is no "always allow" here: whether allowed or denied, a
 * single answer is remembered either way.
 */
export const ApprovalDetail = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string(),
    /*
     * What else the request says, kept so the card can show it and a list row does not answer it (#683 review). All
     * optional: an older host sends none, and a window that predates them ignores them.
     */
    /** Why the agent asks (Codex `reason`, e.g. it wants network access), in its own words */
    reason: z.string().optional(),
    /** The network access it asks for (Codex `networkApprovalContext`): the command alone may be empty */
    network: z.object({ host: z.string(), protocol: z.string() }).optional(),
    /** Input to a terminal already running (Codex `kind: 'writeStdin'`), not a new command */
    stdin: z.boolean().optional(),
    /** It runs outside the sandbox (Claude Code's Bash `dangerouslyDisableSandbox`) */
    unsandboxed: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('file_edit'),
    path: z.string(),
    diffPreview: z.string(),
    multi: z.boolean().default(false),
    /**
     * What the change does to the file, when the tool says (#683 review; Codex `PatchChangeKind`): absent is an edit.
     * A delete or a move is said on the card, and a list row does not answer it.
     */
    change: z.enum(['add', 'update', 'delete', 'move']).optional(),
    /** Where a move takes the file */
    movePath: z.string().optional(),
  }),
  /**
   * Anything else, as one text to read. `about` names a card the host raised that a window may know more about
   * (#665: `centralu_apply`, an agent applying the installed update); a window that does not know it, or predates
   * the field, reads `raw` as it always has, so the question is the whole of the card in every build.
   */
  z.object({ kind: z.literal('other'), raw: z.string(), about: z.string().optional() }),
  z.object({
    kind: z.literal('capability'),
    /** The app trying to use the capability — name is from the manifest */
    app: z.object({ appId: AppId, projectId: z.string().nullable(), name: z.string() }),
    /** The capability's name — `agent:<tool>`, `app:<scope>/<app>`, `host:<name>` */
    capability: z.string(),
    /** A single line for a person to read — what it is trying to do ("run an agent (Claude Code) in a new session") */
    text: z.string(),
  }),
  /**
   * One project reaching another (#371) — raised by **the host** in the calling session, the first time a session of
   * `from` asks to reach `to`. `access` says how: 'delegate' gives an existing session in `to` a task
   * (ask_project, part B); 'apps' attaches one of `to`'s apps to the caller (part A, with `app` naming it).
   *
   * Unlike `capability`, this one has all three answers: allow once (this call only), always (remembered for this
   * pair and kind, revocable in Settings), deny (not remembered — the next call asks again).
   */
  z.object({
    kind: z.literal('project_access'),
    access: ProjectConsentKind,
    from: z.object({ id: z.string(), name: z.string() }),
    to: z.object({
      id: z.string(),
      name: z.string(),
      /**
       * Whether the person trusts the target project (#382). `false` is said on the card: the existing target session
       * follows that trust. Absent from a host that predates it, read as not saying.
       */
      trusted: z.boolean().optional(),
      /**
       * The linked machine the target project is on (#700), by the name the person gave it. Absent: a project on this
       * computer. A card that names a machine has no "always": the consent is for this call only (nothing is
       * remembered for a project of another machine).
       */
      machine: z.string().optional(),
    }),
    /** One line for a person to read: what the caller wants done there (the task, cut short; or the app's use) */
    text: z.string(),
    app: z.object({ appId: z.string(), name: z.string() }).optional(),
    /** The existing session chosen for ask_project; absent from older hosts. */
    session: z.object({ id: z.string(), name: z.string() }).optional(),
  }),
  /**
   * A session asks to start another agent in its own project (#561, start_agent) — raised by **the host** in the
   * calling session, the first time it starts one. Four answers: allow once (this call only), always for this
   * session (`always` with scope `session`, kept while this host serves the session), always for this project
   * (`always` with scope `project`, remembered as the project's 'agents' consent and revoked in Settings), deny.
   */
  z.object({
    kind: z.literal('agent_start'),
    project: z.object({ id: z.string(), name: z.string() }),
    /** The agent CLI the new session runs, and its model when the caller named one */
    tool: z.string(),
    model: z.string().optional(),
    /** The difficulty the caller named (#729), which chose `model` from the person's setting; absent from older hosts */
    difficulty: AgentDifficulty.optional(),
    /** The permission preset the new session gets: the caller's own, never more */
    preset: PermissionPreset,
    /** A new worktree the session works in (#561 part 2), on this branch; absent: the caller's own folder */
    worktree: z.object({ branch: z.string() }).optional(),
    /** One line for a person to read: the task, cut short */
    text: z.string(),
  }),
  /**
   * An ordinary session asks to check or install Centralu itself (#581). Applying the installed build (#665) is not an
   * action here: a released window parses events strictly and drops one whose enum it does not know, so that card
   * rides on `other` with `about: 'centralu_apply'`.
   */
  z.object({
    kind: z.literal('centralu_update'),
    action: z.enum(['check', 'install']),
  }),
  /**
   * The orchestrator asks to make a new project (#515, create_project) — raised by **the host** in the orchestrator's
   * session. Nothing exists until the person allows it: then the folder at `path` is made (empty) and registered as
   * the project `name`. Allow or deny only; there is no "always".
   */
  z.object({
    kind: z.literal('project_create'),
    /** The folder's name, which is the project's */
    name: z.string(),
    /** The full path of the folder that will be made, in its machine's own terms */
    path: z.string(),
    /** The repository the folder is a clone of (#515), when it is not made empty */
    source: GitSource.optional(),
    /**
     * The linked machine the folder is made on, by the name the person gave it (#82, remote-hub.md §12): absent for
     * this computer. The card and its question name it, since `path` alone does not say whose disk it is
     */
    machine: z.string().optional(),
  }),
])
export type ApprovalDetail = z.infer<typeof ApprovalDetail>

/** The path of a file edit whose request names no file (#169): said as such rather than drawn as an empty card */
export const NO_PATH = '(no path)'

/** The `about` of an agent's apply card (#665), on an `other` detail */
export const CENTRALU_APPLY = 'centralu_apply'

/**
 * The question an agent's apply card asks (#665), carried whole as the card's text so a window of any build reads it.
 * Here rather than with the other questions in core: the host raises this card, and the host does not import core.
 * It says what the relaunch costs: the agents keep running, but the relaunched window moves the agent host to the new
 * build at once, and that swap stops Centralu tool calls still running past its 10-second drain, in every session.
 */
export const CENTRALU_APPLY_QUESTION =
  'Allow this session to apply the installed Centralu update? The window relaunches into it and running agents keep going. ' +
  'Right after, the new window switches the agent host to the new build: in any session, a Centralu tool call still running ' +
  'after 10 seconds (an agent waiting on its child agents, for one) is stopped and has to be tried again.'

/** An agent's apply card (#665): an update question, whose "always" is for this session only */
export function isCentraluApply(d: ApprovalDetail): boolean {
  return d.kind === 'other' && d.about === CENTRALU_APPLY
}

/**
 * The `about` of the orchestrator's handoff card (#694, handoff_session), on an `other` detail: the question is the
 * whole card in every build, and a window that knows the name keeps its "always" to the asking session, as an apply
 * card's is (the host remembers it for that session while it serves it, never for a project).
 */
export const SESSION_HANDOFF = 'session_handoff'

/** A card whose "always" is for the asking session only (#581, #665, #694): an update, an apply, a handoff */
export function sessionOnlyAlways(d: ApprovalDetail): boolean {
  return d.kind === 'centralu_update' || (d.kind === 'other' && (d.about === CENTRALU_APPLY || d.about === SESSION_HANDOFF))
}

/** One remembered "always" from one project to another (#371) — a row of Settings' list, with the names as they are now */
export const ProjectConsent = z.object({
  fromProjectId: z.string(),
  fromName: z.string(),
  toProjectId: z.string(),
  toName: z.string(),
  kind: ProjectConsentKind,
  decidedAt: z.number(),
  /** A consent kept by a linked machine (#82); absent or null for the hub's own */
  machine: z.string().nullable().optional(),
})
export type ProjectConsent = z.infer<typeof ProjectConsent>

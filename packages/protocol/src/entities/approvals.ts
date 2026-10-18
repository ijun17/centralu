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
const ApprovalDetailKinds = z.discriminatedUnion('kind', [
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
    from: z.object({
      id: z.string(),
      name: z.string(),
      /**
       * The linked machine the asking project is on (#550, the reverse direction): a session there asks a project of
       * this computer. The card is this computer's and names the machine; approving it is remembered for the pair (that
       * session, this project) until withdrawn in Settings → Machines. Absent: a project on this computer
       */
      machine: z.string().optional(),
      /** The asking session there (#550), by its id on that machine and its name; absent otherwise */
      session: z.object({ id: z.string(), name: z.string() }).optional(),
    }),
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
    /** The short name the caller gave the new session (#861), shown in the sidebar; absent: named from its task */
    name: z.string().optional(),
    /**
     * The linked machine the new session starts on (#1038), by the name the person gave it; `project` is then that
     * machine's checkout of the caller's repository. Absent: this computer. A card that names a machine has no
     * "always": the consent is for this call only, as for ask_project's (#700).
     */
    machine: z.string().optional(),
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
  /**
   * The orchestrator asks to add a folder that already exists as a project (#1220, its add_project command), raised
   * by **the host** in the orchestrator's session. The facts are read on the folder's machine before the card: a path
   * that is missing, a file or already a project is refused without one, so `exists` and `folder` say what was found.
   * On Allow the folder is registered as the sidebar's Add project registers it (untrusted when new). Allow or deny
   * only; there is no "always". `text` is the whole question, which a window that does not know this kind shows (#844).
   */
  z.object({
    kind: z.literal('project_add'),
    /** The project's name: the folder's */
    name: z.string(),
    /** The folder's full path, in its machine's own terms */
    path: z.string(),
    /** The linked machine the folder is on, by the name the person gave it: absent for this computer */
    machine: z.string().optional(),
    exists: z.boolean(),
    folder: z.boolean(),
    /** The folder is in a git repository */
    git: z.boolean(),
    /** That repository's `origin` remote, as its config has it; null when it has none or is no repository */
    origin: z.string().nullable(),
    text: z.string(),
  }),
])

/**
 * The approval card as a window reads it: a card it cannot read is shown as one it can, never dropped (#844).
 *
 * An `approval_request` is an event, and `parseServerFrame` drops an event it cannot parse whole. A card of a kind this
 * build does not know (a newer host's, or a linked machine's on a newer build), or of a known kind with a word this
 * build does not have (`project_access` with a new `access`), used to cost the whole event: the session sat waiting
 * on a question nobody could see. Now it reads as `other`, whose text says first that it is a fallback and of which
 * kind, then what the card names and says (`unknownApprovalCard`), with `about: UNKNOWN_CARD` so the window offers
 * allow and deny only: "always" on a question this build cannot describe would remember something the person never
 * read. A hub that relays a linked machine's card as such refuses "always" for it too, since a window from before this
 * change would still offer it (`Qualifier.unreadCard`). The answer still goes back under the
 * card's `requestId`, and the host that raised the card applies it the way its own kind says.
 *
 * Windows released before this change still drop such a card, so a new kind that must reach them rides on `other`
 * with an `about` instead, as the apply (#665) and handoff (#694) cards do (protocol.md §3.3).
 */
export const ApprovalDetail = ApprovalDetailKinds.catch((ctx) => unknownApprovalCard(ctx.value))
export type ApprovalDetail = z.infer<typeof ApprovalDetailKinds>

/** The `about` of a card this build could not read (#844), on an `other` detail */
export const UNKNOWN_CARD = 'unknown_card'

/** The last line of a card of a kind this build does not know */
export const UNKNOWN_CARD_NOTE = 'A newer Centralu may have sent it. Allow it only if you know what it asks; updating Centralu shows it in full.'

/** The last line of a card of a known kind that did not read: from a newer build, or malformed */
export const UNREADABLE_CARD_NOTE = 'It may come from a newer Centralu, or be malformed. Allow it only if you know what it asks.'

/** A text with something in it, trimmed; agent-host's `trimmed` (json-value.ts), which protocol cannot import (#850) */
const trimmed = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const quoted = (v: unknown, max = 500): string => {
  const cut = (t: string) => (t.length > max ? `${t.slice(0, max)}…` : t)
  // JSON quoting keeps a text on one line, so it cannot pass itself off as the card's own lines; a value that is not
  // text is written as JSON, also one line
  return typeof v === 'string' ? JSON.stringify(cut(v)) : cut(JSON.stringify(v) ?? String(v))
}
const nameOf = (v: unknown): string | undefined => (typeof v === 'object' && v !== null ? trimmed((v as Record<string, unknown>).name) : undefined)

/**
 * A card this build could not read, as the `other` card that says what it can of it (#844). In this order, so the person
 * reads what it is before what it says: that it is a fallback and of which kind (for a known kind, the values that did
 * not read), the projects, app or machine it names, then its own text, quoted and marked as unchecked (a task or a
 * question is often the asking agent's words, not Centralu's), and last a line on why it says so little.
 */
function unknownApprovalCard(raw: unknown): ApprovalDetail {
  const card = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const kind = trimmed(card.kind)?.slice(0, 60)
  const branch = kind ? ApprovalDetailKinds.options.find((o) => o.shape.kind.value === kind) : undefined
  const lines: string[] = []
  let problems = ''
  if (branch) {
    const parsed = branch.safeParse(raw)
    problems = (parsed.error?.issues ?? [])
      .slice(0, 3)
      .map((issue) => {
        const value = issue.path.reduce<unknown>((at, key) => (typeof at === 'object' && at !== null ? (at as Record<PropertyKey, unknown>)[key as PropertyKey] : undefined), raw)
        return `${issue.path.join('.') || 'the card'}: ${value === undefined ? 'missing' : quoted(value, 60)}`
      })
      .join(', ')
    lines.push(`Centralu cannot show this question as it should: a "${kind}" question with something this window cannot read (${problems || 'its shape'}).`)
  } else {
    problems = kind ? `kind ${quoted(kind, 60)}` : 'no kind'
    lines.push(kind ? `Centralu cannot show this question: it is of a kind this window does not know (${quoted(kind, 60)}).` : 'Centralu cannot show this question: it does not say what kind it is.')
  }
  const from = nameOf(card.from)
  const to = nameOf(card.to)
  if (from || to) lines.push(`It reaches from project ${from ? quoted(from, 80) : '(unnamed)'} to project ${to ? quoted(to, 80) : '(unnamed)'}.`)
  const named = [
    nameOf(card.project) && `project ${quoted(nameOf(card.project), 80)}`,
    nameOf(card.app) && `app ${quoted(nameOf(card.app), 80)}`,
    trimmed(card.machine) && `machine ${quoted(trimmed(card.machine), 80)}`,
  ].filter(Boolean)
  if (named.length) lines.push(`It names ${named.join(', ')}.`)
  for (const [key, label] of [['text', 'Its text'], ['raw', 'Its text'], ['command', 'The command'], ['path', 'The file']] as const) {
    const v = trimmed(card[key])
    if (v) lines.push(`${label}, as the request gives it (not checked by Centralu): ${quoted(v)}`)
  }
  lines.push(branch ? UNREADABLE_CARD_NOTE : UNKNOWN_CARD_NOTE)
  console.warn(`[centralu] an approval card did not read and is shown as a fallback: ${kind ?? '(no kind)'}${problems ? ` (${problems})` : ''}`)
  return { kind: 'other', raw: lines.join('\n'), about: UNKNOWN_CARD }
}

/** A card this build could not read (#844): shown as a fallback that says its kind, answered by allow or deny */
export function isUnknownCard(d: ApprovalDetail): boolean {
  return d.kind === 'other' && d.about === UNKNOWN_CARD
}

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

/**
 * The question the orchestrator's add-folder card asks (#1220), carried whole as the card's `text`, which is what a
 * window that does not know the kind shows (#844). Here rather than with the other questions in core: the host raises
 * this card, and the host does not import core. It names every fact the card shows.
 */
export function projectAddQuestion(d: { name: string; path: string; machine?: string; git: boolean; origin: string | null }): string {
  const where = d.machine ? `${d.path} on ${d.machine}` : d.path
  const repo = d.git ? (d.origin ? `a git repository (origin ${d.origin})` : 'a git repository with no origin') : 'not a git repository'
  return `Add the existing folder ${where} as the project ${d.name}? It is ${repo}.`
}

/**
 * The `about` of the orchestrator's card for a change to a linked machine (#1219: adding, installing on, updating,
 * removing one, or turning its start at boot on or off), on an `other` detail: the question is whole in `raw`, so a
 * window of any build reads it. Allow or deny only: a window that knows the name offers no "always", and the host
 * remembers nothing for one (an older window's "always" is read as allow, once).
 */
export const MACHINE_CHANGE = 'machine_change'

/** The orchestrator's card for a change to a linked machine (#1219) */
export function isMachineChange(d: ApprovalDetail): boolean {
  return d.kind === 'other' && d.about === MACHINE_CHANGE
}

import { z } from 'zod'
import { GitSource } from './git.js'
import { AppId, PermissionPreset } from './ids.js'
import { AgentDifficulty } from './tools.js'

export const ApprovalDecision = z.enum(['allow', 'deny', 'always'])
export type ApprovalDecision = z.infer<typeof ApprovalDecision>

/**
 * How one project may reach another: 'delegate' is ask_project, 'apps' another project's app tools, 'agents' a
 * project's sessions starting agents in that same project (start_agent; its row names the project on both sides).
 */
export const ProjectConsentKind = z.enum(['delegate', 'apps', 'agents'])
export type ProjectConsentKind = z.infer<typeof ProjectConsentKind>

export const ApprovalScope = z.enum(['session', 'project'])
export type ApprovalScope = z.infer<typeof ApprovalScope>

/**
 * Normalized by the adapter; core/approval judges inline approval from `kind` alone (FR-3, docs/protocol.md §2).
 * `capability` is raised by the host: an app this session called uses a capability for the first time. One answer,
 * allow or deny, is remembered per app and capability (asked again when the manifest's `uses` changes): no "always".
 */
const ApprovalDetailKinds = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string(),
    // Shown on the card, and a list row does not answer such a request. An older host sends none; an older window ignores them
    /** Why the agent asks (Codex `reason`), in its own words */
    reason: z.string().optional(),
    /** Codex `networkApprovalContext`: the command alone may be empty */
    network: z.object({ host: z.string(), protocol: z.string() }).optional(),
    /** Input to a terminal already running (Codex `kind: 'writeStdin'`), not a new command */
    stdin: z.boolean().optional(),
    /** Claude Code's Bash `dangerouslyDisableSandbox` */
    unsandboxed: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('file_edit'),
    path: z.string(),
    diffPreview: z.string(),
    multi: z.boolean().default(false),
    /** Codex `PatchChangeKind`; absent is an edit. A delete or move is said on the card, and a list row does not answer it */
    change: z.enum(['add', 'update', 'delete', 'move']).optional(),
    movePath: z.string().optional(),
  }),
  /**
   * Anything else, as one text. `about` names a host-raised card a window may know more about (`centralu_apply`); a
   * window that does not know it reads `raw`, so the question is the whole card in every build.
   */
  z.object({ kind: z.literal('other'), raw: z.string(), about: z.string().optional() }),
  z.object({
    kind: z.literal('capability'),
    app: z.object({ appId: AppId, projectId: z.string().nullable(), name: z.string() }),
    /** `agent:<tool>`, `app:<scope>/<app>` or `host:<name>` */
    capability: z.string(),
    text: z.string(),
  }),
  /**
   * One project reaching another, raised by the host the first time a session of `from` asks to reach `to`. Three
   * answers: allow once, always (remembered for the pair and kind, revocable in Settings), deny (not remembered).
   */
  z.object({
    kind: z.literal('project_access'),
    access: ProjectConsentKind,
    from: z.object({
      id: z.string(),
      name: z.string(),
      /**
       * The linked machine of the asking project: the card is this computer's, and approving it is remembered for
       * (that session, this project) until withdrawn in Settings → Machines. Absent: this computer
       */
      machine: z.string().optional(),
      /** The asking session there, by its id on that machine; absent otherwise */
      session: z.object({ id: z.string(), name: z.string() }).optional(),
    }),
    to: z.object({
      id: z.string(),
      name: z.string(),
      /** `false` is said on the card: the existing target session follows that trust. Absent from an older host: not said */
      trusted: z.boolean().optional(),
      /** The target's linked machine; absent: this computer. Then no "always": nothing is remembered for another machine */
      machine: z.string().optional(),
    }),
    /** What the caller wants done there (the task, cut short; or the app's use) */
    text: z.string(),
    app: z.object({ appId: z.string(), name: z.string() }).optional(),
    /** The existing session chosen for ask_project; absent from older hosts. */
    session: z.object({ id: z.string(), name: z.string() }).optional(),
  }),
  /**
   * A session asks to start another agent in its own project (start_agent), raised by the host the first time. Answers:
   * allow once; always with scope `session` (kept while this host serves the session); always with scope `project` (the
   * project's 'agents' consent, revoked in Settings); deny.
   */
  z.object({
    kind: z.literal('agent_start'),
    project: z.object({ id: z.string(), name: z.string() }),
    tool: z.string(),
    model: z.string().optional(),
    /** It chose `model` from the person's setting; absent from older hosts */
    difficulty: AgentDifficulty.optional(),
    /** The caller's own preset, never more */
    preset: PermissionPreset,
    /** A new worktree on this branch; absent: the caller's own folder */
    worktree: z.object({ branch: z.string() }).optional(),
    /** The task, cut short */
    text: z.string(),
    /** Shown in the sidebar; absent: named from its task */
    name: z.string().optional(),
    /**
     * The linked machine it starts on; `project` is then that machine's checkout of the caller's repository. Absent:
     * this computer. Then no "always": the consent is for this call only, as for ask_project's
     */
    machine: z.string().optional(),
    /**
     * The `auto` caller's child on `machine` will not run under `auto`: `machine_off`, its "Allow auto from a linked
     * computer" switch is off; `older`, its Centralu cannot take `auto` from another computer. Absent: the child runs
     * under the caller's preset (such a start raises no card at all), or an older host.
     */
    autoWithheld: z.enum(['machine_off', 'older']).optional(),
  }),
  /**
   * An ordinary session asks to check or install Centralu. The apply card is not an action here: a released window
   * drops an event whose enum it does not know, so it rides on `other` with `about: 'centralu_apply'`.
   */
  z.object({
    kind: z.literal('centralu_update'),
    action: z.enum(['check', 'install']),
  }),
  /**
   * The Assistant asks to make a new project (create_project), raised by the host. Nothing exists until the person
   * allows it: then the folder at `path` is made and registered as `name`. Allow or deny only.
   */
  z.object({
    kind: z.literal('project_create'),
    /** The folder's name, which is the project's */
    name: z.string(),
    /** In its machine's own terms */
    path: z.string(),
    /** The repository it is cloned from; absent: made empty */
    source: GitSource.optional(),
    /** Absent: this computer (remote-hub.md §12). Named on the card, since `path` alone does not say whose disk it is */
    machine: z.string().optional(),
  }),
  /**
   * The Assistant asks to add an existing folder as a project (add_project), raised by the host. The folder is read on
   * its machine first; a missing path, a file or an existing project is refused without a card. Allow or deny only.
   * `text` is the whole question, which a window that does not know this kind shows.
   */
  z.object({
    kind: z.literal('project_add'),
    name: z.string(),
    /** In its machine's own terms */
    path: z.string(),
    /** Absent: this computer */
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
 * The approval card as a window reads it: one it cannot read becomes an `other` card that says so and offers allow and
 * deny only, rather than costing the whole event (docs/protocol.md §3.3).
 */
export const ApprovalDetail = ApprovalDetailKinds.catch((ctx) => unknownApprovalCard(ctx.value))
export type ApprovalDetail = z.infer<typeof ApprovalDetailKinds>

/** The `about` of the fallback for a card this build could not read */
export const UNKNOWN_CARD = 'unknown_card'

/** The last line of a card of a kind this build does not know */
export const UNKNOWN_CARD_NOTE =
  'A newer Centralu may have sent it. Allow it only if you know what it asks; updating Centralu shows it in full.'

/** The last line of a card of a known kind that did not read: from a newer build, or malformed */
export const UNREADABLE_CARD_NOTE =
  'It may come from a newer Centralu, or be malformed. Allow it only if you know what it asks.'

/** A text with something in it, trimmed; agent-host's `trimmed` (json-value.ts), which protocol cannot import (#850) */
const trimmed = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const quoted = (v: unknown, max = 500): string => {
  const cut = (t: string) => (t.length > max ? `${t.slice(0, max)}…` : t)
  // JSON quoting keeps a value on one line, so it cannot pass itself off as the card's own lines
  return typeof v === 'string' ? JSON.stringify(cut(v)) : cut(JSON.stringify(v) ?? String(v))
}
const isObject = (v: unknown): v is Record<PropertyKey, unknown> => typeof v === 'object' && v !== null
const nameOf = (v: unknown): string | undefined => (isObject(v) ? trimmed(v.name) : undefined)

/** The fallback `other` card, its lines in the order docs/protocol.md §3.3 gives; the card's own text is marked unchecked */
function unknownApprovalCard(raw: unknown): ApprovalDetail {
  const card: Record<PropertyKey, unknown> = isObject(raw) ? raw : {}
  const kind = trimmed(card.kind)?.slice(0, 60)
  const branch = kind ? ApprovalDetailKinds.options.find((o) => o.shape.kind.value === kind) : undefined
  const lines: string[] = []
  let problems = ''
  if (branch) {
    const parsed = branch.safeParse(raw)
    problems = (parsed.error?.issues ?? [])
      .slice(0, 3)
      .map((issue) => {
        const value = issue.path.reduce<unknown>((at, key) => (isObject(at) ? at[key] : undefined), raw)
        return `${issue.path.join('.') || 'the card'}: ${value === undefined ? 'missing' : quoted(value, 60)}`
      })
      .join(', ')
    lines.push(
      `Centralu cannot show this question as it should: a "${kind}" question with something this window cannot read (${problems || 'its shape'}).`,
    )
  } else {
    problems = kind ? `kind ${quoted(kind, 60)}` : 'no kind'
    lines.push(
      kind
        ? `Centralu cannot show this question: it is of a kind this window does not know (${quoted(kind, 60)}).`
        : 'Centralu cannot show this question: it does not say what kind it is.',
    )
  }
  const from = nameOf(card.from)
  const to = nameOf(card.to)
  if (from || to)
    lines.push(
      `It reaches from project ${from ? quoted(from, 80) : '(unnamed)'} to project ${to ? quoted(to, 80) : '(unnamed)'}.`,
    )
  const named = [
    nameOf(card.project) && `project ${quoted(nameOf(card.project), 80)}`,
    nameOf(card.app) && `app ${quoted(nameOf(card.app), 80)}`,
    trimmed(card.machine) && `machine ${quoted(trimmed(card.machine), 80)}`,
  ].filter(Boolean)
  if (named.length) lines.push(`It names ${named.join(', ')}.`)
  for (const [key, label] of [
    ['text', 'Its text'],
    ['raw', 'Its text'],
    ['command', 'The command'],
    ['path', 'The file'],
  ] as const) {
    const v = trimmed(card[key])
    if (v) lines.push(`${label}, as the request gives it (not checked by Centralu): ${quoted(v)}`)
  }
  lines.push(branch ? UNREADABLE_CARD_NOTE : UNKNOWN_CARD_NOTE)
  console.warn(
    `[centralu] an approval card did not read and is shown as a fallback: ${kind ?? '(no kind)'}${problems ? ` (${problems})` : ''}`,
  )
  return { kind: 'other', raw: lines.join('\n'), about: UNKNOWN_CARD }
}

/** The fallback for a card this build could not read: answered by allow or deny only */
export function isUnknownCard(d: ApprovalDetail): boolean {
  return d.kind === 'other' && d.about === UNKNOWN_CARD
}

/** The path of a file edit whose request names no file, said rather than drawn as an empty card */
export const NO_PATH = '(no path)'

/** The `about` of an agent's apply card, on an `other` detail */
export const CENTRALU_APPLY = 'centralu_apply'

/**
 * The apply card's question, whole as its text so a window of any build reads it. Here, not in core: the host raises
 * the card and does not import core. It says what the relaunch costs: the agent host restarts, cutting every turn.
 */
export const CENTRALU_APPLY_QUESTION =
  'Allow this session to apply the installed Centralu update? The window relaunches into it and the agent host restarts: ' +
  'running turns in every session, this one included, stop and go on once it is back, each told to check what already ' +
  'happened. Open terminals and Run commands start again; a waiting approval or question is asked again.'

/** An agent's apply card: an update question, whose "always" is for this session only */
export function isCentraluApply(d: ApprovalDetail): boolean {
  return d.kind === 'other' && d.about === CENTRALU_APPLY
}

/**
 * The `about` of the Assistant's handoff card (handoff_session), on an `other` detail. A window that knows it keeps its
 * "always" to the asking session, as for an apply card (the host remembers it for that session, never a project).
 */
export const SESSION_HANDOFF = 'session_handoff'

/** A card whose "always" is for the asking session only: an update, an apply, a handoff */
export function sessionOnlyAlways(d: ApprovalDetail): boolean {
  return (
    d.kind === 'centralu_update' ||
    (d.kind === 'other' && (d.about === CENTRALU_APPLY || d.about === SESSION_HANDOFF))
  )
}

/** One remembered "always" from one project to another: a row of Settings' list, with the names as they are now */
export const ProjectConsent = z.object({
  fromProjectId: z.string(),
  fromName: z.string(),
  toProjectId: z.string(),
  toName: z.string(),
  kind: ProjectConsentKind,
  decidedAt: z.number(),
  /** A consent kept by a linked machine; absent or null for the hub's own */
  machine: z.string().nullable().optional(),
})
export type ProjectConsent = z.infer<typeof ProjectConsent>

/**
 * The add-folder card's question, whole as its `text`, which a window that does not know the kind shows. Here, not in
 * core: the host raises the card and does not import core.
 */
export function projectAddQuestion(d: {
  name: string
  path: string
  machine?: string
  git: boolean
  origin: string | null
}): string {
  const where = d.machine ? `${d.path} on ${d.machine}` : d.path
  const repo = d.git
    ? d.origin
      ? `a git repository (origin ${d.origin})`
      : 'a git repository with no origin'
    : 'not a git repository'
  return `Add the existing folder ${where} as the project ${d.name}? It is ${repo}.`
}

/**
 * The `about` of the Assistant's card for a change to a linked machine (add, install, update, remove, start at boot),
 * on an `other` detail. Allow or deny only: the host remembers nothing, and reads an older window's "always" as allow once.
 */
export const MACHINE_CHANGE = 'machine_change'

export function isMachineChange(d: ApprovalDetail): boolean {
  return d.kind === 'other' && d.about === MACHINE_CHANGE
}

/**
 * The `about` of the Assistant's card for a change to its settings or the trash ("apply updates when idle", deleting
 * for good, emptying), on an `other` detail. Allow or deny only, and the host remembers nothing.
 */
export const ASSISTANT_CHANGE = 'assistant_change'

/** `orchestrator_change` is the same card's `about` under the role's old name, which a linked machine of beta.57 to beta.84 sends (#2532) */
export function isAssistantChange(d: ApprovalDetail): boolean {
  return d.kind === 'other' && (d.about === ASSISTANT_CHANGE || d.about === 'orchestrator_change')
}

/**
 * The `about` of the card for one call of an app's tool (`app` with `call`), on an `other` detail. Allow or deny only,
 * every time: the host remembers nothing, and reads an older window's "always" as allow once.
 */
export const APP_CALL = 'app_call'

export function isAppCall(d: ApprovalDetail): boolean {
  return d.kind === 'other' && d.about === APP_CALL
}

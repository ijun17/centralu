import type {
  AgentDifficulty,
  BackgroundTask,
  GitSource,
  Interruption,
  LineHeight,
  MachineInfo,
  RpcResult,
  ApprovalDetail,
  Question,
  QuestionAnswer,
  SessionInfo,
  PermissionPreset,
  ToolName,
  UpdateStatus,
} from '@cc/protocol'

/** One request of the orchestrator's machine commands (#1219), as the tool runner reads its arguments */
export type MachineRequest =
  | { action: 'add'; sshTarget: string; name?: string; wslDistro?: string }
  | { action: 'install' | 'update' | 'remove' | 'reconnect'; machine: string }
  | { action: 'auto_reconnect'; machine: string; on: boolean }
  | { action: 'autostart'; machine: string; on: boolean }

/** What `set_preferences` changes (#1219, preferences and the trash): each field is one setting the window offers; absent means leave it */
export type PreferenceChanges = {
  /** A theme by id or name; it sets the dark or the light side by the theme's base, and shows that side */
  theme?: string
  textSize?: number
  bodyFont?: string
  codeFont?: string
  lineHeight?: LineHeight
  /** Minutes of quiet before an idle session sleeps, or 'never' */
  idleSleepMinutes?: number | 'never'
  checkForUpdates?: boolean
  applyUpdatesWhenIdle?: boolean
  moveIdleSessionsToNewAgentCli?: boolean
  /** The notification switches (#1306), the ones to change; reversible, no card */
  notifications?: { approval?: boolean; error?: boolean; done?: boolean; allDone?: boolean; whenFocused?: boolean; sound?: boolean }
}

/** One request of the orchestrator's preference commands (#1219), as the tool runner reads its arguments */
export type PreferencesRequest = { action: 'get' } | { action: 'set'; changes: PreferenceChanges }

/** One request of the orchestrator's trash commands (#1219), as the tool runner reads its arguments */
export type TrashRequest =
  | { action: 'list' }
  | { action: 'restore'; sessionId: string; what: 'session' | 'steps' }
  | { action: 'trash_steps'; sessionId: string }
  | { action: 'delete'; sessionId: string; what: 'session' | 'steps' }
  | { action: 'empty' }

export type OrchestratedSession = {
  sessionId: string
  name: string
  project: string
  state: string
  /** Whether the worktree branch has landed on trunk (#69) — how the manager decides "finished" on its own */
  merged?: boolean
  /** The PR for this branch (#76 stage 3) — measured via gh. Distinguishes "waiting on review" from "just in progress" */
  pr?: { number: number; state: string }
  /** A `ToolName` for the hub's own sessions; a linked machine's is whatever that build calls its tool */
  tool: ToolName | (string & {})
  /** One line describing what last happened */
  preview: string
  /** When it last moved — decides which session is the "current conversation" */
  lastActive?: string
  /** The linked machine it runs on, by the name the person gave it (#82 phase 4); absent for this computer's own */
  machine?: string
  /** Why that machine could not be asked just now, so the row is what the hub last knew of it */
  away?: string
  /** Why its last turn did not run to its end (#698), until it works again */
  interruption?: Interruption
  /** Its card is a question, not an approval: `state` says waiting_approval for both (#428) */
  waitingOn?: 'question'
}

/** One `recall` hit: where it was said, and the seq that opens it with read_session */
export type RecallHit = {
  sessionId: string
  session: string
  project: string
  snippet: string
  /** Pass this as read_session's around to jump straight to that passage */
  seq: number
  at?: string
  /** The linked machine it was said on (#82 phase 4); absent for this computer's own */
  machine?: string
}

/** Why a machine that is not connected cannot be asked, in the words every tool uses for it */
export const NOT_REACHABLE = 'not reachable right now'

/**
 * Why a machine nothing here will connect cannot be asked (#1341): the person disconnected it, or its Auto reconnect is
 * off and the attempt at the hub's start is over. No call connects it; only the person's Connect does
 */
export const NOT_CONNECTED = 'not connected until the person connects it'

/** What `awayPhrase` says for `NOT_CONNECTED`: the model is told to ask the person, who is the one who can */
export const NOT_CONNECTED_PHRASE = 'is not connected, and nothing here connects it by itself; ask the person to connect it (Settings, Machines, Connect)'

/**
 * A machine that cannot be asked (`LinkedProject.away`), as the verb phrase after its name: the words a model reads for
 * not reachable and for not connected, its plain cause for any other
 */
export function awayPhrase(why: string): string {
  if (why === NOT_CONNECTED) return NOT_CONNECTED_PHRASE
  return why === NOT_REACHABLE ? `is ${NOT_REACHABLE}` : `could not be asked just now (${why})`
}

/** A project on a linked machine, as the hub's orchestrator names it (#82 phase 4) */
export type LinkedProject = {
  id: string
  name: string
  path: string
  defaultTool: ToolName | null
  /** The machine's name as the person gave it, and its id (what a qualified project name starts with) */
  machine: string
  machineId: string
  /** Whether the person trusts the project on that machine (#382). Absent from a machine that predates it: not saying, which is not "not trusted" */
  trusted?: boolean
  /** Set when the machine cannot be asked just now: why. The project is then what the headers mirror last held */
  away?: string
  /** The person's instructions there for agents started in it (#1161 item 2); absent when none, or from a machine that predates them */
  agentInstructions?: string
}

/** Failed with a sentence the model reads, or done */
type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: string }

/**
 * The sessions of the machines this host links to, for its orchestrator (#82, docs/plans/remote-hub.md §12;
 * links/linked-sessions.ts). Every id it gives and takes is machine-qualified (`<machine>.<id>`). Only the hub's
 * central orchestrator reaches through it: a manager, a lead and an ordinary session keep their own machine's view
 */
export type LinkedSessions = {
  /** An instruction to a machine's session, recorded there as sent by `fromName` (`host.send`) */
  /** `ask`: the text is an ask_project task, worked on at that agent depth until its turn ends (#838) */
  send(sessionId: string, text: string, fromName: string, ask?: { depth: number }): Promise<Outcome>
  /** A machine's session's model, effort or verbosity (`agents.updateSettings` there); the answer in the hub's terms */
  updateSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; verbosity?: string | null },
  ): Promise<Outcome<{ info: SessionInfo & { applied?: string } }>>
  /**
   * The projects of `projects()` whose name or qualified id is `ref`, under the same per-machine bound: one on a machine
   * that cannot be asked just now comes from the mirror, marked `away`, so it is found as unreachable, never as missing
   */
  findProjects(ref: string): Promise<LinkedProject[]>
  /**
   * Every linked machine's projects (ask_project, #700). A machine that cannot be asked contributes what the headers
   * mirror last held, each project marked `away` with why, and is named in `away` whether or not the mirror held
   * anything: a project there is reported as unreachable, never as missing
   */
  projects(): Promise<{ projects: LinkedProject[]; away: { machine: string; machineId: string; why: string }[] }>
  /** A machine project's ordinary sessions (its workers, not an app's) as that machine reports them now; ids qualified */
  projectSessions(project: LinkedProject): Promise<Outcome<{ sessions: { id: string; name: string; state: string }[] }>>
  /**
   * A new session in a machine's project, under `preset` (`normal` when none is given; the caller caps it, #838), named
   * if a name is given. For start_agent's child there (#1038): its model and effort, a new worktree on `worktreeBranch`,
   * and the agent depth it is kept at (`CreateSessionParams.agentDepth`); `callerPreset`, the preset its caller carries
   * there (#1273, `CreateSessionParams.fromHub`), `auto` only once the machine said it takes it (`hubAuto`). `preset` in
   * the answer: what the machine started it under, as it says
   */
  createSession(
    project: LinkedProject,
    opts: { tool?: ToolName; name?: string; preset?: PermissionPreset; model?: string; effort?: string; worktreeBranch?: string; agentDepth?: number; callerPreset?: PermissionPreset },
  ): Promise<Outcome<{ sessionId: string; name: string; preset?: PermissionPreset }>>
  /**
   * Whether a machine runs an `auto` caller's child under `auto` too (#1273, `host.hubAuto` there): its "Allow auto from
   * a linked computer" switch. `olderBuild`: the machine runs a Centralu from before it, which keeps `normal`
   */
  hubAuto(machineId: string): Promise<Outcome<{ allowed: boolean }> | { ok: false; error: string; olderBuild: true }>
  /**
   * A machine project's `origin` remote, as git there has it (`projects.origin`, #1038); null with none. `olderBuild`: the
   * machine runs a Centralu from before it, which also drops `createSession`'s `agentDepth`
   */
  origin(project: LinkedProject): Promise<Outcome<{ origin: string | null }> | { ok: false; error: string; olderBuild: true }>
  /** Stops a machine's session's running turn (`agents.interrupt` there, #1038) */
  interrupt(sessionId: string): Promise<Outcome>
  /** Moves a machine's session to that machine's trash, its worktree left in place (`agents.deleteSession` there, #1038) */
  deleteSession(sessionId: string): Promise<Outcome>
  /**
   * The project's instructions for started agents as the machine has them now (#1161 item 2), '' for none; an error
   * when it cannot be asked, so the caller keeps what it listed before. Optional, as is `deleteAgentChild`: a reader
   * from before them (a stand-in, a build that predates #1161) has neither, and its caller does as it did then
   */
  agentInstructions?(project: LinkedProject): Promise<Outcome<{ text: string }>>
  /**
   * A start_agent child deleted there with the worktree made for it on `branch`, when nothing would be lost
   * (`agents.deleteAgentChild` there, #1161 item 3). `olderBuild`: the machine predates it, and nothing was deleted
   */
  deleteAgentChild?(
    sessionId: string,
    branch: string,
  ): Promise<Outcome<{ worktree: 'removed' | 'kept' | 'none'; path?: string; branch?: string; why?: string; note?: string }> | { ok: false; error: string; olderBuild: true }>
  /**
   * The last message a machine's session took in (its text and sender, `from` qualified), or null for none within its
   * last thousand messages: whose turn it is running (#1038 review)
   */
  lastUserMessage(sessionId: string): Promise<Outcome<{ message: { text: string; from: unknown } | null }>>
  /** The cards standing in a machine's session now, as that machine lists them (#1038: agent_session on a child there) */
  cards(sessionId: string): Promise<Outcome<{
    approval: { requestId: string; detail: ApprovalDetail } | null
    questions: { requestId: string; questions: Question[] }[]
  }>>
  /** Answers a question card of a machine's session, as its window would (`agents.answerQuestion` there, #1038) */
  answerQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[]): Promise<Outcome>
  /** A linked machine by its id or the name the person gave it, case aside */
  machineNamed(ref: string): { id: string; name: string } | null
  /** Whether the machine with this id is still linked: a removed machine is not (#723) */
  machineLinked(machineId: string): boolean
  /**
   * Each session's background work as the machine lists it now (`sessions.list`, #723), ids qualified; null when the
   * machine cannot be asked. What the hub knows of that work is otherwise only the changes relayed since its link came up
   */
  backgroundTasks(machineId: string): Promise<{ sessionId: string; tasks: BackgroundTask[] }[] | null>
  /** Where `projects.create` would make the folder on that machine, or why it would refuse */
  previewProject(machineId: string, spec: { name: string; parent?: string; source?: GitSource }): Promise<Outcome<{ name: string; path: string }>>
  createProject(machineId: string, spec: { name: string; parent?: string; source?: GitSource }): Promise<Outcome<{ projectId: string; name: string; path: string }>>
  /**
   * What a folder on that machine is, as its host reads it (`projects.inspect` there, #1220). A machine on a Centralu
   * from before it is named as too old
   */
  inspectFolder(machineId: string, path: string): Promise<Outcome<{ facts: RpcResult<'projects.inspect'> }>>
  /** Registers an existing folder there as a project: that machine's `projects.add`, as its group's Add project calls it (#1220) */
  addProject(machineId: string, path: string): Promise<Outcome<{ projectId: string; name: string; path: string }>>
  /**
   * What an ordinary session's reader view needs of a machine's session (#984), from the headers mirror: whether it is
   * an app's (its builder or an agent an app asked for, never shown to a reader) and whether its project is trusted
   * there. Null when the mirror does not hold it, which the reader treats as not readable.
   */
  readerFacts(sessionId: string): { app: boolean; trusted: boolean } | null
  /** A machine's session as the hub last knew it (the headers mirror): its name and its project's */
  describe(sessionId: string): { name: string; project: string } | null
  /**
   * The last thing a machine's session said (`host.lastAnswer` there, #1186): its head up to `maxChars` (an ellipsis
   * past it), its length in all, and the seq its first message has there (`around` for read_session), or null when
   * the machine does not say (an older one, read from its lines). A read that failed says why: it used to be an empty
   * answer, which read as "it said nothing"
   */
  lastWords(sessionId: string, maxChars: number): Promise<Outcome<{ text: string; length: number; seq: number | null }>>
  /** Every linked machine's sessions, the hub's view of each (its orchestrator and coordinators left out) */
  list(): Promise<OrchestratedSession[]>
  /** Every linked machine's sessions, the hub's view of each (its orchestrator and coordinators left out) */
  list(): Promise<OrchestratedSession[]>
  /** The name of the linked machine a qualified id names, or null for an id of this host */
  machineOf(sessionId: string): string | null
  read(
    sessionId: string,
    limit?: number,
    opts?: { around?: number; tools?: boolean; offset?: number },
  ): Promise<{ ok: boolean; error?: string; lines?: string[]; state?: string }>
  /** Each machine's hits in its own rank order, one list per machine, and the machines that could not be searched, as `<name> (<why>)` */
  recall(query: string, limit: number): Promise<{ hits: RecallHit[][]; notSearched: string[] }>
}

/**
 * A card standing in a session whose turn the caller gave it (#676), as the caller reads it: a question it may answer
 * (the person may too, and the first answer wins), or an approval it is only told of unless its own preset is `auto`
 * when it answers. The questions and the approval's detail are the target's text: rendered fenced, never as an
 * instruction.
 */
export type RoutedCard = {
  /** The handle the caller answers with (`cardHandle`): the request id bound to the turn and to what the card asks */
  card: string
  /** The adapter's own id for the card, which a new process may reuse */
  requestId: string
} & ({ kind: 'question'; questions: Question[] } | { kind: 'approval'; detail: ApprovalDetail; answerable: boolean })

/**
 * A request to a session busy with a turn that is not the requester's (#677): what the requester may do instead. The
 * requester chooses, by calling again with `ifBusy`; nothing was sent.
 *
 *   note       add it to the running turn as a mid-turn note (#594/#606/#653): only an `auto` requester, on a CLI that
 *              takes input mid-turn; the turn and its answer stay its owner's. The requester hears the turn's end only
 *              when it asks for a report (`reportBack`, #1233) and nobody else is owed it
 *   queue      hold it and deliver it as a new turn when the running one ends; the requester is told when that ends
 *   fork       a sub-session started from a copy of the session's conversation now, linked to the requester, in a
 *              worktree of its own (`fork_read`: read-only work, in the session's folder, under at most `safe`)
 */
export type IfBusy = 'note' | 'queue' | 'fork' | 'fork_read'
export type BusyChoice = { choice: 'note' | 'queue' | 'fork'; available: boolean; why?: string }
export type BusyAnswer =
  /** `ahead` and `progress` (#1186): how many requests are queued there before one would be, and where its turn is */
  | { state: 'busy'; sessionId: string; sessionName: string; sessionState: string; choices: BusyChoice[]; ahead?: number; progress?: TurnProgress }
  /** `lowMemory` (#686): queued instead of the fork asked for, since memory was low; what was read */
  | { state: 'queued'; sessionId: string; sessionName: string; queueId: string; position: number; lowMemory?: string }
  /** `reportTaken` (#1233): a report was asked for, but another session is owed that turn's end, so it stays theirs */
  | { state: 'noted'; sessionId: string; sessionName: string; reportTaken?: true }
  | { state: 'forked'; sessionId: string; sessionName: string; forkedFrom: string }

/**
 * Where a running turn is, as a wait past its bound and a busy answer tell the caller (#1186): how long the session has
 * recorded nothing (`quietFor`, "40 s", "3 min"), and its last step. "Still working" used to say nothing of it, so a
 * session at work and one stuck read the same
 */
export type TurnProgress = { quietFor: string; lastStep?: string }

/** What one ask_project call comes back with (#371 part B) — rendered for the model by runOrchestratorTool */
export type AskProjectResult =
  | {
      ok: true
      state: 'done'
      project: string
      sessionId: string
      sessionName: string
      /** The delegated turn's final answer, cut in the middle when long */
      answer: string
      /** Named paths inside the target project the caller may now read (files, or output folders) */
      readable: string[]
      /** Named paths outside it: listed, not granted */
      outside: string[]
    }
  | {
      ok: true
      state: 'working'
      project: string
      sessionId: string
      sessionName: string
      /** What the delegated session waits on, when it waits on the person (an approval, a question) */
      notice?: string
      /** Where its turn is (#1186), when this host records it */
      progress?: TurnProgress
    }
  | {
      ok: true
      /** The delegated turn stopped on a card the caller may read and answer (#676): agent_session answers it */
      state: 'asking'
      project: string
      sessionId: string
      sessionName: string
      cards: RoutedCard[]
    }
  | ({ ok: true; project: string } & Extract<BusyAnswer, { state: 'busy' | 'queued' }>)
  | { ok: false; error: string }

/**
 * What start_agent and agent_session come back with (#561) — rendered for the model by runOrchestratorTool.
 *
 *   done      the turn the caller gave it ended; `answer` is its final text, cut in the middle when long
 *   working   still running past the wait's bound (or not waited on); `reported` says the caller will be told when it ends
 *   at_rest   nothing the caller gave it is running (agent_session status/wait); `answer` is its last final text
 *   asking    the turn the caller gave it waits on a card the caller reads here and answers with agent_session (#676)
 *   answered  agent_session answer reached the card
 *   busy      the session is busy with a turn that is not the caller's: nothing was sent, the choices are listed (#677)
 *   queued    held until the session's running turn ends, then delivered as a new turn (#677)
 *   stopped   agent_session stop ended the turn
 *   deleted   agent_session delete put a child in the trash; worktree children also report branch cleanup
 *   pending   no session yet (#673): the start waits on the person's card. `sessionId` is the request's handle, which
 *             agent_session follows (status, wait) or withdraws (stop) until the person answers
 */
export type ChildRunResult =
  | ({
      ok: true
      sessionId: string
      sessionName: string
      tool: string
      notice?: string
      /** Which busy choice ran (#677): a note into the running turn, or a fork of the session (`sessionId` is the fork) */
      via?: 'note' | 'fork'
      /** For a fork: the session it was copied from */
      forkedFrom?: string
    } & (
      /**
       * `cleanUp` (#690): the caller's own child, its work over, so the answer names its delete. Not for a session it
       * only observes or reads under `auto`, a turn cut short, or a report still owed over its background work
       */
      | { state: 'done'; answer: string; readable: string[]; outside: string[]; cleanUp?: boolean }
      | { state: 'working'; reported: boolean; progress?: TurnProgress }
      | { state: 'at_rest'; answer: string; sessionState: string; interruption?: Interruption; cleanUp?: boolean }
      | { state: 'asking'; cards: RoutedCard[] }
      | { state: 'answered'; card: string }
      | { state: 'busy'; sessionState: string; choices: BusyChoice[] }
      | { state: 'queued'; queueId: string; position: number; lowMemory?: string }
      | { state: 'stopped' }
      /**
       * No session yet (#673): the person has not answered the card; or, with `lowMemory`, the start is allowed and
       * queued until memory recovers (#686)
       */
      | { state: 'pending'; lowMemory?: { available: string; floor: string; maxWaitMinutes: number } }
      | { state: 'deleted'; branch?: undefined; setAside?: undefined; warning?: undefined; note?: undefined }
      | { state: 'deleted'; branch: string; warning?: string; note?: string; setAside: { changedFiles: number; commits: number } }
    ))
  | { ok: false; error: string }

/**
 * start_agent's arguments (#561): the task; the tool, model and effort when the caller picks them; a new worktree (part 2);
 * and code intelligence (#686), off for a child unless `lsp` is true
 */
export type StartAgentOpts = {
  task: string
  tool?: string
  model?: string
  effort?: string
  /** #729: without `model`, the person's model for this tool and difficulty (prefs.agentModels) */
  difficulty?: AgentDifficulty
  wait?: boolean
  worktree?: boolean
  branch?: string
  lsp?: boolean
  /** A short name for the new session (#861), shown in the sidebar; a new worktree's branch is made from it */
  name?: string
  /** A linked machine to start it on (#1038), by its id or name: in that machine's checkout of the caller's repository */
  machine?: string
}

/**
 * One session the caller started, as agent_session list shows it (#690): a parent that forgot to clean up after using
 * its children's answers sweeps them in one call. `finished` is a child at rest with nothing standing on it, the one a
 * parent deletes; `asleep` says its process stopped (#568), which costs no memory but still leaves its row and
 * worktree. `unmerged` is a worktree branch git and the PR do not show as landed: a delete keeps that work in the trash.
 */
export type AgentListRow = {
  sessionId: string
  name: string
  tool: string
  state: 'working' | 'waiting' | 'finished' | 'stopped'
  asleep: boolean
  lastActive?: string
  worktree?: { branch: string; unmerged: boolean }
  /** The linked machine it runs on (#1038), by name; absent: this computer */
  machine?: string
}

/** agent_session's arguments (#561) */
export type AgentSessionOpts = {
  sessionId: string
  action: 'status' | 'send' | 'wait' | 'stop' | 'delete' | 'answer'
  text?: string
  /** send to a busy session (#677): what to do instead of returning the choices */
  ifBusy?: IfBusy
  /** answer (#676): which card, when more than one stands */
  card?: string
}

/**
 * What handoff_session answers (#694): refused, done (the successor is `sessionId`, named as the original `from`), or
 * still running past the call's bound (agent mode's note, most often): calling again with `waitFor: handle` waits on
 * that run and no other.
 */
export type HandoffResult =
  | { ok: false; error: string }
  | { ok: true; state: 'done'; sessionId: string; sessionName: string; tool: ToolName; mode: 'record' | 'agent'; from: string; path: string }
  | { ok: true; state: 'writing'; sessionId: string; sessionName: string; handle: string }

/**
 * The tools given only to the orchestrator (FR-11).
 *
 * **This is the boundary of the access scope.** Whatever this interface can give is the entire
 * extent of what the orchestrator can do — there is no way at all to reach outside the sessions
 * this app manages. No files, no projects, no other tools live here.
 *
 * Kept tool-neutral. Claude exposes it through an in-process MCP server; other tools can expose
 * it their own way — SDK types must not step even one foot outside adapters/<tool>/.
 */
export type OrchestratorTools = {
  /**
   * Checks or starts installing Centralu itself; ordinary sessions need the person's consent first. "apply" (#665) asks
   * a window to relaunch into the installed build, by the caller's own preset: auto applies, normal asks, safe is
   * refused. `relaunched` says a relaunch started, with the version it starts when known.
   */
  updateCentralu?(
    action: 'check' | 'install' | 'apply',
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string; status?: UpdateStatus; relaunched?: { version?: string } }>
  /** Sessions this app currently manages (excludes the orchestrator itself and archived sessions); `project` narrows by name or id */
  listSessions(opts?: { project?: string }): Promise<OrchestratedSession[]>
  /**
   * Sends work to a session. Returns a reason if the target does not exist — does not fail silently.
   *
   * With `reportBack`, the orchestrator is notified once when that session's turn ends. Off by
   * default, because waking it up on every turn end would create a loop where they wake each
   * other, and would also double the turn cost.
   *
   * A note (a send into a turn already running, #1233) never drops a report someone is owed, its own included:
   * without `reportBack` it leaves the marks as they are; with it, it adds this orchestrator's, unless another
   * session is owed that turn's end (`reportTaken`). A new instruction to a session at rest without `reportBack`
   * still replaces this orchestrator's earlier request (#166).
   */
  sendToSession(
    sessionId: string,
    text: string,
    reportBack?: boolean,
    /** What to do when the session is busy with a turn that is not this seat's (#677); absent: the choices come back */
    ifBusy?: IfBusy,
  ): Promise<{ ok: boolean; error?: string; busy?: BusyAnswer }>
  /**
   * Reads a session's recent conversation.
   *
   * Without this, the orchestrator had **no way at all to check** when a report seemed thin — the
   * one-line summary from list_sessions and the report itself came from the same source, so there
   * was no way around it either. This tool has been in the spec (FR-11) from the start.
   */
  readSession(
    sessionId: string,
    limit?: number,
    opts?: {
      /** A seq given by recall. Reads around that point — a direct path to the found passage */
      around?: number
      /** Whether to expand tool-call bodies too. Collapsed by default (a full script's text would bury the conversation) */
      tools?: boolean
      /**
       * With `around`, the one line that starts there, read from this character on (#1186): a line past
       * `LINE_MAX_CHARS` is cut, and its cut names this offset to read on from
       */
      offset?: number
    },
  ): Promise<{
    ok: boolean
    error?: string
    lines?: string[]
    state?: string
    /** Cards in its delegated turn waiting on this seat (#676) */
    cards?: RoutedCard[]
    /** Its project is not trusted, told to a trusted reader that reached it (#984): its text may be planted */
    untrusted?: boolean
  }>
  /**
   * Searches past conversations — **memory that crosses project boundaries**.
   *
   * Why we do not store memory separately: it creates a new problem of who decides what to
   * remember, and a distilled summary stays frozen even after the original changes. We never
   * delete a single conversation, so **being findable is already being remembered.**
   */
  /**
   * Archives or restores a session.
   *
   * Without this, the only way to unstick a jammed window was to restart the app or to archive
   * and then restore, and the orchestrator could do neither, so it always had to hand off to a
   * person (dogfooding). We give it this because it is reversible.
   */
  /**
   * Creates a worker session (#13).
   *
   * Why creation is given but deletion is not: a session that gets created is visible to the
   * person in the list and can be reversed (both archiving and deletion stay in the person's
   * hands), but deletion also erases the conversation record and cannot be undone.
   */
  createSession(opts: {
    /** The project's name or id — the orchestrator belongs to no project, so this must always be pointed to */
    project?: string
    tool?: ToolName
    /** The session name. If given, the automatic name does not override it */
    name?: string
    /**
     * The first instruction to send right after creation. Its turn is the orchestrator's (#1233), as a send to a
     * session at rest is: its cards come to the orchestrator, and its later words go in as notes with no busy answer
     */
    firstMessage?: string
    /**
     * Whether the orchestrator is told once when that first turn ends (#1233). On unless false: work it hands out is
     * work it hears the end of, as start_agent's is. Means nothing without `firstMessage`
     */
    reportBack?: boolean
  }): Promise<{ ok: boolean; error?: string; sessionId?: string; name?: string }>
  /**
   * Changes a session's performance settings (#30).
   *
   * **The permission preset not existing on this type is itself the decision.** If the
   * orchestrator could switch a preset to auto, the rule "cannot approve on someone else's
   * behalf" would collapse through a back door — this blocks it by making it inexpressible,
   * rather than by checking the field and rejecting it.
   * A change is announced to the screen as an event — no silent, untraceable settings change.
   */
  updateSessionSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null },
  ): Promise<{ ok: boolean; error?: string; /** takes effect once the running turn ends (#164) */ deferred?: boolean }>
  /**
   * Asks another project to do a task (#371 part B, ask_project) — an ordinary session's only reach outside its own
   * project, and only with the person's consent for the pair. Selects an existing ordinary session in the target
   * project with that project's folder, instructions, tool and permissions, sends the task, and waits for the turn,
   * up to a bound (`ASK_WAIT_MS`): past it, the answer is "still working" and a call with no task waits again.
   * `signal` is the caller's tool call: aborted, the delegated turn is stopped too.
   */
  askProject(opts: { project: string; session?: string; task?: string; ifBusy?: Exclude<IfBusy, 'fork' | 'fork_read'> }, signal?: AbortSignal): Promise<AskProjectResult>
  /**
   * Starts another agent in the caller's own project (#561, start_agent): a visible session marked `askedBy` the
   * caller, under the caller's permission preset, behind the person's consent. Waits like askProject unless
   * `wait` is false; `signal` is the caller's tool call, and aborted it stops the turn being waited on.
   */
  startAgent(opts: StartAgentOpts, signal?: AbortSignal): Promise<ChildRunResult>
  /** Works with a session the caller started (#561, agent_session): status, send more, wait, stop */
  agentSession(opts: AgentSessionOpts, signal?: AbortSignal): Promise<ChildRunResult>
  /** The sessions the caller started with start_agent that are still here (#690, agent_session list) */
  listAgents(): Promise<{ ok: true; agents: AgentListRow[] } | { ok: false; error: string }>
  /**
   * Answers a card standing in a session whose turn this seat gave it (#676, answer_question): the directing seats'
   * way, as agent_session's `answer` is an ordinary session's. Same rules (`RoutedCards.answerRoutedCard`,
   * sessions/routed-cards.ts).
   */
  answerQuestion(opts: { sessionId: string; card?: string; text: string }): Promise<ChildRunResult>
  recall(
    query: string,
    limit?: number,
  ): Promise<{
    hits: RecallHit[]
    /** Linked machines that could not be searched just now, each with why (#82: one that is off says so instead of finding nothing) */
    notSearched?: string[]
  }>
  /**
   * **Proposes to the person** that an MCP server be installed (a dogfooding request — wanting to
   * equip itself with a capability like Playwright). Follows the propose-not-power rule exactly:
   * this call installs nothing on its own. If the person approves, the app registers it and
   * restarts the orchestrator — since this is registering arbitrary command execution, installing
   * it without approval would simply be a back door.
   */
  proposeMcpServer(spec: {
    name: string
    command: string
    args: string[]
    why?: string
  }): Promise<{ ok: boolean; error?: string }>
  /**
   * **Proposes to the person** a reusable procedure (a skill) (#71). A skill lives in the app's
   * database, not as a file — a worker session can write files but not the database, so this
   * closes off any path for a lower-privilege session to reach the orchestrator's own
   * instructions. It has no effect at all before approval: a skill is **permanent leverage** over
   * an agent that can instruct every session, so if self-authorship survived without approval,
   * injected text would effectively become permanent authority.
   */
  proposeSkill(spec: { name: string; content: string; why?: string }): Promise<{ ok: boolean; error?: string }>
  /**
   * Makes a new project — an empty folder, or a clone of `source`, by default in this computer's `~/Centralu` — **only once
   * the person approves the card it raises** (#515). The card stands in the calling session's approval slot with the full path on it, and
   * the call waits for the answer, so the model learns whether the project exists and where. `signal` is the tool
   * call's: aborted, the card is withdrawn and nothing is made.
   */
  createProject(
    /** `machine`: a linked machine by name or id (#82 phase 4); this computer when absent */
    spec: { name: string; parent?: string; source?: { git: string; branch?: string }; machine?: string },
    signal?: AbortSignal,
  ): Promise<{ ok: true; projectId: string; name: string; path: string; machine?: string } | { ok: false; error: string }>
  /**
   * Adds a folder that already exists as a project, on this computer or a linked machine (#1220, the add_project
   * command), **only once the person allows the card it raises**, which shows the folder's facts as its machine read
   * them. A path that is missing, a file or already a project is refused before any card. Absent on seats that cannot.
   */
  addProject?(
    /** `machine`: a linked machine by name or id; this computer when absent */
    spec: { path: string; machine?: string },
    signal?: AbortSignal,
  ): Promise<{ ok: true; projectId: string; name: string; path: string; machine?: string } | { ok: false; error: string }>
  /** The linked machines as `machines.list` answers (#1220, the list_machines command); absent on seats that cannot */
  listMachines?(): MachineInfo[]
  /**
   * A change to the linked machines (#1219, the machine commands): add, install or update Centralu, remove, reconnect,
   * Auto reconnect, start at boot. Those that change a machine or this computer's reach wait for the person's card.
   * The answer is the text the model reads. Absent on seats that cannot.
   */
  machine?(req: MachineRequest, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /**
   * The preferences (#1219, preferences and the trash): read them all, and change the reversible ones the window offers (theme, text
   * size, fonts, line height, idle sleep, the update switches) through the window's own calls. Turning on "apply updates
   * when idle" waits for the person's card. Absent on seats that cannot.
   */
  preferences?(req: PreferencesRequest, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /**
   * The trash (#1219): list it, restore a session or its subagent steps, move a session's subagent steps to it; deleting
   * for good, one item or all of it, waits for the person's card naming what goes. Absent on seats that cannot.
   */
  trash?(req: TrashRequest, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /**
   * Hands a session off to a fresh one (#694), the orchestrator's alone: the note from the record by default or written
   * by the session (`mode: 'agent'`), the original's live children moved to the successor (#693), the original kept.
   * The rules of who may hand off what are `HandoffFlow`'s (handoff-flow.ts). Absent on seats that cannot hand off.
   */
  handoffSession?(
    spec: { sessionId?: string; tool?: ToolName; mode?: 'record' | 'agent'; instructions?: string; waitFor?: string },
    signal?: AbortSignal,
  ): Promise<HandoffResult>
  /**
   * Checks its own app (M4 C-3) — for a session that creates an app only. Which app is decided by
   * the calling session itself (the app it is creating): it takes no name, so there is no way to
   * probe someone else's app. `text` is the report meant for the agent to read.
   */
  checkApp(): Promise<{ ok: boolean; text: string }>
  /**
   * Creates a new app from a template (M4 C-1b) — orchestrator only. The same path as the "New
   * app" button (`apps.create`).
   *
   * Why this is a power rather than a propose: what gets created is **a copy of a template** — it
   * loads no code that is already in the repository, and no command the person did not choose. An
   * app is only ever created in a trusted project, and it never overwrites an id that already
   * exists. Without a project it makes a new folder and registers it as a project whose root is the
   * app (#1141); that folder is the one thing it makes outside a project, so the person allows it on
   * create_project's card first. Deletion is still a human's job.
   */
  createApp(spec: {
    /** The project's name or id. A new app project if omitted (#1141) */
    project?: string
    /** Without a project: the full path of the folder the new app project's folder goes in; `~/Centralu` if omitted */
    parent?: string
    id: string
    name: string
    description?: string
    /** The tool for the session that creates it (C-2). The project's default tool if omitted */
    tool?: ToolName
  }, signal?: AbortSignal): Promise<{
    ok: boolean
    error?: string
    appId?: string
    projectId?: string | null
    dir?: string
    /** The session created alongside it to build the app (C-2) — absent if it failed to start, with `builderError` as the reason */
    builder?: { sessionId: string; name: string }
    builderError?: string
  }>
  /**
   * Another project's app tools, on demand (#371 part A, sessions/app-access.ts) — for a project's
   * ordinary session. `findApps` lists what it could attach (apps other projects share, and the
   * person's own user-folder apps), `attachApp` attaches one (asking the person once per pair of
   * projects for another project's app), `detachApp` takes it away again. `when` says when the agent
   * has the change: `now` (Claude) or `next_turn` (a Codex thread restarts once the turn ends).
   * Every other seat answers with a refusal.
   */
  findApps(query?: string): Promise<
    | { ok: true; apps: { ref: string; name: string; project: string | null; description: string; tools: string[] | null }[] }
    | { ok: false; error: string }
  >
  attachApp(app: string): Promise<
    { ok: true; server: string; tools: string[]; when: 'now' | 'next_turn'; already?: boolean } | { ok: false; error: string }
  >
  detachApp(app: string): Promise<{ ok: true; server: string; when: 'now' | 'next_turn' } | { ok: false; error: string }>
}

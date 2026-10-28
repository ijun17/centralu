import { z } from 'zod'
import { GitSource, ProjectId, SessionId } from '../../entities.js'
import { ATTACHMENT_MAX_BASE64, FsResolvePurpose } from '../files.js'
import { machineParam } from '../machine-fields.js'
import { AGENT_INSTRUCTIONS_MAX, SavedCommand } from '../projects.js'

/** The parameters of the `projects` methods, which the host validates (docs/protocol.md §3). Their results: ./projects.results.ts */
export const projectsParams = {
  'git.status': z.object({ projectId: ProjectId }),
  'git.diff': z.object({ projectId: ProjectId, path: z.string(), staged: z.boolean().optional() }),
  'git.log': z.object({ projectId: ProjectId, limit: z.number().optional() }),
  'git.commitDetail': z.object({ projectId: ProjectId, sha: z.string() }),
  'git.branches': z.object({ projectId: ProjectId }),
  /**
   * The things git ignores (#76) — the list of things that will **not** exist in a new worktree.
   *
   * Offered as candidates for "what to copy" by the worktree setup window. bytes only assists
   * and can be null (measuring it is abandoned if it takes too long) — the list itself is the
   * answer, and the size is only material for the decision.
   */
  'git.ignoredEntries': z.object({ projectId: ProjectId }),
  'git.checkout': z.object({ projectId: ProjectId, branch: z.string(), dryRun: z.boolean().optional() }),
  'git.stage': z.object({
    projectId: ProjectId,
    paths: z.array(z.string()),
    unstage: z.boolean().optional(),
  }),
  /** `cancelled`: the person ended it with `git.cancel` (#1007); the screen says so rather than that it failed */
  'git.commit': z.object({ projectId: ProjectId, message: z.string() }),
  'git.push': z.object({ projectId: ProjectId }),
  /**
   * Ends the git write still running for this project (a switch, stage, commit or push from the git panel, #1007): a
   * hook or a credential helper waiting on a sign-in otherwise holds the panel for up to ten minutes. git is ended as
   * a timeout ends it, so it takes its `index.lock` away. `cancelled` is whether there was one to end.
   */
  'git.cancel': z.object({ projectId: ProjectId }),
  /** The host saves a pasted image as a file (so base64 never goes into the database) */
  'attachments.save': z.object({
    sessionId: SessionId,
    name: z.string(),
    mime: z.string(),
    dataBase64: z.string().max(ATTACHMENT_MAX_BASE64, 'This attachment is too large'),
  }),
  'fs.listDir': z.object({ projectId: ProjectId, path: z.string() }),
  /**
   * The full set of directories to watch in this project (#34). **Received as the complete
   * whole every time** — same syntax as projects.reorder, for the same reason: the set of
   * expanded rows on screen is exactly the watch set, so exchanging it as "add this, drop that"
   * would let the two sides drift apart with no error at all.
   * Changes arrive as `fs_changed` events. If watched is smaller than the count sent, it was
   * truncated by the cap.
   */
  'fs.watch': z.object({ projectId: ProjectId, paths: z.array(z.string()) }),
  /**
   * `sessionId` (#1209): the path is that session's, so it is read from the session's folder (its worktree, or the
   * project when it has none) and refused outside it. The session must be one of this project's. Absent, the project.
   */
  'fs.readFile': z.object({ projectId: ProjectId, path: z.string(), sessionId: SessionId.optional() }),
  /**
   * Move a file or folder into another folder of the same project (#19).
   *
   * The destination is a **folder**, not a full path: the gesture is a drop onto a row, and
   * the new name is always the old one. `moved: false` means it landed where it already was.
   */
  'fs.move': z.object({ projectId: ProjectId, from: z.string(), toDir: z.string() }),
  /**
   * Put a file dragged in from the desktop into the project (#19).
   *
   * Bytes, not a source path — the webview never tells the page where a dropped file lives,
   * which is the same reason attachments travel this way.
   */
  'fs.importFile': z.object({
    projectId: ProjectId,
    toDir: z.string(),
    name: z.string(),
    dataBase64: z.string(),
  }),
  /**
   * The absolute path of a project file, for the desktop shell's own OS calls
   * (revealing it in the file manager, moving it to the trash).
   *
   * The host is the only side that knows the project root, so it is the only side allowed
   * to build one — and it refuses paths that leave the project, or that are not there.
   */
  'fs.resolve': z.object({
    projectId: ProjectId,
    path: z.string(),
    /**
     * What the path is for (#838). `trash`: the entry itself, a link included, never what it points at. `project`:
     * the project folder itself, for "Delete project and trash folder" only (the path is ignored). Otherwise (reveal,
     * open in an IDE, or absent from an older window) what it is, a link followed inside the project. The project
     * folder only for `project`, and for an older window's literal root (`.`), which only its delete dialog sends.
     */
    purpose: FsResolvePurpose.optional(),
    /**
     * The session whose folder the path is in, as `fs.readFile`'s (#1209): revealing or opening a worktree session's
     * file. Only for reveal and open; refused with `trash` and `project`, which act on the project's own files.
     */
    sessionId: SessionId.optional(),
  }),
  'projects.add': z.object({ path: z.string(), ...machineParam }),
  /**
   * What a folder is, read on the machine it is on and nothing changed (#1220): the orchestrator's add_project shows
   * it on the person's card before `projects.add` registers the folder. `path` comes back absolute, in that machine's
   * own terms (a leading `~` is that machine's home); a path that is not absolute is refused. `git`: the folder is in
   * a git repository, and `origin` is that repository's `origin` remote as its config has it (no program of the
   * repository runs). `project`: the project already registered for that folder, in whatever spelling it was kept.
   */
  'projects.inspect': z.object({ path: z.string().max(4096), ...machineParam }),
  /**
   * Makes a new project (#515): an **empty** folder named `name` (no git init, no template) inside `parent`, or
   * `~/Centralu` (`PROJECTS_DIR`) of the machine the project lives on when `parent` is absent, then registers it as `projects.add` does.
   * The machine's own host makes it. Refused with one sentence when the name is not one folder name, when `parent` is
   * not a full path to a folder, or when anything of that name is already there: nothing existing is reused.
   *
   * With `source` the folder is a **clone** of that repository instead of empty, made by that machine's own git with
   * its own saved sign-ins, never asking for one (a repository that needs a password it does not have is refused with
   * one sentence). An empty `name` is then the repository's own (`repoNameOf`). A failed clone leaves nothing: the
   * folder it made is removed and no project is registered. Submodules are not cloned.
   */
  'projects.create': z.object({
    name: z.string().max(255),
    parent: z.string().max(4096).optional(),
    source: GitSource.optional(),
    ...machineParam,
  }),
  /**
   * Where `projects.create` would make the folder, without making anything (#515): the dialog shows it as the person
   * types. `parent` is the resolved location (that machine's `~/Centralu` when none is given). With an empty name, `path` and `error`
   * are null; otherwise exactly one of them is set, `error` being the sentence `projects.create` would refuse with.
   */
  'projects.createPreview': z.object({
    name: z.string().max(255),
    parent: z.string().max(4096).optional(),
    source: GitSource.optional(),
    ...machineParam,
  }),
  /**
   * **Deletes** a project — not just removing it from the list, but erasing it from this app's
   * records entirely (its sessions, conversations, search index, approval rules, even usage
   * attribution).
   *
   * **It never touches the folder.** Discarding files only ever happens through the OS trash,
   * which is the shell's (Rust's) job, and the caller finishes that before this command runs.
   * This is also why there is no `deleteFiles` switch here — the host has no hand that can
   * discard files, so accepting one would just be a promise it cannot keep.
   */
  'projects.delete': z.object({ projectId: ProjectId }),
  /**
   * What deleting this project may do to its folder (#1301), read when the Delete project dialog opens: nothing changed. A folder of
   * the user folder registered in place as a project (#1141) is moved to `app-trash/` once nothing can restore it (#1204), which
   * the dialog says. The answer is exact where the list's mark (`ProjectInfo.fromUserFolder`) is not: it compares real paths, as that
   * give-back does, so a project added again through a junction, a symbolic link or a `subst` drive counts, and a path it cannot
   * resolve (a UNC path, a drive that is not there) counts as "may move" (`unsure`, which the dialog words as not sure).
   *   stays            deleting it leaves its folder alone
   *   may_move         the project is the app's folder itself: the host may move that folder
   *   around_may_move  the project lies inside an app folder, whose own project is gone: the host may move the folder around it
   *   unsure           an app folder's own project is gone and this project's path cannot be told from it (a UNC path, a drive that
   *                    is not there, no answer in time): the give-back counts that as at the folder, so it may be
   * "May" because the move also waits for the trash and for any other project at the folder. A host without this method answers
   * "Unknown method", and the dialog goes by the mark.
   */
  'projects.deleteOutlook': z.object({ projectId: ProjectId }),
  /**
   * Whether this project's code is allowed to run on this machine (M4 A-2, plan decision 3).
   *
   * The default is "no" — simply opening a repository someone handed over must not let the app
   * server inside it run with the user's own permissions. Turning it off brings that project's
   * apps down immediately.
   */
  'projects.setTrusted': z.object({ projectId: ProjectId, trusted: z.boolean() }),
  /**
   * Reorders the sidebar. **Receives the entire order as a whole** — exchanging it as
   * "move this one there" would drift out of sync if the list changed in the meantime.
   */
  'projects.reorder': z.object({ orderedIds: z.array(z.string()) }),
  /**
   * Replace this project's saved shell commands (issue #44).
   *
   * The **whole list**, like `projects.reorder` above and for the same reason: it is a
   * short list a person edits by hand, so "make it look like this" states every edit —
   * adding, deleting and (one day) reordering all arrive through one door instead of three.
   *
   * Nothing on the way through inspects the commands. These are the user's own, the same
   * as typing into the terminal below; the approval system is for what an *agent* wants to
   * run, and asking permission for what the person just typed would teach them to wave the
   * prompt through where it matters.
   *
   * Answers with the stored list rather than the project so that saving a command does not
   * cost a `git status` — the caller already has everything else about the project.
   */
  'projects.setCommands': z.object({ projectId: ProjectId, commands: z.array(SavedCommand) }),
  /**
   * Creates the worktree manager slot (#76) — even when it will have no children yet.
   *
   * baseBranch is this project's **trunk**: both where a worktree branches off from and the
   * baseline for measuring whether it has merged. The host never invents a default for it —
   * which branch is the trunk differs by repository, and a wrong default only shows up once a
   * worktree has already branched off from the wrong place. If the slot already exists, it is
   * returned as-is and only the trunk is rewritten (this is how the trunk gets changed).
   */
  'worktrees.createManager': z.object({ projectId: ProjectId, baseBranch: z.string() }),
  /**
   * Sets the project's worktree trunk (#76): where a new worktree forks from by default and what "merged" is measured
   * against. Since the worktree manager was folded into ordinary sessions (#561 part 3), `worktrees.createManager` is
   * refused and this is how the trunk is chosen; `ProjectInfo.worktreeManager.baseBranch` still carries it.
   */
  'worktrees.setTrunk': z.object({ projectId: ProjectId, baseBranch: z.string() }),
  /** Saves worktree provisioning settings (#69) — edited by the worktree section of the new-session window */
  'projects.setWorktreeSetup': z.object({
    projectId: ProjectId,
    setup: z.object({ command: z.string(), copyFiles: z.array(z.string()) }).nullable(),
  }),
  /**
   * Saves the instructions for agents started in this project (#1161 item 2, `ProjectInfo.agentInstructions`). The
   * whole text, as the project's settings show it; an empty text clears it. Bounded, as it travels in every task.
   */
  'projects.setAgentInstructions': z.object({
    projectId: ProjectId,
    text: z.string().max(AGENT_INSTRUCTIONS_MAX),
  }),
  'projects.list': z.object({}),
  'projects.gitStatus': z.object({ projectId: ProjectId }),
  /**
   * The project's `origin` remote, as git has it (#1038): how a hub tells which project of a linked machine is a checkout
   * of the same repository as one of its own (`gitRemoteKey`). Null when the folder is not a git repository or has no
   * `origin`.
   */
  'projects.origin': z.object({ projectId: ProjectId }),
  'files.search': z.object({ projectId: ProjectId, query: z.string(), limit: z.number().default(20) }),
} as const

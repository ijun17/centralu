import { z } from 'zod'
import {
  Attachment,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  GitSource,
  ProjectId,
  SessionId,
} from '../../entities.js'
import { ATTACHMENT_MAX_BASE64, FsEntry, FsFile, FsResolvePurpose } from '../files.js'
import { machineParam } from '../machine-fields.js'
import { ProjectInfo, SavedCommand } from '../projects.js'
import { SessionInfo } from '../sessions.js'

export const projectMethods = {
  'git.status': { params: z.object({ projectId: ProjectId }), result: z.array(GitFileStatus) },
  'git.diff': {
    params: z.object({ projectId: ProjectId, path: z.string(), staged: z.boolean().optional() }),
    result: GitDiff,
  },
  'git.log': { params: z.object({ projectId: ProjectId, limit: z.number().optional() }), result: z.array(GitCommit) },
  'git.commitDetail': {
    params: z.object({ projectId: ProjectId, sha: z.string() }),
    result: z.object({ files: z.array(z.string()), diff: z.string(), truncated: z.boolean() }),
  },
  'git.branches': { params: z.object({ projectId: ProjectId }), result: z.array(GitBranch) },
  /**
   * The things git ignores (#76) — the list of things that will **not** exist in a new worktree.
   *
   * Offered as candidates for "what to copy" by the worktree setup window. bytes only assists
   * and can be null (measuring it is abandoned if it takes too long) — the list itself is the
   * answer, and the size is only material for the decision.
   */
  'git.ignoredEntries': {
    params: z.object({ projectId: ProjectId }),
    result: z.array(z.object({ path: z.string(), bytes: z.number().nullable() })),
  },
  'git.checkout': {
    params: z.object({ projectId: ProjectId, branch: z.string(), dryRun: z.boolean().optional() }),
    result: z.object({ ok: z.boolean(), conflicts: z.array(z.string()), message: z.string().optional(), cancelled: z.literal(true).optional() }),
  },
  'git.stage': {
    params: z.object({ projectId: ProjectId, paths: z.array(z.string()), unstage: z.boolean().optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** `cancelled`: the person ended it with `git.cancel` (#1007); the screen says so rather than that it failed */
  'git.commit': {
    params: z.object({ projectId: ProjectId, message: z.string() }),
    result: z.object({ ok: z.boolean(), message: z.string().optional(), cancelled: z.literal(true).optional() }),
  },
  'git.push': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ ok: z.boolean(), message: z.string().optional(), cancelled: z.literal(true).optional() }),
  },
  /**
   * Ends the git write still running for this project (a switch, stage, commit or push from the git panel, #1007): a
   * hook or a credential helper waiting on a sign-in otherwise holds the panel for up to ten minutes. git is ended as
   * a timeout ends it, so it takes its `index.lock` away. `cancelled` is whether there was one to end.
   */
  'git.cancel': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ cancelled: z.boolean() }),
  },
  /** The host saves a pasted image as a file (so base64 never goes into the database) */
  'attachments.save': {
    params: z.object({
      sessionId: SessionId,
      name: z.string(),
      mime: z.string(),
      dataBase64: z.string().max(ATTACHMENT_MAX_BASE64, 'This attachment is too large'),
    }),
    result: Attachment,
  },
  'fs.listDir': {
    params: z.object({ projectId: ProjectId, path: z.string() }),
    result: z.array(FsEntry),
  },
  /**
   * The full set of directories to watch in this project (#34). **Received as the complete
   * whole every time** — same syntax as projects.reorder, for the same reason: the set of
   * expanded rows on screen is exactly the watch set, so exchanging it as "add this, drop that"
   * would let the two sides drift apart with no error at all.
   * Changes arrive as `fs_changed` events. If watched is smaller than the count sent, it was
   * truncated by the cap.
   */
  'fs.watch': {
    params: z.object({ projectId: ProjectId, paths: z.array(z.string()) }),
    result: z.object({ watched: z.number() }),
  },
  'fs.readFile': {
    params: z.object({ projectId: ProjectId, path: z.string() }),
    result: FsFile,
  },
  /**
   * Move a file or folder into another folder of the same project (#19).
   *
   * The destination is a **folder**, not a full path: the gesture is a drop onto a row, and
   * the new name is always the old one. `moved: false` means it landed where it already was.
   */
  'fs.move': {
    params: z.object({ projectId: ProjectId, from: z.string(), toDir: z.string() }),
    result: z.object({ path: z.string(), moved: z.boolean() }),
  },
  /**
   * Put a file dragged in from the desktop into the project (#19).
   *
   * Bytes, not a source path — the webview never tells the page where a dropped file lives,
   * which is the same reason attachments travel this way.
   */
  'fs.importFile': {
    params: z.object({ projectId: ProjectId, toDir: z.string(), name: z.string(), dataBase64: z.string() }),
    result: z.object({ path: z.string() }),
  },
  /**
   * The absolute path of a project file, for the desktop shell's own OS calls
   * (revealing it in the file manager, moving it to the trash).
   *
   * The host is the only side that knows the project root, so it is the only side allowed
   * to build one — and it refuses paths that leave the project, or that are not there.
   */
  'fs.resolve': {
    params: z.object({
      projectId: ProjectId,
      path: z.string(),
      /**
       * What the path is for (#838). `trash`: the entry itself, a link included, never what it points at. `project`:
       * the project folder itself, for "Delete project and trash folder" only (the path is ignored). Otherwise (reveal,
       * open in an IDE, or absent from an older window) what it is, a link followed inside the project. The project
       * folder only for `project`, and for an older window's literal root (`.`), which only its delete dialog sends.
       */
      purpose: FsResolvePurpose.optional(),
    }),
    result: z.object({ path: z.string() }),
  },
  'projects.add': { params: z.object({ path: z.string(), ...machineParam }), result: ProjectInfo },
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
  'projects.create': {
    params: z.object({ name: z.string().max(255), parent: z.string().max(4096).optional(), source: GitSource.optional(), ...machineParam }),
    result: ProjectInfo,
  },
  /**
   * Where `projects.create` would make the folder, without making anything (#515): the dialog shows it as the person
   * types. `parent` is the resolved location (that machine's `~/Centralu` when none is given). With an empty name, `path` and `error`
   * are null; otherwise exactly one of them is set, `error` being the sentence `projects.create` would refuse with.
   */
  'projects.createPreview': {
    params: z.object({ name: z.string().max(255), parent: z.string().max(4096).optional(), source: GitSource.optional(), ...machineParam }),
    result: z.object({ parent: z.string(), path: z.string().nullable(), error: z.string().nullable() }),
  },
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
  'projects.delete': {
    params: z.object({ projectId: ProjectId }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Whether this project's code is allowed to run on this machine (M4 A-2, plan decision 3).
   *
   * The default is "no" — simply opening a repository someone handed over must not let the app
   * server inside it run with the user's own permissions. Turning it off brings that project's
   * apps down immediately.
   */
  'projects.setTrusted': {
    params: z.object({ projectId: ProjectId, trusted: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Reorders the sidebar. **Receives the entire order as a whole** — exchanging it as
   * "move this one there" would drift out of sync if the list changed in the meantime.
   */
  'projects.reorder': {
    params: z.object({ orderedIds: z.array(z.string()) }),
    result: z.array(ProjectInfo),
  },
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
  'projects.setCommands': {
    params: z.object({ projectId: ProjectId, commands: z.array(SavedCommand) }),
    result: z.array(SavedCommand),
  },
  /**
   * Creates the worktree manager slot (#76) — even when it will have no children yet.
   *
   * baseBranch is this project's **trunk**: both where a worktree branches off from and the
   * baseline for measuring whether it has merged. The host never invents a default for it —
   * which branch is the trunk differs by repository, and a wrong default only shows up once a
   * worktree has already branched off from the wrong place. If the slot already exists, it is
   * returned as-is and only the trunk is rewritten (this is how the trunk gets changed).
   */
  'worktrees.createManager': {
    params: z.object({ projectId: ProjectId, baseBranch: z.string() }),
    result: SessionInfo,
  },
  /**
   * Sets the project's worktree trunk (#76): where a new worktree forks from by default and what "merged" is measured
   * against. Since the worktree manager was folded into ordinary sessions (#561 part 3), `worktrees.createManager` is
   * refused and this is how the trunk is chosen; `ProjectInfo.worktreeManager.baseBranch` still carries it.
   */
  'worktrees.setTrunk': {
    params: z.object({ projectId: ProjectId, baseBranch: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Saves worktree provisioning settings (#69) — edited by the worktree section of the new-session window */
  'projects.setWorktreeSetup': {
    params: z.object({
      projectId: ProjectId,
      setup: z.object({ command: z.string(), copyFiles: z.array(z.string()) }).nullable(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'projects.list': { params: z.object({}), result: z.array(ProjectInfo) },
  'projects.gitStatus': { params: z.object({ projectId: ProjectId }), result: ProjectInfo },
  /**
   * The project's `origin` remote, as git has it (#1038): how a hub tells which project of a linked machine is a checkout
   * of the same repository as one of its own (`gitRemoteKey`). Null when the folder is not a git repository or has no
   * `origin`.
   */
  'projects.origin': { params: z.object({ projectId: ProjectId }), result: z.object({ origin: z.string().nullable() }) },
  'files.search': {
    params: z.object({ projectId: ProjectId, query: z.string(), limit: z.number().default(20) }),
    result: z.array(z.object({ path: z.string(), name: z.string() })),
  },
} as const

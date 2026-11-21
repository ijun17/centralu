import { z } from 'zod'
import { GitSource, ProjectId, SessionId } from '../../entities.js'
import { ATTACHMENT_MAX_BASE64, FsResolvePurpose } from '../files.js'
import { machineParam } from '../machine-fields.js'
import { AGENT_INSTRUCTIONS_MAX, SavedCommand } from '../projects.js'

/** Params of the `projects` methods, parsed by the host (docs/protocol.md §3). Results: ./projects.results.ts */
export const projectsParams = {
  'git.status': z.object({ projectId: ProjectId }),
  'git.diff': z.object({ projectId: ProjectId, path: z.string(), staged: z.boolean().optional() }),
  'git.log': z.object({ projectId: ProjectId, limit: z.number().optional() }),
  'git.commitDetail': z.object({ projectId: ProjectId, sha: z.string() }),
  'git.branches': z.object({ projectId: ProjectId }),
  /**
   * What will not exist in a new worktree, offered as what to copy. `bytes` may be null (measuring gives up when it takes
   * too long): the list is the answer, the size only helps decide.
   */
  'git.ignoredEntries': z.object({ projectId: ProjectId }),
  'git.checkout': z.object({ projectId: ProjectId, branch: z.string(), dryRun: z.boolean().optional() }),
  'git.stage': z.object({
    projectId: ProjectId,
    paths: z.array(z.string()),
    unstage: z.boolean().optional(),
  }),
  /** `cancelled`: the person ended it with `git.cancel`; the screen says so rather than that it failed */
  'git.commit': z.object({ projectId: ProjectId, message: z.string() }),
  'git.push': z.object({ projectId: ProjectId }),
  /**
   * Ends the git panel's running write: a hook or a credential helper waiting on a sign-in otherwise holds it for up to
   * ten minutes. git is ended as a timeout ends it, so it removes its `index.lock`.
   */
  'git.cancel': z.object({ projectId: ProjectId }),
  /** Saved as a file, so base64 never goes into the database */
  'attachments.save': z.object({
    sessionId: SessionId,
    name: z.string(),
    mime: z.string(),
    dataBase64: z.string().max(ATTACHMENT_MAX_BASE64, 'This attachment is too large'),
  }),
  'fs.listDir': z.object({ projectId: ProjectId, path: z.string() }),
  /**
   * The whole watch set every time: it is the set of expanded rows, and "add this, drop that" would let the two sides
   * drift apart with no error. Changes come as `fs_changed`; `watched` below the count sent means the cap cut it.
   */
  'fs.watch': z.object({ projectId: ProjectId, paths: z.array(z.string()) }),
  /** With `sessionId` (one of this project's), read from that session's worktree and refused outside it */
  'fs.readFile': z.object({ projectId: ProjectId, path: z.string(), sessionId: SessionId.optional() }),
  /** `toDir` is a folder: the gesture is a drop on a row and the name stays. `moved: false`: it was already there */
  'fs.move': z.object({ projectId: ProjectId, from: z.string(), toDir: z.string() }),
  /** Bytes, not a source path: the webview never tells the page where a dropped file lives */
  'fs.importFile': z.object({
    projectId: ProjectId,
    toDir: z.string(),
    name: z.string(),
    dataBase64: z.string(),
  }),
  /**
   * For the shell's own OS calls (reveal, trash). Only the host knows the project root, so only it builds the path, and
   * it refuses one that leaves the project or is not there.
   */
  'fs.resolve': z.object({
    projectId: ProjectId,
    path: z.string(),
    /**
     * `trash`: the entry itself, a link included, never its target. `project`: the project folder (the path ignored), for
     * "Delete project and trash folder" only. Otherwise (reveal, open in an IDE, an older window) a link is followed
     * inside the project. The folder itself only for `project`, and for an older window's delete dialog's `.`.
     */
    purpose: FsResolvePurpose.optional(),
    /** As `fs.readFile`'s, for reveal and open only; refused with `trash` and `project` */
    sessionId: SessionId.optional(),
  }),
  'projects.add': z.object({ path: z.string(), ...machineParam }),
  /**
   * Read on the folder's machine, nothing changed, for add_project's card. `path` comes back absolute in that machine's
   * terms (`~` its home); a relative one is refused. `origin` is read from the repository's config (no program of it
   * runs). `project`: the one already registered for that folder, in whatever spelling it was kept.
   */
  'projects.inspect': z.object({ path: z.string().max(4096), ...machineParam }),
  /**
   * An empty folder `name` (no git init) in `parent` (that machine's `~/Centralu` when absent), registered as
   * `projects.add` does. Refused with one sentence for a bad name or `parent`, or when anything of that name exists.
   * With `source`, a clone by that machine's git and saved sign-ins, never prompting; an empty `name` is the repository's
   * (`repoNameOf`). A failed clone leaves nothing behind. No submodules.
   */
  'projects.create': z.object({
    name: z.string().max(255),
    parent: z.string().max(4096).optional(),
    source: GitSource.optional(),
    ...machineParam,
  }),
  /**
   * Makes nothing; shown as the person types. With an empty name, `path` and `error` are null; otherwise exactly one is set,
   * `error` being the sentence `projects.create` would refuse with.
   */
  'projects.createPreview': z.object({
    name: z.string().max(255),
    parent: z.string().max(4096).optional(),
    source: GitSource.optional(),
    ...machineParam,
  }),
  /**
   * Erases the project from every record (sessions, conversations, search, rules, usage attribution) and never touches
   * the folder: only the shell can use the OS trash, and does so first. Hence no `deleteFiles` switch here.
   */
  'projects.delete': z.object({ projectId: ProjectId }),
  /**
   * docs/protocol.md §3 "project folder on delete". `may_move`: the project is an app folder registered in place, which
   * the host may move to `app-trash/`; `around_may_move`: it lies inside one whose own project is gone; `unsure`: it cannot
   * be told from such a folder, and counts as at it. "May": the move also waits for the trash and any other project there.
   */
  'projects.deleteOutlook': z.object({ projectId: ProjectId }),
  /**
   * Whether the project's code may run here. "No" by default: opening a repository someone handed over must not run its
   * app server with the user's permissions. Off takes its apps down at once.
   */
  'projects.setTrusted': z.object({ projectId: ProjectId, trusted: z.boolean() }),
  /** The whole order: "move this one there" would drift if the list changed meanwhile */
  'projects.reorder': z.object({ orderedIds: z.array(z.string()) }),
  /**
   * The whole list, as `projects.reorder`. Not inspected: they are the person's own, like typing into the terminal, and
   * asking about them would teach waving prompts through. Answers the list, not the project, to spare a `git status`.
   */
  'projects.setCommands': z.object({ projectId: ProjectId, commands: z.array(SavedCommand) }),
  /** Where a new worktree forks from and what "merged" is measured against; `ProjectInfo.worktreeManager.baseBranch` carries it */
  'worktrees.setTrunk': z.object({ projectId: ProjectId, baseBranch: z.string() }),
  'projects.setWorktreeSetup': z.object({
    projectId: ProjectId,
    setup: z.object({ command: z.string(), copyFiles: z.array(z.string()) }).nullable(),
  }),
  /** The whole text; empty clears it. Bounded, as it travels in every task */
  'projects.setAgentInstructions': z.object({
    projectId: ProjectId,
    text: z.string().max(AGENT_INSTRUCTIONS_MAX),
  }),
  'projects.list': z.object({}),
  'projects.gitStatus': z.object({ projectId: ProjectId }),
  /**
   * How a hub tells which linked machine's project is a checkout of one of its own (`gitRemoteKey`). Null: not a git
   * repository, or no `origin`.
   */
  'projects.origin': z.object({ projectId: ProjectId }),
  /** For `@` autocomplete, within the project only */
  'files.search': z.object({ projectId: ProjectId, query: z.string(), limit: z.number().default(20) }),
} as const

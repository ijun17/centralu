import type {
  ProjectConsent,
  ProjectConsentKind,
  ProjectInfo,
  SavedCommand,
  GitSource,
} from '@cc/protocol/client'
import type { MachineRef } from './common.js'

export interface ProjectPort {
  reorder(orderedIds: string[]): Promise<ProjectInfo[]>
  /** `machine`: a folder on that linked machine, the path in its own terms (#82) */
  add(path: string, machine?: MachineRef): Promise<ProjectInfo>
  /**
   * Makes a new project (#515): an empty folder `name` inside `parent`, or the `~/Centralu` of `machine` (this computer
   * when absent), made by that machine's host and registered. Refused with one sentence when anything of that name
   * is already there, or the name is not one folder name. With `source` the folder is a clone of that repository,
   * made by that machine's git with its saved sign-ins; an empty `name` is then the repository's.
   */
  create(name: string, parent?: string, machine?: MachineRef, source?: GitSource): Promise<ProjectInfo>
  /** Where `create` would make the folder, or why it would refuse — nothing is made (#515) */
  createPreview(name: string, parent?: string, machine?: MachineRef, source?: GitSource): Promise<{ parent: string; path: string | null; error: string | null }>
  list(): Promise<ProjectInfo[]>
  gitStatus(projectId: string): Promise<ProjectInfo>
  /**
   * Delete a project and everything this app remembers about it.
   *
   * The folder is not this call's business — the OS trash belongs to the shell, so the
   * caller empties it first and only then removes the record. That order is forced: the
   * path lives in the row, so deleting the row first would leave nothing to point at.
   */
  remove(projectId: string): Promise<{ ok: true }>
  /**
   * What deleting this project may do to its folder (#1301), asked once when the Delete project dialog opens: `stays`, or the
   * host `may_move` it (a folder of the user folder registered in place) or the folder `around_may_move` it. A host before this
   * answers "Unknown method"; the dialog then goes by `ProjectInfo.fromUserFolder`.
   */
  deleteOutlook(projectId: string): Promise<{ folder: 'stays' | 'may_move' | 'around_may_move' | 'unsure' }>
  /**
   * Replace this project's saved shell commands, whole (issue #44).
   *
   * Adding and deleting come through the same door, as `reorder` above does: for a short
   * list a person edits by hand, "make it look like this" already states every edit.
   * What comes back is what was actually stored — the host drops blank entries, so it can
   * differ from what was sent.
   */
  setCommands(projectId: string, commands: SavedCommand[]): Promise<SavedCommand[]>
  /** Saves the instructions for agents started in this project (#1161 item 2); an empty text clears them */
  setAgentInstructions(projectId: string, text: string): Promise<void>
  /** Saves the worktree provisioning setup (#69). Null clears it */
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /**
   * Trusts or stops trusting this project (M4, decision 3). Trusting it lets this project's
   * apps run and its project settings be honored. Turning it off brings those apps down
   * immediately. Changes to the app list come separately, as `external_apps_changed`.
   */
  setTrusted(projectId: string, trusted: boolean): Promise<void>
  /**
   * Sets the project's worktree trunk (#76): where a new worktree forks from and what "merged" is measured against.
   * baseBranch is decided by the caller — inventing a default further down would silently bake in the wrong trunk.
   * It was chosen when making the worktree manager, which was folded into ordinary sessions (#561 part 3).
   */
  setWorktreeTrunk(projectId: string, baseBranch: string): Promise<void>
}

/**
 * Cross-project consents (#371): the person's remembered "always" for one project reaching another — 'delegate'
 * (ask_project delivers to an existing session there) or 'apps' (its apps attach to the caller). Listed and revoked in Settings;
 * the host raises the question itself, as an approval card in the calling session.
 */
export interface ProjectConsentsPort {
  list(): Promise<ProjectConsent[]>
  /** The next reach from that project to that one asks again */
  revoke(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): Promise<void>
}

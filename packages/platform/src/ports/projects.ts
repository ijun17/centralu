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
   * An empty folder `name` in `parent`, or in `machine`'s `~/Centralu`, made by that machine's host (#515). Refused in
   * one sentence when the name is taken or not one folder name. `source`: a clone by that machine's git with its saved
   * sign-ins, and an empty `name` is the repository's.
   */
  create(name: string, parent?: string, machine?: MachineRef, source?: GitSource): Promise<ProjectInfo>
  /** Where `create` would make the folder, or why it would refuse; makes nothing (#515) */
  createPreview(name: string, parent?: string, machine?: MachineRef, source?: GitSource): Promise<{ parent: string; path: string | null; error: string | null }>
  list(): Promise<ProjectInfo[]>
  gitStatus(projectId: string): Promise<ProjectInfo>
  /**
   * Deletes the record, not the folder: the OS trash is the shell's, so the caller trashes the folder first. The row
   * holds the path, so deleting it first would leave nothing to point at.
   */
  remove(projectId: string): Promise<{ ok: true }>
  /**
   * Asked when the Delete project dialog opens (#1301): `may_move`: the host may move the folder (a user-folder
   * folder registered in place); `around_may_move`: the folder around it may. Without an answer,
   * `ProjectInfo.fromUserFolder` decides.
   */
  deleteOutlook(projectId: string): Promise<{ folder: 'stays' | 'may_move' | 'around_may_move' | 'unsure' }>
  /**
   * Replaces the list whole (#44), like `reorder`: for a short list edited by hand that states every edit. Answers what
   * was stored: the host drops blank entries.
   */
  setCommands(projectId: string, commands: SavedCommand[]): Promise<SavedCommand[]>
  /** Instructions for agents started in this project (#1161 item 2); empty text clears them */
  setAgentInstructions(projectId: string, text: string): Promise<void>
  /** Worktree provisioning (#69); null clears it */
  setWorktreeSetup(projectId: string, setup: { command: string; copyFiles: string[] } | null): Promise<void>
  /**
   * Trust lets the project's apps run and its settings be honored (M4, decision 3); off brings those apps down at once.
   * App list changes come as `external_apps_changed`.
   */
  setTrusted(projectId: string, trusted: boolean): Promise<void>
  /**
   * Where a new worktree forks from and what "merged" is measured against (#76). The caller decides: a default further
   * down would silently bake in the wrong trunk.
   */
  setWorktreeTrunk(projectId: string, baseBranch: string): Promise<void>
}

/**
 * The person's remembered "always" for one project reaching another (#371): 'delegate' (ask_project to an existing
 * session there) or 'apps' (its apps attach to the caller). The host asks on an approval card in the calling session.
 */
export interface ProjectConsentsPort {
  list(): Promise<ProjectConsent[]>
  /** The next reach between them asks again */
  revoke(fromProjectId: string, toProjectId: string, kind: ProjectConsentKind): Promise<void>
}

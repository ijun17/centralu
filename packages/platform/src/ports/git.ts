import type {
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
} from '@cc/protocol/client'

/** Runs in the host's dev-services; moving to git2 (Rust) waits until a measurement shows git is a bottleneck */
export interface GitPort {
  status(projectId: string): Promise<GitFileStatus[]>
  diff(projectId: string, path: string, staged?: boolean): Promise<GitDiff>
  log(projectId: string, limit?: number): Promise<GitCommit[]>
  commitDetail(projectId: string, sha: string): Promise<{ files: string[]; diff: string; truncated: boolean }>
  branches(projectId: string): Promise<GitBranch[]>
  /** What a new worktree will not have, offered as copy candidates (#76) */
  ignoredEntries(projectId: string): Promise<{ path: string; bytes: number | null }[]>
  /**
   * The writes below answer `cancelled` when ended by `cancel` (#1007). `dryRun` only reports what would conflict, to
   * show, not to block.
   */
  checkout(projectId: string, branch: string, dryRun?: boolean): Promise<{ ok: boolean; conflicts: string[]; message?: string; cancelled?: true }>
  stage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  commit(projectId: string, message: string): Promise<{ ok: boolean; message?: string; cancelled?: true }>
  push(projectId: string): Promise<{ ok: boolean; message?: string; cancelled?: true }>
  /** Ends the project's running write (a hook, a credential helper waiting on a sign-in) */
  cancel(projectId: string): Promise<{ cancelled: boolean }>
}

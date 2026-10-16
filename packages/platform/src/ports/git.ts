import type {
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
} from '@cc/protocol'

/**
 * Git inspection and operations (FR-4, B-1 new).
 * The implementation lives in the host's dev-services — moving to git2 (Rust) is on hold
 * until measurement confirms it is a bottleneck.
 */
export interface GitPort {
  status(projectId: string): Promise<GitFileStatus[]>
  diff(projectId: string, path: string, staged?: boolean): Promise<GitDiff>
  log(projectId: string, limit?: number): Promise<GitCommit[]>
  commitDetail(projectId: string, sha: string): Promise<{ files: string[]; diff: string; truncated: boolean }>
  branches(projectId: string): Promise<GitBranch[]>
  /** Things git ignores (#76) — things a new worktree will not have; flagged as copy candidates */
  ignoredEntries(projectId: string): Promise<{ path: string; bytes: number | null }[]>
  /** With dryRun, only reports what would conflict (show it, do not block it) */
  checkout(projectId: string, branch: string, dryRun?: boolean): Promise<{ ok: boolean; conflicts: string[]; message?: string }>
  stage(projectId: string, paths: string[], unstage?: boolean): Promise<void>
  commit(projectId: string, message: string): Promise<{ ok: boolean; message?: string }>
  push(projectId: string): Promise<{ ok: boolean; message?: string }>
}

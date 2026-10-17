import type { GitBranch, GitCommit, GitDiff, GitFileStatus } from '@cc/protocol'

/** The mock's git, behind the `git` port: the state tests manipulate and the calls they check */
export class GitMock {
  /** For tests: which diff was asked for — an eye on whether the group is right for a partially staged file (#160) */
  readonly gitDiffCalls: { path: string; staged: boolean }[] = []
  /** The fake git state tests manipulate */
  gitState: {
    files: GitFileStatus[]
    diffs: Record<string, string>
    commits: GitCommit[]
    branches: GitBranch[]
    dirty: string[]
    /**
     * The keys (path or sha) of the diffs to report as truncated.
     *
     * The real host gives only the first part and sets truncated once it crosses the cap
     * (400,000 characters). While the mock always returned false, a test for "the truncation
     * notice does not appear" **could not possibly fail** (#121). Taking a key rather than
     * faking it by length: a test should be able to draw that state without having to build a
     * 400KB string.
     */
    truncated: string[]
    /** Things git ignores (#76) — the list the setup window offers as copy candidates */
    ignored: { path: string; bytes: number | null }[]
    lastCommitMessage?: string
    pushed: boolean
    /** A commit or push waits until `cancel` (a hook or a sign-in that does not end on its own, #1007) */
    holdWrites?: boolean
  } = { files: [], diffs: {}, commits: [], branches: [], dirty: [], truncated: [], ignored: [], pushed: false }

  /** The held writes, each ended by `cancel` */
  private held = new Set<() => void>()
  private hold(): Promise<{ ok: boolean; message?: string; cancelled?: true } | null> {
    if (!this.gitState.holdWrites) return Promise.resolve(null)
    return new Promise((resolve) => {
      const end = () => resolve({ ok: false, message: 'Cancelled', cancelled: true })
      this.held.add(end)
    })
  }

  readonly git = {
    status: async (_projectId: string) => [...this.gitState.files],
    diff: async (_projectId: string, path: string, staged?: boolean): Promise<GitDiff> => {
      this.gitDiffCalls.push({ path, staged: staged ?? false })
      return {
        diff: this.gitState.diffs[path] ?? '',
        truncated: this.gitState.truncated.includes(path),
        binary: false,
      }
    },
    log: async (_projectId: string, limit = 50) => this.gitState.commits.slice(0, limit),
    commitDetail: async (_projectId: string, sha: string) => ({
      files: [`file-${sha}.ts`],
      diff: this.gitState.diffs[sha] ?? '',
      truncated: this.gitState.truncated.includes(sha),
    }),
    branches: async (_projectId: string) => [...this.gitState.branches],
    ignoredEntries: async (_projectId: string) => [...this.gitState.ignored],
    checkout: async (_projectId: string, branch: string, dryRun?: boolean) => {
      if (dryRun) return { ok: this.gitState.dirty.length === 0, conflicts: [...this.gitState.dirty] }
      this.gitState.branches = this.gitState.branches.map((b) => ({ ...b, current: b.name === branch }))
      return { ok: true, conflicts: [] }
    },
    stage: async (_projectId: string, paths: string[], unstage?: boolean) => {
      this.gitState.files = this.gitState.files.map((f) =>
        paths.includes(f.path) ? { ...f, staged: !unstage } : f,
      )
    },
    commit: async (_projectId: string, message: string) => {
      /*
       * Nothing staged: `git commit` fails and the host passes git's own words on (gitCommit, #999). With changes left
       * unstaged git says how to add them; with none, that the tree is clean.
       */
      if (!this.gitState.files.some((f) => f.staged)) {
        return {
          ok: false,
          message: this.gitState.files.length
            ? 'no changes added to commit (use "git add" and/or "git commit -a")'
            : 'nothing to commit, working tree clean',
        }
      }
      const cancelled = await this.hold()
      if (cancelled) return cancelled
      this.gitState.lastCommitMessage = message
      this.gitState.files = this.gitState.files.filter((f) => !f.staged)
      return { ok: true }
    },
    push: async (_projectId: string) => {
      const cancelled = await this.hold()
      if (cancelled) return cancelled
      this.gitState.pushed = true
      return { ok: true }
    },
    cancel: async (_projectId: string) => {
      const ends = [...this.held]
      this.held.clear()
      for (const end of ends) end()
      return { cancelled: ends.length > 0 }
    },
  }
}

import { gitBranchMerged } from '../dev-services/git.js'
import type { BranchPr } from '../dev-services/git-pr.js'
import type { DelegationHost } from './delegation-flow.js'
import type { WorktreeHost } from './worktree-sessions.js'

/**
 * What the merge checks reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type MergeChecksHost = Pick<DelegationHost, 'disposing' | 'emit' | 'handingOver' | 'meta'> &
  Pick<WorktreeHost, 'cwdOf' | 'trunkOf'> & {
    /** The PR status checker (#76, stage 3): the manager's field, which a test swaps out */
    readonly prLookup: (projectCwd: string, branch: string, signal?: AbortSignal) => Promise<BranchPr | 'unavailable' | null>
    /** How often a branch's PR is asked about at most: the manager's field, which a test sets to 0 */
    readonly prPollMs: number
  }

/**
 * Whether a project's worktree branches have landed on its trunk (#69, #76): by local git, else by the branch's PR
 * where gh is installed, and the checks nobody awaits that a leaving host ends (#368). Moved out of the session
 * manager as it was (#428); what it reaches of the manager is `MergeChecksHost`.
 */
export class MergeChecks {
  constructor(private readonly host: MergeChecksHost) {}

  /**
   * **The merge checks nobody awaits, so `disposeAll` can end them** (#368). Started at startup and on every project
   * refresh, each runs git, and gh where it is installed, in the project's folder. They used to outlive the manager:
   * a test that disposed a manager and removed its temporary project right away met a gh still running in that folder,
   * which Windows refuses to remove (EPERM on windows-2022, #368). `disposeAll` and `detachAll` abort the checks and
   * wait for them: an aborted `gitBranchPr` ends gh with the processes it started and returns once gh has exited,
   * and a check stops at its next session once either has begun, so what is left to wait for is at most one git read
   * (its own 10 s limit). A `prLookup` swapped in by a test is waited for as it is.
   */
  readonly mergeChecks = new Set<Promise<void>>()
  readonly mergeChecksStop = new AbortController()

  checkMergedInBackground(projectId: string): void {
    const check: Promise<void> = this.refreshMergedWorktrees(projectId)
      .catch(() => {})
      .finally(() => this.mergeChecks.delete(check))
    this.mergeChecks.add(check)
  }
  readonly prCheckedAt = new Map<string, number>()
  /** A one-way switch so a machine with no gh does not hit ENOENT on every single sweep */
  private ghAvailable = true

  /**
   * Re-checks whether this project's worktree branches have landed on the trunk (#69).
   *
   * Called from two places: startup (once), and the project's git refresh (projects.gitStatus — the
   * path the UI calls, debounced, every time a turn ends). **Never relies on a button of ours**:
   * merging from a terminal is normal usage, and whether a branch has landed on the trunk is a
   * question git itself can answer directly (a design decision). An old session with no `base` is
   * skipped — filling it in with a guess would read a freshly created branch as merged.
   *
   * Only flows false -> true, one direction: a merge is never undone (a revert is a new commit), and
   * a one-way flag means no event storm either.
   */
  async refreshMergedWorktrees(projectId: string): Promise<void> {
    const cwd = this.host.cwdOf(projectId)
    // If a trunk has been set, use it as the baseline (#76). If not, HEAD — this is the case for
    // worktrees created before a manager existed, and the baseline at that time is exactly what it meant back
    // then
    const trunk = this.host.trunkOf(projectId) ?? 'HEAD'
    for (const m of this.host.meta.values()) {
      if (this.host.disposing || this.host.handingOver) return
      if (m.projectId !== projectId || !m.worktree?.base || m.worktreeMerged) continue
      let merged = await gitBranchMerged(cwd, m.worktree.branch, m.worktree.base, trunk).catch(() => false)
      /*
       * A merge local git cannot see (#76, stage 3): a squash or rebase merge cannot be detected with
       * is-ancestor (measured, in git.ts), yet squash is the dominant outcome for a GitHub PR. A PR's
       * MERGED state is a fact recorded by the server, so it has no such blind spot — this fills the
       * gap by asking, when gh is available.
       *
       * Never asked if local git already says merged (the answer cannot change). Since this is a
       * network call, a per-session TTL applies (this sweep runs every time a turn ends), and once gh
       * itself is missing (ENOENT), this process never asks again — the answer to that cannot change either.
       */
      if (!merged && this.ghAvailable && !this.host.disposing && !this.host.handingOver) {
        const now = Date.now()
        // Not for a session deleted during the git check above: its entry would outlive it (#392)
        if (this.host.meta.get(m.id) === m && now - (this.prCheckedAt.get(m.id) ?? 0) >= this.host.prPollMs) {
          this.prCheckedAt.set(m.id, now)
          const pr = await this.host.prLookup(cwd, m.worktree.branch, this.mergeChecksStop.signal).catch(() => null)
          if (pr === 'unavailable') {
            this.ghAvailable = false
            // Logs it once, at the end — without this, "why is the PR chip never showing up" becomes a
            // mystery
            console.error('[worktree] gh not found — PR detection off for this run (local merge detection unaffected)')
          } else if (pr) {
            // Keep the protocol's chip shape; the lookup's headOid is not a UI field.
            const chip = { number: pr.number, state: pr.state, url: pr.url }
            // Never written if it was deleted while this was waiting (#163) — this used to resurrect an
            // id-less row back into meta
            if (this.host.meta.get(m.id) === m && JSON.stringify(chip) !== JSON.stringify(m.worktreePr)) {
              m.worktreePr = chip
              this.host.emit({ type: 'worktree_pr', sessionId: m.id, pr: chip })
            }
          }
          if (pr && pr !== 'unavailable' && pr.state === 'merged') merged = true
        }
      }
      /*
       * Skipped if it was deleted while this was waiting (#163). When writing, **it is corrected right
       * on the same object** — swapping in a new object would leave a different path also holding onto
       * the same session (a wake) writing and saving onto the stale one.
       */
      if (!merged || this.host.meta.get(m.id) !== m) continue
      // A merged branch is never asked about again (the sweep skips it), so its TTL entry has no reader
      this.prCheckedAt.delete(m.id)
      m.worktreeMerged = true
      this.host.emit({ type: 'worktree_merged', sessionId: m.id })
      console.error(`[worktree] branch merged into trunk: ${m.worktree.branch} (${m.id.slice(0, 8)})`)
    }
  }
}

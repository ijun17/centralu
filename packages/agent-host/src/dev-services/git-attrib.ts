import type { GitCommit } from '@cc/protocol'

/**
 * Commit attribution (#50) — through observation, without a hook.
 *
 * Nothing is written to the repository (decision, 2026-08-23): trailers, hooks and templates force a workflow on
 * someone else's repository. The agent's `git commit` is a tool call whose output is already in our event stream.
 */

/**
 * Picks the hash out of the `[branch abc1234]` line of `git commit` output.
 * Detached HEAD's `[detached HEAD abc1234]` has the same shape.
 */
export function parseCommitSha(output: string): string | null {
  const m = /\[[^[\]\n]*[ (]([0-9a-f]{7,40})\]/.exec(output)
  return m?.[1] ?? null
}

/** Whether this tool call is a command that can create a commit — also catches `git commit` inside a pipeline */
export function looksLikeGitCommit(command: string): boolean {
  return /\bgit\b[^\n]*?\bcommit\b/.test(command)
}

/** A recorded hash can be short (7 digits from truncated output), so it is matched by prefix, as git resolves one */
export function attachCommitSessions(
  commits: GitCommit[],
  records: { sha: string; sessionId: string }[],
  nameOf: (sessionId: string) => string | undefined,
): GitCommit[] {
  if (records.length === 0) return commits
  return commits.map((c) => {
    const rec = records.find((r) => c.sha.startsWith(r.sha) || r.sha.startsWith(c.sha))
    if (!rec) return c
    // Even if the session is deleted, the fact that "an agent made this" is kept
    return { ...c, sessionName: nameOf(rec.sessionId) ?? '(deleted session)' }
  })
}

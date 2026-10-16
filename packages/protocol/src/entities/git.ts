import { z } from 'zod'

/**
 * A repository a new project is cloned from (#515): an https, ssh or scp-like address (`gitSourceError` says which),
 * and the branch to check out, the repository's default when absent.
 */
export const GitSource = z.object({ git: z.string().max(2048), branch: z.string().max(255).optional() })
export type GitSource = z.infer<typeof GitSource>

/** The git panel (FR-4) */
export const GitFileStatus = z.object({
  path: z.string(),
  staged: z.boolean(),
  status: z.enum(['M', 'A', 'D', 'R', 'U', '?']),
})
export type GitFileStatus = z.infer<typeof GitFileStatus>

export const GitCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  author: z.string(),
  when: z.number(),
  parents: z.array(z.string()),
  /**
   * The name of the session that made this commit (#50). Known through observation, not a hook
   * — the hash is picked up from the agent's `git commit` tool call and recorded only in our own
   * database. Absent for a commit a person made directly — which is the correct outcome.
   */
  sessionName: z.string().optional(),
})
export type GitCommit = z.infer<typeof GitCommit>

export const GitBranch = z.object({
  name: z.string(),
  current: z.boolean(),
  remote: z.boolean(),
  upstream: z.string().optional(),
})
export type GitBranch = z.infer<typeof GitBranch>

export const GitDiff = z.object({ diff: z.string(), truncated: z.boolean(), binary: z.boolean() })
export type GitDiff = z.infer<typeof GitDiff>

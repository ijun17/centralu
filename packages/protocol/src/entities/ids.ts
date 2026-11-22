import { z } from 'zod'

// One path segment (`<data>/attachments/<id>/`): no separator or leading `.`, so `..` cannot be written; a UUID is 36.
// Measured as a plain string, `"../../Documents"` made `agents.deleteSession` delete that folder recursively.
const SESSION_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

export const SessionId = z.string().regex(SESSION_ID_RE, 'Not a session id')
export type SessionId = z.infer<typeof SessionId>

/** The same rule where zod cannot reach: code that builds a path checks again, as it can be called without the boundary */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value)
}

/** The session id's rule, as a worktree path holds it too: measured, `"../escaped"` made a worktree outside the root */
export const ProjectId = z.string().regex(SESSION_ID_RE, 'Not a project id')
export type ProjectId = z.infer<typeof ProjectId>

/** The same check for a project id: its rule is the session id's */
export const isProjectId = isSessionId

/** Open: the tools are what the host has adapters for, sent on the wire; a closed enum would make each one an edit here */
export const ToolName = z.string().min(1)
export type ToolName = z.infer<typeof ToolName>

/** Open, as `ToolName`; an external app's id is checked where its manifest is validated */
export const AppId = z.string()
export type AppId = z.infer<typeof AppId>

/** Per session, over the CLI's global setting; lowest first. `edits`: `normal` plus uncarded edits in the session's folder */
export const PermissionPreset = z.enum(['safe', 'normal', 'edits', 'auto'])
export type PermissionPreset = z.infer<typeof PermissionPreset>

/** The preset of a start that names none (docs/security-boundaries/presets.md): the start names it, so "Allow auto from a linked computer" does not apply */
export function defaultPresetFor(project: { readonly trusted: boolean }): PermissionPreset {
  return project.trusted ? 'auto' : 'normal'
}

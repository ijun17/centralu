import type { PermissionPreset } from '@cc/protocol/client'

/**
 * The preset a session the person starts gets when they name none (#1525, owner 2026-10-24): `edits` in a trusted
 * project, where the person approves edits inside the folder almost every time and a git repository can undo them, and
 * `normal` in an untrusted one. It is only a default: a preset named at the start, in the settings menu, in a handoff or
 * a fork wins and is never raised, and `normal` keeps its meaning (the person approves each step).
 *
 * A project on a linked machine keeps `normal`: that machine may run a build from before `edits`, which rejects the
 * value and would refuse the whole start.
 */
export function defaultPresetFor(project: { readonly trusted: boolean; readonly machine?: string | null }): PermissionPreset {
  return project.trusted && !project.machine ? 'edits' : 'normal'
}

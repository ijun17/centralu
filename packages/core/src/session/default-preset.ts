import type { PermissionPreset } from '@cc/protocol/client'

/**
 * The preset a session the person starts gets when they name none: `auto` in a trusted project, on this computer or a
 * linked one, and `normal` in an untrusted one, where the person approves each step (owner decision 2026-11-05; it was
 * `edits` in a trusted local project, #1525). It is only a default: a preset named at the start, in the settings menu,
 * in a handoff or a fork wins and is never raised, and a session that exists keeps the preset it has.
 *
 * A linked machine's project gets the same: `auto` and `normal` are values every linked build knows (`edits` was kept
 * off the link because a build from before #1525 rejects it and would refuse the whole start). The person's own start
 * names its preset, so a machine's "Allow auto from a linked computer" switch, which is about what an agent on the
 * other computer carries there, does not stand in its way.
 */
export function defaultPresetFor(project: { readonly trusted: boolean; readonly machine?: string | null }): PermissionPreset {
  return project.trusted ? 'auto' : 'normal'
}

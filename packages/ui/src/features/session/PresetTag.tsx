import type { PermissionPreset } from '@cc/protocol'

/**
 * The preset of a session a linked computer started (#1273: start_agent with a machine), on its sidebar row and its
 * header, on the computer it runs on and on the one that started it. An `auto` caller's child runs under `auto` there
 * when that computer allows it, with no card, so the preset is said where the session is seen rather than only in its
 * settings row. Nothing for any other session: every row carries its preset in its settings, and a tag on each would be
 * noise. MachineTag's hairline chip, so it reads as one more fact about where and how it runs.
 */
export function PresetTag({
  preset,
  startedFromHub,
  testId,
}: {
  preset: PermissionPreset
  startedFromHub: boolean | undefined
  testId?: string
}) {
  if (!startedFromHub) return null
  return (
    <span
      className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint"
      data-testid={testId}
      data-preset={preset}
      title={`Started by a session on a linked computer; runs under ${preset} permissions`}
    >
      {preset}
    </span>
  )
}

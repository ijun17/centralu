import { useState } from 'react'
import type { PermissionPreset } from '@cc/protocol/client'
import { usePresence } from '../../components/presence.js'

/**
 * The preset of a session a linked computer started (#1273: start_agent with a machine), in its header (not on its sidebar row any more: owner, 2026-11-05), on the computer it runs on and on the one that started it. Not when it is `auto`, the default
 * (owner, 2026-11-12, #2213): an `auto` caller's child runs under `auto` there when that computer allows it, which is what nearly every
 * one does, so the tag said what was already assumed. It says the preset when it is a lower one, which is what the person did not expect.
 * Nothing for any other session: every row carries its preset in its settings, and a tag on each would be
 * noise. MachineTag's hairline chip, so it reads as one more fact about where and how it runs. It fades in and out when the
 * preset changes to or from `auto`, and keeps the word it had while it leaves.
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
  const shown = !!startedFromHub && preset !== 'auto'
  const presence = usePresence(shown)
  // The word it had, for the exit: the preset it is changing to is the one it does not show
  const [word, setWord] = useState(preset)
  if (shown && word !== preset) setWord(preset)
  if (!presence.shown) return null
  return (
    <span
      className={`${presence.leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'} shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint`}
      data-testid={testId}
      data-preset={word}
      title={`Started by a session on a linked computer; runs under ${word} permissions`}
    >
      {word}
    </span>
  )
}

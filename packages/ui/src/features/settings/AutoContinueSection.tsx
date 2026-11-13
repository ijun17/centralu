import { autoContinueOf } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { SettingToggle } from './SettingToggle.jsx'

/**
 * "Continue after a usage limit resets" and "Continue when the network is back" (#1415, #2238; on by default, owner 2026-10-26). Rows of
 * the Background card (Settings.tsx): they answer the same question as the rows beside them, what happens to my agents when I am not
 * there. Each computer's host continues its own sessions by its own switches
 */
export function AutoContinueSection() {
  // Each switch by itself: a selector that builds an object would read as a change on every store update
  const limit = useStore((s) => autoContinueOf(s.prefs).limit)
  const network = useStore((s) => autoContinueOf(s.prefs).network)
  const setPrefs = (patch: { continueAfterLimit?: boolean; continueOnNetwork?: boolean }) => void useStore.getState().setPrefs(patch)
  return (
    <>
      <SettingToggle
        checked={limit}
        onChange={(next) => setPrefs({ continueAfterLimit: next })}
        label="Continue after a usage limit resets"
        testId="settings-continue-limit"
        hint="A turn your usage limit stopped goes on by itself when the limit resets. Off, it waits for you."
      />
      <SettingToggle
        checked={network}
        onChange={(next) => setPrefs({ continueOnNetwork: next })}
        label="Continue when the network is back"
        testId="settings-continue-network"
        hint="A turn a network drop or a sleeping computer stopped goes on by itself once the network is back. Off, it waits for you."
      />
    </>
  )
}

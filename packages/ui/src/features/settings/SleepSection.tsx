import { useEffect } from 'react'
import { useStore } from '../../store/store.js'
import { SettingsSelect } from './OtherChoice.jsx'
import { SettingsRow } from './SettingsLayout.jsx'

/** The choices, in minutes; null never. 15 is the default (the owner's decision, 2026-10-12) */
const CHOICES: readonly (number | null)[] = [5, 15, 30, 60, 240, null]

const label = (m: number | null) => (m === null ? 'Never' : m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`)

/**
 * "Put idle sessions to sleep after" (#568). Each session runs its own agent process, a few hundred megabytes
 * that grow while it sits there; a session left alone this long has its process ended and wakes when it is used. In
 * the Background category because it answers the same question as the switch beside it: what happens to my agents
 * when I am not using them.
 */
export function SleepSection(_props: { first: boolean }) {
  const policy = useStore((s) => s.sleepPolicy)
  const load = useStore((s) => s.loadSleepPolicy)
  const setAfter = useStore((s) => s.setSleepAfter)
  useEffect(() => {
    void load()
  }, [load])
  // Nothing to show until the host answers
  if (!policy) return null
  const value = policy.afterMinutes
  const choices = CHOICES.includes(value) ? CHOICES : [...CHOICES.slice(0, -1), value, null]
  return (
    // A row of the Background card (Settings.tsx), under the switch when the platform has one
    <section data-testid="settings-sleep">
      <SettingsRow
        label={<label htmlFor="settings-sleep-after">Put idle sessions to sleep after</label>}
        hint="Frees the memory of a session nobody is using; it wakes, as it was, when you use it."
        more={
          <>
            A session that has not been used for this long, and is not working, waiting for you or running background
            tasks, has its agent process ended to free its memory, where its agent can resume without losing anything. It
            stays in the list as asleep, and wakes when you type to it or send it a message; the conversation continues
            where it was.
          </>
        }
        control={
          <SettingsSelect
            tone="compact"
            id="settings-sleep-after"
            data-testid="settings-sleep-after"
            value={value === null ? 'never' : String(value)}
            onChange={(e) => void setAfter(e.target.value === 'never' ? null : Number(e.target.value))}
          >
            {choices.map((m) => (
              <option key={m ?? 'never'} value={m === null ? 'never' : String(m)}>
                {label(m)}
              </option>
            ))}
          </SettingsSelect>
        }
      />
    </section>
  )
}

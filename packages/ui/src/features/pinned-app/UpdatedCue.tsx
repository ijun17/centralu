import { useEffect, useState } from 'react'

/** How long it stays visible — one glance is enough */
const SHOWN_MS = 8_000
/** If this much time has passed since it was reopened, it does not appear at all — so an old notice does not attach to a view redrawn after coming back from somewhere else */
const FRESH_MS = 30_000

/**
 * "Updated" — a one-word note that the app came back up with new code and its view was reopened
 * (M4 C-4).
 *
 * If the result of a builder agent's fix changes in front of the person **without a sound**, the
 * person cannot tell whether the view changed or they just misread it. But it is not something that
 * should call the person either — waiting and notices belong to quiet colors (the palette rule). So
 * one small word stands briefly next to the title and then withdraws. Its visible duration is
 * measured from when this component renders (measuring from `at` instead would eat into it by
 * however long the new view took to come up). If it has been a while since the last reopen, it does
 * not appear even on a fresh render.
 */
export function UpdatedCue({ at, testId }: { at: number; testId: string }) {
  const [shown, setShown] = useState(() => Date.now() - at < FRESH_MS)
  useEffect(() => {
    const t = setTimeout(() => setShown(false), SHOWN_MS)
    return () => clearTimeout(t)
  }, [at])
  if (!shown) return null
  return (
    <span className="readout shrink-0 text-[10px] text-slate" data-testid={testId} title="The app now runs new code, so this view was opened again">
      Updated
    </span>
  )
}

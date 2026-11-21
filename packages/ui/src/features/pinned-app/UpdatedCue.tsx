import { useEffect, useState } from 'react'

/** One glance */
const SHOWN_MS = 8_000
/** Older reopens show nothing, so a view redrawn on coming back does not get a stale note */
const FRESH_MS = 30_000

/**
 * "Updated": the app came back with new code and its view reopened (M4 C-4). A silent change reads as a misreading,
 * yet notices stay quiet (the palette rule), so one word stands briefly by the title. Timed from this render, not
 * `at`, which the new view's start-up would eat into.
 */
export function UpdatedCue({ at, testId }: { at: number; testId: string }) {
  const [shown, setShown] = useState(() => Date.now() - at < FRESH_MS)
  useEffect(() => {
    const t = setTimeout(() => setShown(false), SHOWN_MS)
    return () => clearTimeout(t)
  }, [at])
  if (!shown) return null
  return (
    <span className="readout shrink-0 text-2xs text-ink-faint" data-testid={testId} title="The app now runs new code, so this view was opened again">
      Updated
    </span>
  )
}

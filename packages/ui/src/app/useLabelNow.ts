import { useCallback, useEffect, useState } from 'react'
import { LabelClock, nextResetTick, watchLabelVisibility, type NextLabelTick } from './labelClock.js'

const clock = new LabelClock()
let mounted = 0
let disconnect: (() => void) | null = null

/** Listen to document visibility only while a changing time label is mounted. */
function connect(): () => void {
  if (mounted++ === 0) {
    disconnect = watchLabelVisibility(clock, document)
  }
  return () => {
    if (--mounted === 0) {
      disconnect?.()
      disconnect = null
    }
  }
}

/** `next` must be stable. Null means this mounted view currently has no changing time label. */
export function useLabelNow(next: NextLabelTick | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!next) return
    const detach = connect()
    const unsubscribe = clock.subscribe(next, setNow)
    return () => {
      unsubscribe()
      detach()
    }
  }, [next])
  return now
}

/** The clock of a label that names a moment ahead (a reset, a continue): it ticks until the moment has passed, so the label can say so */
export function useNowUntil(at: number | undefined): number {
  const next = useCallback((now: number) => nextResetTick(at ?? NaN, now), [at])
  return useLabelNow(at !== undefined && Number.isFinite(at) ? next : null)
}

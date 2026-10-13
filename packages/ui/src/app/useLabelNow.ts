import { useEffect, useState } from 'react'
import { useStore } from '../store/store.js'
import { LabelClock, watchLabelVisibility, type NextLabelTick } from './labelClock.js'

const clock = new LabelClock()
let mounted = 0
let disconnect: (() => void) | null = null

/** Listen only while a time label is mounted; the store carries the app's focus/visibility signal. */
function connect(): () => void {
  if (mounted++ === 0) {
    disconnect = watchLabelVisibility(clock, document, {
      current: () => useStore.getState().appFocused,
      subscribe: (refresh) => useStore.subscribe((state, previous) => {
        if (state.appFocused !== previous.appFocused) refresh()
      }),
    })
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

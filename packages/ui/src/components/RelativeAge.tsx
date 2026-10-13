import { useCallback } from 'react'
import { formatAgo, nextAgeTick } from '../app/labelClock.js'
import { useLabelNow } from '../app/useLabelNow.js'

export function RelativeAge({ when }: { when: number }) {
  const next = useCallback((now: number) => nextAgeTick(when, now), [when])
  const now = useLabelNow(Number.isFinite(when) ? next : null)
  return <>{formatAgo(when, now)}</>
}

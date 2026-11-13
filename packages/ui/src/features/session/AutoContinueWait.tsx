import { useState } from 'react'
import { CONTINUE_WORDS, type Interruption } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { autoContinueLabel } from '../../components/primitives.jsx'
import { formatClock } from '../../app/format.js'
import { Button } from '../../components/Button.jsx'
import { usePresence } from '../../components/presence.js'

/**
 * The wait of a stop Centralu continues by itself (#1415), in the session's header (owner, 2026-10-26): what it waits for,
 * **Continue now** and **Don't continue**. Only here: the line above the composer keeps saying the stop, without these
 * buttons, so no button shows twice. It fades in and out (design-system.md §9); while it leaves it keeps the last wait it
 * said and takes no press.
 */
export function AutoContinueWait({ sessionId, interruption }: { sessionId: string; interruption: Interruption | null | undefined }) {
  const send = useStore((s) => s.send)
  const stopContinue = useStore((s) => s.stopContinue)
  const label = interruption ? autoContinueLabel(interruption, formatClock) : null
  const { shown, leaving } = usePresence(label !== null)
  // The last wait said, for the frames it fades out in ("state from the previous props", as usePresence)
  const [last, setLast] = useState(label)
  if (label !== null && label !== last) setLast(label)
  if (!shown) return null
  return (
    <span
      className={`${leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'} flex min-w-0 shrink items-center gap-2`}
      data-testid="auto-continue"
      aria-hidden={leaving || undefined}
    >
      <span className="truncate text-xs text-ink" data-testid="auto-continue-wait">
        {label ?? last}
      </span>
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        onClick={() => void send(sessionId, CONTINUE_WORDS)}
        title={`Sends "${CONTINUE_WORDS}"`}
        data-testid="auto-continue-now"
      >
        Continue now
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => void stopContinue(sessionId)}
        title="Centralu leaves this turn stopped for you to continue"
        data-testid="auto-continue-stop"
      >
        Don&apos;t continue
      </Button>
    </span>
  )
}

import { CONTINUE_WORDS, type TurnStop } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { turnStopLabel } from '../../components/primitives.jsx'
import { useNowUntil } from '../../app/useLabelNow.js'
import { Button } from '../../components/Button.jsx'
import { useHeld, usePresence } from '../../components/presence.js'

/**
 * The wait of a stop Centralu continues by itself (#1415): what it waits for, **Continue now** and **Don't continue**, in
 * the line above the composer (agent-host/lifecycle/auto-continue.md "Where it shows"). The words wrap rather than cut,
 * and the buttons wrap under them as a pair, so a narrow window still reads the cause and the time.
 *
 * While it fades out it keeps the last wait it said and takes no press. `className` places it in the line.
 */
export function AutoContinueWait({
  sessionId,
  wait: current,
  className = '',
}: {
  sessionId: string
  wait: Extract<TurnStop, { kind: 'wait' }> | null
  className?: string
}) {
  const stopContinue = useStore((s) => s.stopContinue)
  const { shown, leaving } = usePresence(current !== null)
  const wait = useHeld(current)
  const now = useNowUntil(wait?.interruption.autoContinue?.at)
  if (!shown || !wait) return null
  return (
    <div
      className={`${leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'} flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ${className}`.trim()}
      data-testid="auto-continue"
      aria-hidden={leaving || undefined}
    >
      <span className="min-w-0 flex-[1_1_auto] break-words text-ink" data-testid="auto-continue-wait">
        {turnStopLabel(wait, now)}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => void useStore.getState().send(sessionId, CONTINUE_WORDS)}
          title={`Sends "${CONTINUE_WORDS}"`}
          data-testid="auto-continue-now"
        >
          Continue now
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => void stopContinue(sessionId)}
          title="Centralu leaves this turn stopped for you to continue"
          data-testid="auto-continue-stop"
        >
          Don&apos;t continue
        </Button>
      </span>
    </div>
  )
}

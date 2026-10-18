import type { Interruption } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { CONTINUE_TEXT, interruptionLabel } from '../../components/primitives.jsx'

/*
 * The lines a session pane shows above its composer when the session will not simply hear the
 * next message (#428): its machine is away, its last turn was cut short, or it has no process.
 */

/**
 * A session on a linked machine that is away (#82). What shows is what the hub last heard, and nothing here wakes it:
 * the machine's own resync does once it is back, and a message sent now would only fail at the hub. Said in the spot
 * the dormant note takes, because it answers the same question: will this session hear me?
 */
export function AwayNote({ machine }: { machine: string | null }) {
  const name = useMachineName(machine) ?? 'Its machine'
  return (
    <p className="border-t border-line px-4 py-1.5 text-xs text-ink-faint" data-testid="away-note">
      {name} is away — this is what was last heard from it. It picks up again when the machine reconnects.
    </p>
  )
}

export function InterruptedNote({
  sessionId,
  interruption,
}: {
  sessionId: string
  interruption: Interruption
}) {
  const send = useStore((s) => s.send)
  const why =
    interruption.reason === 'network'
      ? 'A network error ended the last turn before it finished.'
      : interruption.reason === 'quit'
        ? 'Centralu quit or restarted while the last turn was running, so it did not finish.'
        : 'The agent tool interrupted the last turn before it finished.'
  return (
    <p
      className="flex items-center gap-2 border-t border-line px-4 py-1.5 text-xs leading-body text-ink-muted"
      data-testid="interrupted-note"
      data-reason={interruption.reason}
      title={interruption.detail}
    >
      <span className="min-w-0 flex-1 break-words">
        <span className="text-ink">{interruptionLabel(interruption)}</span> — {why}
      </span>
      <button
        className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong"
        onClick={() => void send(sessionId, CONTINUE_TEXT)}
        title={`Sends "${CONTINUE_TEXT}"`}
        data-testid="interrupted-continue"
      >
        Continue
      </button>
    </p>
  )
}

/**
 * A session with no process.
 *
 * This used to block with "This session is not running" and require pressing [Continue]. That
 * pushes a machine-level concern onto the person — all they want is to keep talking, and the
 * means to continue is already something this app has. Now sending a message lets the host
 * resume it on its own. This just quietly says so (so it comes as no surprise).
 *
 * Since #568 the usual reason is sleep: the host ends an idle session's process after 15 minutes. The
 * composer taking the keyboard wakes it (and so does a message), so nothing is said while it sleeps;
 * while it starts the line says "Waking".
 */
export function DormantNote({ sessionId }: { sessionId: string }) {
  const waking = useStore((s) => !!s.resuming[sessionId])
  const error = useStore((s) => s.wakeError[sessionId])
  const locked = useStore((s) => !!s.wakeLocked[sessionId])
  const wake = useStore((s) => s.wake)
  const fork = useStore((s) => s.forkConversation)

  // If there is a reason it could not be resumed, that is said first — "sending resumes it"
  // would no longer be true
  if (error && !waking) {
    return (
      <p
        className="flex items-center gap-2 border-t border-line px-4 py-1.5 text-xs leading-body text-ink-muted"
        data-testid="dormant-note"
      >
        <span className="min-w-0 flex-1 break-words">Could not resume — {error}</span>
        {/*
         * When something else is holding the lock, **retrying alone never opens it** — the
         * only way forward used to be going and closing the other app. A way to fork and
         * continue is placed right there alongside it. The fact that it leaves the original
         * untouched has to be spelled out too, or pressing it feels risky.
         */}
        {locked && (
          <button
            className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong"
            onClick={() => void fork(sessionId)}
            title="Continue in a copy of this conversation. The original stays untouched."
            data-testid="dormant-fork"
          >
            Continue in a fork
          </button>
        )}
        <button
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong"
          onClick={() => void wake(sessionId)}
          data-testid="dormant-retry"
        >
          Retry
        </button>
      </p>
    )
  }

  /*
   * Asleep says nothing (owner, 2026-10-18): sleep needs nothing from the person, typing wakes it, so a standing line
   * only took the conversation's room. What stays is what they would want to know: that it is waking, and (above)
   * why it could not.
   */
  if (!waking) return null
  return (
    <p className="border-t border-line px-4 py-1.5 text-xs text-ink-faint" data-testid="dormant-note">
      Waking session…
    </p>
  )
}

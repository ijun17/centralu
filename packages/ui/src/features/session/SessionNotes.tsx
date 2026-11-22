import { useMemo } from 'react'
import { CONTINUE_WORDS, turnStop, type Interruption, type SessionState, type TurnStop } from '@cc/protocol/client'
import { lastTurnRefusedModel, useStore } from '../../store/store.js'
import { useMachineName } from '../../store/selectors.js'
import { turnStopLabel } from '../../components/primitives.jsx'
import { useNowUntil } from '../../app/useLabelNow.js'
import { useHeld, usePresence } from '../../components/presence.js'
import { Button } from '../../components/Button.jsx'
import { AutoContinueWait } from './AutoContinueWait.jsx'

/*
 * The lines a session pane shows above its composer when the session will not simply hear the
 * next message (#428): its machine is away, its last turn stopped, or it has no process.
 */

type NotedSession = { id: string; state: SessionState; live: boolean; interruption?: Interruption | null }

/**
 * Which of the notes below a pane shows, and whether one of them has a button to press. The pane reads this to keep its
 * composer open while it does: a folded composer rises over the bottom of the pane and would cover the button (owner,
 * 2026-11-07). Both the notes and the pane decide from these, so a note cannot show without the pane knowing.
 *
 * The away note has no button (it only says the machine will pick up again), so it does not count.
 */
export function useSessionNotes(session: NotedSession | undefined, away: boolean) {
  const waking = useStore((s) => !!(session && s.resuming[session.id]))
  const wakeError = useStore((s) => (session ? s.wakeError[session.id]?.reason : undefined))
  const state = session?.state
  const interruption = session?.interruption
  // One object while its facts stay, so the note can tell a new stop from the same one
  const stop = useMemo(() => (state && !away ? turnStop({ state, interruption }) : null), [state, interruption, away])
  const dormant = !!session && !away && !session.live
  return {
    stop,
    dormant,
    /** A button waits in a note: every stop has one (Continue, Done, or the wait's two), and the dormant note's Retry */
    hasButton: stop !== null || (dormant && !!wakeError && !waking),
  }
}

/**
 * A session on a linked machine that is away (#82). What shows is what the hub last heard, and nothing here wakes it:
 * the machine's own resync does once it is back, and a message sent now would only fail at the hub. Said in the spot
 * the dormant note takes, because it answers the same question: will this session hear me?
 */
export function AwayNote({ machine }: { machine: string | null }) {
  const name = useMachineName(machine) ?? 'Its machine'
  return (
    <p className="border-t border-line px-conversation py-1.5 text-xs text-ink-faint" data-testid="away-note">
      {name} is away — this is what was last heard from it. It picks up again when the machine reconnects.
    </p>
  )
}

/**
 * Why the last turn stopped and what can be done (`turnStop`), the one note that says it. The conversation keeps the tool's
 * own words as its record; this says what Centralu knows and offers: Continue for a cut turn, Done (#1549) to take an
 * error's mark off, or while Centralu waits to continue it, the wait (AutoContinueWait).
 *
 * The wait and the rest sit in one grid cell so they cross-fade without the line jumping to two rows. `stop` is null when
 * nothing stopped; the note then fades out saying the last stop, taking no press.
 */
export function StopNote({ sessionId, stop: current }: { sessionId: string; stop: TurnStop | null }) {
  const send = useStore((s) => s.send)
  const done = useStore((s) => s.markDone)
  const note = usePresence(current !== null)
  const stop = useHeld(current)
  const plain = usePresence(stop?.kind !== 'wait')
  // The plain line's stop, kept while it fades out under a wait that came
  const said = useHeld(stop?.kind === 'wait' ? null : stop)
  const now = useNowUntil(said?.kind === 'stopped' ? said.resetAt : undefined)
  // Trying again cannot help a refused model; another model can (#1369). Held with the stop, so the note fades out whole
  const pickModel = useHeld(
    useStore((s) => (current ? (current.kind === 'error' || (current.kind === 'stopped' && current.error)) && lastTurnRefusedModel(s.chat[sessionId]) : null)),
  )
  if (!note.shown || !stop) return null
  return (
    <div
      className={`${note.leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'} grid grid-cols-1 border-t border-line-chrome px-conversation py-1.5 text-xs leading-body text-ink-muted`}
      aria-hidden={note.leaving || undefined}
      data-testid="stop-note"
      data-kind={stop.kind}
    >
      {plain.shown && said && (
        <div
          className={`${plain.leaving ? 'cc-fade-out pointer-events-none' : 'cc-fade'} col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1`}
          aria-hidden={plain.leaving || undefined}
        >
          <span className="min-w-0 flex-[1_1_auto] break-words text-ink" data-testid="stop-note-words">
            {turnStopLabel(said, now)}
            {pickModel && ' · pick another model'}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {said.kind === 'stopped' && (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => void send(sessionId, CONTINUE_WORDS)}
                title={`Sends "${CONTINUE_WORDS}"`}
                data-testid="stop-note-continue"
              >
                Continue
              </Button>
            )}
            {pickModel && (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => useStore.getState().requestSettingsMenu(sessionId)}
                data-testid="stop-note-pick-model"
              >
                Pick another model
              </Button>
            )}
            {(said.kind === 'error' || said.error) && (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => void done(sessionId)}
                title="Clears the error mark. Nothing is stopped or sent."
                data-testid="stop-note-done"
              >
                Done
              </Button>
            )}
          </span>
        </div>
      )}
      <AutoContinueWait sessionId={sessionId} wait={stop.kind === 'wait' ? stop : null} className="col-start-1 row-start-1" />
    </div>
  )
}

/**
 * A session with no process.
 *
 * It does not block with "This session is not running" and a [Continue] to press: that pushes
 * a machine-level concern onto the person — all they want is to keep talking, and the means to
 * continue is already something this app has. Sending a message lets the host resume it on its
 * own.
 *
 * The usual reason is sleep (#568): the host ends an idle session's process after 15 minutes. The
 * composer taking the keyboard wakes it (and so does a message), so nothing is said while it sleeps;
 * while it starts the line says "Waking".
 */
export function DormantNote({ sessionId }: { sessionId: string }) {
  const waking = useStore((s) => !!s.resuming[sessionId])
  const error = useStore((s) => s.wakeError[sessionId]?.reason)
  const locked = useStore((s) => !!s.wakeLocked[sessionId])
  // The conversation's line already gives the reason: the note says only what it offers (#2360)
  const said = useStore((s) => !!s.wakeError[sessionId]?.saidByLine)
  const wake = useStore((s) => s.wake)
  const fork = useStore((s) => s.forkConversation)

  // If there is a reason it could not be resumed, that is said first — "sending resumes it"
  // would no longer be true
  if (error && !waking) {
    return (
      <p
        className="flex items-center gap-2 border-t border-line-chrome px-conversation py-1.5 text-xs leading-body text-ink-muted"
        data-testid="dormant-note"
      >
        <span className="min-w-0 flex-1 break-words">{said ? 'Could not resume' : `Could not resume — ${error}`}</span>
        {/*
         * When something else is holding the lock, **retrying alone never opens it** — the
         * only other way forward is closing the other app. A way to fork and
         * continue is placed right there alongside it. The fact that it leaves the original
         * untouched has to be spelled out too, or pressing it feels risky.
         */}
        {locked && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => void fork(sessionId)}
            title="Continue in a copy of this conversation. The original stays untouched."
            data-testid="dormant-fork"
          >
            Continue in a fork
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => void wake(sessionId)}
          data-testid="dormant-retry"
        >
          Retry
        </Button>
      </p>
    )
  }

  /*
   * Asleep says nothing (owner, 2026-10-18): sleep needs nothing from the person, typing wakes it, so a standing line
   * would only take the conversation's room. What stays is what they would want to know: that it is waking, and (above)
   * why it could not.
   */
  if (!waking) return null
  return (
    <p className="border-t border-line px-conversation py-1.5 text-xs text-ink-faint" data-testid="dormant-note">
      Waking session…
    </p>
  )
}

import type { BackgroundTask, Interruption, SessionState, ToolName } from '@cc/protocol/client'
import { useToolMeta } from '../../../store/selectors.js'
import { Tooltip, interruptionLabel, stateLabel } from '../../../components/primitives.jsx'
import { lookOf } from '../../session/look.js'
import { backgroundNote } from '../../session/BackgroundTasks.jsx'
import { usePresence } from '../../../components/presence.js'

/**
 * The session mark: tool and state in one spot. Our own letter, not a vendor logo (trademarks). The state is the chip's
 * look (`lookOf`, #736; docs/themes.md "The urgency order"); background work is a faint dot (docs/design-system.md §1);
 * asleep is not shown (docs/design-system.md §10).
 */
export function ToolMark({
  tool,
  state,
  asleep = false,
  interruption = null,
  openQuestions = 0,
  unread = true,
  background,
}: {
  tool: ToolName
  state: SessionState
  asleep?: boolean
  interruption?: Interruption | null
  openQuestions?: number
  unread?: boolean
  /** The session's background tasks, for the dot (a row in the sidebar); `testId` goes on the dot */
  background?: { tasks: readonly BackgroundTask[]; testId: string }
}) {
  const meta = useToolMeta(tool)
  const note = background ? backgroundNote(background.tasks) : null
  // The dot fades in and, when the last task ends, out (usePresence keeps it for its exit)
  const dot = usePresence(note !== null)
  const base = `${meta.label} · ${stateLabel(state)}${interruption ? ` · ${interruptionLabel(interruption)}` : ''}`
  const lines = note ? [`${base} · ${note.summary}`, ...note.running] : [base]
  const label = lines.join('\n')
  const look = lookOf({ state, interruption, openQuestions, unread })

  return (
    <Tooltip
      content={
        <>
          {base}
          {note && ` · ${note.summary}`}
          {note?.running.map((line, i) => (
            // By place: two tasks can carry the same description
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </>
      }
      testId={`tool-mark-tip-${tool}`}
      className="shrink-0"
    >
      <span
        className="cc-mark relative shrink-0 rounded-md"
        data-look={look}
        aria-label={label}
        data-testid={`tool-mark-${tool}`}
        data-state={state}
        data-interruption={interruption?.reason}
        data-asleep={asleep || undefined} // a hook for tests; it changes nothing shown
      >
        <span
          /*
            The letter in the UI face (docs/design-system.md §4). 14px inside the ring's 1.5px: 17px in every look. The
            sidebar and chip grounds are close (equal in the high-contrast themes), so the keycap treatment (`.cc-chip`)
            parts them without spending brightness. Its fill follows the look (`.cc-mark`).
          */
          className="cc-chip cc-chip-letter flex size-[14px] items-center justify-center rounded-sm border border-line-strong text-2xs font-semibold leading-none text-ink"
        >
          {meta.mark}
        </span>
        {background && dot.shown && <BackgroundDot testId={background.testId} leaving={dot.leaving} />}
      </span>
    </Tooltip>
  )
}

/** The background-work dot on a mark's bottom-right corner; a project's chip for sessions paused on background work wears it too */
export function BackgroundDot({ testId, leaving = false }: { testId: string; leaving?: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute -bottom-px -right-px size-[5px] rounded-full bg-ink-faint ring-[1.5px] ring-surface-side ${leaving ? 'cc-fade-out' : 'cc-fade'}`}
      data-testid={testId}
      data-leaving={leaving || undefined}
    />
  )
}

import type { Interruption, SessionState, ToolName } from '@cc/protocol/client'
import { useToolMeta } from '../../../store/selectors.js'
import { Tooltip, interruptionLabel, stateLabel } from '../../../components/primitives.jsx'
import { lookOf } from '../../session/look.js'

/**
 * The session mark — tool and state, in one spot. Without the tool, there would be no way to tell
 * apart two sessions with similar titles (this was actually mixed up during dogfooding).
 *
 * **No official logo is used.** Both companies' marks are trademarks with their own brand
 * guidelines — bundling a logo file into the app and distributing it could run into those rules.
 * With our own glyph, that problem does not exist at all, and it fits this app's own rule of
 * distinguishing things by shape in grayscale.
 *
 * The ring and the fill are the state, in four looks (`lookOf`, #736; the lines are in styles/index.css
 * under `.cc-mark`): a thin grey line at rest, a thick white line while it answers, the same line dashed
 * on grey when the turn broke off, and solid on grey when the person has to act. Nothing moves. The
 * chip's own 1px border is the same in all four, and the exact state is in the tooltip.
 */
/*
 * Asleep (#568): the session has no process, because the host put it to sleep when idle or nothing has woken it since a
 * restart. Not shown at all, not even in the tooltip (owner, 2026-10-18): sleep is the app working as it should,
 * nothing the person has to act on (using the session wakes it), and a fade would be mistaken for a stalled session
 * (#670). So a finished turn still looks finished and idle still looks idle. `data-asleep` stays for tests.
 */
export function ToolMark({ tool, state, asleep = false, interruption = null, openQuestions = 0, unread = true }: { tool: ToolName; state: SessionState; asleep?: boolean; interruption?: Interruption | null; openQuestions?: number; unread?: boolean }) {
  const meta = useToolMeta(tool)
  const label = `${meta.label} · ${stateLabel(state)}${interruption ? ` · ${interruptionLabel(interruption)}` : ''}`
  const look = lookOf({ state, interruption, openQuestions, unread })

  return (
    <Tooltip content={label} testId={`tool-mark-tip-${tool}`} className="shrink-0">
      <span
        className="cc-mark shrink-0 rounded-md"
        data-look={look}
        aria-label={label}
        data-testid={`tool-mark-${tool}`}
        data-state={state}
        data-interruption={interruption?.reason}
        data-asleep={asleep || undefined} // a hook for tests; it changes nothing shown
      >
        <span
          /*
            A bright letter on a dark chip, in the UI's own face (Pretendard, owner 2026-10-18: rounder and clearer at
            this size than the code face; the chip's width is fixed, so a fixed-width face bought nothing here). The chip is 14px inside the ring's 1.5px, so the mark is 17px in
            every look.

            The sidebar background (surface-side) and the chip background (surface-floor) differ by only a few steps, so
            a single border does not separate them well. Instead of raising the border brightness
            further, **the same treatment as a keycap** (cc-chip) is used: a 1px highlight on top and
            a shadow underneath. It reads as a separate object without spending more brightness, and
            brightness is the resource this app uses to state urgency, so spending it on decoration
            would cut into that signal by the same amount. Its fill follows the look (`.cc-mark`).
          */
          className="cc-chip cc-chip-letter flex size-[14px] items-center justify-center rounded-sm border border-line-strong text-2xs font-semibold leading-none text-ink"
        >
          {meta.mark}
        </span>
      </span>
    </Tooltip>
  )
}

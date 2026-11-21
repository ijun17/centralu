import { memo } from 'react'
import { contextShare } from '@cc/protocol/client'
import { formatCount } from '../../app/format.js'
import { useStore } from '../../store/store.js'
import { SessionSettings } from './SessionSettings.jsx'

/*
 * The row below the composer, where the settings are chosen just before a send. Apart from the composer,
 * whose textarea would otherwise re-render on every streamed delta of context and liveness.
 */

/** Points below the tool's compaction point at which the bar warns */
const WARN_BEFORE_COMPACT = 10

export const ComposerFooter = memo(function ComposerFooter({
  sessionId,
  onMenuOpenChange,
}: {
  sessionId: string
  onMenuOpenChange?: (open: boolean) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  if (!session) return null
  // Of the model's full window (#1553); a window of 0 gives none. `capped`: only a floor under the window is known
  const share = contextShare(session.context)
  const ctxPct = share ? Math.round(share.fraction * 100) : null
  const compactPct = share?.compactAt?.fraction != null ? Math.round(share.compactAt.fraction * 100) : null
  // Said in the tooltip only (owner, #1572)
  const estimated = session.context?.exactness === 'estimate'
  // At 80% when no compaction point is known (FR-14)
  const warn = ctxPct !== null && ctxPct >= (compactPct !== null ? Math.max(1, compactPct - WARN_BEFORE_COMPACT) : 80)
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <SessionSettings
        sessionId={session.id}
        tool={session.tool}
        model={session.model}
        effort={session.effort}
        verbosity={session.verbosity}
        serviceTier={session.serviceTier}
        preset={session.permissionPreset}
        live={session.live}
        onOpenChange={onMenuOpenChange}
      />
      {/* Unseen, a worktree sends people to the project folder
          asking why nothing changed */}
      {session.worktree && (
        <span
          className="readout truncate text-2xs text-ink-faint"
          title={`Runs in a git worktree: ${session.worktree.path}`}
          data-testid="worktree-badge"
        >
          ⑂ {session.worktree.branch}
        </span>
      )}
      {/* Context beside where it is used; unknown (never reported,
          a dim `—`) is not 0% */}
      {/*
        Tabular figures, so the number does not jitter (owner, 2026-10-18). The compaction point is in the
        tooltip alone, not on the bar (owner, #1572).
      */}
      <span
        className={`ml-auto flex shrink-0 flex-col items-stretch gap-[1.5px] text-xs tabular-nums ${
          ctxPct === null ? 'text-ink-faint/50' : warn ? 'text-ink' : 'text-ink-faint'
        }`}
        data-testid="context-gauge"
        title={
          session.context
            ? `Context ${formatCount(session.context.used)} / ${formatCount(session.context.window)} tokens${
                estimated ? ' (estimated until the next turn ends)' : ''
              }${
                share?.capped
                  ? " — the model's full window is not known yet, so this is the share of a smaller window the tool reported: the real share is at most this"
                  : ''
              }${
                share?.compactAt
                  ? ` · compacts at ${formatCount(share.compactAt.tokens)} tokens${compactPct !== null ? ` (${compactPct}%)` : ''}`
                  : ''
              }`
            : 'Context unknown — this session has never reported one'
        }
      >
        <span className="leading-none">Context {ctxPct === null ? '—' : `${share?.capped ? '≤' : ''}${ctxPct}%`}</span>
        <span className="block h-1" aria-hidden>
          <span className="block h-full overflow-hidden rounded-full bg-line">
            {ctxPct !== null && (
              <span
                className={`block h-full rounded-full ${warn ? 'bg-ink' : 'bg-ink-faint'}`}
                style={{ width: `${Math.min(100, Math.max(0, ctxPct))}%` }}
                data-testid="context-gauge-fill"
              />
            )}
          </span>
        </span>
      </span>
    </div>
  )
})

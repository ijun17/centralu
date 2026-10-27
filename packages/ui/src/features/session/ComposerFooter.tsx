import { memo } from 'react'
import { contextShare } from '@cc/protocol/client'
import { formatCount } from '../../app/format.js'
import { useStore } from '../../store/store.js'
import { SessionSettings } from './SessionSettings.jsx'

/**
 * The row below the composer — model, effort, permissions, worktree, context.
 *
 * **Why this subscribes separately** from the composer: the values here keep changing during
 * the conversation (context on every turn, live on every restart), and the composer has nothing
 * to do with any of that. Back when this was one component, the textarea itself was re-rendered
 * whole on every delta while a response streamed.
 *
 * The placement is unchanged — model and permissions are decided **right before sending**, so
 * they belong here, where the hand and eye already are, rather than in the header at the
 * opposite end of the screen.
 */
/** Points below the point where the tool compacts at which the bar starts to warn */
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
  // The share is used / the model's full window (#1553), whichever tool; the host says which window that is. A window of 0 (a model
  // the host could not size) has no percentage to give. `capped`: only a floor under the model's window is known, so the figure is
  // an upper bound and says so.
  const share = contextShare(session.context)
  const ctxPct = share ? Math.round(share.fraction * 100) : null
  const compactPct = share?.compactAt?.fraction != null ? Math.round(share.compactAt.fraction * 100) : null
  // An estimate is not drawn on the figure (owner, #1572); only the tooltip says it holds until the turn ends
  const estimated = session.context?.exactness === 'estimate'
  // The bar warns when the tool is about to compact: within 10 points of its compaction point. With none known, at 80% (FR-14)
  const warn = ctxPct !== null && ctxPct >= (compactPct !== null ? Math.max(1, compactPct - WARN_BEFORE_COMPACT) : 80)
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <SessionSettings
        sessionId={session.id}
        // Not the project's default — **this session's** tool (tools can be mixed)
        tool={session.tool}
        model={session.model}
        effort={session.effort}
        verbosity={session.verbosity}
        serviceTier={session.serviceTier}
        preset={session.permissionPreset}
        live={session.live}
        onOpenChange={onMenuOpenChange}
      />
      {/*
          A worktree session **runs in a different directory.** If that fact is not visible,
          people open the project folder and run into "why has nothing changed" — placing it
          next to the settings makes what is running where readable in one spot.
        */}
      {session.worktree && (
        <span
          className="readout truncate text-2xs text-ink-faint"
          title={`Runs in a git worktree: ${session.worktree.path}`}
          data-testid="worktree-badge"
        >
          ⑂ {session.worktree.branch}
        </span>
      )}
      {/*
          Context is placed **next to where it is used**, too. In the conversation header it sat
          at the opposite end of the screen, so during a long write-up, how much was actually
          left never registered (found in dogfooding).

          **Unknown and 0% are told apart.** A session that has never finished a turn has no
          value. Showing 0% at that point would be a lie that says "nothing has been used yet" —
          a dim `—` means it is unknown.

          (Before #48, a restarted session also fell into this. `context` was not in the
          database, so quitting and reopening the app made the value disappear. It is persisted
          now, so a blank truly only ever means "never reported at all".)
        */}
      {/*
        In the UI face, with figures of one width so the number does not jitter as it counts (owner, 2026-10-18).
        A thin bar under the number (owner, 2026-10-18), so how full it is reads at a glance: the track is a hairline,
        the fill steps up to ink from 80% as the number does; unknown draws the track alone. An estimate (the size a compaction
        reported, #1282, or a turn's running size) is drawn like any reading, with no mark on the figure (owner, #1572); only the tooltip
        says it holds until the turn ends. The point where the tool compacts is in the tooltip alone, not on the bar (owner, #1572).
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

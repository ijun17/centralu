import { memo } from 'react'
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
export const ComposerFooter = memo(function ComposerFooter({
  sessionId,
  onMenuOpenChange,
}: {
  sessionId: string
  onMenuOpenChange?: (open: boolean) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  if (!session) return null
  // A window of 0 (a model the host could not size) has no percentage to give
  const ctxPct = session.context && session.context.window > 0 ? Math.round((session.context.used / session.context.window) * 100) : null
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
      <span
        className={`readout ml-auto shrink-0 text-xs ${
          ctxPct === null ? 'text-ink-faint/50' : ctxPct >= 80 ? 'text-ink' : 'text-ink-faint'
        }`}
        data-testid="context-gauge"
        title={
          session.context
            ? `Context ${formatCount(session.context.used)} / ${formatCount(session.context.window)} tokens`
            : 'Context unknown — this session has never reported one'
        }
      >
        Context {ctxPct === null ? '—' : `${ctxPct}%`}
      </span>
    </div>
  )
})

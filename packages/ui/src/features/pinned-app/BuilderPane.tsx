import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { SessionPane } from '../session/SessionView.jsx'
import { useStore } from '../../store/store.js'

/**
 * Opens the builder session's conversation **beside** the app view (M4 C-5).
 *
 * There was also the option of a link that jumps to that session. That would switch the center lane
 * over to the session and hide the app view — breaking the promise that "the person never leaves the
 * app" (plan C-5) the moment it is pressed. Opening it beside the view instead lets the same pair of
 * eyes catch the view changing while the builder agent fixes it, and lets the person answer a
 * follow-up question from the agent right there. Needing almost nothing new to build is another
 * reason: the conversation panel is exactly the SessionPane the grid already uses (model, permission,
 * composer, approval card, all of it). The composer is collapsed — so it does not eat into reading
 * room in the narrow side panel (the same collapse as the grid). Messages are usually sent through
 * the input row below instead.
 */
export function BuilderPane({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const known = useStore((s) => !!s.sessions[sessionId])
  return (
    <aside className="flex w-[380px] min-w-0 shrink-0 flex-col border-l border-line" data-testid="builder-pane" aria-label="Builder conversation">
      {known ? (
        <SessionPane
          sessionId={sessionId}
          fold
          headerExtra={
            <IconButton label="Close the builder conversation" onClick={onClose} testId="builder-pane-close" align="right">
              <CloseIcon />
            </IconButton>
          }
        />
      ) : (
        <p className="px-3 py-3 text-[12px] text-ink-faint">The builder session is not loaded yet.</p>
      )}
    </aside>
  )
}

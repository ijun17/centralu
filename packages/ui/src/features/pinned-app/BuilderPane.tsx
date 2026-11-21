import { IconButton } from '../../components/IconButton.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { SessionPane } from '../session/SessionView.jsx'
import { useStore } from '../../store/store.js'

/**
 * The builder's conversation beside the app view (M4 C-5), not a jump to it, which would hide the app: the person
 * never leaves the app (plan C-5), sees the view change as the builder fixes it and answers it there. The grid's
 * SessionPane, its composer folded when short (`foldWhenShort`); messages usually go through the input row below.
 */
export function BuilderPane({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const known = useStore((s) => !!s.sessions[sessionId])
  return (
    <aside className="flex w-[380px] min-w-0 shrink-0 flex-col border-l border-line" data-testid="builder-pane" aria-label="Builder conversation">
      {known ? (
        <SessionPane
          sessionId={sessionId}
          foldWhenShort
          headerExtra={
            <IconButton label="Close the builder conversation" onClick={onClose} testId="builder-pane-close" align="right">
              <CloseIcon />
            </IconButton>
          }
        />
      ) : (
        <p className="px-3 py-3 text-sm text-ink-faint">The builder session is not loaded yet.</p>
      )}
    </aside>
  )
}

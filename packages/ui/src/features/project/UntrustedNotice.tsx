import { createListeners } from '@cc/common'
import { useState, useSyncExternalStore } from 'react'
import { Button } from '../../components/Button.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { useStore } from '../../store/store.js'
import { TrustCard, trustCardIds, UNTRUSTED_OFF } from './TrustCard.jsx'

/**
 * Projects whose notice the person put away in this window, so a session switch does not bring it back. Read through
 * `useSyncExternalStore`: two panels of one project in a grid both let it go when either does.
 */
const putAway = new Set<string>()
const listeners = createListeners((e) => console.error('A notice listener threw', e))
let putAwayCount = 0
const subscribe = (fn: () => void) => listeners.add(fn)
const isPutAway = (id: string) => putAway.has(id)
function putAwayNow(id: string): void {
  putAway.add(id)
  putAwayCount++
  listeners.emit()
}

/**
 * What is off in an untrusted project, said where the person works in it (#1512); nothing else says `CLAUDE.md` and
 * `AGENTS.md` are ignored. One line at any panel width, the rest in the hover text. The button opens the same card as
 * every "Trust this project…": trusting runs the repository's code, so the person decides, one press from the limit.
 */
export function UntrustedNotice({ projectId, className = '' }: { projectId: string | null; className?: string }) {
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const [open, setOpen] = useState(false)
  // The count is the snapshot: it changes exactly when a notice is put away, and every instance re-reads its own project
  useSyncExternalStore(subscribe, () => putAwayCount)
  if (!project || project.trusted || isPutAway(project.id)) return null
  return (
    <div className={className} role="status" data-testid="untrusted-notice">
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <span className="min-w-0 flex-1 truncate" title={`${project.name} is not trusted: ${UNTRUSTED_OFF}.`}>
          {project.name} is not trusted: CLAUDE.md and AGENTS.md are ignored
        </span>
        {!open && (
          <Button variant="primary" onRaised size="sm" className="shrink-0" onClick={() => setOpen(true)} data-testid="untrusted-notice-trust">
            Trust this project…
          </Button>
        )}
        <button
          type="button"
          className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
          aria-label="Dismiss"
          data-testid="untrusted-notice-dismiss"
          onClick={() => putAwayNow(project.id)}
        >
          <CloseIcon />
        </button>
      </div>
      {open && (
        <div className="mt-1.5">
          <TrustCard
            project={project}
            ids={trustCardIds('untrusted-notice-trust-card')}
            onAnswer={(yes) => {
              setOpen(false)
              if (yes) void useStore.getState().setProjectTrusted(project.id, true)
            }}
          />
        </div>
      )}
    </div>
  )
}

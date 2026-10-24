import { useState } from 'react'
import { Button } from '../../components/Button.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { useStore } from '../../store/store.js'
import { TrustCard, trustCardIds, UNTRUSTED_OFF } from './TrustCard.jsx'

/** Projects whose notice the person put away in this window, so a session switch does not bring it back */
const putAway = new Set<string>()

/**
 * What is off in a project the person has not trusted, said where they work in it (#1512). Until now nothing said that
 * its `CLAUDE.md` and `AGENTS.md` are ignored: the card said what trusting turns on, the project row said only that
 * its apps do not run, and an agent's refusal ("the person can trust it from the project menu") reached the person as
 * a line of the agent's answer.
 *
 * One line, whatever the panel's width (a narrow grid panel has no room for three); the rest of what is off stands in the
 * hover text. The button opens the same card as every other "Trust this project…", with the project's apps in view:
 * trusting runs the repository's code, so the decision stays the person's, one press away from where they met the limit.
 */
export function UntrustedNotice({ projectId, className = '' }: { projectId: string | null; className?: string }) {
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const trust = useStore((s) => s.setProjectTrusted)
  const [, bump] = useState(0)
  const [open, setOpen] = useState(false)
  if (!project || project.trusted || putAway.has(project.id)) return null
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
          onClick={() => {
            putAway.add(project.id)
            bump((n) => n + 1)
          }}
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
              if (yes) void trust(project.id, true)
            }}
          />
        </div>
      )}
    </div>
  )
}

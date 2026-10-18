import type { ProjectInfo } from '@cc/protocol'
import { useStore } from '../../../store/store.js'
import { Button } from '../../../components/Button.jsx'

/**
 * Trust asked once at registration (M4, decision 3).
 *
 * Not a modal — it stands under that project's own row. Right after registration there is a path
 * (the orchestrator's folder picker) that immediately opens a new-session dialog, and stacking a
 * dialog on top of a dialog would leave both only half-read. Standing here, the question is still
 * there even after the session dialog is closed and the person comes back. A project left
 * unanswered stays untrusted — it is safer to default to silently off than to silently on.
 *
 * The wording states exactly what happens: trusting it lets this project's apps run and its
 * settings apply.
 */
export function TrustAsk({ project }: { project: ProjectInfo }) {
  const answer = useStore((s) => s.answerTrustAsk)
  return (
    <div
      className="mx-3 mt-2 rounded-md border border-line bg-surface-raised px-2.5 py-2"
      role="group"
      aria-label={`Trust ${project.name}?`}
      data-testid={`trust-ask-${project.name}`}
    >
      <p className="text-sm text-ink">Trust this project?</p>
      <p className="mt-1 text-xs leading-body text-ink-muted">
        Trusting lets this project&apos;s apps run and its settings apply. Trust it only if you trust the code in this
        folder.
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md px-2 py-0.5 text-xs text-ink-faint transition-colors hover:text-ink"
          onClick={() => void answer(false)}
          data-testid={`trust-ask-no-${project.name}`}
        >
          Not now
        </button>
        <Button
          variant="primary"
          onRaised
          size="sm"
          onClick={() => void answer(true)}
          data-testid={`trust-ask-yes-${project.name}`}
        >
          Trust
        </Button>
      </div>
    </div>
  )
}

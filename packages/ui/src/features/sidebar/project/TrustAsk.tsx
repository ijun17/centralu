import type { ProjectInfo } from '@cc/protocol'
import { useStore } from '../../../store/store.js'
import { useProjectApps } from '../../../store/app-catalog.js'
import { usesLines } from '../../app-share/AppReviewDetails.jsx'
import { Button } from '../../../components/Button.jsx'

/**
 * Trust asked once at registration (M4, decision 3), and again from the project menu's "Trust this project…" when the
 * project has apps (#1141).
 *
 * Not a modal — it stands under that project's own row. Right after registration there is a path
 * (the orchestrator's folder picker) that immediately opens a new-session dialog, and stacking a
 * dialog on top of a dialog would leave both only half-read. Standing here, the question is still
 * there even after the session dialog is closed and the person comes back. A project left
 * unanswered stays untrusted — it is safer to default to silently off than to silently on.
 *
 * The wording states exactly what happens: trusting it lets this project's apps run and its
 * settings apply. Trust follows the project, with no switch per app (owner, 2026-10-18, #1141), so the card lists what
 * that trust covers: each app the project holds, its root app and those in `.centralu/apps` alike, with its name, its
 * description and what its manifest declares it may ask for, in plain words. The project's own app (its root) also
 * reaches the orchestrator and the person's other projects once trusted, and the card says so on that app. A long list
 * scrolls inside the card.
 */
export function TrustAsk({ project }: { project: ProjectInfo }) {
  const answer = useStore((s) => s.answerTrustAsk)
  const apps = useProjectApps(project.id)
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
      {apps.length > 0 && (
        <>
          <p className="mt-2 text-xs leading-body text-ink-muted" data-testid={`trust-ask-apps-title-${project.name}`}>
            {apps.length === 1 ? 'Its app:' : `Its ${apps.length} apps:`}
          </p>
          <ul
            className="mt-1 max-h-48 space-y-2 overflow-y-auto pr-1"
            data-testid={`trust-ask-apps-${project.name}`}
            aria-label={`Apps of ${project.name}`}
            tabIndex={0}
          >
            {apps.map((a) => {
              const asks = a.info.uses ? usesLines(a.info.uses) : []
              const description = (a.info.description ?? '').split('\n')[0]!.trim()
              return (
                <li key={a.key} className="text-xs leading-body" data-testid={`trust-ask-app-${a.key}`}>
                  <p className="text-ink">{a.title}</p>
                  {description && <p className="text-ink-muted">{description}</p>}
                  {a.info.root && (
                    <p className="text-ink-muted" data-testid="trust-ask-app-reach">
                      This project is this app: the orchestrator and your other projects can use it.
                    </p>
                  )}
                  {asks.length > 0 ? (
                    <ul className="text-ink-faint" data-testid="trust-ask-app-uses">
                      {asks.map((line) => (
                        <li key={line}>May ask to: {line.charAt(0).toLowerCase() + line.slice(1)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ink-faint" data-testid="trust-ask-app-uses">Asks for nothing beyond its own tools.</p>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
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

import type { ProjectInfo } from '@cc/protocol'
import { useStore } from '../../../store/store.js'
import { TrustCard } from '../../project/TrustCard.jsx'

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
 * The card itself, with the list of the project's apps, is `TrustCard`: the same one every "Trust this project…" opens.
 */
export function TrustAsk({ project }: { project: ProjectInfo }) {
  const answer = useStore((s) => s.answerTrustAsk)
  return (
    <div className="mx-3 mt-2">
      <TrustCard
        project={project}
        onAnswer={(trust) => void answer(trust)}
        ids={{
          card: `trust-ask-${project.name}`,
          yes: `trust-ask-yes-${project.name}`,
          no: `trust-ask-no-${project.name}`,
          title: `trust-ask-apps-title-${project.name}`,
          apps: `trust-ask-apps-${project.name}`,
          app: (key) => `trust-ask-app-${key}`,
        }}
      />
    </div>
  )
}

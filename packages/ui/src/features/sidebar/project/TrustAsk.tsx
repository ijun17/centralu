import type { ProjectInfo } from '@cc/protocol/client'
import { useStore } from '../../../store/store.js'
import { TrustCard } from '../../project/TrustCard.jsx'

/**
 * Trust asked at registration (M4, decision 3) and from "Trust this project…" (#1141), under the project's row, not as
 * a modal: registration can open a new-session dialog at once, and the question outlives it. Unanswered stays untrusted.
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

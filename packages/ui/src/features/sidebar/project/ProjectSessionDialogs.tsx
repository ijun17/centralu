import type { ProjectInfo } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import { handoffBlockedBy, useStore } from '../../../store/store.js'
import { ConfirmHandoff } from '../dialogs/ConfirmHandoff.jsx'
import { ConfirmDelete } from '../dialogs/ConfirmDelete.jsx'

export function ProjectSessionDialogs({
  project,
  sessions,
  confirming,
  setConfirming,
  handingOff,
  setHandingOff,
}: {
  project: ProjectInfo
  sessions: SessionSummary[]
  confirming: string | null
  setConfirming: (id: string | null) => void
  handingOff: string | null
  setHandingOff: (id: string | null) => void
}) {
  const deleteSession = useStore((s) => s.deleteSession)
  const handoffSession = useStore((s) => s.handoffSession)
  return (
    <>
      {confirming && (
        <ConfirmDelete
          sessionId={confirming}
          name={sessions.find((s) => s.id === confirming)?.name ?? 'Session'}
          // This session's own tool, not the project default — this sentence states where the transcript ends up, so it must not be wrong
          tool={sessions.find((s) => s.id === confirming)?.tool ?? project.defaultTool ?? ''}
          onCancel={() => setConfirming(null)}
          onConfirm={(deleteWorktree, deleteExternal) => {
            void deleteSession(confirming, deleteWorktree, deleteExternal)
            setConfirming(null)
          }}
        />
      )}

      {handingOff && (
        <ConfirmHandoff
          name={sessions.find((s) => s.id === handingOff)?.name ?? 'Session'}
          tool={sessions.find((s) => s.id === handingOff)?.tool ?? project.defaultTool ?? ''}
          // Determining a dead session (#78): asking a session that has errored or hit a rate limit
          // to write a handoff note is asking someone who cannot respond for a will — the transcript mode is pre-selected
          dead={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? s.state === 'error' || !!s.limit : false
          })()}
          // Asking the agent is blocked while a card is up — the request would go through as the answer to a question (#174, same determination as the store)
          blocked={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? handoffBlockedBy(s) : null
          })()}
          onCancel={() => setHandingOff(null)}
          onConfirm={(tool, deleteOld, mode) => {
            // The dialog closes and progress is shown inside the session — the handoff request and its text stay in the conversation as is
            void handoffSession(handingOff, { tool, deleteOld, mode })
            setHandingOff(null)
          }}
        />
      )}
    </>
  )
}

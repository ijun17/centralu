import { backgroundCount, isInTurn, type SessionSummary } from '@cc/core'
import { handoffBlockedBy, useStore } from '../../../store/store.js'
import { ConfirmHandoff } from '../dialogs/ConfirmHandoff.jsx'
import { ConfirmDelete } from '../dialogs/ConfirmDelete.jsx'

export function ProjectSessionDialogs({
  defaultTool,
  sessions,
  confirming,
  setConfirming,
  handingOff,
  setHandingOff,
}: {
  /** What a session with no tool of its own is said to use: the project's default, or '' */
  defaultTool: string
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
          // Its own tool, not the project default: the dialog says where the transcript stays
          tool={sessions.find((s) => s.id === confirming)?.tool ?? defaultTool}
          onCancel={() => setConfirming(null)}
          onDone={() => setConfirming(null)}
          onConfirm={(deleteWorktree, deleteExternal) => {
            void deleteSession(confirming, deleteWorktree, deleteExternal)
            setConfirming(null)
          }}
        />
      )}

      {handingOff && (
        <ConfirmHandoff
          name={sessions.find((s) => s.id === handingOff)?.name ?? 'Session'}
          tool={sessions.find((s) => s.id === handingOff)?.tool ?? defaultTool}
          // Errored or rate-limited (#78): the other tool is pre-selected
          dead={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? s.state === 'error' || !!s.limit : false
          })()}
          // While a card is up the request would go in as its answer (#174, the store's own rule)
          blocked={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? handoffBlockedBy(s) : null
          })()}
          working={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? isInTurn(s.state) : false
          })()}
          backgroundTasks={backgroundCount(sessions.find((x) => x.id === handingOff)?.backgroundTasks ?? [])}
          onCancel={() => setHandingOff(null)}
          onConfirm={(tool, deleteOld, mode) => {
            // Progress shows in the session, where the request stays in the conversation
            void handoffSession(handingOff, { tool, deleteOld, mode })
            setHandingOff(null)
          }}
        />
      )}
    </>
  )
}

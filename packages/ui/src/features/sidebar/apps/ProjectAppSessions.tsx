import { useState } from 'react'
import type { SessionSummary } from '@cc/core'
import { treeRows } from '../tree.js'
import { childrenGroupKey } from '../../../store/foldGroups.js'
import { useStore } from '../../../store/store.js'
import { useSelectedSessionId } from '../../../store/selectors.js'
import { SessionListRow } from '../rows/SessionListRow.jsx'
import { ProjectSessionDialogs } from '../project/ProjectSessionDialogs.jsx'

/** A listed project app owns these rows, so they cannot be reordered into the project's session list. */
export function ProjectAppSessions({ sessions, projectId, folded }: { sessions: SessionSummary[]; projectId: string; folded: boolean }) {
  const selected = useSelectedSessionId()
  const defaultTool = useStore((s) => s.projects[projectId]?.defaultTool ?? '')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [handingOff, setHandingOff] = useState<string | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const foldedGroups = useStore((s) => s.prefs.foldedGroups)
  return (
    <>
      {/* The app's group folded away leaves the dialogs of a row that was open (rename, delete) where they are */}
      {(folded ? [] : treeRows(sessions, (id) => foldedGroups.includes(childrenGroupKey(id)))).map((row) => (
        <SessionListRow
          key={row.s.id}
          row={row}
          projectId={projectId}
          inApp
          onReorder={() => {}}
          focusedSessionId={selected}
          renaming={renaming}
          setRenaming={setRenaming}
          sessionMenu={sessionMenu}
          setSessionMenu={setSessionMenu}
          setHandingOff={setHandingOff}
          setConfirming={setConfirming}
        />
      ))}
      <ProjectSessionDialogs
        defaultTool={defaultTool}
        sessions={sessions}
        confirming={confirming}
        setConfirming={setConfirming}
        handingOff={handingOff}
        setHandingOff={setHandingOff}
      />
    </>
  )
}

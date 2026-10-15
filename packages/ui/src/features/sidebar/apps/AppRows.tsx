import { useMemo } from 'react'
import type { SessionSummary } from '@cc/core'
import { appGroupKey } from '../../../store/foldGroups.js'
import { useStore } from '../../../store/store.js'
import type { ExternalCatalogApp } from '../../../store/app-catalog.js'
import { useGroupFold } from '../rows/groupFold.js'
import { AppRow } from './AppRow.jsx'
import { ProjectAppSessions } from './ProjectAppSessions.jsx'
import { UserAppSessions } from './UserAppSessions.jsx'

export function AppRows({ apps, sessionsByApp, testId }: { apps: ExternalCatalogApp[]; sessionsByApp?: Map<string, SessionSummary[]>; testId: string }) {
  if (apps.length === 0) return null
  return (
    <ul data-testid={testId}>
      {apps.map((a) =>
        a.projectId === null ? (
          <UserAppGroup key={a.key} app={a} />
        ) : (
          <ProjectAppGroup key={a.key} app={a} projectId={a.projectId} sessions={sessionsByApp?.get(a.appId) ?? []} />
        ),
      )}
    </ul>
  )
}

/** A project app's row and, folded or not (#666), the sessions it owns */
function ProjectAppGroup({ app, projectId, sessions }: { app: ExternalCatalogApp; projectId: string; sessions: SessionSummary[] }) {
  const [folded, setFolded] = useGroupFold(appGroupKey(app.key))
  return (
    <>
      <AppRow app={app} sessions={sessions} folded={folded} onFold={setFolded} />
      <ProjectAppSessions sessions={sessions} projectId={projectId} folded={folded} />
    </>
  )
}

/** A user-folder app's row and, folded or not (#666), its builder and the agents it started */
function UserAppGroup({ app }: { app: ExternalCatalogApp }) {
  const [folded, setFolded] = useGroupFold(appGroupKey(app.key))
  const all = useStore((s) => s.sessions)
  const machine = app.info.machine ?? null
  // The machine too (#82): two machines' user-folder apps can share an id, and neither has a project to tell them apart
  const own = useMemo(
    () => Object.values(all).filter((s) => !s.projectId && s.appId === app.appId && (s.machine ?? null) === machine),
    [all, app.appId, machine],
  )
  return (
    <>
      <AppRow app={app} sessions={own} folded={folded} onFold={setFolded} />
      {!folded && <UserAppSessions sessions={own} />}
    </>
  )
}

import { useUserApps } from '../../../store/app-catalog.js'
import { NAME_PAD } from '../layout.js'
import { AppRows } from './AppRows.jsx'

/**
 * User-folder apps still listed (#1141). An app is a project now: a folder with `centralu.app.json` at its root stands
 * in the project list with its project, and the host registers each old user-folder app as a project in place. So the
 * "Your apps" section with its New app and Import buttons is gone (that also settles #732's crowded bottom); New app
 * stands beside New folder below the list, and Import is in the New app dialog and the command palette.
 *
 * What can still arrive with no project: a linked machine running a build from before #1141 sends its user-folder apps
 * as it always did, and an app this computer's host could not register stays in its user folder. Those stand here,
 * under a plain title, only while there is one, so none becomes unreachable; with none, nothing is drawn.
 */
export function UserApps() {
  const apps = useUserApps()
  if (apps.length === 0) return null
  return (
    <section className="border-b border-line/70 py-2.5" data-testid="user-apps">
      {/* Its title stands in the column a project's name does (32px), so its apps are one step in from it like a project's rows */}
      <header className={`flex items-center gap-2 ${NAME_PAD} pr-3`}>
        <span className="text-md font-medium tracking-tight text-ink">Other apps</span>
      </header>
      <div className="mt-1.5">
        <AppRows apps={apps} testId="user-apps-list" />
      </div>
    </section>
  )
}

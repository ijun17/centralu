import { useUserApps } from '../../../store/app-catalog.js'
import { NAME_PAD } from '../layout.js'
import { AppRows } from './AppRows.jsx'

/**
 * Apps with no project (#1141): those a linked machine on a build before #1141 sends, and those this host could not
 * register as projects. Listed under a plain title only while there is one, so none becomes unreachable.
 */
export function UserApps() {
  const apps = useUserApps()
  if (apps.length === 0) return null
  return (
    <section className="border-b border-line py-2.5" data-testid="user-apps">
      {/* The title stands in a project name's column, so its apps sit one step in like a project's rows */}
      <header className={`flex items-center gap-2 ${NAME_PAD} pr-3`}>
        <span className="text-md font-medium tracking-tight text-ink">Other apps</span>
      </header>
      <div className="mt-1.5">
        <AppRows apps={apps} testId="user-apps-list" />
      </div>
    </section>
  )
}

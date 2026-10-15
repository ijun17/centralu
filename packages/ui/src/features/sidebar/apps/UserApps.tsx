import { useState } from 'react'
import { useStore } from '../../../store/store.js'
import { NewAppDialog } from '../../project/NewAppDialog.jsx'
import { IconButton } from '../../../components/IconButton.jsx'
import { ImportIcon, PlusIcon } from '../../../components/icons.jsx'
import { useUserApps } from '../../../store/app-catalog.js'
import { NAME_PAD } from '../layout.js'
import { AppRows } from './AppRows.jsx'

/**
 * Apps in the user's folder (M4 B-2, decision 1) — used across several projects, so they do not
 * stand under any one project and get their own group instead. A header with the same shape as a
 * project block.
 *
 * **The group exists even with no apps in it (M4 C-1).** It used to be that no apps meant no group,
 * but then there was no place to create the first user-folder app — because "New app" lives on
 * this header. When empty, it is a single header line with the text pulled back (background-
 * information brightness). The button stays visible: in an empty group it is the one thing there
 * is to press, and hiding it on hover would leave no clue why the group exists at all.
 */
export function UserApps() {
  const apps = useUserApps()
  const [newAppOpen, setNewAppOpen] = useState(false)
  // Import (M4 E-3) — there is one dialog for the whole app (a deep link opens the same dialog too), so the store opens it
  const openImport = useStore((s) => s.openImport)
  return (
    <section className="border-b border-line/70 py-2.5" data-testid="user-apps">
      {/* Its title stands in the column a project's name does (32px), so its apps are one step in from it like a project's rows */}
      <header className={`flex items-center gap-2 ${NAME_PAD} pr-3`}>
        <span className={`text-md font-medium tracking-tight ${apps.length ? 'text-ink' : 'text-ink-faint'}`}>Your apps</span>
        <span className="-my-1 flex items-center ml-auto shrink-0">
          <IconButton label="Import an app from a folder, a .zip, or a link" onClick={() => openImport()} testId="user-apps-import" align="right">
            <ImportIcon size={13} />
          </IconButton>
        </span>
        <span className="-my-1 flex items-center shrink-0">
          <IconButton label="New app for every project" onClick={() => setNewAppOpen(true)} testId="user-apps-new" align="right">
            <PlusIcon size={13} />
          </IconButton>
        </span>
      </header>
      {apps.length > 0 && (
        <div className="mt-1.5">
          <AppRows apps={apps} testId="user-apps-list" />
        </div>
      )}
      {newAppOpen && <NewAppDialog projectId={null} onClose={() => setNewAppOpen(false)} />}
    </section>
  )
}

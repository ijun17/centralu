import { useRef, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useTextZoom } from '../../store/store.js'
import { CreateProjectDialog } from '../project/CreateProjectDialog.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { PlusIcon } from '../../components/icons.jsx'
import { AddRemoteProjectDialog } from '../machines/AddRemoteProjectDialog.jsx'
import { SIDEBAR_VARS } from './layout.js'
import { OrchestratorButton } from './OrchestratorButton.jsx'
import { GridButton } from './GridButton.jsx'
import { ProjectBlock } from './project/ProjectBlock.jsx'
import { UserApps } from './apps/UserApps.jsx'
import { AddProjectMachines } from './menus/AddProjectMachines.jsx'

/** The observation lane — high density, using as little space as possible (docs/architecture.md design principle 1) */
export function Sidebar() {
  /*
   * One list whatever machine a project is on (#734), in the hub's order, which the person sets by dragging across
   * machines; a linked machine's project carries its machine's badge instead of standing under a machine header.
   */
  const projectIds = useStore((s) => Object.keys(s.projects).join(','))
  const ids = projectIds ? projectIds.split(',') : []
  const machineIds = useStore((s) => Object.keys(s.machines).join(','))
  const machines = machineIds ? machineIds.split(',') : []
  const [addingOn, setAddingOn] = useState<string | null>(null)
  /** The Add project button's machine choice (#734), open once a machine is linked */
  const [choosing, setChoosing] = useState(false)
  const addAnchor = useRef<HTMLButtonElement>(null)
  const width = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  // The minimum width is fixed in real pixels — the limit on how narrow the list can get stays the
  // same even when text is zoomed in
  const zoom = useTextZoom()
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const setToast = useStore((s) => s.setToast)
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const pickHere = async () => {
    setAdding(true)
    try {
      const picked = await platform.system.pickDirectory()
      if (picked) await addProject(picked)
    } catch (e) {
      setToast((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-side"
      style={{ width, ...SIDEBAR_VARS }}
      data-testid="sidebar"
    >
      <ResizeHandle
        side="right"
        min={SIDEBAR_MIN / zoom}
        max={SIDEBAR_MAX}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        testId="sidebar-resize"
      />
      <OrchestratorButton />
      <GridButton />
      {ids.length === 0 ? (
        <p className="px-4 py-6 text-sm leading-body text-ink-faint">
          No projects yet.
          <br />
          Start with <span className="text-ink-muted">Add project</span> below.
        </p>
      ) : (
        ids.map((id) => <ProjectBlock key={id} projectId={id} />)
      )}
      <UserApps />
      {/*
        **Where the person presses and where the result appears must be the same place** (issue
        #4). It used to live at the far right of the top bar — the person pressed one side of the
        screen and had to go find the result in the sidebar on the other side. A new project is
        appended to the **end** of the list, so the button lives at the end of the list too: the
        result grows right below where it was pressed.

        It is not lit up the way the orchestrator and the grid button are. Those two are doors
        used constantly, while this is something done rarely, so it has to stay unobtrusive while
        the list is being read.
      */}
      {/*
        Two ways in, side by side (#515): an existing folder through the picker, or a new empty one made in
        ~/Centralu (the dialog says where). The orchestrator's create_project makes the same folder behind a card.
      */}
      <div className="flex gap-1.5 px-2 py-2">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-sm text-ink-faint transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40"
          /*
           * **There should be exactly one way to pick a folder in this app.**
           *
           * This used to open a window where the person typed an absolute path by hand — a
           * fallback left over from the web-development days that carried straight over into
           * Tauri. The first-run screen was already using the native picker, so the same task had
           * two ways to do it, and **the more frequently used one had the worse method** (open
           * Finder, copy the path, come back and paste it). The dialog is gone entirely, and the
           * button itself is now the picker.
           */
          /*
           * Once a machine is linked, it first asks where (#734): this computer, the picker as before, or a linked
           * machine, whose folder is typed (the picker cannot see that machine's disk). The machine headers that each
           * had their own + are gone; with no machine linked there is nothing to choose and it is the picker at once.
           */
          ref={addAnchor}
          onClick={() => {
            if (machines.length > 0) setChoosing((v) => !v)
            else void pickHere()
          }}
          disabled={adding}
          data-testid="add-project"
          aria-haspopup={machines.length > 0 ? 'menu' : undefined}
          title="Add an existing folder as a project"
        >
          <PlusIcon size={13} />
          <span className="truncate">Add project</span>
        </button>
        <button
          className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink-faint transition-colors hover:border-line-strong hover:text-ink"
          onClick={() => setCreating(true)}
          data-testid="create-project"
          title="Create a new, empty folder as a project, in the Centralu folder of your home unless you choose another"
        >
          New folder
        </button>
      </div>
      {choosing && (
        <AddProjectMachines
          machines={machines}
          anchorEl={addAnchor.current}
          onClose={() => setChoosing(false)}
          onPick={(machine) => {
            setChoosing(false)
            if (machine) setAddingOn(machine)
            else void pickHere()
          }}
        />
      )}
      {addingOn && <AddRemoteProjectDialog machine={addingOn} onClose={() => setAddingOn(null)} />}
      {creating && <CreateProjectDialog onClose={() => setCreating(false)} />}
    </aside>
  )
}

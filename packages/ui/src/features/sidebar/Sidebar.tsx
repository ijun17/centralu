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
  // Whether the host's first lists have arrived since this window opened; a later reconnect keeps what is shown
  const connected = useStore((s) => s.connection === 'connected')
  const everListed = useRef(false)
  if (connected) everListed.current = true
  const listed = everListed.current
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
    /*
      **Only the project list scrolls** (#988). The whole sidebar used to be the scroller, and the resize handle, an
      absolutely placed child of it, scrolled up with the rows: past the first screen there was no edge left to drag.
      Now the aside never scrolls; the top doors and the bottom area stand still, and the handle is the scroller's
      sibling, spanning the aside's full height, so a scroll never moves it and the list's scrollbar never covers it.
    */
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-surface-side"
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
      <div className="shrink-0">
        <OrchestratorButton />
        <GridButton />
      </div>
      {/*
        The list keeps room for about two rows however short the window (#988 follow-up): in a 150px window the fixed
        top and bottom left it none, and a project's row could not be reached at all. The bottom area gives way first.
      */}
      <div className="min-h-[4.5rem] flex-1 overflow-y-auto" data-testid="sidebar-projects">
        {/*
          Until the host's first lists arrive the list is not known to be empty (owner, 2026-10-18: "No projects yet"
          flashed on a slow start). The shape of two projects stands there instead, and the real list fades in.
        */}
        {ids.length === 0 && !listed ? (
          <SidebarSkeleton />
        ) : ids.length === 0 ? (
          <p className="cc-fade px-4 py-6 text-sm leading-body text-ink-faint">
            No projects yet.
            <br />
            Start with <span className="text-ink-muted">Add project</span> below.
          </p>
        ) : (
          <div className="cc-fade">
            {ids.map((id) => (
              <ProjectBlock key={id} projectId={id} />
            ))}
          </div>
        )}
      </div>
      {/*
        The bottom area stands still under the list (#988). Capped, so many apps cannot push the list off the screen:
        past the cap it scrolls on its own, and in a window too short for both it shrinks before the list does. How this
        area is laid out is #732's to decide.
      */}
      <div
        className="max-h-[45%] min-h-0 shrink overflow-y-auto border-t border-line/70"
        data-testid="sidebar-bottom"
      >
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
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left text-sm text-ink-faint transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
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

/** Two projects' shape while the first lists are read: a name line over two session rows each */
function SidebarSkeleton() {
  return (
    <div
      className="cc-skeleton flex flex-col"
      role="status"
      aria-label="Loading projects"
      data-testid="sidebar-skeleton"
    >
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2.5 border-b border-line/70 px-4 py-3.5">
          <div className="h-3 w-1/3 animate-pulse rounded-md bg-surface-hover/50" />
          {[0, 1].map((r) => (
            <div key={r} className="flex items-center gap-2 pl-6">
              <div className="size-[17px] shrink-0 animate-pulse rounded-md bg-surface-hover/50" />
              <div
                className="h-2.5 animate-pulse rounded-md bg-surface-hover/50"
                style={{ width: r === 0 ? '58%' : '44%' }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

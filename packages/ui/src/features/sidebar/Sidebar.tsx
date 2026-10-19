import { useRef, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useTextZoom } from '../../store/store.js'
import { CreateProjectDialog } from '../project/CreateProjectDialog.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { AppIcon, FolderIcon, FolderPlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { NewAppDialog } from '../project/NewAppDialog.jsx'
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
  const listed = useStore((s) => s.workspaceReady)
  const machineIds = useStore((s) => Object.keys(s.machines).join(','))
  const machines = machineIds ? machineIds.split(',') : []
  const [addingOn, setAddingOn] = useState<string | null>(null)
  /** The Add project button's machine choice (#734), open once a machine is linked */
  const [choosing, setChoosing] = useState(false)
  const addAnchor = useRef<HTMLSpanElement>(null)
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
  const [creatingApp, setCreatingApp] = useState(false)
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
      {/*
        The three ways a project comes to be stand over the list as icons (owner, 2026-10-19), beside its name, instead
        of a row of framed buttons under it: the list starts where its own controls are, and the bottom keeps only the
        user-folder apps still listed. The row stands still; only the list under it scrolls. A wider gap above it sets it
        off from the doors, and a divider under it, the same hairline as between projects, sets it over the list (owner,
        2026-10-19).
      */}
      <div className="mt-4 flex shrink-0 items-center gap-0.5 border-b border-line/70 pb-1.5 pl-4 pr-2" data-testid="sidebar-projects-head">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-faint">Projects</span>
        <span ref={addAnchor} className="flex">
          <IconButton
            /*
             * **There should be exactly one way to pick a folder in this app**: this button is the picker itself (the
             * typed-path dialog is long gone). Once a machine is linked it first asks where (#734): this computer, the
             * picker, or a linked machine, whose folder is typed (the picker cannot see that machine's disk).
             */
            label="Add a folder as a project"
            onClick={() => {
              if (machines.length > 0) setChoosing((v) => !v)
              else void pickHere()
            }}
            disabled={adding}
            testId="add-project"
            align="right"
          >
            <FolderIcon size={14} />
          </IconButton>
        </span>
        <IconButton
          label="New folder as a project"
          onClick={() => setCreating(true)}
          testId="create-project"
          align="right"
        >
          <FolderPlusIcon size={14} />
        </IconButton>
        {/* An app is made like a project (#1141): a new folder that joins this list as a project whose root is the app */}
        <IconButton label="New app" onClick={() => setCreatingApp(true)} testId="create-app" align="right">
          <AppIcon size={14} />
        </IconButton>
      </div>
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
            Start with the buttons beside <span className="text-ink-muted">Projects</span> above: an existing folder, a new
            folder, or a new app.
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
        The bottom area stands still under the list (#988). Capped, so a long leftover list cannot push the list off the
        screen: past the cap it scrolls on its own, and in a window too short for both it shrinks before the list does.
        Since #1141 it holds the three ways a project comes to be, and only above them the user-folder apps still listed
        (none on this computer once its host has moved them into projects).
      */}
      <div
        className="max-h-[45%] min-h-0 shrink overflow-y-auto border-t border-line/70 empty:hidden"
        data-testid="sidebar-bottom"
      >
        <UserApps />
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
      {creatingApp && <NewAppDialog projectId={null} onClose={() => setCreatingApp(false)} />}
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

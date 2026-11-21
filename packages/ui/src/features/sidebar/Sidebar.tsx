import { errorMessage } from '@cc/protocol/client'
import { useRef, useState } from 'react'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, sidebarFloor, useTextZoom } from '../../store/store.js'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { AppPlusIcon, FolderPlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { NewAppDialog } from '../project/NewAppDialog.jsx'
import { AddRemoteProjectDialog } from '../machines/AddRemoteProjectDialog.jsx'
import { SIDEBAR_VARS } from './layout.js'
import { AssistantButton } from './AssistantButton.jsx'
import { GridButton } from './GridButton.jsx'
import { SearchField } from '../palette/SearchField.jsx'
import { OverlayScrollbar } from '../../components/OverlayScrollbar.jsx'
import { ProjectBlock } from './project/ProjectBlock.jsx'
import { UserApps } from './apps/UserApps.jsx'
import { AddProjectMachines } from './menus/AddProjectMachines.jsx'

/** The observation lane — high density, using as little space as possible (docs/architecture.md design principle 1) */
export function Sidebar() {
  // One list across machines (#734), in the hub's order; a linked machine's project carries its machine's badge
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
  const listRef = useRef<HTMLDivElement>(null)
  const width = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  // The minimum width is in real pixels, whatever the text zoom
  const zoom = useTextZoom()
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const setToast = useStore((s) => s.setToast)
  const [adding, setAdding] = useState(false)
  const [creatingApp, setCreatingApp] = useState(false)
  const pickHere = async () => {
    setAdding(true)
    try {
      const picked = await platform.system.pickDirectory()
      if (picked) await addProject(picked)
    } catch (e) {
      setToast(errorMessage(e))
    } finally {
      setAdding(false)
    }
  }

  return (
    // Only the project list scrolls (#988): the resize handle, an absolute child, would scroll away with the rows
    <aside
      className="relative flex h-full shrink flex-col overflow-hidden border-r border-line bg-surface-side"
      style={{ width, minWidth: sidebarFloor(zoom), ...SIDEBAR_VARS }}
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
        {/* The palette hangs from wherever this field is measured to be (SearchField) */}
        <div className="px-2 pt-2">
          <SearchField />
        </div>
        <AssistantButton />
        <GridButton />
      </div>
      {/*
        The list keeps room for about two rows however short the window (#988); the bottom area gives way first
      */}
      {/*
        The ways a project comes to be, as icons over the list: an existing folder or a new app. No "New folder as a
        project": the file manager or an agent makes the folder, then it is added.
      */}
      <div className="mt-4 flex shrink-0 items-center gap-0.5 border-b border-line pb-1.5 pl-4 pr-2" data-testid="sidebar-projects-head">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-faint">Projects</span>
        <span ref={addAnchor} className="flex">
          <IconButton
            /*
             * The app's one folder picker. With a machine linked it first asks where (#734); a linked machine's folder is
             * typed, as the picker cannot see its disk.
             */
            label="Add a folder as a project"
            onClick={() => {
              if (machines.length > 0) setChoosing((v) => !v)
              else void pickHere()
            }}
            disabled={adding}
            haspopup={machines.length > 0 ? 'menu' : undefined}
            testId="add-project"
            align="right"
          >
            <FolderPlusIcon size={14} />
          </IconButton>
        </span>
        {/* An app is made like a project (#1141): a new folder that joins this list as a project whose root is the app */}
        <IconButton label="New app" onClick={() => setCreatingApp(true)} testId="create-app" align="right">
          <AppPlusIcon size={14} />
        </IconButton>
      </div>
      {/*
        The bar is drawn over the list (OverlayScrollbar): a native one would shift every row as the list outgrows the
        window. The thumb stands 4px in, clear of the resize handle (w-1) on the same edge.
      */}
      <div className="relative flex min-h-[4.5rem] flex-1 flex-col">
        <div ref={listRef} className="cc-scroll-overlay min-h-0 flex-1 overflow-y-auto" data-testid="sidebar-projects">
          {/*
            Until the first lists arrive the list is not known to be empty, so a skeleton, not "No projects yet"
          */}
          {ids.length === 0 && !listed ? (
            <SidebarSkeleton />
          ) : ids.length === 0 ? (
            <p className="cc-fade px-4 py-6 text-sm leading-body text-ink-faint">
              No projects yet.
              <br />
              Start with the buttons beside <span className="text-ink-muted">Projects</span> above: an existing folder or a
              new app.
            </p>
          ) : (
            <div className="cc-fade">
              {ids.map((id) => (
                <ProjectBlock key={id} projectId={id} />
              ))}
            </div>
          )}
        </div>
        <div className="absolute inset-y-0 right-1 w-0">
          <OverlayScrollbar scrollRef={listRef} testId="sidebar-scrollbar" />
        </div>
      </div>
      {/*
        The user-folder apps still listed (#1141), capped so they cannot push the list off screen
      */}
      <div
        className="max-h-[45%] min-h-0 shrink overflow-y-auto border-t border-line empty:hidden"
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
        <div key={i} className="flex flex-col gap-2.5 border-b border-line px-4 py-3.5">
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

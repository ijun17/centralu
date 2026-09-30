import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectInfo, SessionState, ToolName } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { handoffBlockedBy, useStore } from '../../store/store.js'
import { NewSessionDialog } from '../project/NewSessionDialog.jsx'
import { NewAppDialog } from '../project/NewAppDialog.jsx'
import { APPS } from '../../apps/registry.js'
import { WorktreeManagerDialog } from '../project/WorktreeManagerDialog.jsx'
import { DeleteProjectDialog } from '../project/DeleteProjectDialog.jsx'
import {
  useIsProjectOpen,
  useIsProjectSelected,
  useSelectedSessionId,
  useSessionsOf,
  useToolMeta,
  useTools,
} from '../../store/selectors.js'
import { Tooltip, stateLabel } from '../../components/primitives.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { AppIcon, ChevronIcon, CrownIcon, DotsIcon, ImportIcon, PlusIcon } from '../../components/icons.jsx'
import { useProjectApps, useUserApps, type ExternalCatalogApp } from '../../store/app-catalog.js'
import type { ExternalAppStatus } from '@cc/protocol'
import { Modal } from '../../components/Modal.jsx'
import { useOrbitSync } from '../../components/orbit.js'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useTextZoom } from '../../store/store.js'
import { APP_MIME, PROJECT_MIME, SESSION_MIME, dropsBefore, moveTo, projectItemMime } from './reorder.js'
import { foldSummary, type FoldSummaryState } from './fold.js'

/**
 * Drag-to-reorder.
 *
 * **The kind of thing being dragged is stated as a MIME type.** That is what makes dropping a
 * session onto a project's spot do nothing — without checking the kind, the wrong list gets
 * reordered.
 *
 * The drop spot is shown as a line. Without the line there is no way to know where it will land
 * until the hand lifts, so the person drops it, sees it is wrong, and undoes it, over and over.
 */
function useDropLine(mime: string, onDrop: (draggedId: string, before: boolean) => void) {
  const [edge, setEdge] = useState<'top' | 'bottom' | null>(null)

  return {
    edge,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(mime)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        setEdge(dropsBefore(r, e.clientY) ? 'top' : 'bottom')
      },
      onDragLeave: () => setEdge(null),
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData(mime)
        setEdge(null)
        if (!id) return
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onDrop(id, dropsBefore(r, e.clientY))
      },
    },
  }
}

/**
 * One session row. It can be dragged, and can receive another row being dropped on it.
 *
 * Each row has to hold its own drop state so the line is drawn **only on that row** — combining
 * them into one would mean recomputing which row it is over on every event.
 */
function SessionRow({
  id,
  projectId,
  onReorder,
  draggable,
  nested,
  children,
}: {
  id: string
  /** Carried in the drag, so the project screen can tell its own sessions from another project's (reorder.ts) */
  projectId: string
  onReorder: (draggedId: string, before: boolean) => void
  /**
   * Not draggable while the name is being edited. An input inside a draggable ancestor gets a
   * text-selection drag from the browser interpreted as **dragging the element** instead, so
   * rubbing across it to fix the name drags the whole row along with it.
   */
  draggable: boolean
  /**
   * Is this a worktree session, drawn indented under its manager (#69)? Indentation plus a
   * vertical guide line — hierarchy lives only in the sidebar (the grid is flat, a design
   * decision).
   */
  nested?: boolean
  children: ReactNode
}) {
  const drop = useDropLine(SESSION_MIME, onReorder)
  return (
    <li
      data-nested={nested || undefined}
      className={`group/row relative ${nested ? 'ml-4 border-l border-edge/60' : ''} ${dropLine(drop.edge)}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_MIME, id)
        e.dataTransfer.setData(projectItemMime(projectId), projectId)
        e.dataTransfer.effectAllowed = 'move'
      }}
      {...drop.handlers}
    >
      {children}
    </li>
  )
}

/**
 * The drop-spot indicator — a single thin line is enough.
 *
 * **Must not be drawn with a border.** A border grows an element by 1px, so every time the
 * indicator moves to a different row the whole list shifts by that amount — while dragging, it
 * reads as a constant little jump (a dogfooding finding). Worse, the spot the hand is aiming for
 * keeps moving, which makes dropping harder too.
 *
 * **The line sits on the boundary between rows, not inside a row** (dogfooding, 2026-09-10:
 * "it is the same spot, but the line nudges up and down slightly"). One boundary is shared by two
 * rows — it is the "bottom" for the row above and the "top" for the row below. An inset shadow
 * draws that on **each row's own inside edge**, so the two indicators pointing at the same
 * boundary ended up 2-3px apart. That is why the line appeared to jump by that amount every time
 * the hand crossed the boundary.
 *
 * Placing an absolutely positioned pseudo-element (`after`) right on the boundary (-1px) instead
 * makes the two rows' indicators land on **the same pixel**. It keeps the property of not
 * affecting box size — `absolute` does not claim space in the layout.
 */
const DROP_LINE = 'after:pointer-events-none after:absolute after:inset-x-0 after:z-10 after:h-0.5 after:bg-ash after:content-[""]'

function dropLine(edge: 'top' | 'bottom' | null): string {
  if (!edge) return ''
  return `${DROP_LINE} ${edge === 'top' ? 'after:-top-px' : 'after:-bottom-px'}`
}

/** The observation lane — high density, using as little space as possible (docs/architecture.md design principle 1) */
export function Sidebar() {
  const projectIds = useStore((s) => Object.keys(s.projects).join(','))
  const ids = projectIds ? projectIds.split(',') : []
  const width = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  // The minimum width is fixed in real pixels — the limit on how narrow the list can get stays the
  // same even when text is zoomed in
  const zoom = useTextZoom()
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const setToast = useStore((s) => s.setToast)
  const [adding, setAdding] = useState(false)
  // Is the orchestrator currently pointing at this button (#63)?
  const hint = useStore((s) => s.addProjectHint)

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-y-auto border-r border-edge bg-pit"
      style={{ width }}
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
        <p className="px-4 py-6 text-xs leading-relaxed text-slate">
          No projects yet.
          <br />
          Start with <span className="text-ash">Add project</span> below.
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
      <div className="px-2 py-2">
        <button
          /*
           * Lights up when the orchestrator is pointing here (#63).
           *
           * Instead of putting a second folder picker inside the conversation, **this one button
           * lights up** — the app should have one door for this, and drawing a second door
           * teaches the person that "projects are something you ask the orchestrator to do." No
           * chromatic color is used (the palette rule): this button, normally muted, becoming
           * chalk is by itself enough to make it the brightest thing on screen, and that
           * brightness itself means "here."
           */
          className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-40 ${
            hint
              ? 'breathe border-ash text-chalk'
              : 'border-edge text-slate hover:border-graphite hover:text-chalk'
          }`}
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
          onClick={async () => {
            setAdding(true)
            try {
              const picked = await platform.system.pickDirectory()
              if (picked) await addProject(picked)
            } catch (e) {
              setToast((e as Error).message)
            } finally {
              setAdding(false)
            }
          }}
          disabled={adding}
          data-testid="add-project"
          data-hint={hint || undefined}
          title="Register a directory for agents to run in"
        >
          <PlusIcon size={13} />
          <span className="truncate">Add project</span>
        </button>
      </div>
    </aside>
  )
}

/**
 * The door to the orchestrator — **directing by talking**.
 *
 * Placed directly above the grid. The two are two ways of looking at the same thing, so they
 * should stand side by side:
 *   orchestrator  direct sessions by talking, in one window
 *   grid          watch several windows at a glance
 *
 * Not nested under a project. This session does not belong to any project — crossing multiple
 * projects is the whole reason it exists.
 *
 * **The button spells out that it is still experimental** (issue #1). It looks identical to the
 * grid button, and people pressed it without knowing the difference. Putting the label **inside**
 * the orchestrator screen would be too late — the person has already pressed it by then, and the
 * harm being prevented is exactly "pressing it without knowing."
 *
 * Follows the palette rule (styles/index.css) as is: **urgency is brightness, kind is shape.**
 * The text is slate (the color reserved for background information). Making it brighter would be
 * a lie that it is more urgent than the grid button — "experimental" is not urgent, it is
 * **something the person should press knowingly.**
 *
 * The border used to be dashed. The reasoning was "when the sidebar narrows, the text gets
 * clipped away and only the shape is left," but **measuring it showed that was not true.** The
 * 'Experimental' badge is `shrink-0`, so it stands at its full 63px even at the narrowest width
 * (180px, with the button at 163px) — what gets clipped instead is the name. Since there was
 * nothing the dashed border was protecting, there was no reason for it to stay either.
 */
function OrchestratorButton() {
  const view = useStore((s) => s.view)
  const open = useStore((s) => s.openOrchestrator)
  const id = useStore((s) => s.orchestratorId)
  const active = view === 'orchestrator'

  return (
    <div className="px-2 pt-2">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
          active
            ? 'border-slate/50 bg-graphite text-chalk'
            : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
        }`}
        // The same rule as the grid: a selection, not a toggle. To leave, choose something else
        onClick={() => void open()}
        /*
          The orchestrator is a session too. Before the first conversation, no session exists yet,
          so it is not made draggable — that keeps the #63 rule that opening a screen alone never
          creates a process. Once a conversation exists, it can be dragged into the grid like any
          other session row. The side that receives an ID into GridView was already shared code;
          this was the only entry point still missing from it.
        */
        draggable={!!id}
        onDragStart={(e) => {
          if (!id) return
          e.dataTransfer.setData(SESSION_MIME, id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        aria-pressed={active}
        data-testid="orchestrator-button"
        title={
          id
            ? 'Evolving — one conversation that directs your sessions. Drag it to Grid to watch it beside other sessions.'
            : 'Evolving — one conversation that directs your sessions, and it keeps gaining new abilities. Expect it to change.'
        }
      >
        <CrownIcon />
        <span className="truncate font-medium tracking-tight">Orchestrator</span>
        <span className="shrink-0 text-[10px] text-slate" data-testid="orchestrator-experimental">
          Evolving
        </span>
      </button>
      <HomelessSessions />
    </div>
  )
}

/**
 * Homeless sessions (user request, 2026-09-09) — **the spot the sidebar catches them in**.
 *
 * This settled on one rule: **the app that gave a session its meaning is that session's home, and
 * when there is no home, the sidebar catches it.** That is why the foreman session no longer
 * stands here while the control app is enabled — the work-item row now is the foreman, so the same
 * thing no longer stands as two rows with different names the way it used to.
 *
 * The only sessions that land here are ones that lost somewhere to go: the app was disabled
 * (toggled off), the app disappeared from the registry, or an old row that no app ever claimed as
 * its own. The rule that **a session must still be reachable even after its app is disabled** is
 * kept by this list existing — otherwise a single toggle would erase a session from the screen.
 *
 * Sessions that belong to a project live under that project, so they do not come here.
 */
function HomelessSessions() {
  const sessions = useStore((s) => s.sessions)
  const apps = useStore((s) => s.apps)
  const focused = useStore((s) => s.focusedSessionId)
  const focusSession = useStore((s) => s.focusSession)
  const homeless = Object.values(sessions).filter((s) => {
    if (s.projectId || s.kind === 'orchestrator') return false
    if (!s.appId) return true // no app claims ownership
    if (!APPS.some((a) => a.id === s.appId)) return true // app has disappeared from the registry
    return apps[s.appId]?.enabled === false // app is disabled
  })
  if (homeless.length === 0) return null
  return (
    <div className="mt-1 space-y-0.5" data-testid="homeless-sessions">
      <p className="px-2.5 text-[10px] uppercase text-slate">No app</p>
      {homeless.map((s) => (
        <button
          key={s.id}
          className={`flex w-full items-center gap-2 rounded border-l-2 py-1 pl-2.5 pr-2 text-left text-[12px] transition-colors ${
            focused === s.id
              ? 'border-l-ash bg-graphite/40 text-chalk'
              : 'border-l-transparent text-ash hover:bg-graphite/20 hover:text-chalk'
          }`}
          onClick={() => focusSession(s.id)}
          data-testid={`homeless-row-${s.id}`}
        >
          <ToolMark tool={s.tool} state={s.state} />
          <span className="truncate">{s.name}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * The door to the grid.
 *
 * **It has to look different from a project.** If it had the same shape as the other rows in the
 * list, it would read as "one more project," but this is not a project, it is **a way of
 * watching**. Wrapping it in a rounded box sets it apart from the list — the shape says it is a
 * different kind of thing before the text does.
 *
 * Dropping a session here switches into the grid and adds that session to it. If the person had to
 * open the screen first and then drag it in separately, that would be doing the work twice, so
 * dropping it here handles both steps at once.
 *
 * **The Experimental badge is gone** (2026-08-27, by the user's call). It went up when the
 * grid shipped looking finished while the spec still listed it under non-goals (issue #25) —
 * the mark existed to warn about the hour you might lose inside an unproven view. Weeks of
 * dogfooding later the grid is simply how sessions get watched side by side, and a warning
 * that no longer warns anyone is clutter on the one lane that is always on screen.
 * The orchestrator's badge stays — that surface still is what its mark says it is.
 */
function GridButton() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const panels = useStore((s) => s.gridPanels)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const [over, setOver] = useState(false)
  const active = view === 'grid'

  return (
    <div className="px-2 pb-1 pt-1.5">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
          active
            ? 'border-slate/50 bg-graphite text-chalk'
            : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
        } ${over ? 'shadow-[inset_0_0_0_2px_var(--color-ash)]' : ''}`}
        /*
          A **selection**, not a toggle.
          Making it an on/off switch reads as "a layer briefly covering the previous screen" — it
          actually was misread that way. It follows the same rule as the other rows in the
          sidebar: pressing it shows this, and leaving it means choosing something else.
        */
        onClick={() => setView('grid')}
        aria-pressed={active}
        data-testid="grid-button"
        title="See sessions side by side."
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SESSION_MIME)) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(SESSION_MIME)
          setOver(false)
          if (!id) return
          e.preventDefault()
          if (!panels.includes(id)) void setGridPanels([...panels, id])
          setView('grid')
        }}
      >
        <GridIcon />
        <span className="truncate font-medium tracking-tight">Grid</span>
        {panels.length > 0 && <span className="readout ml-auto text-[10px] text-slate">{panels.length}</span>}
      </button>
    </div>
  )
}

/** A split screen — a symbol drawn to depict exactly what the grid does */
function GridIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * Lays out the session list in tree order (#69): a manager immediately followed by its worktree
 * children.
 *
 * Hierarchy lives only in the sidebar — the grid, the inbox and the palette all stay flat lists
 * (design decision: "The hierarchy lives in the sidebar; the grid stays a flat set of panels").
 *
 * If the parent is not in this list (archived, etc.), the child is drawn at the top level —
 * indentation is only a sign of a relationship, and drawing it indented while the parent is
 * invisible would make it look like it is hanging under nothing.
 */
function orderAsTree(
  sessions: SessionSummary[],
): { s: SessionSummary; nested: boolean; managerOfLive: number }[] {
  const here = new Set(sessions.map((x) => x.id))
  const kids = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const s of sessions) {
    if (s.parentSessionId && here.has(s.parentSessionId)) {
      kids.set(s.parentSessionId, [...(kids.get(s.parentSessionId) ?? []), s])
    } else {
      roots.push(s)
    }
  }
  return roots.flatMap((root) => {
    const children = kids.get(root.id) ?? []
    return [
      { s: root, nested: false, managerOfLive: children.length },
      ...children.map((c) => ({ s: c, nested: true, managerOfLive: 0 })),
    ]
  })
}

function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const focusedSessionId = useSelectedSessionId()
  const focusSession = useStore((s) => s.focusSession)
  const sessions = useSessionsOf(projectId)
  // Whether the dialog is open is held by the store — the first-run screen also needs to open this dialog
  const newSessionOpen = useStore((s) => s.newSessionFor === projectId)
  const openNewSession = useStore((s) => s.openNewSession)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The session whose handoff confirmation dialog is open (null when none is) */
  const [handingOff, setHandingOff] = useState<string | null>(null)
  /** The open session menu — since there are many rows, the anchor is the pressed button element, not a ref */
  const [sessionMenu, setSessionMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  /** The session whose name is currently being edited. Only one at a time — with two rows as inputs
   * simultaneously there is no way to tell which one is active */
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameSession = useStore((s) => s.rename)
  const deleteSession = useStore((s) => s.deleteSession)
  const handoffSession = useStore((s) => s.handoffSession)
  const focusProject = useStore((s) => s.focusProject)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const reorderSessions = useStore((s) => s.reorderSessions)
  const selected = useIsProjectSelected(projectId)
  // Its screen or one of its sessions is on screen — the whole group is tinted (see the section below)
  const open = useIsProjectOpen(projectId)
  // Does the manager's worktree proposal point at this project (#69)? The + button lights up
  const proposalHere = useStore((s) => s.worktreeProposals.some((p) => p.projectId === projectId))
  const [managerDialog, setManagerDialog] = useState(false)
  // New app dialog (M4 C-1) — opened from the project row's menu, like the new session dialog
  const [newAppOpen, setNewAppOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Is trust being asked about right after registration (M4, decision 3)? Asked only once, then dismissed once answered
  const askingTrust = useStore((s) => s.trustAsk === projectId)
  // This project's apps (M4 B-2) — stand below the sessions, in the same row shape
  const projectApps = useProjectApps(projectId)
  const setProjectTrusted = useStore((s) => s.setProjectTrusted)
  /** Where the menu hangs from — the pressed button (not a corner of the sidebar) */
  const menuAnchor = useRef<HTMLSpanElement>(null)
  const [deleting, setDeleting] = useState(false)
  // Fold state (#205) — held by the store: remembered per project and persists across restarts
  const folded = useStore((s) => s.foldedProjects.includes(projectId))
  const toggleFold = useStore((s) => s.toggleProjectFold)
  const foldOthers = useStore((s) => s.foldOtherProjects)
  const manyProjects = useStore((s) => Object.keys(s.projects).length > 1)
  // When expanded, each row's own mark already states its state — do not repeat it on the name line
  const summary = folded ? foldSummary(sessions) : []

  /*
   * Hooks are called **before any early return**. If even one render happens without a project,
   * the hook order shifts and React throws — the kind of crash that hits right when a project is
   * being deleted.
   */
  const drop = useDropLine(PROJECT_MIME, (draggedId, before) => {
    const ids = Object.keys(useStore.getState().projects)
    void reorderProjects(moveTo(ids, draggedId, projectId, before))
  })

  if (!project) return null

  return (
    /*
      Which project is on screen, stated in two layers (user request, 2026-10-01): the whole group — its name row,
      its sessions and its apps, between two of the dividers below — is tinted, and the one row that is open keeps
      the row mark inside it. A row mark alone says "this row"; with several projects open in the list the eye then
      has to walk up to find whose row it is, and a folded project has no row to mark at all.

      The tint is the selected Grid and Orchestrator buttons' graphite, at the strength of a row's hover rather than
      a button's fill: it covers a dozen rows, and at full strength the group would outshine the row that is open in
      it. It stays well under that row's own mark (graphite/40 plus the ash bar), which is what keeps the two layers
      reading as "this project, and this row in it". It is drawn only for the focus lane (openProjectOf) — the grid
      and the orchestrator light their own buttons.

      The divider is the section's own bottom border. A colour change adds no size, so selecting a project moves
      nothing in the list.
    */
    <section
      className={`relative border-b border-edge/70 py-2.5 transition-colors ${open ? 'bg-graphite/20' : ''} ${dropLine(drop.edge)}`}
      data-testid={`project-${project.name}`}
      data-folded={folded || undefined}
      data-selected={open || undefined}
      {...drop.handlers}
    >
      {/*
        Grabbed and moved by its name line — making the whole section draggable would conflict with dragging sessions.

        When the project screen is open this line is marked the way an open session row is — the ash bar and the
        graphite/40 band — so the name row and a session row say "open" in one grammar. It replaced an underline
        under the name, which was too faint to find once the group around it was tinted too.

        **The band must not move anything.** A session row is 31.5px tall (py-1.5 around a 13px line); this line
        is only its text. The padding that makes the band a row's height is cancelled by an equal negative margin,
        so every row below stands exactly where it did, and both are always on, so selecting it changes nothing
        but colour. The bar is always there too, transparent until selected, with pl-2 + 2px keeping the arrow at
        the old pl-2.5.
      */}
      <header
        className={`group -my-1.5 flex items-baseline gap-2 border-l-2 py-1.5 pl-2 pr-3 transition-colors ${
          selected ? 'border-l-ash bg-graphite/40' : 'border-l-transparent'
        }`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PROJECT_MIME, projectId)
          e.dataTransfer.effectAllowed = 'move'
        }}
      >
        {/*
          The fold arrow (#205). **This is the one and only door for folding** — the name is where
          the project screen opens (#206), so if pressing it also folded, one of the two would
          always misfire. Expand-on-hover is not used either: if the list expands and collapses as
          the mouse passes over, the row the person meant to press gets shoved out of place, and a
          waiting session gets hidden too (from the original request).

          Unlike that, it is **always visible.** Being folded is a state, not an action, and if it
          only shows on hover there is nowhere to ask why a row is missing. The arrow stands in the
          same vertical column as a session row's tool mark (the header's 2px bar + pl-2 + button), so the name also
          starts at the same spot as a session name — the tree reads as a tree. Since the name line
          aligns on the text baseline, the button with no text is centered separately inside a
          wrapping box.
        */}
        <span className="-my-1 flex shrink-0 self-center">
          <IconButton
            label={folded ? `Expand ${project.name}` : `Collapse ${project.name}`}
            onClick={() => toggleFold(projectId)}
            testId={`project-fold-${project.name}`}
          >
            <ChevronIcon open={!folded} />
          </IconButton>
        </span>
        {/*
          Pressing the project name shows git, files and the terminal (without selecting a
          session). Background information like branch, change count or concurrent sessions
          **does not get its own row under the name** — with several projects, those rows would
          stack up and push out the session list that actually needs to be seen. Instead, it is
          answered by a tooltip when asked for (hover, focus).
        */}
        <Tooltip
          content={<ProjectDetail project={project} />}
          testId={`project-tip-${project.name}`}
        >
          <button
            className={`truncate text-left text-[13px] font-medium tracking-tight text-chalk transition-colors ${
              selected ? '' : 'hover:text-beacon'
            }`}
            onClick={() => focusProject(projectId)}
            aria-current={selected ? 'page' : undefined}
            data-testid={`project-header-${project.name}`}
          >
            {project.name}
          </button>
        </Tooltip>

        {/*
          Only marks that claim no new space stay on the name line.
          Concurrent sessions in particular is a signal that warns of a data-loss risk, and
          hiding it entirely behind a tooltip would violate "show it, do not block it" (FR-2).
        */}
        <ProjectMarks project={project} />
        {summary.length > 0 && <FoldSummary name={project.name} counts={summary} />}
        {/*
          Every action on this row sits behind one button (a dogfooding request).

          `+` (new session) used to be **always visible.** The reason at the time was "new session
          is the most frequent action, so it must not stay invisible until it suddenly appears,"
          and that reason is still right — except that in the meantime this row picked up three
          actions (new session, worktree manager, delete project). Lining up all three as icons
          would make the button row longer than the project name. So they are folded into one, and
          **it stays hidden by default** instead: a folded button that is always on screen only
          gets in the way of eyes reading the list.

          Hidden, but not made unreachable — keyboard focus (focus-within) and a worktree
          proposal (#69) surface the button without hovering. The proposal case especially:
          making a hidden button breathe is useless if nobody can see it.
        */}
        <span
          ref={menuAnchor}
          className={`-my-1 shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            summary.length > 0 ? '' : 'ml-auto'
          } ${
            menuOpen || proposalHere ? 'opacity-100' : 'opacity-0'
          } ${proposalHere ? 'breathe rounded text-chalk' : ''}`}
          data-testid={`project-actions-${project.name}`}
          data-worktree-proposal={proposalHere || undefined}
        >
          {/*
            A plain button, not an IconButton — to drop the tooltip (dogfooding, 2026-09-02).
            Since pressing it opens a named menu right there, a hover tooltip was not an
            explanation but noise left overlapping the open menu. The screen-reader name stays.
          */}
          <button
            type="button"
            aria-label={`Actions for ${project.name}`}
            onClick={() => setMenuOpen((v) => !v)}
            data-testid={`project-menu-${project.name}`}
            className="flex items-center justify-center rounded p-1 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
          >
            <DotsIcon size={14} />
          </button>
        </span>
        {menuOpen && (
          <ProjectMenu
            project={project}
            anchorEl={menuAnchor.current}
            onClose={() => setMenuOpen(false)}
            onNewSession={() => openNewSession(projectId)}
            onNewApp={() => setNewAppOpen(true)}
            onStartManager={() => setManagerDialog(true)}
            onToggleTrust={() => void setProjectTrusted(projectId, !project.trusted)}
            onFoldOthers={manyProjects ? () => foldOthers(projectId) : undefined}
            onDelete={() => setDeleting(true)}
          />
        )}
      </header>

      {askingTrust && <TrustAsk project={project} />}

      {/*
        Folding removes the session rows and the app rows together (#205). The trust question
        (above) stays — it is not a row, it is a question waiting for an answer. Dialogs (below)
        stay too: folding is a way of viewing, not closing whatever work was in progress.

        **A session cannot be dropped onto a folded project.** A session only changes position
        within its own project (onReorder only touches that project's own list), and the drop spot
        is a session row — a folded project has no rows, so no line appears and dropping does
        nothing. It also does not expand while being dragged over: the whole point of expanding it
        to show it would be a spot that never accepts the drop anyway. If a session's own project
        is folded, there is no row to drag from it in the first place.
      */}
      {!folded && (
        <ul className="mt-1.5">
          {orderAsTree(sessions).map(({ s, nested, managerOfLive }) => {
            const unread = s.lastSeq > s.lastReadSeq
            const focused = focusedSessionId === s.id
            return (
              <SessionRow
                key={s.id}
                id={s.id}
                projectId={projectId}
                nested={nested}
                /*
                 * A child row cannot be dragged — position is membership (#69). Letting a row
                 * drawn indented under a parent be moved by hand would make the new position read
                 * as membership, while the actual membership (parentSessionId) stays unchanged,
                 * and the screen would end up lying.
                 */
                draggable={renaming !== s.id && !nested}
                onReorder={(draggedId, before) =>
                  void reorderSessions(
                    projectId,
                    moveTo(
                      sessions.map((x) => x.id),
                      draggedId,
                      s.id,
                      before,
                    ),
                  )
                }
              >
                {renaming === s.id ? (
                  <SessionNameInput
                    id={s.id}
                    initial={s.name}
                    onDone={(name) => {
                      setRenaming(null)
                      // No reason for a round trip when the name is unchanged (and no reason for a failure toast either)
                      if (name && name !== s.name) void renameSession(s.id, name)
                    }}
                  />
                ) : (
                  <>
                    <button
                      onClick={() => focusSession(s.id)}
                      /*
                        Double-clicking the name edits it in place — the same convention as file
                        explorers and tab names, so the hand knows it before the person even finds
                        the button. The pencil button is a second entry point for a person who does
                        not know that convention: keeping only one of the two would leave half the
                        people unable to rename anything.
                      */
                      onDoubleClick={() => setRenaming(s.id)}
                      data-testid={`session-row-${s.id}`}
                      // The open row inside the tinted group — the same word an app row and the project's name row use
                      aria-current={focused ? 'page' : undefined}
                      /*
                        Unread (FR-16) is stated by the name's brightness (the text-chalk on the
                        truncate span below). It is also kept as an attribute so a test can see a
                        fact not otherwise present on screen — asserting a class name would break
                        the test every time the color gets adjusted.
                      */
                      data-unread={(unread && !focused) || undefined}
                      /*
                        The right padding has to clear **two** buttons that appear on hover.
                        pr-8 is a value from when only delete existed; once the pencil was added, a
                        long name would run in underneath the buttons — text hidden under a button
                        is worse than text truncated.
                      */
                      className={`flex w-full items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-14 text-left text-[13px] transition-colors ${
                        focused
                          ? 'border-l-ash bg-graphite/40 text-chalk'
                          : 'border-l-transparent text-ash hover:bg-graphite/20 hover:text-chalk'
                      }`}
                    >
                      {/*
                        One mark states two things: the letter is the tool, the border is the
                        state. A separate dot right next to the mark would read as overlapping the
                        two, and blur both instead.
                      */}
                      <ToolMark tool={s.tool} state={s.state} />
                      <span className={`truncate ${unread && !focused ? 'text-chalk' : ''}`}>{s.name}</span>
                      {/*
                        Merged (#69) — this branch's work has landed on the trunk. A sign that it
                        is history, not ongoing work, and a child in this state does not block the
                        manager from being deleted. Cleaning up the tree is left to the person in
                        the delete dialog (which already states what is left).
                      */}
                      {s.merged && (
                        <span
                          className="shrink-0 rounded border border-edge px-1 text-[9px] leading-relaxed text-slate"
                          data-testid={`merged-badge-${s.id}`}
                          title="Branch merged into the trunk — safe to clean up from the delete dialog"
                        >
                          merged
                        </span>
                      )}
                      {/*
                        The PR chip (#76 stage 3) — this branch's pull request, measured through
                        gh. Not drawn once merged is showing: a merged PR also lights up the merged
                        badge, and stating the same outcome twice on a 13px row blurs both.
                      */}
                      {s.pr && !s.merged && (
                        <span
                          className="shrink-0 rounded border border-edge px-1 text-[9px] leading-relaxed text-slate"
                          data-testid={`pr-badge-${s.id}`}
                          title={`Pull request #${s.pr.number} — ${s.pr.state}\n${s.pr.url}`}
                        >
                          PR #{s.pr.number}
                          {s.pr.state === 'closed' ? ' ✕' : ''}
                        </span>
                      )}
                      {/*
                        An unread dot used to be here and **was removed** (dogfooding, 2026-09-02).

                        It was stating the same fact for a third time on this row: the tool mark's
                        border already states the state (an ash ring when a turn ends), and the
                        name's brightness already states unread (the text-chalk above). Since all
                        three lit up together when a turn ended while the person was away, the dot
                        added no information, only the question "what is that now" — and that
                        question was actually asked. The determination logic (lastReadSeq, markRead)
                        is unchanged.
                      */}
                    </button>
                    {/*
                      One menu instead of four icons (pencil, handoff, worktree, delete) — a
                      dogfooding request, the same grammar as the project row. With four icons it
                      turned into an unlabeled game of matching pictures, and two of them (handoff,
                      delete) were the kind that must not be pressed by mistake.
                    */}
                    {/*
                      The right padding has to match the project header's px-3 — the two are
                      buttons standing in the same vertical column in the sidebar, and leaving them
                      at 4px and 12px stood out immediately to the eye (a dogfooding finding).
                      Fixing only one side would put them out of alignment again, so the value is
                      kept matched.
                    */}
                    <span
                      className={`absolute right-3 top-1/2 flex -translate-y-1/2 items-center transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${
                        sessionMenu?.id === s.id ? 'opacity-100' : 'opacity-0'
                      }`}
                      data-testid={`session-actions-${s.id}`}
                    >
                      {/* A plain button like the project's ⋯ — a named menu opens right away, so a tooltip is noise */}
                      <button
                        type="button"
                        aria-label={`Actions for ${s.name}`}
                        onClick={(e) => {
                          // Reading it inside the updater is too late — React clears currentTarget once the handler returns
                          const el = e.currentTarget
                          setSessionMenu((cur) => (cur?.id === s.id ? null : { id: s.id, el }))
                        }}
                        data-testid={`session-menu-${s.id}`}
                        className="flex items-center justify-center rounded p-1 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
                      >
                        <DotsIcon size={14} />
                      </button>
                    </span>
                    {sessionMenu?.id === s.id && (
                      <SessionMenu
                        session={s}
                        managerOfLive={managerOfLive}
                        anchorEl={sessionMenu.el}
                        onClose={() => setSessionMenu(null)}
                        onRename={() => setRenaming(s.id)}
                        onNewWorktree={() => openNewSession(projectId, { worktree: true })}
                        onHandoff={() => setHandingOff(s.id)}
                        onDelete={() => setConfirming(s.id)}
                      />
                    )}
                  </>
                )}
              </SessionRow>
            )
          })}
        </ul>
      )}
      {!folded && <AppRows apps={projectApps} testId={`project-apps-${project.name}`} />}

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => openNewSession(null)} />}
      {newAppOpen && <NewAppDialog projectId={projectId} onClose={() => setNewAppOpen(false)} />}
      {managerDialog && (
        <WorktreeManagerDialog projectId={projectId} onClose={() => setManagerDialog(false)} />
      )}
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} />}

      {confirming && (
        <ConfirmDelete
          sessionId={confirming}
          name={sessions.find((s) => s.id === confirming)?.name ?? 'Session'}
          // This session's own tool, not the project default — this sentence states where the transcript ends up, so it must not be wrong
          tool={sessions.find((s) => s.id === confirming)?.tool ?? project.defaultTool ?? ''}
          onCancel={() => setConfirming(null)}
          onConfirm={(deleteWorktree, deleteExternal) => {
            void deleteSession(confirming, deleteWorktree, deleteExternal)
            setConfirming(null)
          }}
        />
      )}

      {handingOff && (
        <ConfirmHandoff
          name={sessions.find((s) => s.id === handingOff)?.name ?? 'Session'}
          tool={sessions.find((s) => s.id === handingOff)?.tool ?? project.defaultTool ?? ''}
          // Determining a dead session (#78): asking a session that has errored or hit a rate limit
          // to write a handoff note is asking someone who cannot respond for a will — the transcript mode is pre-selected
          dead={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? s.state === 'error' || !!s.limit : false
          })()}
          // Asking the agent is blocked while a card is up — the request would go through as the answer to a question (#174, same determination as the store)
          blocked={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? handoffBlockedBy(s) : null
          })()}
          onCancel={() => setHandingOff(null)}
          onConfirm={(tool, deleteOld, mode) => {
            // The dialog closes and progress is shown inside the session — the handoff request and its text stay in the conversation as is
            void handoffSession(handingOff, { tool, deleteOld, mode })
            setHandingOff(null)
          }}
        />
      )}
    </section>
  )
}

/**
 * An app row (M4 B-2) — same shape, same spot as a session row. Pressing it opens the pinned app
 * screen.
 *
 * So sessions and apps standing in one list do not read as mixed together, the mark is split by
 * **shape** (a session gets a tool-letter chip, an app gets a window icon). Status is a single word
 * at the far right, and nothing at all is written for the normal cases (idle, running). Since an
 * app comes up on first need and goes down when idle, "stopped" is ordinary, not a breakage. If it
 * were always written, the one word that actually matters (failed) would get buried. An app that
 * cannot be opened (untrusted, broken, stalled) has its mark dimmed, and the reason is visible by
 * staying on the row.
 */
const APP_HINT: Partial<Record<ExternalAppStatus, string>> = {
  starting: 'starting',
  crashed: 'crashed',
  failed: 'failed',
  untrusted: 'not trusted',
  invalid: 'invalid',
  // An imported app is waiting for the person's confirmation (M4 E-3) — opening it brings up the confirmation dialog
  unconfirmed: 'not enabled',
}

function AppRows({ apps, testId }: { apps: ExternalCatalogApp[]; testId: string }) {
  if (apps.length === 0) return null
  return (
    <ul data-testid={testId}>
      {apps.map((a) => (
        <AppRow key={a.key} app={a} />
      ))}
    </ul>
  )
}

function AppRow({ app }: { app: ExternalCatalogApp }) {
  const openApp = useStore((s) => s.openApp)
  // Same rule as a session row: lit only while **currently looking at** that screen (useSelectedSessionId in selectors)
  const active = useStore(
    (s) => s.view === 'app' && s.focusedApp?.appId === app.appId && (s.focusedApp?.projectId ?? null) === app.projectId,
  )
  /*
   * A chain started from this app's screen is waiting on the person's answer (M4 D-4) — visible
   * here even without the pinned app screen open. Pressing it opens that screen, with the question
   * standing there. Written in a bright word: that belongs to whatever is blocked (the palette rule).
   */
  const asking = useStore((s) => s.appQuestions.some((q) => q.origin.appId === app.appId && (q.origin.projectId ?? null) === app.projectId))
  const hint = asking ? 'asks you' : APP_HINT[app.info.status]
  const projectId = app.projectId
  return (
    <li
      className="relative"
      /*
        A project's app can be dragged onto its project screen, like a session row (#203): hidden
        there, it comes back where it is dropped. A user-folder app belongs to no project and no
        screen takes an app otherwise — the grid shows sessions — so it is not draggable at all.
      */
      draggable={!!projectId}
      onDragStart={(e) => {
        if (!projectId) return
        e.dataTransfer.setData(APP_MIME, app.key)
        e.dataTransfer.setData(projectItemMime(projectId), projectId)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <button
        type="button"
        onClick={() => openApp(app.projectId, app.appId)}
        data-testid={`app-row-${app.key}`}
        data-status={app.info.status}
        aria-current={active ? 'page' : undefined}
        title={app.status.reason ?? app.info.description ?? undefined}
        className={`flex w-full items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-3 text-left text-[13px] transition-colors ${
          active ? 'border-l-ash bg-graphite/40 text-chalk' : 'border-l-transparent text-ash hover:bg-graphite/20 hover:text-chalk'
        }`}
      >
        {/* Same width as the tool chip (17px) — a session name and an app name start at the same vertical column */}
        <span className={`flex size-[17px] shrink-0 items-center justify-center ${app.status.runnable ? '' : 'opacity-50'}`}>
          <AppIcon />
        </span>
        <span className="truncate">{app.title}</span>
        {hint && (
          <span
            className={`readout ml-auto shrink-0 text-[10px] ${asking || app.status.tone === 'alert' ? 'text-chalk' : 'text-slate'}`}
            data-testid="app-row-hint"
            data-asking={asking || undefined}
          >
            {hint}
          </span>
        )}
      </button>
    </li>
  )
}

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
function UserApps() {
  const apps = useUserApps()
  const [newAppOpen, setNewAppOpen] = useState(false)
  // Import (M4 E-3) — there is one dialog for the whole app (a deep link opens the same dialog too), so the store opens it
  const openImport = useStore((s) => s.openImport)
  return (
    <section className="border-b border-edge/70 py-2.5" data-testid="user-apps">
      <header className="flex items-center gap-2 px-3">
        <span className={`text-[13px] font-medium tracking-tight ${apps.length ? 'text-chalk' : 'text-slate'}`}>Your apps</span>
        <span className="-my-1 ml-auto shrink-0">
          <IconButton label="Import an app from a folder, a .zip, or a link" onClick={() => openImport()} testId="user-apps-import" align="right">
            <ImportIcon size={13} />
          </IconButton>
        </span>
        <span className="-my-1 shrink-0">
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

/**
 * Trust asked once at registration (M4, decision 3).
 *
 * Not a modal — it stands under that project's own row. Right after registration there is a path
 * (the orchestrator's folder picker) that immediately opens a new-session dialog, and stacking a
 * dialog on top of a dialog would leave both only half-read. Standing here, the question is still
 * there even after the session dialog is closed and the person comes back. A project left
 * unanswered stays untrusted — it is safer to default to silently off than to silently on.
 *
 * The wording states exactly what happens: trusting it lets this project's apps run and its
 * settings apply.
 */
function TrustAsk({ project }: { project: ProjectInfo }) {
  const answer = useStore((s) => s.answerTrustAsk)
  return (
    <div
      className="mx-3 mt-2 rounded border border-edge bg-panel px-2.5 py-2"
      role="group"
      aria-label={`Trust ${project.name}?`}
      data-testid={`trust-ask-${project.name}`}
    >
      <p className="text-[12px] text-chalk">Trust this project?</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ash">
        Trusting lets this project&apos;s apps run and its settings apply. Trust it only if you trust the code in this
        folder.
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:text-chalk"
          onClick={() => void answer(false)}
          data-testid={`trust-ask-no-${project.name}`}
        >
          Not now
        </button>
        <button
          type="button"
          className="rounded border border-edge bg-void px-2 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite"
          onClick={() => void answer(true)}
          data-testid={`trust-ask-yes-${project.name}`}
        >
          Trust
        </button>
      </div>
    </div>
  )
}

/**
 * The handoff confirmation dialog (a dogfooding request).
 *
 * States the whole sequence in sentences — because this one button bundles three steps together:
 * "ask for a note → new session → (by default) actually delete." Since destruction is at the end,
 * the warning stands in the delete palette (the same grammar as project deletion). Typing the name
 * is not required: if the last step fails, nothing is lost, there are just two sessions left over,
 * and if it succeeds, the only thing lost is exactly what the person just read and approved.
 *
 * The receiving agent can be chosen (a dogfooding request) — the note is plain text, so it does
 * not lock in a tool. It defaults to the current tool. Deletion is also a checkbox: turning it off
 * turns this from switching tools into branching.
 */
function ConfirmHandoff({
  name,
  tool,
  dead,
  blocked,
  onConfirm,
  onCancel,
}: {
  name: string
  tool: ToolName
  /** A session unable to respond due to an error or a rate limit (#78) — all three defaults (mode, target, deletion) flip together */
  dead: boolean
  /** A card currently up (#174) — while one is up, the agent cannot be asked. The record mode does not ask, so it goes through as is */
  blocked: 'question' | 'approval' | null
  onConfirm: (tool: ToolName, deleteOld: boolean, mode: 'agent' | 'record') => void
  onCancel: () => void
}) {
  /*
   * Defaults are inverted for a dead session (#78): mode defaults to record (no asking), the
   * target defaults to **the other tool** (if the service is down and that is why the handoff is
   * happening, defaulting to the same tool is a one-click trap), and deletion defaults to off
   * (keep the original until the successor is confirmed working). Only the initial values are
   * flipped — changing one radio afterward never silently changes another selection (no silent
   * actions).
   */
  const tools = useTools()
  const otherTool = tools.find((t) => t.name !== tool)?.name ?? tool
  const [mode, setMode] = useState<'agent' | 'record'>(dead ? 'record' : 'agent')
  const [heirTool, setHeirTool] = useState<ToolName>(dead ? otherTool : tool)
  const [deleteOld, setDeleteOld] = useState(!dead)
  const toolLabel = useToolMeta(tool).label
  return (
    <Modal onClose={onCancel} testId="confirm-handoff">
      <div className="w-[400px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <p className="text-[13px] text-chalk">Hand off to a fresh session?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>

        {/* Where the note comes from — a live session writes it itself, a dead one has the app build it from the transcript (#78) */}
        <p className="mt-3 text-[10px] uppercase text-slate">Handoff note</p>
        <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label="Handoff note source">
          {(
            [
              { key: 'agent', label: 'Ask the agent' },
              { key: 'record', label: 'From the record' },
            ] as const
          ).map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={mode === m.key}
              data-testid={`handoff-mode-${m.key}`}
              onClick={() => setMode(m.key)}
              className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                mode === m.key
                  ? 'border-ash bg-graphite text-chalk'
                  : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ash" data-testid="handoff-mode-note">
          {mode === 'agent'
            ? 'This session writes a handoff note, the app saves it outside the project, then a fresh session starts by reading it.'
            : 'The app builds the note from its stored conversation — this session is not asked. Use this when the agent cannot respond (outage, limits).'}
        </p>
        {mode === 'agent' && blocked && (
          <p className="mt-2 text-[11px] leading-relaxed text-beacon" data-testid="handoff-blocked">
            This session is waiting on {blocked === 'question' ? 'a question' : 'an approval'}. Asking for a note now would
            {blocked === 'question' ? ' answer the question with the handoff request' : ' drop the approval card'} —
            answer it first, or build the note from the record.
          </p>
        )}

        {/* The receiving agent — choosing a different tool does not carry over tool-specific settings like model or reasoning effort */}
        <p className="mt-3 text-[10px] uppercase text-slate">Hand off to</p>
        <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label="Hand off to">
          {tools.map((t) => (
            <button
              key={t.name}
              type="button"
              role="radio"
              aria-checked={heirTool === t.name}
              data-testid={`handoff-tool-${t.name}`}
              onClick={() => setHeirTool(t.name)}
              className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                heirTool === t.name
                  ? 'border-ash bg-graphite text-chalk'
                  : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
              }`}
            >
              {t.label}
              {t.name === tool && <span className="ml-1 text-[10px] text-slate">(current)</span>}
            </button>
          ))}
        </div>

        {deleteOld ? (
          <p
            className="mt-3 rounded border border-del/40 bg-del-bg px-2.5 py-2 text-[11px] leading-relaxed text-chalk"
            data-testid="handoff-warning"
          >
            When the new session is ready, this session moves to the trash — and{' '}
            <span className="text-del">deleting it for good there deletes the {toolLabel} conversation file
            too</span>. Until then, Settings → Trash reads it and restores it.
          </p>
        ) : (
          <p className="mt-3 text-[11px] leading-relaxed text-ash" data-testid="handoff-keep-note">
            This session stays — the new one starts from the note alongside it.
          </p>
        )}
        <label
          className={`mt-2 flex cursor-pointer items-start gap-2 text-[11px] ${
            deleteOld ? 'text-del' : 'text-ash hover:text-chalk'
          }`}
          data-testid="handoff-delete-toggle"
        >
          <input
            type="checkbox"
            className={`mt-0.5 ${deleteOld ? 'accent-del' : 'accent-ash'}`}
            checked={deleteOld}
            onChange={(e) => setDeleteOld(e.target.checked)}
          />
          <span>Move this session to the trash after the handoff</span>
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`rounded border px-3 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              deleteOld
                ? 'border-del/40 bg-del-bg text-del hover:border-del/70'
                : 'border-edge bg-panel text-chalk hover:border-graphite'
            }`}
            onClick={() => onConfirm(heirTool, deleteOld, mode)}
            disabled={mode === 'agent' && !!blocked}
            data-testid="confirm-handoff-yes"
          >
            Hand off
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Edits a session name in place (issue #5).
 *
 * **No modal is shown.** A name only gets its meaning by being chosen among the other names — if
 * a dialog covers the screen, the person ends up naming it without being able to see what it might
 * be confused with. This was the problem where auto-generated names, since they truncate the first
 * prompt, produced four rows all reading `This session is being continued…` in a row, so the other
 * four rows have to stay visible while one is being edited.
 *
 * An empty name is **treated as a cancel.** If a slip of deleting the text and clicking away
 * produced a nameless row, that row could no longer point at anything in the list.
 */
function SessionNameInput({
  id,
  initial,
  onDone,
}: {
  id: string
  initial: string
  onDone: (name: string) => void
}) {
  const [text, setText] = useState(initial)
  /*
   * Confirming with Enter makes the input disappear, and disappearing also fires one more blur
   * event. Without a guard, the same name gets sent twice — one succeeds and one fails, and an
   * error toast pops up for no apparent reason.
   */
  const done = useRef(false)
  const finish = (name: string) => {
    if (done.current) return
    done.current = true
    onDone(name.trim())
  }

  return (
    <input
      autoFocus
      className="w-full border-l-2 border-l-ash bg-graphite/40 py-1.5 pl-2.5 pr-3 text-[13px] text-chalk outline-none"
      value={text}
      onChange={(e) => setText(e.target.value)}
      // An auto-generated name is usually replaced wholesale, so the whole text is selected (press → once to append instead)
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        // Stopped here so global shortcuts (⌘K, etc.) do not intercept the typing
        e.stopPropagation()
        if (e.key === 'Enter') finish(text)
        else if (e.key === 'Escape') finish(initial)
      }}
      // Clicking elsewhere to leave still keeps the edited value — there is no separate confirm button
      onBlur={() => finish(text)}
      data-testid={`session-name-input-${id}`}
      spellCheck={false}
    />
  )
}

/**
 * Delete confirmation.
 *
 * **States plainly what is deleted and what stays behind.**
 * Writing only "this cannot be undone" would not be true — the underlying tool (Claude, Codex)
 * still keeps the conversation, and it can be recovered through '+ → previous conversation.'
 * Making it sound scarier than it is leaves the person unable to clean up, and rows just pile up.
 */
/**
 * The action menu on a project row.
 *
 * The reason it is one labeled list instead of three icons is **that names are needed.** `+` could
 * be learned to mean new session, but there is no way to know before pressing that a branch icon
 * means the worktree manager and a trash icon means deleting the project — and one of those is the
 * kind of thing that must not be pressed just to find out.
 *
 * Delete sits **at the very bottom, below a divider.** The two above it are things done every day,
 * while this is something done once, and they must not sit in the same group when the hand is
 * moving from memory.
 */
/**
 * The shared shell for sidebar row menus — placement (zoom compensation, flipping, edge handling)
 * and the closing rules live here. Pulled out of the project menu: once session rows needed the
 * same menu, writing this calculation twice would foreseeably end up with only one copy fixed later
 * (the zoom compensation already went through that once).
 */
function RowMenu({
  anchorEl,
  testId,
  onClose,
  children,
}: {
  anchorEl: HTMLElement | null
  testId: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  /*
   * **Appears right below the button that opened it.**
   *
   * It used to be `absolute right-2 top-6`. This row has no positioned ancestor of its own, so
   * that coordinate resolved against the sidebar as a whole, and no matter which project was
   * pressed, the menu always landed at one fixed spot near the top right of the sidebar — pressing
   * the tenth project produced its answer at the very top (a dogfooding finding). A menu has to sit
   * **next to whatever called it** for it to read as a menu about that thing.
   *
   * Why `fixed`: the sidebar has `overflow-y-auto`, so placing it in normal flow would clip the
   * menu for projects lower in the list. Positioning it relative to the viewport leaves no box to
   * clip against.
   *
   * If there is no room below, it flips upward. That means the height has to be **measured first**,
   * and the height is only known once it is rendered — so it is measured and placed with
   * useLayoutEffect (which runs before paint), and any frame where the position is not yet decided
   * never reaches the screen (hidden via visibility).
   */
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current
      if (!anchorEl || !el) return
      /*
       * **Everything is computed after converting to layout pixels** — because of zoom
       * (--text-zoom).
       *
       * getBoundingClientRect returns screen pixels already multiplied by the zoom, but the
       * top/right set here are lengths inside the zoomed root, so the zoom gets multiplied in
       * **a second time** when it is rendered. Mixing them as-is put the menu 24px below and 103px
       * to the left of the button at zoom 1.1 (54px/249px at 1.25 — measured; this is what the
       * dogfooding report "the menu position looks wrong" turned out to be). The e2e tests missed
       * it because they only measured at zoom 1.0.
       *
       * The window size (innerWidth/Height) has no notion of zoom, and offsetHeight is already in
       * raw layout pixels — only the screen pixels (rect) and the window pixels are divided by
       * zoom, so everything lands in one coordinate system.
       */
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
      const r = anchorEl.getBoundingClientRect()
      const h = el.offsetHeight
      const w = el.offsetWidth
      const winH = window.innerHeight / zoom
      const winW = window.innerWidth / zoom
      const GAP = 4 // Between the button and the menu — if flush, it is unclear where the button ends
      const EDGE = 8 // Keeps it from sitting flush against the window edge
      const below = r.bottom / zoom + GAP
      setPos({
        top: below + h <= winH - EDGE ? below : Math.max(EDGE, r.top / zoom - GAP - h),
        /*
         * The menu's right edge lines up with the button's — it reads as flowing out of the
         * button. But the left edge is also protected (dogfooding: with a narrow sidebar, the menu
         * ran off the left side of the window and became invisible). `right` means "how far from
         * the window's right edge," so a larger value pushes the menu further left, and if the
         * button sits close to the window's left edge, an entire menu-width can end up off screen —
         * this clamps it so the menu's left edge stays within EDGE.
         */
        right: Math.max(EDGE, Math.min(winW - r.right / zoom, winW - EDGE - w)),
      })
    }
    place()
    /*
     * When the sidebar scrolls, the button moves but the fixed menu does not — this re-attaches
     * it. Listened to in the capture phase because scroll does not bubble, so a plain listener on
     * window would not catch scrolling inside the sidebar.
     */
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorEl])
  /*
   * Closes when the person clicks outside it. If another project is pressed while a menu is open,
   * it can look as if two menus are open at once, but in fact each one holds its own state, so
   * neither closes the other.
   */
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // capture: the close still fires even when a row below calls stopPropagation
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      data-testid={testId}
      className="fixed z-30 w-48 rounded border border-edge bg-panel py-1 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
      style={{ top: pos?.top ?? 0, right: pos?.right ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  )
}

/** One menu row. Closing is bundled into onClick — the caller that opens it is the one that knows onClose */
function ActionRow({
  label,
  onClick,
  testId,
  danger,
}: {
  label: string
  onClick: () => void
  testId: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onClick}
      className={`block w-full px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-graphite/25 ${
        danger ? 'text-ash hover:text-beacon' : 'text-ash hover:text-chalk'
      }`}
    >
      {label}
    </button>
  )
}

function ProjectMenu({
  project,
  anchorEl,
  onClose,
  onNewSession,
  onNewApp,
  onStartManager,
  onToggleTrust,
  onFoldOthers,
  onDelete,
}: {
  project: ProjectInfo
  anchorEl: HTMLElement | null
  onClose: () => void
  onNewSession: () => void
  onNewApp: () => void
  onStartManager: () => void
  onToggleTrust: () => void
  /** Only when there are two or more projects — with just one, there is no "other" to fold */
  onFoldOthers?: () => void
  onDelete: () => void
}) {
  const pick = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <RowMenu anchorEl={anchorEl} testId={`project-menu-open-${project.name}`} onClose={onClose}>
      <ActionRow label="New session" onClick={pick(onNewSession)} testId={`new-session-${project.name}`} />
      {/*
        New app (M4 C-1) — right below new session. Both are "add one more thing to this project,"
        so they belong in the same group. It shows up even for an untrusted project too: the dialog
        states why and lets the person trust it right there (if the row disappeared from the menu
        instead, there would be nowhere to ask why it is missing).
      */}
      <ActionRow label="New app…" onClick={pick(onNewApp)} testId={`new-app-${project.name}`} />
      {/*
        The door to **first** create the manager slot (#76). Shown only when it is a git repo and
        that slot does not exist yet — once created, that slot stands as a row in the session list,
        so there never end up being two doors that do the same thing.
      */}
      {project.git?.isRepo && !project.worktreeManager && (
        <ActionRow
          label="Start worktree manager"
          onClick={pick(onStartManager)}
          testId={`start-worktree-manager-${project.name}`}
        />
      )}
      {/*
        Trust (M4, decision 3). Asked once at registration, and changed from here afterward. A
        single toggle row, not a confirmation dialog: turning it off is the safe direction, which
        stops apps and ignores settings, and turning it on is something the person did by opening
        the menu, reading the label and pressing it.
      */}
      <ActionRow
        label={project.trusted ? 'Stop trusting this project' : 'Trust this project'}
        onClick={pick(onToggleTrust)}
        testId={`toggle-trust-${project.name}`}
      />
      {/*
        Fold everything else at once (#205). Lets a person focus on one project without going and
        folding every other project one by one — this project stays expanded while the rest fold.
        No separate undo is provided: a folded row still states how many sessions are waiting, and
        expanding it is one press of the arrow.
      */}
      {onFoldOthers && (
        <ActionRow
          label="Collapse other projects"
          onClick={pick(onFoldOthers)}
          testId={`fold-others-${project.name}`}
        />
      )}
      <div className="my-1 border-t border-edge" />
      <ActionRow
        label="Delete project…"
        onClick={pick(onDelete)}
        testId={`delete-project-${project.name}`}
        danger
      />
    </RowMenu>
  )
}

/**
 * The action menu on a session row (dogfooding: the hover icons grew to four — pencil, handoff,
 * worktree, delete. The same reason the project row moved from three icons to a menu applies:
 * **names are needed.** There is no way to know what a handoff arrow icon means before pressing it,
 * and two of them are the kind that must not be pressed just to find out.)
 *
 * Delete sits at the very bottom, below a divider — everyday actions and once-in-a-while actions
 * do not belong in the same group.
 */
function SessionMenu({
  session,
  managerOfLive,
  anchorEl,
  onClose,
  onRename,
  onNewWorktree,
  onHandoff,
  onDelete,
}: {
  session: SessionSummary
  managerOfLive: number
  anchorEl: HTMLElement | null
  onClose: () => void
  onRename: () => void
  onNewWorktree: () => void
  onHandoff: () => void
  onDelete: () => void
}) {
  const pick = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <RowMenu anchorEl={anchorEl} testId={`session-menu-open-${session.id}`} onClose={onClose}>
      <ActionRow label="Rename" onClick={pick(onRename)} testId={`rename-session-${session.id}`} />
      {/* Manager rows only — add one more worktree session under this one (#69) */}
      {managerOfLive > 0 && (
        <ActionRow
          label="New worktree session"
          onClick={pick(onNewWorktree)}
          testId={`new-worktree-session-${session.id}`}
        />
      )}
      {/* A worktree session cannot do this yet — the worktree's lifetime is tied to the session */}
      {!session.worktree && (
        <ActionRow
          label="Hand off to a fresh session…"
          onClick={pick(onHandoff)}
          testId={`handoff-session-${session.id}`}
        />
      )}
      <div className="my-1 border-t border-edge" />
      <ActionRow
        label="Delete session…"
        onClick={pick(onDelete)}
        testId={`delete-session-${session.id}`}
        danger
      />
    </RowMenu>
  )
}

function ConfirmDelete({
  sessionId,
  name,
  tool,
  onConfirm,
  onCancel,
}: {
  sessionId: string
  name: string
  tool: ToolName
  onConfirm: (deleteWorktree: boolean, deleteExternal: boolean) => void
  onCancel: () => void
}) {
  const platform = usePlatform()
  const toolLabel = useToolMeta(tool).label
  /*
   * Since #204 the session goes to the trash, and both choices below are about what goes with it **when it is deleted
   * for good** from Settings → Trash. The dialog says so in its first lines: a session that leaves the sidebar with
   * no word about where it went and how it comes back is the retired archive (FR-20).
   *
   * Whether to also delete the original on the tool's side too (dogfooding: "really delete it").
   * **Defaults to deleting it** — it used to default to keeping it, but a person pressing delete
   * actually means to clean up, so a half-delete that "deleted it, but the file is still there"
   * turned out to be the wrong feel (a second dogfooding finding). Turning it off swaps the notice
   * in the same spot to "it stays on the tool's side" (the same grammar as project deletion: the
   * two sentences are never shown together for the person to pick between).
   */
  const [deleteExternal, setDeleteExternal] = useState(true)

  /*
   * Whether this is a worktree session, and whether it has uncommitted changes, is **asked the
   * moment the dialog opens.** The session list only holds the path, not whether it is dirty —
   * that is a fact only the filesystem can answer.
   */
  const [wt, setWt] = useState<{ path: string; branch: string; dirty: boolean; changedFiles: number } | null>(
    null,
  )
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  useEffect(() => {
    let alive = true
    void platform.agents
      .worktreeStatus(sessionId)
      .then((r) => alive && setWt(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [platform, sessionId])
  return (
    <Modal onClose={onCancel} testId="confirm-delete">
      <div className="w-[380px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <p className="text-[13px] text-chalk">Move this session to the trash?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate" data-testid="delete-trash-note">
          Chat history and attachments stay in Centralu’s trash, out of the sidebar, search and the agents’ reach.{' '}
          <span className="text-chalk">Settings → Trash</span> reads it, restores it, or deletes it for good.
        </p>
        {deleteExternal ? (
          <p
            className="mt-1 rounded border border-del/40 bg-del-bg px-2 py-1.5 text-[11px] leading-relaxed text-chalk"
            data-testid="delete-external-warning"
          >
            When it is deleted for good,{' '}
            <span className="text-del">the conversation file in {toolLabel} is deleted too</span> — there will be
            nothing left to pull back.
          </p>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-ash" data-testid="delete-notice">
            The conversation stays in {toolLabel} — you can pull it back from{' '}
            <span className="text-chalk">+ → Past conversations</span>.
          </p>
        )}
        <label
          className={`mt-2 flex cursor-pointer items-start gap-2 text-[11px] ${
            deleteExternal ? 'text-del' : 'text-ash hover:text-chalk'
          }`}
          data-testid="delete-external-toggle"
        >
          <input
            type="checkbox"
            className={`mt-0.5 ${deleteExternal ? 'accent-del' : 'accent-ash'}`}
            checked={deleteExternal}
            onChange={(e) => setDeleteExternal(e.target.checked)}
          />
          <span>Delete the {toolLabel} conversation file too, when deleted for good</span>
        </label>

        {/*
          A worktree's **lifetime differs from the session's.** Hours of an agent's work can be
          sitting there, so it defaults to being kept. Deleting it requires the person to turn it
          on by hand — and to read first what would be lost.
        */}
        {wt && (
          <div className="mt-3 rounded border border-edge bg-panel p-2.5" data-testid="delete-worktree">
            <p className="text-[11px] text-ash">
              This session ran in a worktree — <span className="font-mono text-chalk">{wt.branch}</span>
            </p>
            <p className="mt-1 text-[11px] text-slate">It stays where it is while the session is in the trash.</p>
            {wt.dirty && (
              <p className="mt-1 text-[11px] text-chalk" data-testid="worktree-dirty">
                {wt.changedFiles} uncommitted {wt.changedFiles === 1 ? 'change' : 'changes'} would be lost once it is
                deleted.
              </p>
            )}
            <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[11px] text-ash hover:text-chalk">
              <input
                type="checkbox"
                className="mt-0.5 accent-ash"
                checked={deleteWorktree}
                onChange={(e) => setDeleteWorktree(e.target.checked)}
                data-testid="delete-worktree-toggle"
              />
              <span>
                Delete the worktree too, when deleted for good
                <span className="mt-0.5 block text-[10px] break-all text-slate">{wt.path}</span>
              </span>
            </label>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk hover:border-graphite"
            onClick={() => onConfirm(deleteWorktree, deleteExternal)}
            data-testid="confirm-delete-yes"
          >
            Move to trash
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Marks placed on the name line — they claim no new vertical space.
 *
 * A warning used to live here, "N running in the same folder" (⧉N). It was removed (user request,
 * 2026-09-07): running several sessions in the same folder is **an intentional choice** in this
 * app, and a worktree is the answer if the person actually wants them kept apart. A warning that
 * is always on becomes background noise, not advice.
 */
function ProjectMarks({ project }: { project: ProjectInfo }) {
  const changed = project.git?.changedFiles ?? 0
  const denied = project.git?.denied === true

  return (
    /*
      **Placed right next to the name.** Pushed to the far end with ml-auto, these numbers used to
      read as disconnected from what they were about, sitting far from the name (dogfooding: "what
      is this number?"). Right next to it, it reads as one unit: "22 changes in this project."

      The explanation is given through the **app's own tooltip.** The browser's default title takes
      one or two seconds to appear, and if a person wondering "what is this" has to wait that long,
      they simply stop asking. The fewer units a bare-number mark has, the faster the answer needs
      to come.
    */
    <span className="readout flex shrink-0 items-center gap-1.5 text-[10px] text-slate">
      {changed > 0 && (
        <Tooltip
          content={`${changed} uncommitted file${changed > 1 ? 's' : ''}`}
          testId={`mark-changed-tip-${project.name}`}
        >
          <span data-testid={`mark-changed-${project.name}`}>{changed}</span>
        </Tooltip>
      )}
      {denied && (
        <Tooltip content="Folder access permission required" testId={`git-denied-tip-${project.name}`}>
          <span className="text-ash" data-testid={`git-denied-${project.name}`}>
            !
          </span>
        </Tooltip>
      )}
    </span>
  )
}

/**
 * The status summary for a folded project (#205) — what the hidden session rows are waiting for,
 * as counts.
 *
 * **Uses the same marks as a session row.** Inventing a new symbol would mean the person has to
 * learn it too, and it would read as the row's mark and the summary saying different things. So the
 * chip shape, ring color (RING) and spin (cc-orbit) match ToolMark exactly, and only the count sits
 * where the tool letter would. Approval is a pure white ring, so it stays the brightest thing on
 * screen even in a folded row — this app's rule that brightness is urgency holds in a folded row
 * too.
 *
 * It stands at the far right of the name line (right before the ⋯). With several projects folded,
 * the summaries line up in one vertical column, readable top to bottom in a single glance to see
 * who is calling. The meaning is given by the app's own tooltip — the fewer units a bare-number
 * mark has, the faster the answer needs to come.
 */
function FoldSummary({ name, counts }: { name: string; counts: { state: FoldSummaryState; count: number }[] }) {
  const label = counts.map((c) => `${c.count} ${stateLabel(c.state).toLowerCase()}`).join(' · ')
  return (
    <span className="-my-1 ml-auto flex shrink-0 self-center">
      <Tooltip content={label} testId={`fold-summary-tip-${name}`} align="right">
        <span className="flex items-center gap-1" aria-label={label} data-testid={`fold-summary-${name}`}>
          {counts.map((c) => (
            <StateCount key={c.state} state={c.state} count={c.count} />
          ))}
        </span>
      </Tooltip>
    </span>
  )
}

/** A chip like ToolMark — a count instead of a letter. A stalled state (error) dims the text just like ToolMark does */
function StateCount({ state, count }: { state: FoldSummaryState; count: number }) {
  // Spins at **the same angle** as a grid panel or a session mark (components/orbit.ts)
  useOrbitSync(state === 'working')
  return (
    <span
      className={`shrink-0 rounded-[5px] p-[1.5px] ${state === 'working' ? 'cc-orbit' : ''}`}
      style={state === 'working' ? undefined : { background: RING[state] }}
      data-state={state}
    >
      <span
        className={`readout cc-chip flex h-[14px] min-w-[14px] items-center justify-center rounded-[3.5px] border border-graphite bg-void px-[3px] text-[9px] font-semibold leading-none text-chalk ${
          state === 'error' ? 'opacity-50' : ''
        }`}
      >
        {count}
      </span>
    </span>
  )
}

/** Tooltip content — claims no space by default, but answers everything when asked */
function ProjectDetail({ project }: { project: ProjectInfo }) {
  return (
    <span className="block" data-testid={`project-detail-${project.name}`}>
      <span className="readout block truncate text-slate">{project.path}</span>
      <span className="mt-1 block" data-testid={`project-trust-${project.name}`}>
        {project.trusted ? 'Trusted — its apps can run' : "Not trusted — its apps don't run"}
      </span>
      <span className="mt-1 block">
        {project.git?.denied ? (
          // Showing this as "not a repo" would lead the person to the wrong conclusion — what is actually needed is granting permission
          <span className="text-chalk" data-testid="git-denied">
            Folder access permission required — System Settings → Privacy & Security → Files and Folders
          </span>
        ) : project.git ? (
          <>
            <span className="text-chalk">{project.git.branch}</span>
            {project.git.changedFiles > 0 && <span> · {project.git.changedFiles} changed</span>}
          </>
        ) : (
          <span>not a git repo</span>
        )}
      </span>
    </span>
  )
}

/**
 * The session mark — tool and state, in one spot. Without the tool, there would be no way to tell
 * apart two sessions with similar titles (this was actually mixed up during dogfooding).
 *
 * **No official logo is used.** Both companies' marks are trademarks with their own brand
 * guidelines — bundling a logo file into the app and distributing it could run into those rules.
 * With our own glyph, that problem does not exist at all, and it fits this app's own rule of
 * distinguishing things by shape in grayscale.
 *
 * The border is the state. Brighter means more urgent — the same rule that runs through this whole
 * app. Only 'working' spins: a stalled state and a running one are already distinguishable even in
 * a still frame, but nothing answers "is it working or has it stopped" as certainly as motion does.
 *
 * A stalled state (rate-limited, error) dims the letter to set it apart from an active state. With
 * six states, telling them all apart by border brightness alone is hard, so the name is carried in
 * full in the tooltip.
 */
const RING: Record<SessionState, string> = {
  working: '', // cc-orbit takes over the background
  waiting_approval: 'var(--color-beacon)',
  error: 'var(--color-beacon)',
  waiting_input: 'var(--color-ash)',
  limited: 'var(--color-slate)',
  idle: 'transparent',
}

function ToolMark({ tool, state }: { tool: ToolName; state: SessionState }) {
  const meta = useToolMeta(tool)
  const label = `${meta.label} · ${stateLabel(state)}`
  const stalled = state === 'limited' || state === 'error'
  // Spins at **the same angle** as a grid panel's border (components/orbit.ts)
  useOrbitSync(state === 'working')

  return (
    <span
      className={`shrink-0 rounded-[5px] p-[1.5px] ${state === 'working' ? 'cc-orbit' : ''}`}
      style={state === 'working' ? undefined : { background: RING[state] }}
      title={label}
      aria-label={label}
      data-testid={`tool-mark-${tool}`}
      data-state={state}
    >
      <span
        /*
         * A dark letter on a bright chip — grabs the eye in the list at a glance, but pure white
         * (beacon) is not used. That belongs to "something is waiting for me," and using it here
         * would bury the real signal. One step down, chalk, is used instead. The letter is set in
         * the terminal font (monospace) — a single-character glyph needs a fixed width, or the row
         * would jitter.
         */
        /*
          A bright letter on a dark background. With a bright chip, the spinning orbit ring got
          buried in that brightness, and 'working' itself became invisible — the mark doubles as
          the state indicator, and if the state cannot be seen, moving the mark here loses its
          point.

          The sidebar background (pit) and the chip background (void) differ by only two steps, so
          a single border does not separate them well. Instead of raising the border brightness
          further, **the same treatment as a keycap** (cc-chip) is used: a 1px highlight on top and
          a shadow underneath. It reads as a separate object without spending more brightness, and
          brightness is the resource this app uses to state urgency, so spending it on decoration
          would cut into that signal by the same amount.
        */
        className={`readout cc-chip flex size-[14px] items-center justify-center rounded-[3.5px] border border-graphite bg-void text-[9px] font-semibold leading-none text-chalk ${
          stalled ? 'opacity-50' : ''
        }`}
      >
        {meta.mark}
      </span>
    </span>
  )
}

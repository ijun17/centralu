import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { FsEntry } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { useProjectMachine } from '../../store/selectors.js'
import { useRemoteIde, type RemoteIde } from '../machines/remoteIde.js'
import { ChevronIcon } from '../../components/icons.jsx'
import { iconForFile } from './fileIcon.js'
import { hasDragFiles, hasDragPath, readDragPath, setDragPath } from './dragPath.js'
import { TabActions } from '../evidence/tabActions.jsx'

/**
 * The file tree (FR-5, C-2).
 * A lazy load — only a directory that has actually been opened is read. The first render has to
 * stay light even in a repository with 10k+ files.
 *
 * **Ignored files are shown by default** (issue #17). They used to be hidden until you
 * found this checkbox, and a hidden row does not look filtered — it looks like the file is
 * not there. That is the wrong first impression for a tree whose job is "show me this
 * repo", and the file you came for is often exactly the untracked one.
 *
 * The toggle stays, because of what `.gitignore` covers: not a curiosity or two but
 * `node_modules`, `dist`, `.next` — thousands of rows that sort in among `src`. Anyone
 * drowning in those turns it off once and it stays off, which is only true since the switch
 * stopped being component state: leaving for the Git tab or collapsing the panel used to
 * put it back, so "can't see ignored files" really meant "you can, but it forgets". It
 * lives on the store now and comes back with the rest of the panel's layout. Whether it is
 * on is a way of looking, so unlike expanded folders (#16, which belong to a project) it is
 * one setting for the whole app.
 *
 * **The tree can now change files, not only show them** (#18, #19). Four operations and no
 * more: reveal, drag one in, drag one around, move one to the trash. Create, rename,
 * copy/paste, multi-select and filtering are deliberately absent — this app is a place to
 * watch an agent work, not an editor, and each of those brings a mode or a dialog with it.
 * Operations apply to ignored files like any other: they are ordinary files (#17), and the
 * untracked one is often exactly the one you came to move.
 */
export function FileTree({ projectId }: { projectId: string }) {
  const showIgnored = useStore((s) => s.showIgnored)
  const setShowIgnored = useStore((s) => s.setShowIgnored)
  const [version, setVersion] = useState<Record<string, number>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)

  /*
   * The side that made a change signals that it should be re-read.
   *
   * Right after we make a change ourselves, there is no reason to wait for the watcher (#34) — the
   * moment already knows what changed, so **only the changed directory's** stamp is bumped
   * immediately. Re-reading the whole tree would be the shorter code, but in a repository with
   * twenty folders expanded, one move would turn into twenty list requests — exactly what this
   * file's header comment's lazy principle exists to prevent.
   */
  const refresh = useCallback((...dirs: string[]) => {
    setVersion((v) => {
      const next = { ...v }
      for (const d of dirs) next[d] = (next[d] ?? 0) + 1
      return next
    })
  }, [])

  /*
   * And now **a change made outside** is also reported (#34).
   *
   * The watched set is exactly the expanded directories — not the whole repository. A folder the
   * lazy tree has not read is not on screen, so there is no reason to watch it either, and that
   * keeps it from ever hitting Linux's inotify limit (one watch per directory). The root ('') is
   * always visible, so it is always included.
   *
   * This uses the same stamp table as `refresh` above (right after we make a change ourselves) —
   * whether the source of "it changed" is us, Finder, or an agent, the screen's job is the same:
   * "re-read that one directory."
   */
  const platform = usePlatform()
  const expanded = useStore((s) => s.expandedDirs[projectId])
  useEffect(() => {
    // A failed watch registration must not break the tree — watching is a side glance, not the main job
    void platform.fs.watch(projectId, ['', ...(expanded ?? [])]).catch(() => {})
  }, [platform, projectId, expanded])
  useEffect(() => {
    // The watch is only torn down when leaving the project. Tearing it down and re-setting it
    // every time the expanded set changes would miss whatever changed in between — the effect
    // above only swaps out the watched set.
    return () => {
      void platform.fs.watch(projectId, []).catch(() => {})
    }
  }, [platform, projectId])
  useEffect(
    () =>
      platform.agents.subscribe((e) => {
        if (e.type === 'fs_changed' && e.projectId === projectId) refresh(...e.dirs)
      }),
    [platform, projectId, refresh],
  )

  /*
   * There is **only one** folder currently being targeted.
   *
   * Each row used to hold its own state at first, but when an inner folder intercepted the drop (the
   * closest one wins), the outer folder had no way to know the cursor had left it, and both stayed
   * lit. Two lit spots means the screen gives two answers to "where will it go" — a fact that has
   * only one answer needs to be tracked as only one piece of state.
   */
  const [hover, setHover] = useState<string | null>(null)
  const ops = useFileOps(projectId, refresh)
  /*
   * The row menu's two verbs act on this computer's files through the desktop shell (reveal in the file manager, move
   * to the OS trash), so a project on a linked machine never gets them (#82): its paths are the other machine's. What
   * it gets instead is VS Code over Remote-SSH, the one editor that can open that machine's path from here; with no
   * way to reach it (a WSL machine), there is no menu at all.
   */
  const remote = useProjectMachine(projectId) !== null
  const remoteIde = useRemoteIde(projectId)
  const openMenu = useCallback(
    (target: MenuTarget, x: number, y: number) => {
      if (!remote || remoteIde) setMenu({ target, x, y })
    },
    [remote, remoteIde],
  )
  const ctx = useMemo(
    () => ({ projectId, version, ops, openMenu, hover, setHover, remoteIde }),
    [projectId, version, ops, openMenu, hover, remoteIde],
  )

  return (
    <TreeCtx.Provider value={ctx}>
      <section className="flex min-h-0 flex-1 flex-col" data-testid="file-tree">
        {/*
          Controls live at the right end of the tab strip (user request, 2026-09-07) — drawing yet
          another header bar here would have effectively written "Project files" a second time
          directly under the 'Files' tab.
        */}
        <TabActions>
          {/*
            The project itself, for a project on a linked machine (#82): its folder in VS Code over Remote-SSH. A row's
            menu opens one file or folder; this is the door to the whole project, which has no row of its own.
          */}
          {remoteIde && (
            <button
              type="button"
              className="shrink-0 text-xs text-ink-faint transition-colors hover:text-ink"
              onClick={() => void remoteIde.open('')}
              title={remoteIde.title}
              data-testid="file-tree-open-vscode"
            >
              {remoteIde.label}
            </button>
          )}
          {/* 'Ignored' alone read as a state, not an action — it is the showing that is optional */}
          <label
            className="flex shrink-0 items-center gap-1.5 text-xs text-ink-faint"
            title="Show what .gitignore hides — node_modules, build output, local files"
          >
            <input
              type="checkbox"
              className="accent-line-strong"
              checked={showIgnored}
              onChange={(e) => setShowIgnored(e.target.checked)}
              data-testid="toggle-ignored"
            />
            Show ignored
          </label>
        </TabActions>
        <TreeRoot showIgnored={showIgnored} projectId={projectId} />
      </section>
      {menu && <RowMenu state={menu} close={() => setMenu(null)} />}
    </TreeCtx.Provider>
  )
}

/**
 * Where the list lives, and also **the project root's drop target**.
 *
 * The empty space below the last row stands for the root. Without it, there would be no way to pull
 * something inside a folder back out — the root is the one directory with no row of its own, so
 * there is nowhere else to target it.
 */
function TreeRoot({ projectId, showIgnored }: { projectId: string; showIgnored: boolean }) {
  const drop = useDropTarget('')
  return (
    <div
      className={`min-h-0 flex-1 overflow-auto py-1 ${drop.over ? 'bg-surface-hover/15' : ''}`}
      data-testid="file-drop-root"
      {...drop.handlers}
    >
      <Dir projectId={projectId} path="" depth={0} showIgnored={showIgnored} defaultOpen />
    </div>
  )
}

type MenuTarget = { path: string; name: string; isDir: boolean }
type MenuState = { target: MenuTarget; x: number; y: number }

type TreeContext = {
  projectId: string
  /** A stamp bumped for each directory that needs re-reading — stands in for a watcher */
  version: Record<string, number>
  ops: FileOps
  openMenu: (target: MenuTarget, x: number, y: number) => void
  /** The folder currently targeted (`''` is the root). Only one spot on screen is ever lit at a time */
  hover: string | null
  setHover: (dir: string | null) => void
  /** For a project on a linked machine VS Code can reach (#82): the row menu's one verb. Null for this computer's */
  remoteIde: RemoteIde | null
}

const TreeCtx = createContext<TreeContext | null>(null)

function useTree(): TreeContext {
  const ctx = useContext(TreeCtx)
  if (!ctx) throw new Error('FileTree rows must be rendered inside FileTree')
  return ctx
}

/** `src/app/a.ts` → `src/app`. The root is an empty string — exactly the notation listDir uses */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * The four things the tree does to files (#18, #19).
 *
 * **Success is quiet, failure is loud.** The result of a move is already visible as the row itself
 * moving, so adding a toast would be noise, but a failure moves nothing, so without a word it becomes
 * a 'silent no-op' — exactly what this project forbids. Only the trash also announces success: a row
 * disappearing only says "it was deleted" as far as that goes, and the promise that **it can be
 * brought back** (which is the whole point of #18's decision) only comes across by stating where it
 * went.
 */
function useFileOps(projectId: string, refresh: (...dirs: string[]) => void) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)

  return useMemo(
    () => ({
      reveal: async (target: MenuTarget) => {
        try {
          const res = await platform.fs.reveal(projectId, target.path)
          if (!res.supported) setToast(res.reason ?? 'Showing files is not available here')
        } catch (e) {
          setToast(`Could not show ${target.name}: ${(e as Error).message}`)
        }
      },
      trash: async (target: MenuTarget) => {
        try {
          const res = await platform.fs.trash(projectId, target.path)
          if (!res.supported) return setToast(res.reason ?? 'Deleting files is not available here')
          refresh(parentOf(target.path))
          setToast(`Moved to Trash: ${target.name} — put it back from there`)
        } catch (e) {
          setToast(`Could not delete ${target.name}: ${(e as Error).message}`)
        }
      },
      move: async (from: string, toDir: string) => {
        try {
          const res = await platform.fs.move(projectId, from, toDir)
          // moved:false means it was dropped back where it already was — a missed drop, not a failure, so nothing is said
          if (res.moved) refresh(parentOf(from), toDir)
        } catch (e) {
          setToast((e as Error).message)
        }
      },
      importFiles: async (files: File[], toDir: string) => {
        for (const file of files) {
          try {
            await platform.fs.importFile(projectId, toDir, file.name, await readBase64(file))
            refresh(toDir)
          } catch (e) {
            setToast((e as Error).message)
          }
        }
      },
    }),
    [platform, projectId, refresh, setToast],
  )
}

type FileOps = ReturnType<typeof useFileOps>

/**
 * Turns one file into base64.
 *
 * A dataURL has the shape `data:<mime>;base64,<body>`, so stripping the prefix leaves it directly
 * usable, and the browser does the conversion. Handling the bytes directly makes string
 * concatenation freeze the screen for tens of seconds on a large file, and the symptom reported as
 * "the file will not attach" for attachments was actually exactly this.
 */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

/**
 * A drop target for something — either a single folder row, or the whole tree (= the project root).
 *
 * **Where it is dropped decides what happens.** Dragging the same file row, dropping it on the
 * composer puts the path into the sentence (the pre-existing behavior, `dragPath.ts`), while
 * dropping it here moves the file. The two never get mixed up because the composer knows nothing
 * about this spot and this spot knows nothing about the composer.
 *
 * What arrived is told apart **by what it carries**: our own MIME type means a move within the tree,
 * an OS file means something dragged in from outside. If it is neither, `preventDefault` is not
 * called — which lets the browser tell the person "this cannot be dropped here" through the cursor.
 */
function useDropTarget(dir: string) {
  const { ops, hover, setHover } = useTree()
  const accepts = (dt: DataTransfer) => hasDragPath(dt) || hasDragFiles(dt)

  return {
    over: hover === dir,
    handlers: {
      onDragOver: (e: ReactDragEvent<HTMLElement>) => {
        if (!accepts(e.dataTransfer)) return
        e.preventDefault()
        // Once an inner folder is targeted, the outer folder and root are not — the closest spot wins
        e.stopPropagation()
        // Something dragged from within the tree is a move, while a file from outside is a copy
        // coming in. Without the cursor stating this, there would be no way to know what will
        // happen before letting go.
        e.dataTransfer.dropEffect = hasDragPath(e.dataTransfer) ? 'move' : 'copy'
        setHover(dir)
      },
      onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
        // A leave event also fires when entering a child, so only an actual exit outward is honored
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null)
      },
      onDrop: (e: ReactDragEvent<HTMLElement>) => {
        if (!accepts(e.dataTransfer)) return
        e.preventDefault()
        e.stopPropagation()
        setHover(null)
        const from = readDragPath(e.dataTransfer)
        if (from) return void ops.move(from, dir)
        void ops.importFiles([...e.dataTransfer.files], dir)
      },
    },
  }
}

function Dir({
  projectId,
  path,
  depth,
  showIgnored,
  defaultOpen = false,
}: {
  projectId: string
  path: string
  depth: number
  showIgnored: boolean
  defaultOpen?: boolean
}) {
  const platform = usePlatform()
  const { version } = useTree()
  const open = defaultOpen
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const stamp = version[path] ?? 0

  /*
   * `entries` was used as a guard to avoid re-reading once it had been read, but that also blocked
   * it **even when the input changed.** Picking a session in a different project changed projectId,
   * but it still bailed out early because entries was already populated, so the file tree kept
   * showing the old project (a dogfooding finding).
   *
   * Removing the guard still does not cause repeated reads — this effect only runs when open,
   * projectId or path **actually change.** The condition "do not re-read" is expressed through
   * dependencies, not simulated with state. `stamp` is included for the same reason: the fact that
   * the list needs re-reading after a file is moved or deleted is also expressed through a
   * dependency, not simulated with state.
   *
   * The project can change again while a response is still in flight, so a late response is
   * discarded.
   */
  useEffect(() => {
    if (!open) return
    let alive = true
    void platform.fs
      .listDir(projectId, path)
      .then((e) => alive && setEntries(e))
      .catch(() => alive && setEntries([]))
    return () => {
      alive = false
    }
  }, [open, platform, projectId, path, stamp])

  if (!open && depth > 0) return null
  const visible = (entries ?? []).filter((e) => showIgnored || !e.ignored)

  return (
    <ul>
      {visible.map((e) =>
        e.isDir ? (
          <DirRow key={e.path} entry={e} projectId={projectId} depth={depth} showIgnored={showIgnored} />
        ) : (
          <FileRow key={e.path} entry={e} depth={depth} />
        ),
      )}
      {entries?.length === 0 && depth === 0 && <li className="px-3 py-2 text-sm text-ink-faint">Empty</li>}
    </ul>
  )
}

/**
 * Whether a folder is open is **the project's** fact, not this row's (issue #16).
 *
 * It used to be `useState` here, so it died with the component: moving between two sessions
 * of the same repo collapsed the whole tree and you dug down the same path again. Drafts
 * had the same shape of bug and moved onto the session — this one moves onto the *project*,
 * because an expanded folder is a fact about the code rather than about a conversation.
 * Two sessions on one repo want the same tree open; two projects almost never do.
 *
 * The whole `<li>` takes the drop, not just the row: everything inside a folder renders
 * inside its `<li>`, so letting go over a file two levels down lands in the folder that
 * file is in — which is where someone aiming at it expects it to land.
 */
function DirRow({
  entry,
  projectId,
  depth,
  showIgnored,
}: {
  entry: FsEntry
  projectId: string
  depth: number
  showIgnored: boolean
}) {
  const open = useStore((s) => s.expandedDirs[projectId]?.includes(entry.path) ?? false)
  const toggleDir = useStore((s) => s.toggleDir)
  const { openMenu } = useTree()
  const drop = useDropTarget(entry.path)

  return (
    <li data-testid={`file-drop-${entry.path}`} {...drop.handlers}>
      <button
        className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-sm transition-colors hover:text-ink ${
          drop.over ? 'bg-surface-hover/40 text-ink' : 'text-ink-muted'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => toggleDir(projectId, entry.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu({ path: entry.path, name: entry.name, isDir: true }, e.clientX, e.clientY)
        }}
        data-testid={`dir-${entry.path}`}
        /* A folder is also moved as a whole — a tree where only files can be moved only works halfway */
        draggable
        onDragStart={(e) => setDragPath(e.dataTransfer, entry.path)}
      >
        {/* Same width as a file's extension column — so folder names and file names line up */}
        <span className="flex w-7 shrink-0 justify-center text-ink-faint">
          <ChevronIcon open={open} />
        </span>
        <span className={`truncate ${entry.ignored ? 'text-ink-faint' : ''}`}>{entry.name}</span>
      </button>
      {open && <Dir projectId={projectId} path={entry.path} depth={depth + 1} showIgnored={showIgnored} defaultOpen />}
    </li>
  )
}

function FileRow({ entry, depth }: { entry: FsEntry; depth: number }) {
  const openFile = useStore((s) => s.openFile)
  const current = useStore((s) => s.viewerPath)
  const { openMenu, projectId } = useTree()
  const touched = useTouched(projectId)

  return (
    <li>
      <button
        className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-sm transition-colors ${
          current === entry.path ? 'bg-surface-hover/40 text-ink' : entry.ignored ? 'text-ink-faint' : 'text-ink-muted hover:text-ink'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => openFile(entry.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu({ path: entry.path, name: entry.name, isDir: false }, e.clientX, e.clientY)
        }}
        data-testid={`file-${entry.path}`}
        /* The shortest path to putting a file into the conversation — no need to memorize and type
           the path. The same drag becomes a 'move' when dropped on a folder (the drop target
           decides which) */
        draggable
        onDragStart={(e) => setDragPath(e.dataTransfer, entry.path)}
      >
        <FileKind name={entry.name} />
        <span className="truncate">{entry.name}</span>
        {/* A file the agent just touched (FR-5) — a symbol, not a color */}
        {touched.has(entry.path) && (
          <span className="ml-auto shrink-0 text-2xs text-ink-faint" title="Edited by agent">
            ◆
          </span>
        )}
      </button>
    </li>
  )
}

/**
 * The right-click menu (#18, #19).
 *
 * **The reason delete is here** is the reason this menu exists at all. Putting a delete button on
 * the row means a hand aiming to open something could land on delete instead, and opening and
 * deleting have very different costs to undo. A right click is an entirely different action from a
 * left click, so it cannot be pressed by mistake, and there was nothing already using right-click on
 * a tree row to take over from.
 *
 * There is no confirmation dialog — that is #18's decision. The trash can be undone **even after**
 * pressing it, while a dialog can only be undone before pressing it. A dialog that asks ends up
 * being clicked through reflexively anyway, so an undoable delete is always the better choice.
 */
function RowMenu({ state, close }: { state: MenuState; close: () => void }) {
  const { ops, remoteIde } = useTree()
  const fileManager = usePlatform().capabilities.fileManagerName
  const rootRef = useRef<HTMLDivElement>(null)

  /*
   * Closes on an outside click and on Escape (the same handling as SessionSettings).
   * **It has to exclude itself** — mousedown fires before click, so closing it even for a click
   * inside would make the menu disappear the instant an item is pressed, and the click would land
   * on nothing.
   */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Only the innermost open thing closes — the inbox or a modal must not close along with it
      e.stopPropagation()
      close()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [close])

  const { target } = state
  /*
   * Placed after converting to layout pixels (#183) — the same rule as the sidebar menu (RowMenu).
   * The click coordinates and the window size are screen pixels already multiplied by zoom
   * (--text-zoom), but the left/top set here are lengths inside the zoomed root, so zoom gets
   * multiplied in a second time when rendered. Used as-is, the menu appeared below and to the right
   * of the click at zoom 1.25, and near the right edge of the window it ran off the window entirely.
   */
  const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
  /*
   * A project on a linked machine (#82): neither this computer's file manager nor its trash holds that machine's file,
   * so the menu has the one verb that reaches it. A folder opens as a VS Code folder, a file as a file.
   */
  if (remoteIde) {
    return (
      <div
        ref={rootRef}
        role="menu"
        data-testid="file-menu"
        className="fixed z-40 w-56 overflow-hidden rounded-md border border-line bg-surface-raised shadow-(--shadow-popover)"
        style={{
          left: Math.min(state.x / zoom, window.innerWidth / zoom - 232),
          top: Math.min(state.y / zoom, window.innerHeight / zoom - 40),
        }}
      >
        <button
          type="button"
          role="menuitem"
          data-testid="file-menu-vscode"
          title={remoteIde.title}
          className="block w-full truncate px-2.5 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/25 hover:text-ink"
          onClick={() => {
            close()
            void remoteIde.open(target.path, target.isDir ? undefined : {})
          }}
        >
          {remoteIde.label}
        </button>
      </div>
    )
  }
  return (
    <div
      ref={rootRef}
      role="menu"
      data-testid="file-menu"
      className="fixed z-40 w-56 overflow-hidden rounded-md border border-line bg-surface-raised shadow-(--shadow-popover)"
      // Opening it near the edge of the screen would push the menu off the window — pulled back inward
      style={{
        left: Math.min(state.x / zoom, window.innerWidth / zoom - 232),
        top: Math.min(state.y / zoom, window.innerHeight / zoom - 76),
      }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="file-menu-reveal"
        title={`Show ${target.name} in ${fileManager}`}
        className="block w-full truncate px-2.5 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/25 hover:text-ink"
        onClick={() => {
          close()
          void ops.reveal(target)
        }}
      >
        Reveal in {fileManager}
      </button>
      {/*
        Delete is set apart below a divider. With the two items touching, it would be easy to
        confuse the top one for the bottom one — pressing the top one by mistake just opens a
        window, while pressing the bottom one makes the file disappear.
      */}
      <button
        type="button"
        role="menuitem"
        data-testid="file-menu-trash"
        title="Moves it to the Trash — you can put it back from there"
        className="block w-full truncate border-t border-line px-2.5 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/25 hover:text-ink"
        onClick={() => {
          close()
          void ops.trash(target)
        }}
      >
        Move {target.isDir ? 'folder' : 'file'} to Trash
      </button>
    </div>
  )
}

/**
 * The file-kind mark — vscode-icons (MIT).
 *
 * A familiar picture lets the kind register before the name is even read. This app started out by
 * stripping out all color, so bringing color in at all is itself a decision — but a file's kind is a
 * **classification, not a state**, so it does not overlap with the brightness system ("the
 * brightest thing = something waiting for me"). The icons are small and low-saturation, so they do
 * not pull the eye away from skimming the list either.
 *
 * An extension missing from the table falls back to the default file icon — even if the list falls
 * behind, there is never a blank.
 */
function FileKind({ name }: { name: string }) {
  return (
    <img
      src={iconForFile(name)}
      alt=""
      width={13}
      height={13}
      className="w-7 shrink-0 px-[7px]"
      draggable={false}
      aria-hidden
      data-file-icon
    />
  )
}

/**
 * The derived calculation is memoized in the hook (a selector that builds a new array causes an
 * infinite re-render).
 * Only sessions belonging to this tree's project are collected (#185) — paths are relative to the
 * project, so a path with the same name touched by a session in a different project must not get
 * marked.
 */
function useTouched(projectId: string): Set<string> {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => {
    const set = new Set<string>()
    for (const s of Object.values(sessions)) {
      if (s.projectId === projectId) for (const p of s.touchedPaths) set.add(p)
    }
    return set
  }, [sessions, projectId])
}

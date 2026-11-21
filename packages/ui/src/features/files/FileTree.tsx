import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { FsEntry } from '@cc/platform/ports'
import { errorMessage, wireParent } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { useStore } from '../../store/store.js'
import { useProjectMachine } from '../../store/selectors.js'
import { useRemoteIde, type RemoteIde } from '../machines/remoteIde.js'
import { useAnchoredPlacement } from '../../components/anchored.js'
import { ChevronIcon } from '../../components/icons.jsx'
import { useDismiss } from '../../components/useDismiss.js'
import { iconForFile } from './fileIcon.js'
import { hasDragFiles, hasDragPath, readDragPath, setDragPath } from './dragPath.js'
import { TabActions } from '../evidence/tabActions.jsx'

/**
 * The file tree (FR-5), read lazily per opened folder. Ignored files show by default (#17): a hidden row looks absent and
 * the untracked file is often the one sought; the toggle is one app-wide store setting. Four operations only (#18, #19):
 * reveal, drag in, drag around, trash. No create, rename, copy or multi-select: this app watches an agent, it is no editor.
 */
export function FileTree({ projectId }: { projectId: string }) {
  const showIgnored = useStore((s) => s.showIgnored)
  const setShowIgnored = useStore((s) => s.setShowIgnored)
  const [version, setVersion] = useState<Record<string, number>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Our own change bumps only the changed directory's stamp, without waiting for the watcher (#34); re-reading the whole
  // tree would cost one request per open folder.
  const refresh = useCallback((...dirs: string[]) => {
    setVersion((v) => {
      const next = { ...v }
      for (const d of dirs) next[d] = (next[d] ?? 0) + 1
      return next
    })
  }, [])

  // Outside changes (#34) bump the same stamps. Only the root and open folders are watched (FR-5), which also keeps clear
  // of Linux's inotify limit (one watch per directory).
  const platform = usePlatform()
  const expanded = useStore((s) => s.expandedDirs[projectId])
  // Watches live in the host's memory under the window's connection (#842 item 6), so they are resent on every reconnect
  // and resync: a restarted or switched host holds none (#972 item 3). A resync also re-reads open folders, since changes
  // made while nothing watched were never reported.
  const connected = useStore((s) => s.connection === 'connected')
  const hostResyncs = useStore((s) => s.hostResyncs)
  useEffect(() => {
    if (!connected) return
    // A failed watch must not break the tree; it is reported (#841)
    void useStore.getState().watchProjectDirs(projectId, ['', ...(expanded ?? [])])
  }, [projectId, expanded, connected, hostResyncs])
  const resyncsSeen = useRef(hostResyncs)
  useEffect(() => {
    if (resyncsSeen.current === hostResyncs) return
    resyncsSeen.current = hostResyncs
    refresh('', ...(useStore.getState().expandedDirs[projectId] ?? []))
  }, [hostResyncs, projectId, refresh])
  useEffect(() => {
    // Torn down only when leaving the project: re-setting it on each expand would miss changes in between
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

  // One targeted folder for the whole tree: with per-row state, an inner folder taking the drop leaves the outer one lit
  const [hover, setHover] = useState<string | null>(null)
  const ops = useFileOps(projectId, refresh)
  // Reveal and trash act on this computer's files, so a linked machine's project (#82) gets VS Code over Remote-SSH
  // instead, and no menu when VS Code cannot reach it (a WSL machine).
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
          In the tab strip: a header bar here would repeat the Files tab.
        */}
        <TabActions>
          {/* 'Ignored' alone read as a state; it is the showing that is optional */}
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

/** Also the root's drop target: the root has no row, so the space below the last row stands for it */
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
  /** Bumped per directory to re-read */
  version: Record<string, number>
  ops: FileOps
  openMenu: (target: MenuTarget, x: number, y: number) => void
  /** The targeted folder (`''` is the root) */
  hover: string | null
  setHover: (dir: string | null) => void
  /** A linked machine's project VS Code can reach (#82); null for this computer's */
  remoteIde: RemoteIde | null
}

const TreeCtx = createContext<TreeContext | null>(null)

function useTree(): TreeContext {
  const ctx = useContext(TreeCtx)
  if (!ctx) throw new Error('FileTree rows must be rendered inside FileTree')
  return ctx
}

/**
 * Success is quiet, since the rows move; a failure is always said. Trash also says where the file went, since that it can
 * be put back is the point of #18.
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
          setToast(`Could not show ${target.name}: ${errorMessage(e)}`)
        }
      },
      trash: async (target: MenuTarget) => {
        try {
          const res = await platform.fs.trash(projectId, target.path)
          if (!res.supported) return setToast(res.reason ?? 'Deleting files is not available here')
          refresh(wireParent(target.path))
          setToast(`Moved to Trash: ${target.name} — put it back from there`)
        } catch (e) {
          setToast(`Could not delete ${target.name}: ${errorMessage(e)}`)
        }
      },
      move: async (from: string, toDir: string) => {
        try {
          const res = await platform.fs.move(projectId, from, toDir)
          // moved:false: dropped where it was, a miss rather than a failure
          if (res.moved) refresh(wireParent(from), toDir)
        } catch (e) {
          setToast(errorMessage(e))
        }
      },
      importFiles: async (files: File[], toDir: string) => {
        for (const file of files) {
          try {
            await platform.fs.importFile(projectId, toDir, file.name, await readBase64(file))
            refresh(toDir)
          } catch (e) {
            setToast(errorMessage(e))
          }
        }
      },
    }),
    [platform, projectId, refresh, setToast],
  )
}

type FileOps = ReturnType<typeof useFileOps>

/** Through a data URL, so the browser converts: building the string from bytes froze the screen for tens of seconds on a large file */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

/**
 * A folder row, or the whole tree for the root. Our path moves, an OS file is imported; anything else is not
 * `preventDefault`ed, so the cursor says it cannot drop here.
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
        // The closest folder wins
        e.stopPropagation()
        // The cursor says move or copy before the hand lets go
        e.dataTransfer.dropEffect = hasDragPath(e.dataTransfer) ? 'move' : 'copy'
        setHover(dir)
      },
      onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
        // Leave also fires on entering a child
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
  const stamp = version[path] ?? 0

  // No "already read" guard on `entries`: it would also block the read for a new project. The deps (`stamp` included)
  // decide when to read, and useLoad drops a late answer.
  const read = useLoad(() => (open ? platform.fs.listDir(projectId, path) : null), [open, platform, projectId, path], [stamp])
  const entries: FsEntry[] | undefined = read.data

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
      {/* A failed read says so, not "Empty" at the top or nothing inside a folder (#850 item 8) */}
      {read.error !== null && (
        <li>
          <LoadFailed
            what={depth === 0 ? 'the files' : 'this folder'}
            error={read.error}
            onRetry={() => void read.reload()}
            className="px-3 py-1"
            testId={depth === 0 ? 'file-tree-failed' : undefined}
          />
        </li>
      )}
    </ul>
  )
}

/**
 * Open folders live on the project (#16): a fact about the code, shared by its sessions and kept across them. The whole
 * `<li>` takes the drop, so letting go over a nested file lands in its folder.
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
          drop.over ? 'bg-surface-hover/40 text-ink' : 'text-ink-muted hover:bg-surface-hover/20'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => toggleDir(projectId, entry.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu({ path: entry.path, name: entry.name, isDir: true }, e.clientX, e.clientY)
        }}
        data-testid={`dir-${entry.path}`}
        /* A folder moves as a whole too */
        draggable
        onDragStart={(e) => setDragPath(e.dataTransfer, entry.path)}
      >
        {/* The icon column's width, so folder and file names line up */}
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
          // The same hover and selected pair as a changed file and a commit row
          current === entry.path
            ? 'bg-surface-selected text-ink'
            : `hover:bg-surface-hover/20 hover:text-ink ${entry.ignored ? 'text-ink-faint' : 'text-ink-muted'}`
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => openFile(entry.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu({ path: entry.path, name: entry.name, isDir: false }, e.clientX, e.clientY)
        }}
        data-testid={`file-${entry.path}`}
        /* Into the conversation as a path, or onto a folder as a move: the drop target decides */
        draggable
        onDragStart={(e) => setDragPath(e.dataTransfer, entry.path)}
      >
        <FileKind name={entry.name} />
        <span className="truncate">{entry.name}</span>
        {/* A file the agent just touched (FR-5): a dot, not a colour */}
        {touched.has(entry.path) && (
          <span
            className="ml-auto mr-1 size-1.5 shrink-0 rounded-full bg-ink-muted"
            title="Edited by agent"
            role="img"
            aria-label="Edited by agent"
          />
        )}
      </button>
    </li>
  )
}

/**
 * Delete lives on right click (#18, #19), where no hand aiming to open lands. No confirmation (#18): the trash undoes
 * after the press, and a dialog gets clicked through.
 */
function RowMenu({ state, close }: { state: MenuState; close: () => void }) {
  const { ops, remoteIde } = useTree()
  const fileManager = usePlatform().capabilities.fileManagerName
  const rootRef = useRef<HTMLDivElement>(null)

  // Excludes itself: mousedown precedes click, so an item press would close the menu first
  useDismiss({ onClose: close, refs: [rootRef] })
  // `state` is in zoomed screen pixels, left/top in layout pixels (#183, anchored.ts). Measured, so near the right or
  // bottom edge it opens up and left of the pointer.
  const place = useAnchoredPlacement({ x: state.x, y: state.y }, rootRef, true)
  const shell = {
    ref: rootRef,
    role: 'menu',
    'data-testid': 'file-menu',
    className:
      'fixed z-40 w-56 overflow-y-auto rounded-lg border border-line bg-surface-raised p-1 shadow-(--shadow-popover)',
    style: {
      left: place?.left ?? 0,
      top: place?.top ?? 0,
      maxHeight: place?.maxHeight,
      visibility: place ? 'visible' : 'hidden',
    } as const,
  }

  const { target } = state
  // A linked machine's file (#82): a folder opens as a VS Code folder, a file as a file
  if (remoteIde) {
    return (
      <div {...shell}>
        <button
          type="button"
          role="menuitem"
          data-testid="file-menu-vscode"
          title={remoteIde.title}
          className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/60 hover:text-ink"
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
    <div {...shell}>
      <button
        type="button"
        role="menuitem"
        data-testid="file-menu-reveal"
        title={`Show ${target.name} in ${fileManager}`}
        className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/60 hover:text-ink"
        onClick={() => {
          close()
          void ops.reveal(target)
        }}
      >
        Reveal in {fileManager}
      </button>
      {/*
        Delete sits below a divider: a slip on Reveal opens a window, a slip on delete removes the file.
      */}
      <div className="my-1 border-t border-line" />
      <button
        type="button"
        role="menuitem"
        data-testid="file-menu-trash"
        title="Moves it to the Trash — you can put it back from there"
        className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-hover/60 hover:text-ink"
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
 * In colour: a file's kind is a classification, not a state, so it stays out of the brightness order (brightest = waiting
 * for you); small, low-saturation icons do not pull the eye from the list.
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
 * Memoized here: a selector building a new set would re-render forever. Only this project's sessions (#185), since paths
 * are project-relative.
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

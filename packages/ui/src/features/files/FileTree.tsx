import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { FsEntry } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { ChevronIcon } from '../../components/icons.jsx'
import { iconForFile } from './fileIcon.js'
import { hasDragFiles, hasDragPath, readDragPath, setDragPath } from './dragPath.js'

/**
 * 파일 트리 (FR-5, C-2).
 * lazy 로드 — 열어본 디렉토리만 읽는다. 10k+ 저장소에서도 첫 렌더가 가벼워야 한다.
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
   * 바꾼 쪽이 다시 읽으라고 알려준다.
   *
   * 파일 감시자가 없다 (#34는 따로 간다). 그래서 "무엇이 바뀌었는지"를 아는 유일한 시점은
   * 우리가 바꾼 직후이고, 그때 **바뀐 디렉토리만** 표를 올린다. 트리 전체를 다시 읽는 쪽이
   * 짧게 끝나지만, 열어둔 폴더가 스무 개인 저장소에서는 옮기기 한 번이 목록 요청 스무 개가
   * 된다 — 이 파일 머리말의 lazy 원칙이 막으려는 것이 그것이다.
   */
  const refresh = useCallback((...dirs: string[]) => {
    setVersion((v) => {
      const next = { ...v }
      for (const d of dirs) next[d] = (next[d] ?? 0) + 1
      return next
    })
  }, [])

  /*
   * 지금 겨누고 있는 폴더는 **하나뿐이다.**
   *
   * 처음엔 자리마다 자기 상태를 들고 있었는데, 안쪽 폴더가 드롭을 가로채면(가장 가까운
   * 자리가 이긴다) 바깥 폴더는 커서가 떠난 것을 알 방법이 없어 둘 다 밝은 채로 남았다.
   * 밝은 자리가 둘이면 어디로 갈지 화면이 답을 두 개 하는 셈이다 — 답이 하나뿐인 사실은
   * 상태도 하나여야 한다.
   */
  const [hover, setHover] = useState<string | null>(null)
  const ops = useFileOps(projectId, refresh)
  const openMenu = useCallback((target: MenuTarget, x: number, y: number) => setMenu({ target, x, y }), [])
  const ctx = useMemo(
    () => ({ projectId, version, ops, openMenu, hover, setHover }),
    [projectId, version, ops, openMenu, hover],
  )

  return (
    <TreeCtx.Provider value={ctx}>
      <section className="flex min-h-0 flex-1 flex-col" data-testid="file-tree">
        <header className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
          <span className="text-[11px] text-slate">Project files</span>
          {/* 'Ignored' alone read as a state, not an action — it is the showing that is optional */}
          <label
            className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-slate"
            title="Show what .gitignore hides — node_modules, build output, local files"
          >
            <input
              type="checkbox"
              className="accent-graphite"
              checked={showIgnored}
              onChange={(e) => setShowIgnored(e.target.checked)}
              data-testid="toggle-ignored"
            />
            Show ignored
          </label>
        </header>
        <TreeRoot showIgnored={showIgnored} projectId={projectId} />
      </section>
      {menu && <RowMenu state={menu} close={() => setMenu(null)} />}
    </TreeCtx.Provider>
  )
}

/**
 * 목록이 사는 자리이자 **프로젝트 루트의 드롭 자리**.
 *
 * 마지막 줄 아래의 빈 공간이 루트를 뜻한다. 이게 없으면 폴더 안의 것을 다시 밖으로 꺼낼
 * 방법이 없다 — 루트는 자기 줄이 없는 유일한 디렉토리라서 겨눌 데가 없다.
 */
function TreeRoot({ projectId, showIgnored }: { projectId: string; showIgnored: boolean }) {
  const drop = useDropTarget('')
  return (
    <div
      className={`min-h-0 flex-1 overflow-auto py-1 ${drop.over ? 'bg-graphite/15' : ''}`}
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
  /** 다시 읽어야 하는 디렉토리마다 올라가는 표 — 감시자 대신이다 */
  version: Record<string, number>
  ops: FileOps
  openMenu: (target: MenuTarget, x: number, y: number) => void
  /** 지금 겨누고 있는 폴더 (`''`는 루트). 화면에서 밝은 자리는 언제나 하나다 */
  hover: string | null
  setHover: (dir: string | null) => void
}

const TreeCtx = createContext<TreeContext | null>(null)

function useTree(): TreeContext {
  const ctx = useContext(TreeCtx)
  if (!ctx) throw new Error('FileTree rows must be rendered inside FileTree')
  return ctx
}

/** `src/app/a.ts` → `src/app`. 루트는 빈 문자열 — listDir이 쓰는 표기 그대로다 */
function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * 트리가 파일에 하는 네 가지 (#18, #19).
 *
 * **성공은 조용하고 실패는 시끄럽다.** 옮긴 결과는 줄이 움직이는 것으로 이미 보이므로
 * 토스트를 더하면 소음이지만, 실패는 아무것도 움직이지 않아서 말해주지 않으면
 * '조용한 무동작'이 된다 — 이 프로젝트가 금지하는 바로 그것이다.
 * 휴지통만 성공도 말한다: 줄이 사라지는 것은 "지웠다"까지만 말하고, **되돌릴 수 있다**는
 * 약속(#18의 결정 전체가 그것이다)은 어디로 갔는지 말해야 전해진다.
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
          // moved:false는 제자리에 놓은 것 — 빗나간 드롭이지 실패가 아니므로 말하지 않는다
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
 * 파일 하나를 base64로.
 *
 * dataURL은 `data:<mime>;base64,<본문>` 꼴이라 앞머리만 떼면 그대로 쓸 수 있고 변환은
 * 브라우저가 한다. 바이트를 직접 돌리면 큰 파일에서 문자열 이어붙이기가 화면을 수십 초
 * 멈추는데, 첨부에서 "파일이 안 붙는다"로 보고된 증상이 실제로 그것이었다.
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
 * 무언가를 받는 자리 — 폴더 줄 하나, 또는 트리 전체(= 프로젝트 루트).
 *
 * **떨어뜨린 곳이 무엇을 할지 정한다.** 같은 파일 줄을 끌어도 입력창에 놓으면 경로가
 * 문장에 들어가고(원래 있던 동작, `dragPath.ts`), 여기 놓으면 파일이 옮겨간다. 둘이
 * 섞이지 않는 이유는 입력창이 이 자리를 모르고 이 자리가 입력창을 모르기 때문이다.
 *
 * 무엇이 왔는지는 **실은 것**으로 가른다: 우리 MIME이면 트리 안의 이동, OS 파일이면 밖에서
 * 끌어온 것. 둘 다 아니면 `preventDefault`를 하지 않는다 — 그러면 브라우저가 "여기엔 못
 * 놓는다"고 커서로 말해준다.
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
        // 안쪽 폴더가 겨눠지면 바깥 폴더·루트는 겨눠지지 않는다 — 가장 가까운 자리가 이긴다
        e.stopPropagation()
        // 트리 안에서 끌어온 것은 옮기는 것이고 밖에서 온 파일은 사본이 들어오는 것이다.
        // 커서가 이걸 말해주지 않으면 손을 놓기 전까지 무슨 일이 날지 알 수 없다.
        e.dataTransfer.dropEffect = hasDragPath(e.dataTransfer) ? 'move' : 'copy'
        setHover(dir)
      },
      onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
        // 자식으로 들어갈 때도 leave가 오므로 실제로 밖으로 나간 것만 본다
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
   * 한 번 읽으면 다시 안 읽으려고 `entries`를 가드로 뒀는데, 그게 **입력이 바뀌어도**
   * 막았다. 다른 프로젝트의 세션을 골라 projectId가 바뀌어도 이미 채워진 entries
   * 때문에 그대로 돌아나가서, 파일 트리가 옛 프로젝트를 계속 보여줬다 (도그푸딩 지적).
   *
   * 가드를 빼도 계속 읽지 않는다 — 이 효과는 open·projectId·path가 **바뀔 때만** 돈다.
   * "다시 읽지 않는다"는 조건을 상태로 흉내 내지 말고 의존성으로 말하게 한다.
   * `stamp`가 함께 있는 것도 같은 이유다: 파일을 옮기거나 지운 뒤 목록을 다시 읽어야
   * 한다는 사실을 상태로 흉내 내지 않고 의존성으로 말한다.
   *
   * 응답이 늦게 오는 사이 프로젝트가 또 바뀔 수 있으므로 늦은 응답은 버린다.
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
      {entries?.length === 0 && depth === 0 && <li className="px-3 py-2 text-[12px] text-slate">Empty</li>}
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
        className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[12px] transition-colors hover:text-chalk ${
          drop.over ? 'bg-graphite/40 text-chalk' : 'text-ash'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => toggleDir(projectId, entry.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu({ path: entry.path, name: entry.name, isDir: true }, e.clientX, e.clientY)
        }}
        data-testid={`dir-${entry.path}`}
        /* 폴더도 통째로 옮긴다 — 파일만 옮겨지는 트리는 절반만 움직인다 */
        draggable
        onDragStart={(e) => setDragPath(e.dataTransfer, entry.path)}
      >
        {/* 파일의 확장자 칸과 같은 폭 — 그래야 폴더와 파일의 이름이 한 줄에 선다 */}
        <span className="flex w-7 shrink-0 justify-center text-slate">
          <ChevronIcon open={open} />
        </span>
        <span className={`truncate ${entry.ignored ? 'text-slate' : ''}`}>{entry.name}</span>
      </button>
      {open && <Dir projectId={projectId} path={entry.path} depth={depth + 1} showIgnored={showIgnored} defaultOpen />}
    </li>
  )
}

function FileRow({ entry, depth }: { entry: FsEntry; depth: number }) {
  const openFile = useStore((s) => s.openFile)
  const current = useStore((s) => s.viewerPath)
  const touched = useTouched()
  const { openMenu } = useTree()

  return (
    <li>
      <button
        className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[12px] transition-colors ${
          current === entry.path ? 'bg-graphite/40 text-chalk' : entry.ignored ? 'text-slate' : 'text-ash hover:text-chalk'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => openFile(entry.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenu({ path: entry.path, name: entry.name, isDir: false }, e.clientX, e.clientY)
        }}
        data-testid={`file-${entry.path}`}
        /* 대화에 파일을 얹는 가장 짧은 길 — 경로를 외워서 치지 않아도 되게.
           같은 드래그가 폴더 위에서는 '옮기기'가 된다 (떨어뜨린 곳이 정한다) */
        draggable
        onDragStart={(e) => setDragPath(e.dataTransfer, entry.path)}
      >
        <FileKind name={entry.name} />
        <span className="truncate">{entry.name}</span>
        {/* 에이전트가 방금 만진 파일 (FR-5) — 색이 아니라 기호로 */}
        {touched.includes(entry.path) && (
          <span className="ml-auto shrink-0 text-[9px] text-slate" title="Edited by agent">
            ◆
          </span>
        )}
      </button>
    </li>
  )
}

/**
 * 오른쪽 클릭 메뉴 (#18, #19).
 *
 * **지우기가 여기 있는 이유**가 이 메뉴가 있는 이유다. 줄에 지우기 버튼을 달면 열려던 손이
 * 지우기에 닿을 수 있는데, 여는 것과 지우는 것은 되돌리는 값이 다르다. 오른쪽 클릭은 왼쪽
 * 클릭과 아예 다른 동작이라 잘못 누를 수가 없고, 트리 줄에서 오른쪽 클릭이 하던 일이
 * 지금까지 없어서 뺏어 올 것도 없다.
 *
 * 확인 대화상자는 없다 — 그게 #18의 결정이다. 휴지통은 누른 **뒤에도** 되돌릴 수 있고
 * 대화상자는 누르기 전까지만 되돌릴 수 있다. 물어보는 창은 결국 반사적으로 넘기게 되므로,
 * 되돌릴 수 있는 삭제가 언제나 낫다.
 */
function RowMenu({ state, close }: { state: MenuState; close: () => void }) {
  const { ops } = useTree()
  const fileManager = usePlatform().capabilities.fileManagerName
  const rootRef = useRef<HTMLDivElement>(null)

  /*
   * 바깥 클릭과 Escape로 닫는다 (SessionSettings·RunMenu와 같은 처리).
   * **자기 자신은 빼야 한다** — mousedown은 click보다 먼저 와서, 안쪽까지 닫아 버리면
   * 항목을 누르는 순간 메뉴가 사라지고 클릭은 어디에도 닿지 않는다.
   */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 가장 안쪽에 열린 것만 닫힌다 — 인박스·모달이 같이 닫히면 안 된다
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
  return (
    <div
      ref={rootRef}
      role="menu"
      data-testid="file-menu"
      className="fixed z-40 w-56 overflow-hidden rounded border border-edge bg-panel shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
      // 화면 끝에서 열면 메뉴가 창 밖으로 나간다 — 안쪽으로 당긴다
      style={{ left: Math.min(state.x, window.innerWidth - 232), top: Math.min(state.y, window.innerHeight - 76) }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="file-menu-reveal"
        title={`Show ${target.name} in ${fileManager}`}
        className="block w-full truncate px-2.5 py-1.5 text-left text-[12px] text-ash transition-colors hover:bg-graphite/25 hover:text-chalk"
        onClick={() => {
          close()
          void ops.reveal(target)
        }}
      >
        Reveal in {fileManager}
      </button>
      {/*
        지우기는 선 아래에 따로 둔다. 항목 둘이 붙어 있으면 위아래를 헷갈리는데, 위쪽은
        잘못 눌러도 창이 하나 열릴 뿐이고 아래쪽은 파일이 사라진다.
      */}
      <button
        type="button"
        role="menuitem"
        data-testid="file-menu-trash"
        title="Moves it to the Trash — you can put it back from there"
        className="block w-full truncate border-t border-edge px-2.5 py-1.5 text-left text-[12px] text-ash transition-colors hover:bg-graphite/25 hover:text-chalk"
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
 * 파일 종류 표식 — vscode-icons(MIT).
 *
 * 익숙한 그림이라 이름을 읽기 전에 종류가 잡힌다. 이 앱은 색을 다 빼고 시작했으므로
 * 색을 들이는 건 그 자체로 결정인데, 파일 종류는 **상태가 아니라 분류**라
 * 밝기 체계("가장 밝은 것 = 나를 기다리는 것")와 겹치지 않는다.
 * 아이콘은 작고 채도가 낮아 목록을 훑는 눈을 뺏지도 않는다.
 *
 * 표에 없는 확장자는 기본 파일 아이콘으로 떨어진다 — 목록이 못 따라와도 빈칸은 없다.
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
    />
  )
}

/** 파생 계산은 훅에서 memo화한다 (셀렉터가 새 배열을 만들면 무한 리렌더) */
function useTouched(): string[] {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => {
    const set = new Set<string>()
    for (const s of Object.values(sessions)) for (const p of s.touchedPaths) set.add(p)
    return [...set]
  }, [sessions])
}

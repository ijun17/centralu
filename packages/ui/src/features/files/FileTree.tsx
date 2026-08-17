import { useEffect, useMemo, useState } from 'react'
import type { FsEntry } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { ChevronIcon } from '../../components/icons.jsx'
import { iconForFile } from './fileIcon.js'
import { setDragPath } from './dragPath.js'

/**
 * 파일 트리 (FR-5, C-2).
 * lazy 로드 — 열어본 디렉토리만 읽는다. 10k+ 저장소에서도 첫 렌더가 가벼워야 한다.
 */
export function FileTree({ projectId }: { projectId: string }) {
  const [showIgnored, setShowIgnored] = useState(false)
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="file-tree">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="text-[11px] text-slate">프로젝트 파일</span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-slate">
          <input
            type="checkbox"
            className="accent-graphite"
            checked={showIgnored}
            onChange={(e) => setShowIgnored(e.target.checked)}
            data-testid="toggle-ignored"
          />
          무시된 항목
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        <Dir projectId={projectId} path="" depth={0} showIgnored={showIgnored} defaultOpen />
      </div>
    </section>
  )
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
  const open = defaultOpen
  const [entries, setEntries] = useState<FsEntry[] | null>(null)

  useEffect(() => {
    if (!open || entries) return
    void platform.fs
      .listDir(projectId, path)
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [open, entries, platform, projectId, path])

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
      {entries?.length === 0 && depth === 0 && <li className="px-3 py-2 text-[12px] text-slate">비어 있습니다</li>}
    </ul>
  )
}

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
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button
        className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[12px] text-ash transition-colors hover:text-chalk"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => setOpen((o) => !o)}
        data-testid={`dir-${entry.path}`}
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

  return (
    <li>
      <button
        className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-[12px] transition-colors ${
          current === entry.path ? 'bg-graphite/40 text-chalk' : entry.ignored ? 'text-slate' : 'text-ash hover:text-chalk'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => openFile(entry.path)}
        data-testid={`file-${entry.path}`}
        /* 대화에 파일을 얹는 가장 짧은 길 — 경로를 외워서 치지 않아도 되게 */
        draggable
        onDragStart={(e) => setDragPath(e.dataTransfer, entry.path)}
      >
        <FileKind name={entry.name} />
        <span className="truncate">{entry.name}</span>
        {/* 에이전트가 방금 만진 파일 (FR-5) — 색이 아니라 기호로 */}
        {touched.includes(entry.path) && (
          <span className="ml-auto shrink-0 text-[9px] text-slate" title="에이전트가 수정함">
            ◆
          </span>
        )}
      </button>
    </li>
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

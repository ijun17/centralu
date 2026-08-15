import { useEffect, useMemo, useState } from 'react'
import type { FsEntry } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

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
        style={{ paddingLeft: `${depth * 12 + 10}px` }}
        onClick={() => setOpen((o) => !o)}
        data-testid={`dir-${entry.path}`}
      >
        <span className="w-2 shrink-0 text-[9px] text-slate">{open ? '▾' : '▸'}</span>
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
        style={{ paddingLeft: `${depth * 12 + 22}px` }}
        onClick={() => openFile(entry.path)}
        data-testid={`file-${entry.path}`}
      >
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

/** 파생 계산은 훅에서 memo화한다 (셀렉터가 새 배열을 만들면 무한 리렌더) */
function useTouched(): string[] {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => {
    const set = new Set<string>()
    for (const s of Object.values(sessions)) for (const p of s.touchedPaths) set.add(p)
    return [...set]
  }, [sessions])
}

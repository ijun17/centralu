import { useCallback, useEffect, useState } from 'react'
import type { GitFileStatus } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { FileTree } from '../files/FileTree.jsx'
import { Kbd } from '../../components/primitives.jsx'

/**
 * 증거 레인 (우측).
 *
 * 세 레인의 역할이 서로 다르다:
 *   좌 = 관찰(무엇이 나를 기다리나) · 중앙 = 조작(말을 건다) · 우 = 증거(정말 그랬나)
 *
 * 여기 있는 것들은 대화를 **대신하는** 화면이 아니다. 에이전트가 "세 파일 고쳤습니다"라고
 * 말할 때 그 말을 확인하는 자리다. 그래서 탭이 아니라 옆에 함께 있어야 한다.
 *
 * 내부는 탭이 아니라 **세로로 쌓는다.** 깃 변경 목록과 파일 트리는 둘 다 결국 파일 목록이고,
 * 실제 사용 빈도는 '에이전트가 뭘 건드렸나'(깃)가 압도적이다. 여기에 탭을 또 두면
 * 방금 없앤 탐색 레이어를 되살리는 꼴이다.
 *
 * 자세히 보는 일(코드·diff)은 여기서 하지 않는다 — 360px에서 diff는 읽을 수 없다.
 * 클릭하면 넓은 오버레이가 대화 위에 펼쳐진다.
 */
export function EvidencePanel() {
  const open = useStore((s) => s.panelOpen)
  const togglePanel = useStore((s) => s.togglePanel)
  const projectId = useStore((s) => {
    const focused = s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null
    return focused ?? s.focusedProjectId
  })
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const openGit = useStore((s) => s.openGit)
  const [treeOpen, setTreeOpen] = useState(true)

  if (!open || !projectId || !project) return null

  return (
    <aside
      className="flex h-full w-[340px] shrink-0 flex-col overflow-hidden border-l border-edge bg-pit"
      data-testid="evidence-panel"
    >
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2" data-tauri-drag-region>
        <span className="truncate text-[11px] uppercase tracking-[0.12em] text-slate">증거</span>
        <span className="readout truncate text-[11px] text-ash" data-testid="evidence-project">
          {project.name}
        </span>
        <button
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
          onClick={() => togglePanel(false)}
          data-testid="evidence-close"
          title="증거 패널 닫기 (⌘B)"
        >
          ✕
        </button>
      </header>

      <GitChanges projectId={projectId} branch={project.git?.branch ?? null} denied={project.git?.denied} isRepo={!!project.git} />

      {/* 트리는 접을 수 있다. 평소에 보는 건 '바뀐 것'이지 '전부'가 아니다 */}
      <section className="flex min-h-0 flex-1 flex-col border-t border-edge">
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-left text-[11px] uppercase tracking-[0.12em] text-slate transition-colors hover:text-ash"
          onClick={() => setTreeOpen((v) => !v)}
          data-testid="evidence-tree-toggle"
          aria-expanded={treeOpen}
        >
          <span className="text-[9px]">{treeOpen ? '▾' : '▸'}</span> 파일
        </button>
        {treeOpen && <FileTree projectId={projectId} />}
      </section>

      <footer className="flex items-center gap-1.5 border-t border-edge px-3 py-1.5 text-[10px] text-slate">
        <Kbd>⌘</Kbd>
        <Kbd>B</Kbd>
        <span>패널</span>
        <button
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:bg-graphite/50 hover:text-chalk"
          onClick={() => openGit()}
          data-testid="evidence-git-full"
          disabled={!project.git}
        >
          깃 전체
        </button>
      </footer>
    </aside>
  )
}

/**
 * 변경된 파일 — 이 앱에서 가장 자주 보는 목록.
 * 여기서는 **목록만** 보여준다. 클릭하면 diff는 넓은 곳에서 편다.
 */
function GitChanges({
  projectId,
  branch,
  denied,
  isRepo,
}: {
  projectId: string
  branch: string | null
  denied?: boolean
  isRepo: boolean
}) {
  const platform = usePlatform()
  const openGit = useStore((s) => s.openGit)
  const touched = useTouchedCount(projectId)
  const [files, setFiles] = useState<GitFileStatus[] | null>(null)

  const refresh = useCallback(async () => {
    if (!isRepo) return setFiles([])
    try {
      setFiles(await platform.git.status(projectId))
    } catch {
      setFiles([])
    }
  }, [platform, projectId, isRepo])

  // 에이전트가 파일을 건드리면 목록을 다시 읽는다 (증거는 최신이어야 의미가 있다)
  useEffect(() => {
    void refresh()
  }, [refresh, touched])

  return (
    <section className="flex max-h-[45%] min-h-0 flex-col" data-testid="evidence-git">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">변경</span>
        {branch && (
          <span className="readout truncate text-[10px] text-slate" data-testid="evidence-branch">
            {branch}
          </span>
        )}
        {files && files.length > 0 && (
          <span className="readout ml-auto text-[10px] text-ash" data-testid="evidence-change-count">
            {files.length}
          </span>
        )}
      </div>

      {denied ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-ash" data-testid="evidence-git-denied">
          폴더 접근 권한이 필요합니다 — 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더
        </p>
      ) : !isRepo ? (
        <p className="px-3 pb-2 text-[11px] text-slate" data-testid="evidence-not-repo">
          git 저장소가 아닙니다
        </p>
      ) : files === null ? (
        <p className="px-3 pb-2 text-[11px] text-slate">읽는 중…</p>
      ) : files.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-slate" data-testid="evidence-clean">
          변경 사항이 없습니다
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-1">
          {files.map((f) => (
            <li key={`${f.path}-${f.staged ? 's' : 'u'}`}>
              <button
                className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-graphite/25"
                onClick={() => openGit(f.path)}
                data-testid={`evidence-file-${f.path}`}
                title={`${f.path} — diff 보기`}
              >
                {/* 종류는 글자로 구분한다 (색이 없는 디자인이므로) */}
                <span className="readout w-3 shrink-0 text-[10px] text-ash">{f.status.slice(0, 1).toUpperCase()}</span>
                <span className="truncate text-[12px] text-ash">{f.path}</span>
                {f.staged && <span className="readout ml-auto shrink-0 text-[9px] text-slate">staged</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 에이전트가 만진 파일 수 — 목록을 다시 읽을 시점을 아는 신호 */
function useTouchedCount(projectId: string): number {
  return useStore((s) => {
    let n = 0
    for (const sess of Object.values(s.sessions)) {
      if (sess.projectId === projectId) n += sess.touchedPaths.length
    }
    return n
  })
}

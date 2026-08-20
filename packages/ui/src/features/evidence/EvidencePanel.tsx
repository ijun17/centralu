import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitCommit, GitFileStatus } from '@cc/protocol'
import { laneCount, layoutCommits } from '@cc/core'
import { CommitGraph, ROW_H } from '../../components/CommitGraph.jsx'
import { ChevronIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useShortcut } from '../../app/shortcut.js'
import { useStore, type PanelTab } from '../../store/store.js'
import { FileTree } from '../files/FileTree.jsx'
import { TerminalPane } from './Terminal.jsx'
import { COMMIT_LIMIT, commitAgo, hasMultipleAuthors } from './commits.js'
import { DragRegion } from '../../components/DragRegion.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, TREE_DEFAULT, TREE_MAX, TREE_MIN } from '../../store/store.js'

/**
 * 증거 레인 (우측).
 *
 * 세 레인의 역할이 서로 다르다:
 *   좌 = 관찰(무엇이 나를 기다리나) · 중앙 = 조작(말을 건다) · 우 = 증거(정말 그랬나)
 *
 * 여기 있는 것들은 대화를 **대신하는** 화면이 아니다. 에이전트가 "세 파일 고쳤습니다"라고
 * 말할 때 그 말을 확인하는 자리다. 그래서 중앙 탭이 아니라 옆에 함께 둔다.
 *
 * 자세히 보는 일(코드·diff·커밋)은 여기서 하지 않는다 — 340px에서 diff는 읽을 수 없다.
 * 클릭하면 넓은 오버레이가 대화 위에 펼쳐진다.
 *
 * **This lane stays visible while that overlay is open** (issue #15). It used to be covered
 * by it, on the reasoning above — but "a diff needs more than 340px" is a reason not to draw
 * the diff *in here*, not a reason to hide the list that sent you to it. This is where the
 * next file comes from, so covering it turned reading three changed files into three rounds
 * of escape-and-find-it-again.
 */
export function EvidencePanel() {
  const open = useStore((s) => s.panelOpen)
  const projectId = useStore((s) => {
    const focused = s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null
    return focused ?? s.focusedProjectId
  })
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))
  const width = useStore((s) => s.panelWidth)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  const [resizing, setResizing] = useState(false)

  if (!projectId || !project) return null

  /*
   * 열고 닫힐 때 **폭이 미끄러진다.**
   *
   * 예전엔 접힌 띠와 패널을 통째로 갈아 끼워서 화면이 툭 바뀌었다. 그러면 눈이
   * "무엇이 어디로 갔는지" 따라가지 못해, 접은 건지 사라진 건지 순간 헷갈린다.
   * 폭이 이어지면 같은 것이 접혔다는 게 저절로 읽힌다.
   *
   * 끄는 중에는 전환을 끈다 — 매 프레임 보간하면 손을 따라오지 못하고 끈적해진다.
   */
  return (
    <aside
      className={`relative flex h-full shrink-0 flex-col overflow-hidden border-l border-edge bg-pit ${
        resizing ? '' : 'transition-[width] duration-200 ease-out motion-reduce:transition-none'
      }`}
      style={{ width: open ? width : RAIL_W }}
      data-testid={open ? 'evidence-panel' : 'evidence-rail-shell'}
    >
      {open ? (
        <>
          <ResizeHandle
            side="left"
            min={PANEL_MIN}
            max={PANEL_MAX}
            onResize={setPanelWidth}
            onReset={() => setPanelWidth(PANEL_DEFAULT)}
            onDraggingChange={setResizing}
            testId="evidence-resize"
          />
          <PanelHeader projectName={project.name} branch={project.git?.branch ?? null} isRepo={!!project.git} />
          <PanelBody projectId={projectId} project={project} />
        </>
      ) : (
        // 닫혀 있어도 흔적은 남긴다 — 사라진 것과 접힌 것은 다르다
        <CollapsedRail projectId={projectId} isRepo={!!project.git} />
      )}
    </aside>
  )
}

/** 접힌 띠의 폭. CollapsedRail이 그리는 폭과 같아야 전환이 이어진다 */
const RAIL_W = 32

function PanelHeader({
  projectName,
  branch,
  isRepo,
}: {
  projectName: string
  branch: string | null
  isRepo: boolean
}) {
  const tab = useStore((s) => s.panelTab)
  const setPanelTab = useStore((s) => s.setPanelTab)
  const togglePanel = useStore((s) => s.togglePanel)
  const sc = useShortcut()
  const openBranches = useStore((s) => s.openBranches)

  return (
    <>
      <DragRegion className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="readout truncate text-[11px] text-ash" data-testid="evidence-project">
          {projectName}
        </span>
        {branch && (
          <button
            className="readout truncate text-[10px] text-slate transition-colors hover:text-chalk"
            onClick={openBranches}
            data-testid="evidence-branch"
            title="Switch branch"
          >
            {branch}
          </button>
        )}
        <span className="ml-auto shrink-0">
        <IconButton
          label={`Collapse panel (${sc('mod', 'B')})`}
          onClick={() => togglePanel(false)}
          testId="evidence-close"
          align="right"
        >
          {/* 접기도 '펼침의 반대'라 같은 표시를 쓴다 — 뜻이 같으면 모양도 같아야 한다 */}
          <ChevronIcon open={false} />
        </IconButton>
        </span>
      </DragRegion>

      <nav className="flex items-center gap-0.5 border-b border-edge px-2 py-1" data-testid="evidence-tabs">
        {/*
          History sits next to Git rather than inside it (#21). Both are repo questions, so
          both go dark without a repo — but they are different questions: Git asks "what is
          uncommitted right now", History asks "how did we get here". The Git tab keeps its
          short strip of commits as context for staging; this is the same log as a place you
          go to read it, with the whole column instead of ~7 rows.
        */}
        {(
          [
            ['git', 'Git'],
            ['history', 'History'],
            ['files', 'Files'],
            ['terminal', 'Terminal'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPanelTab(id as PanelTab)}
            data-testid={`evidence-tab-${id}`}
            disabled={(id === 'git' || id === 'history') && !isRepo}
            className={`rounded px-2 py-0.5 text-[12px] transition-colors disabled:opacity-40 ${
              tab === id ? 'bg-graphite/50 text-chalk' : 'text-ash hover:text-chalk'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
    </>
  )
}

function PanelBody({
  projectId,
  project,
}: {
  projectId: string
  project: { git?: { denied?: boolean } | null }
}) {
  const tab = useStore((s) => s.panelTab)
  const isRepo = !!project.git

  // 터미널은 프로젝트(디렉토리)의 것이라 깃 저장소인지와 무관하다
  if (tab === 'terminal') return <TerminalPane projectId={projectId} />

  /*
    깃과 기록은 둘 다 저장소에 묻는 질문이라, 저장소가 아니면 둘 다 답이 없다.
    탭은 이미 비활성이지만 여기로 닿는 길이 남아 있다 — 저장된 스냅샷으로 되살아나거나,
    그 탭을 보는 중에 저장소가 아닌 프로젝트로 옮겨 앉거나.
  */
  if (tab === 'files' || !isRepo) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tab !== 'files' && !isRepo && (
          <p className="px-3 py-2 text-[11px] text-slate" data-testid="evidence-not-repo">
            Not a git repository
          </p>
        )}
        <FileTree projectId={projectId} />
      </div>
    )
  }

  if (tab === 'history') return <CommitHistory projectId={projectId} />

  // 깃 탭: 위는 지금 무엇이 바뀌었나, 아래는 어떻게 여기까지 왔나.
  // 둘 다 파일 목록이 아니라 서로 다른 질문이라서 나란히 둔다.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitChanges projectId={projectId} denied={project.git?.denied} />
      <GitTree projectId={projectId} />
    </div>
  )
}

/** 패널을 접었을 때 남는 세로 띠. 어디로 갔는지 보이고, 변경 수는 접힌 채로도 읽힌다 */
function CollapsedRail({ projectId, isRepo }: { projectId: string; isRepo: boolean }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const platform = usePlatform()
  const sc = useShortcut()
  const touched = useTouchedCount(projectId)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!isRepo) {
      setCount(null)
      return
    }
    // 프로젝트를 옮기는 사이 늦게 온 응답이 남의 프로젝트 숫자를 그리면 안 된다
    let alive = true
    platform.git
      .status(projectId)
      .then((f) => alive && setCount(f.length))
      .catch(() => alive && setCount(null))
    return () => {
      alive = false
    }
  }, [platform, projectId, isRepo, touched])

  return (
    /* 껍데기(폭·테두리·배경)는 바깥 aside가 갖는다 — 여기서 또 그리면 전환 중에 선이 겹친다 */
    <div
      className="flex h-full w-8 shrink-0 flex-col items-center gap-2 py-2"
      data-testid="evidence-rail"
    >
      <button
        className="rounded px-1 py-0.5 text-[12px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
        onClick={() => togglePanel(true)}
        data-testid="evidence-open"
        title={`Expand evidence panel (${sc('mod', 'B')})`}
      >
        ‹
      </button>
      {count !== null && count > 0 && (
        <button
          className="readout rounded px-1 text-[10px] text-ash transition-colors hover:text-chalk"
          onClick={() => togglePanel(true)}
          data-testid="evidence-rail-count"
          title={`${count} changed files`}
        >
          {count}
        </button>
      )}
      {/* 세로쓰기 — 접힌 띠가 무엇의 띠인지 말해준다 */}
      <span
        className="mt-1 text-[10px] tracking-[0.2em] text-slate"
        style={{ writingMode: 'vertical-rl' }}
        aria-hidden
      >
        Evidence
      </span>
    </div>
  )
}

/**
 * 변경된 파일 — 이 앱에서 가장 자주 보는 목록.
 * 목록과 커밋까지만 여기서 하고, diff는 넓은 곳에서 편다.
 */
function GitChanges({ projectId, denied }: { projectId: string; denied?: boolean }) {
  const platform = usePlatform()
  const openGit = useStore((s) => s.openGit)
  const setToast = useStore((s) => s.setToast)
  const touched = useTouchedCount(projectId)
  const [files, setFiles] = useState<GitFileStatus[] | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  // 요청 세대 번호 — 프로젝트를 옮기는 사이 늦게 온 응답이 남의 목록을 그리면 안 된다
  const statusGen = useRef(0)
  const refresh = useCallback(async () => {
    const gen = ++statusGen.current
    try {
      const next = await platform.git.status(projectId)
      if (gen === statusGen.current) setFiles(next)
    } catch {
      if (gen === statusGen.current) setFiles([])
    }
  }, [platform, projectId])

  // 에이전트가 파일을 건드리면 다시 읽는다 (증거는 최신이어야 의미가 있다)
  useEffect(() => {
    void refresh()
  }, [refresh, touched])

  const unstaged = files?.filter((f) => !f.staged) ?? []
  const staged = files?.filter((f) => f.staged) ?? []

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      // RPC가 던지면(끊김·타임아웃) 잡는 곳이 없어 성공처럼 보였다 — 조용한 실패 금지
      setToast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col border-b border-edge" data-testid="evidence-git">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">Changes</span>
        {files && files.length > 0 && (
          <>
            <span className="readout text-[10px] text-ash" data-testid="evidence-change-count">
              {files.length}
            </span>
            <button
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
              onClick={() => openGit()}
              data-testid="evidence-git-full"
              title="Open in wide view"
            >
              Expand
            </button>
          </>
        )}
      </div>

      {denied ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-ash" data-testid="evidence-git-denied">
          Folder access permission required — System Settings → Privacy & Security → Files and Folders
        </p>
      ) : files === null ? (
        <p className="px-3 pb-2 text-[11px] text-slate">Loading…</p>
      ) : files.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-slate" data-testid="evidence-clean">
          No changes
        </p>
      ) : (
        <>
          {/*
            스테이지된 것과 아닌 것을 **나눠서** 보여준다.
            커밋에 무엇이 실릴지가 커밋 직전에 알아야 할 유일한 사실인데,
            한 목록에 섞어두면 그걸 줄 끝의 작은 꼬리표로 읽어야 했다.
            위가 실릴 것, 아래가 안 실릴 것 — 경계가 곧 답이다.
          */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChangeGroup
              title="Staged"
              files={staged}
              onOpen={openGit}
              busy={busy}
              action={{
                id: 'unstage',
                one: 'Unstage',
                all: 'Unstage all',
                run: (paths) => run(() => platform.git.stage(projectId, paths, true)),
              }}
            />
            <ChangeGroup
              title="Changed"
              files={unstaged}
              onOpen={openGit}
              busy={busy}
              action={{
                id: 'stage',
                one: 'Stage',
                all: 'Stage all',
                run: (paths) => run(() => platform.git.stage(projectId, paths)),
              }}
            />
          </div>

          {/* 커밋은 좁은 곳에서도 되어야 한다 — 확인하고 바로 마무리하는 흐름이 끊기면 안 된다 */}
          <div className="border-t border-edge px-3 py-2">
            <input
              className="w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
              placeholder="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              data-testid="evidence-commit-message"
            />
            <div className="mt-1.5 flex gap-1.5">
              <button
                className="flex-1 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
                disabled={busy || !message.trim() || staged.length === 0}
                data-testid="evidence-commit"
                onClick={() =>
                  void run(async () => {
                    const r = await platform.git.commit(projectId, message.trim())
                    setToast(r.ok ? 'Committed' : (r.message ?? 'Commit failed'))
                    if (r.ok) setMessage('')
                  })
                }
              >
                Commit
              </button>
              <button
                className="rounded border border-edge px-2 py-1 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk disabled:opacity-40"
                disabled={busy}
                data-testid="evidence-push"
                onClick={() =>
                  void run(async () => {
                    const r = await platform.git.push(projectId)
                    setToast(r.ok ? 'Pushed' : (r.message ?? 'Push failed'))
                  })
                }
              >
                Push
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

/** 한 무리(스테이지됨 / 변경됨). 비어 있으면 머리글도 내보내지 않는다 */
function ChangeGroup({
  title,
  files,
  onOpen,
  busy,
  action,
}: {
  title: string
  files: GitFileStatus[]
  onOpen: (path: string) => void
  busy: boolean
  action: { id: 'stage' | 'unstage'; one: string; all: string; run: (paths: string[]) => Promise<void> }
}) {
  if (files.length === 0) return null
  return (
    <section data-testid={`evidence-group-${title.toLowerCase()}`}>
      <header className="sticky top-0 flex items-center gap-1.5 bg-pit px-3 py-1">
        <h4 className="text-[10px] uppercase tracking-[0.12em] text-slate">{title}</h4>
        <span className="readout text-[10px] text-slate">{files.length}</span>
        <button
          className="ml-auto text-[10px] text-slate transition-colors hover:text-chalk disabled:opacity-40"
          disabled={busy}
          onClick={() => void action.run(files.map((f) => f.path))}
          data-testid={`evidence-${action.id}-all`}
        >
          {action.all}
        </button>
      </header>
      <ul>
        {files.map((f) => (
          <ChangeRow
            key={f.path}
            file={f}
            onOpen={() => onOpen(f.path)}
            busy={busy}
            actionId={action.id}
            actionLabel={action.one}
            onAction={() => void action.run([f.path])}
          />
        ))}
      </ul>
    </section>
  )
}

function ChangeRow({
  file,
  onOpen,
  busy,
  actionId,
  actionLabel,
  onAction,
}: {
  file: GitFileStatus
  onOpen: () => void
  busy: boolean
  actionId: 'stage' | 'unstage'
  actionLabel: string
  onAction: () => void
}) {
  return (
    <li className="group/file relative">
      <button
        className="flex w-full items-center gap-2 px-3 py-1 pr-12 text-left transition-colors hover:bg-graphite/25"
        onClick={onOpen}
        data-testid={`evidence-file-${file.path}`}
        title={`${file.path} — view diff`}
      >
        {/* 종류는 색이 아니라 글자로 구분한다 (완전 무채색) */}
        <span className="readout w-3 shrink-0 text-[10px] text-ash">{file.status.slice(0, 1).toUpperCase()}</span>
        <span className="truncate text-[12px] text-ash" dir="rtl">
          {file.path}
        </span>
      </button>
      {/*
        파일 하나만 올리고 내리는 길. 이게 없으면 "이것만 빼고 커밋"을 하려고
        터미널로 나가야 했다 — 확인하던 자리에서 그대로 끝낼 수 있어야 한다.
      */}
      <button
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] text-slate opacity-0 transition-opacity hover:text-chalk focus:opacity-100 group-hover/file:opacity-100 disabled:opacity-40"
        disabled={busy}
        onClick={onAction}
        data-testid={`evidence-${actionId}-${file.path}`}
        title={`${file.path} ${actionLabel}`}
      >
        {actionLabel}
      </button>
    </li>
  )
}

/**
 * 깃 트리 — 어떻게 여기까지 왔나.
 *
 * 선을 그린다. 예전엔 좁다는 이유로 점만 찍었는데, 그러면 갈라짐과 합쳐짐이 사라져
 * 그냥 목록이 된다 — 트리라고 부를 이유가 없어진다. 레인 폭을 9px로 좁게 잡으면
 * 실제 저장소에서 제목 자리를 거의 뺏지 않는다.
 */
function GitTree({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const openCommit = useStore((s) => s.openCommit)
  const touched = useTouchedCount(projectId)
  const height = useStore((s) => s.treeHeight)
  const setTreeHeight = useStore((s) => s.setTreeHeight)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)

  useEffect(() => {
    // 프로젝트를 옮기는 사이 늦게 온 응답이 남의 기록을 그리면 안 된다
    let alive = true
    platform.git
      .log(projectId, 50)
      .then((c) => alive && setCommits(c))
      .catch(() => alive && setCommits([]))
    return () => {
      alive = false
    }
  }, [platform, projectId, touched])

  const graph = useMemo(() => {
    const rows = layoutCommits(commits ?? [])
    return { rows, lanes: laneCount(rows) }
  }, [commits])

  return (
    <section
      className="relative flex shrink-0 flex-col"
      style={{ height }}
      data-testid="evidence-tree"
    >
      <ResizeHandle
        side="top"
        min={TREE_MIN}
        max={TREE_MAX}
        onResize={setTreeHeight}
        onReset={() => setTreeHeight(TREE_DEFAULT)}
        testId="evidence-tree-resize"
      />
      <div className="px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">History</span>
      </div>
      {commits === null ? (
        <p className="px-3 pb-2 text-[11px] text-slate">Loading…</p>
      ) : commits.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-slate" data-testid="evidence-no-commits">
          No commits
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-1" data-testid="evidence-commits">
          {commits.map((c, i) => (
            <li key={c.sha}>
              <button
                /* 높이를 고정한다 — 행마다 높이가 다르면 선이 경계에서 어긋나 끊겨 보인다 */
                className="flex w-full items-center gap-1.5 pr-3 text-left transition-colors hover:bg-graphite/25"
                style={{ height: ROW_H }}
                onClick={() => openCommit(c.sha)}
                data-testid={`evidence-commit-${c.shortSha}`}
                title={`${c.subject} — ${c.author}`}
              >
                <CommitGraph row={graph.rows[i]!} commit={c} lanes={graph.lanes} head={i === 0} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ash">{c.subject}</span>
                  <span className="readout block truncate text-[10px] text-slate">
                    {c.shortSha} · {c.author}
                    {c.parents.length > 1 && ' · merge'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 기록 탭 — 로그를 **읽으러 오는** 자리 (#21).
 *
 * 위 `GitTree`와 데이터는 같고 용무가 다르다. 저쪽은 커밋을 만드는 동안 곁눈질하는
 * 맥락이라 일곱 줄에 갇혀 있고, 여기는 세로 한 칸을 통째로 쓴다.
 *
 * **선을 그리지 않는다.** 레인은 "이 갈래들이 어디서 만났나"를 물을 때 폭값을 하는데,
 * "요즘 무슨 일이 있었나"에는 같은 픽셀을 날짜에 주는 편이 낫다. 그래서 그래프는 저쪽에,
 * 날짜는 이쪽에 둔다 — 두 벌을 만든 게 아니라 질문을 나눈 것이다.
 *
 * 눌렀을 때 열리는 것도 새로 만들지 않는다: `openCommit`이 이미 넓은 오버레이의 기록
 * 탭을 그 커밋으로 펴 준다 (`git show`가 주는 diff 하나를 `DiffView`가 그린다).
 */
function CommitHistory({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const openCommit = useStore((s) => s.openCommit)
  const touched = useTouchedCount(projectId)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)

  useEffect(() => {
    // 프로젝트를 옮기는 사이 늦게 온 응답이 남의 기록을 그리면 안 된다
    let alive = true
    platform.git
      .log(projectId, COMMIT_LIMIT)
      .then((c) => alive && setCommits(c))
      .catch(() => alive && setCommits([]))
    return () => {
      alive = false
    }
  }, [platform, projectId, touched])

  // 한 번만 읽는다 — 줄마다 시계를 보면 같은 목록 안에서 기준 시각이 달라진다
  const now = Date.now()
  const withAuthor = commits ? hasMultipleAuthors(commits) : false

  if (commits === null) {
    return (
      <p className="px-3 py-2 text-[11px] text-slate" data-testid="evidence-history">
        Loading…
      </p>
    )
  }
  if (commits.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-slate" data-testid="evidence-history-empty">
        No commits yet
      </p>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="evidence-history">
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {commits.map((c) => (
          <li key={c.sha}>
            <button
              className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-graphite/25"
              onClick={() => openCommit(c.sha)}
              data-testid={`history-commit-${c.shortSha}`}
              title={`${c.subject} — ${c.author}`}
            >
              <span className="w-full truncate text-[12px] text-ash">{c.subject}</span>
              <span className="readout w-full truncate text-[10px] text-slate">
                {[
                  c.shortSha,
                  commitAgo(c.when, now),
                  ...(withAuthor ? [c.author] : []),
                  ...(c.parents.length > 1 ? ['merge'] : []),
                ].join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* 조용히 끊긴 목록은 "더 오래된 커밋이 없다"고 거짓말하는 목록이다 */}
      {commits.length >= COMMIT_LIMIT && (
        <p
          className="shrink-0 border-t border-edge px-3 py-1.5 text-[10px] text-slate"
          data-testid="evidence-history-cap"
        >
          Newest {COMMIT_LIMIT} commits — older ones are not listed
        </p>
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

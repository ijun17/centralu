import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitCommit, GitFileStatus } from '@cc/protocol'
import { laneCount, layoutCommits } from '@cc/core'
import { CommitGraph, ROW_H } from '../../components/CommitGraph.jsx'
import { ChevronIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useShortcut } from '../../app/shortcut.js'
import { useStore, type PanelTab } from '../../store/store.js'
import {
  PANEL_TABS,
  PANEL_TAB_MIME,
  moveTab,
  moveTabToGroupEnd,
  splitTab,
  type PanelGroup,
} from '../../store/panelLayout.js'
import { FileTree } from '../files/FileTree.jsx'
import { TerminalPane } from './Terminal.jsx'
import { COMMIT_LIMIT, commitAgo, hasMultipleAuthors } from './commits.js'
import { DragRegion } from '../../components/DragRegion.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, useTextZoom } from '../../store/store.js'

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
  // 최소 폭은 실픽셀 고정 (사이드바와 같은 규칙) — 글자 배율이 좁힘의 한계를 못 먹는다
  const zoom = useTextZoom()
  const [resizing, setResizing] = useState(false)
  const isRepo = !!project?.git

  /*
   * ⌘⇧1–4 — switch tab. Settings advertises this under Shortcuts, so it has to keep
   * working when the tabs are rearranged (#20). **The digit follows the tab's identity**
   * (1 git · 2 history · 3 files · 4 terminal — PANEL_TABS order), not its seat in the
   * strip: the shortcut list is static text, and static text can only tell the truth
   * about a mapping that a reorder does not move. Position digits would also silently
   * retarget muscle memory every time a tab is dragged.
   */
  useEffect(() => {
    if (!projectId) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return
      // e.code, not e.key — Shift turns the key value into '!' '@' … (same as App.tsx)
      const digit = /^Digit([1-4])$/.exec(e.code)?.[1]
      if (!digit) return
      const tab = PANEL_TABS[Number(digit) - 1]!
      // Without a repo, git/history stay unreachable by key just as their buttons are disabled
      if ((tab === 'git' || tab === 'history') && !isRepo) return
      e.preventDefault()
      useStore.getState().setPanelTab(tab)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectId, isRepo])

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
            min={PANEL_MIN / zoom}
            max={PANEL_MAX}
            onResize={setPanelWidth}
            onReset={() => setPanelWidth(PANEL_DEFAULT)}
            onDraggingChange={setResizing}
            testId="evidence-resize"
          />
          <PanelHeader projectName={project.name} branch={project.git?.branch ?? null} />
          <PanelGroups projectId={projectId} project={project} isRepo={isRepo} />
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

function PanelHeader({ projectName, branch }: { projectName: string; branch: string | null }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const sc = useShortcut()
  const openBranches = useStore((s) => s.openBranches)

  return (
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
        {/* Collapsing is 'the opposite of expanding', so it wears the same mark — same meaning, same shape */}
        <ChevronIcon open={false} />
      </IconButton>
      </span>
    </DragRegion>
  )
}

const TAB_LABELS: Record<PanelTab, string> = {
  git: 'Git',
  history: 'History',
  files: 'Files',
  terminal: 'Terminal',
}

/**
 * The tab groups, stacked vertically (#20). One group is the everyday panel. Dragging
 * a tab to the bottom half of the body splits a second group off; dragging the bottom
 * group's last tab back to a strip dissolves it. Every arrangement change goes through
 * the pure functions in store/panelLayout.ts and lands in the store, which persists it
 * globally — the panel is a way of looking, so there is one arrangement for the whole
 * app and it survives a relaunch (the #20 decision).
 */
function PanelGroups({
  projectId,
  project,
  isRepo,
}: {
  projectId: string
  project: { git?: { denied?: boolean } | null }
  isRepo: boolean
}) {
  const groups = useStore((s) => s.panelLayout)
  const setPanelLayout = useStore((s) => s.setPanelLayout)

  return (
    <>
      {groups.map((g, gi) => (
        <TabGroup
          key={gi}
          gi={gi}
          group={g}
          groups={groups}
          isRepo={isRepo}
          onLayout={setPanelLayout}
          projectId={projectId}
          project={project}
        />
      ))}
    </>
  )
}

/** One group: its strip of tabs, then whichever tab is active in it */
function TabGroup({
  gi,
  group,
  groups,
  isRepo,
  onLayout,
  projectId,
  project,
}: {
  gi: number
  group: PanelGroup
  groups: PanelGroup[]
  isRepo: boolean
  onLayout: (groups: PanelGroup[]) => void
  projectId: string
  project: { git?: { denied?: boolean } | null }
}) {
  const setPanelTab = useStore((s) => s.setPanelTab)
  const panelSplit = useStore((s) => s.panelSplit)
  const setPanelSplit = useStore((s) => s.setPanelSplit)
  const [splitHint, setSplitHint] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  return (
    <>
      <nav
        className={`flex items-center gap-0.5 border-b border-edge px-2 py-1 ${gi > 0 ? 'border-t' : ''}`}
        data-testid={gi === 0 ? 'evidence-tabs' : `evidence-tabs-${gi}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANEL_TAB_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(e) => {
          // Dropped on the strip but not on a tab: the tab joins this group's end.
          // This is also the unsplit gesture — the bottom group's last tab dragged up
          // here empties that group, and an empty group stops existing.
          const dragged = e.dataTransfer.getData(PANEL_TAB_MIME) as PanelTab
          if (!dragged) return
          e.preventDefault()
          onLayout(moveTabToGroupEnd(groups, dragged, gi))
        }}
      >
        {group.tabs.map((id) => (
          <TabButton
            key={id}
            id={id}
            active={group.active === id}
            // Repo questions have no answer without a repo (#21) — and a disabled button
            // also fires no drag events, so these tabs are arranged from repo projects
            disabled={(id === 'git' || id === 'history') && !isRepo}
            groups={groups}
            onLayout={onLayout}
            onPick={setPanelTab}
          />
        ))}
      </nav>
      <div
        /*
          overflow-hidden은 이웃 그룹을 지키는 담이다. 이게 없던 동안 위 그룹의 내용이
          몸통을 넘치면 **아래 그룹의 탭 스트립 위에 그려졌다** (깃 탭의 고정 높이
          History 스트립이 실제로 그랬다 — 도그푸딩 지적). 탭 하나가 무엇을 그리든
          자기 몸통 밖으로는 못 나간다는 규칙을 내용물이 아니라 그릇이 지킨다.
        */
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        /*
          나뉜 두 몸통의 몫 (도그푸딩: 반반 고정은 "터미널은 좁아도 되고 diff는 넓어야
          한다"를 못 담았다). 탭 띠는 고정 높이라 flexGrow가 몸통끼리만 나눈다 —
          basis는 flex-1의 0 그대로라 grow 비가 곧 높이 비다.
        */
        style={groups.length === 2 ? { flexGrow: gi === 0 ? panelSplit : 1 - panelSplit } : undefined}
        ref={bodyRef}
        data-testid={`evidence-body-${gi}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(PANEL_TAB_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const r = e.currentTarget.getBoundingClientRect()
          // One group: only the bottom half is a target (that is what "split" means here).
          // Two groups: this whole body adopts the dropped tab — the halves are taken.
          setSplitHint(groups.length > 1 || e.clientY > r.top + r.height / 2)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setSplitHint(false)
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData(PANEL_TAB_MIME) as PanelTab
          setSplitHint(false)
          if (!dragged) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          if (groups.length === 1) {
            if (e.clientY > r.top + r.height / 2) onLayout(splitTab(groups, dragged))
          } else {
            onLayout(moveTabToGroupEnd(groups, dragged, gi))
          }
        }}
      >
        {/*
          경계 조절 손잡이 (도그푸딩 요청). 아래 묶음 몸통의 윗변이 곧 두 묶음의 경계다 —
          끌면 아래 몸통의 높이가 나오고, 두 몸통 합에 대한 비율로 저장한다.
          몸통 합으로 나누는 이유: 탭 띠는 고정이라 flexGrow가 나누는 공간이 그것뿐이다.
        */}
        {gi === 1 && (
          <ResizeHandle
            side="top"
            testId="panel-split-handle"
            min={15}
            max={85}
            onReset={() => setPanelSplit(0.5)}
            onResize={(h) => {
              const other = bodyRef.current?.parentElement?.querySelector<HTMLElement>(
                '[data-testid="evidence-body-0"]',
              )
              const total = (other?.offsetHeight ?? 0) + (bodyRef.current?.offsetHeight ?? 0)
              if (total > 0) setPanelSplit(1 - h / total)
            }}
          />
        )}
        <TabBody tab={group.active} projectId={projectId} project={project} />
        {splitHint && (
          <div
            /*
              The boundary is the meaning ("this half becomes the split"), so it wears
              the same ash landing line as every other drop indicator — border-edge was
              measured too faint against the tinted half to read as a boundary at all.
            */
            className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-graphite/30 ${
              groups.length === 1 ? 'top-1/2 shadow-[inset_0_2px_0_0_var(--color-ash)]' : 'top-0'
            }`}
            data-testid="evidence-split-hint"
          />
        )}
      </div>
    </>
  )
}

/**
 * The pointer decides left/right the way the sidebar decides top/bottom (reorder.ts
 * `dropsBefore`): the boundary at the middle gives each outcome half the button, so
 * the hand can predict which side it gets.
 */
const dropsLeft = (rect: { left: number; width: number }, clientX: number): boolean =>
  clientX < rect.left + rect.width / 2

function TabButton({
  id,
  active,
  disabled,
  groups,
  onLayout,
  onPick,
}: {
  id: PanelTab
  active: boolean
  disabled: boolean
  groups: PanelGroup[]
  onLayout: (groups: PanelGroup[]) => void
  onPick: (tab: PanelTab) => void
}) {
  // Each button keeps its own drop edge so the line is drawn on that button only —
  // the same call as the sidebar rows, for the same reason.
  const [edge, setEdge] = useState<'left' | 'right' | null>(null)

  return (
    <button
      onClick={() => onPick(id)}
      data-testid={`evidence-tab-${id}`}
      disabled={disabled}
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.setData(PANEL_TAB_MIME, id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANEL_TAB_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setEdge(dropsLeft(e.currentTarget.getBoundingClientRect(), e.clientX) ? 'left' : 'right')
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        const dragged = e.dataTransfer.getData(PANEL_TAB_MIME) as PanelTab
        setEdge(null)
        if (!dragged) return
        e.preventDefault()
        e.stopPropagation()
        onLayout(moveTab(groups, dragged, id, dropsLeft(e.currentTarget.getBoundingClientRect(), e.clientX)))
      }}
      className={`rounded px-2 py-0.5 text-[12px] transition-colors disabled:opacity-40 ${
        active ? 'bg-graphite/50 text-chalk' : 'text-ash hover:text-chalk'
      } ${dropLine(edge)}`}
    >
      {TAB_LABELS[id]}
    </button>
  )
}

/**
 * The drop position, as an inset shadow on the target's edge — a border would grow the
 * button 2px and nudge the whole strip while dragging (the sidebar learned this the
 * hard way; see its dropLine).
 */
function dropLine(edge: 'left' | 'right' | null): string {
  if (!edge) return ''
  return edge === 'left'
    ? 'shadow-[inset_2px_0_0_0_var(--color-ash)]'
    : 'shadow-[inset_-2px_0_0_0_var(--color-ash)]'
}

/** What one tab shows. The active tab of every group renders through here. */
function TabBody({
  tab,
  projectId,
  project,
}: {
  tab: PanelTab
  projectId: string
  project: { git?: { denied?: boolean } | null }
}) {
  const isRepo = !!project.git

  // The terminal belongs to the project (a directory), so being a git repo is irrelevant
  if (tab === 'terminal') return <TerminalPane projectId={projectId} />

  /*
    Git and history both ask questions of the repository, so neither has an answer
    without one. The tabs are disabled then, but paths still lead here — a saved
    snapshot can restore them, or a non-repo project can move in under a watching tab.
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

  /*
    Git tab: what changed right now, alone. The history strip that used to sit below it
    left with the split feature (#20): it was a fixed-height block, so in a short split
    half it overflowed the group body straight over the next group's tab strip — and the
    History tab (#21) already answers "how did we get here" with a full column to do it in.
  */
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitChanges projectId={projectId} denied={project.git?.denied} />
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
  /*
   * Writes through the store, reads straight from the platform (issue #49).
   *
   * This panel sits **beside** the sidebar count it was leaving stale — commit here and the
   * number a few pixels to the left kept the old value. `refresh` below stays local because
   * it fetches the file list, which the store does not hold; the store owns the summary.
   */
  const gitStage = useStore((s) => s.gitStage)
  const gitCommit = useStore((s) => s.gitCommit)
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
                run: (paths) => run(() => gitStage(projectId, paths, true)),
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
                run: (paths) => run(() => gitStage(projectId, paths)),
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
                    const r = await gitCommit(projectId, message.trim())
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
 * 기록 탭 — 로그를 **읽으러 오는** 자리 (#21).
 *
 * 깃 탭 아래 살던 History 스트립의 후계이기도 하다. 그 스트립은 고정 높이라 분할(#20)
 * 에서 이웃 그룹의 탭 스트립을 덮었고, 같은 질문("어떻게 여기까지 왔나")을 이 탭이
 * 세로 한 칸으로 이미 답하고 있어서 스트립 쪽을 걷었다.
 *
 * **선(레인 그래프)은 이제 여기서 그린다.** #21 때 이 탭이 날짜를 고르고 선을 버린
 * 이유는 "그래프는 저쪽(스트립)에 있다"였다 — 그 저쪽이 사라졌으므로 전제도 사라졌다.
 * 전체 폭의 탭에는 둘이 같이 설 자리가 있다: 선이 갈라짐·합쳐짐을, 날짜가 '얼마나
 * 됐나'를 말한다. 행 높이는 그래서 고정이다 — 선이 행 경계에서 맞물려야 이어져 보인다.
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
  const graph = useMemo(() => {
    const rows = layoutCommits(commits ?? [])
    return { rows, lanes: laneCount(rows) }
  }, [commits])

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
        {commits.map((c, i) => (
          <li key={c.sha}>
            <button
              /* 높이 고정 — 행마다 높이가 다르면 선이 행 경계에서 어긋나 끊겨 보인다 */
              className="flex w-full items-center gap-1.5 pr-3 text-left transition-colors hover:bg-graphite/25"
              style={{ height: ROW_H }}
              onClick={() => openCommit(c.sha)}
              data-testid={`history-commit-${c.shortSha}`}
              title={`${c.subject} — ${c.author}`}
            >
              {/* 왼쪽 여백은 그래프가 진다 (PAD_L) — px-3을 겹치면 점이 벽에서 두 배 멀어진다 */}
              <CommitGraph row={graph.rows[i]!} commit={c} lanes={graph.lanes} head={i === 0} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-ash">{c.subject}</span>
                <span className="readout block truncate text-[10px] text-slate">
                  {[
                    c.shortSha,
                    commitAgo(c.when, now),
                    ...(withAuthor ? [c.author] : []),
                    ...(c.parents.length > 1 ? ['merge'] : []),
                    // 어느 세션이 만들었나 (#50) — 훅 없이 관찰로 안 것. 사람 커밋에는 없다
                    ...(c.sessionName ? [c.sessionName] : []),
                  ].join(' · ')}
                </span>
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

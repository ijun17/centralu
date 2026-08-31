import { useCallback, useEffect, useRef, useState } from 'react'
import { TOOL_META, TOOL_NAMES, type ExternalSession, type ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useSessionsOf } from '../../store/selectors.js'
import { Kbd } from '../../components/primitives.jsx'
import { Modal } from '../../components/Modal.jsx'

type Detection = { tool: ToolName; installed: boolean; loggedIn: boolean; detail: string }

/**
 * 이전 세션 목록의 상태.
 * 'unsupported'는 실패가 아니라 **정상적인 결과**다 — 구버전 도구는 목록을 못 준다.
 * 그때도 새 세션은 그대로 만들 수 있어야 하므로 오류로 취급하지 않는다.
 */
type PastState =
  | { status: 'loading' }
  | { status: 'ok'; sessions: ExternalSession[] }
  | { status: 'unsupported'; reason: string }

/** 방금 · 32분 전 · 3시간 전 · 5일 전 — 정확한 시각보다 '얼마나 됐나'가 중요하다 */
function ago(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  const day = Math.floor(hour / 24)
  return day < 30 ? `${day}d ago` : `${Math.floor(day / 30)}mo ago`
}

/**
 * 세션 생성 (FR-7).
 *
 * **여기서 고르는 것은 도구와 "새로 시작 vs 이어가기"뿐이다.** 모델·권한은 세션을
 * 만든 뒤 헤더에서 바꾼다 — 시작하기 전에 정할 수 있는 것보다, 대화하며 바꿀 수
 * 있는 것이 실제로 더 유용하다. (도구만 예외인 이유: 프로세스 자체라 도중에 못 바꾼다)
 *
 * **첫 프롬프트 입력칸은 없다** (2026-08-27 도그푸딩: "조잡하고, 필요 없지 않나").
 * 만들자마자 입력창이 있는 화면으로 가는데 모달에서 미리 쓸 이유가 없다 — 세션
 * 이름이 되는 규칙(FR-18)도 입력창의 첫 메시지에 똑같이 적용된다 (manager가 send에서
 * 'New session'을 첫 문장으로 바꾼다). 소제목·안내문도 같은 이유로 걷어냈다:
 * 이 창의 본체는 대화 목록 하나다.
 */
export function NewSessionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const createSession = useStore((s) => s.createSession)
  const running = useSessionsOf(projectId).filter((s) => !s.archived)
  // 워크트리는 깃 저장소에서만 만들 수 있다 — 아니면 체크박스를 죽이고 이유를 적는다
  const isRepo = !!project?.git

  const [tools, setTools] = useState<Detection[] | null>(null)
  const [tool, setTool] = useState<ToolName>(project?.defaultTool ?? 'claude')
  const [busy, setBusy] = useState(false)
  /**
   * 이 세션만 워크트리에서 돌린다 (FR-2 옵션).
   *
   * **기본은 꺼짐이다.** 스펙이 정한 원칙이 "원본 디렉토리에서 직접 작업"이고,
   * 워크트리는 원하는 사람만 켜는 격리 수단이다. 예외는 매니저 줄의 +로 열린
   * 경우 하나 (#69) — 거기서는 켜진 채 열린다. 강제가 아니라 예열이다: 끄는 건 자유고,
   * 초기값이라 열려 있는 동안 스토어를 다시 읽지 않는다 (mount마다 한 번).
   */
  const [worktree, setWorktree] = useState(useStore.getState().newSessionWorktree)
  const [error, setError] = useState<string | null>(null)

  // 이어받을 이전 세션. null이면 '새 세션'이다 (기본값)
  const [resume, setResume] = useState<ExternalSession | null>(null)
  const focusSession = useStore((s) => s.focusSession)
  const [past, setPast] = useState<PastState>({ status: 'loading' })

  // 다이얼로그를 열 때마다 감지한다 — 사용자가 방금 설치·로그인했을 수 있다
  const detect = useCallback(async () => {
    try {
      setTools(await platform.agents.detect())
    } catch {
      setTools([])
    }
  }, [platform])
  useEffect(() => {
    void detect()
  }, [detect])

  // 도구를 바꾸면 목록도 바뀐다 — 이전 선택은 다른 도구의 것이므로 버린다
  useEffect(() => {
    let alive = true
    setResume(null)
    setPast({ status: 'loading' })
    void platform.agents
      .listExternalSessions(projectId, tool)
      .then((r) => {
        if (!alive) return
        setPast(
          r.supported
            ? { status: 'ok', sessions: r.sessions }
            : { status: 'unsupported', reason: r.reason ?? 'Could not list past conversations' },
        )
      })
      .catch((e: Error) => alive && setPast({ status: 'unsupported', reason: e.message }))
    return () => {
      alive = false
    }
  }, [platform, projectId, tool])

  /**
   * 둘 중 **하나만** 쓸 수 있어도 앱은 정상으로 동작해야 한다 (제품 규칙).
   *
   * 기본 도구가 못 쓰는 상태인데 다른 하나가 멀쩡하면 **말없이 그쪽으로 옮긴다.**
   * 안 그러면 Codex만 쓰는 사람이 다이얼로그를 열 때마다 "Claude에 로그인하라"는
   * 벽을 만나고, 안 쓰는 도구에 로그인해야 창이 열린다 — 이 앱의 원칙("워크플로를
   * 강요하지 않는다")에 정면으로 어긋난다.
   *
   * 감지 결과가 처음 온 순간 **한 번만** 옮긴다. 그 뒤 사용자가 고른 것은 건드리지 않는다.
   */
  const autoPicked = useRef(false)
  useEffect(() => {
    if (!tools || autoPicked.current) return
    autoPicked.current = true
    const ok = (t: ToolName) => {
      const d = tools.find((x) => x.tool === t)
      return d?.installed === true && d.loggedIn
    }
    setTool((cur) => (ok(cur) ? cur : (TOOL_NAMES.find(ok) ?? cur)))
  }, [tools])

  const info = (t: ToolName) => tools?.find((x) => x.tool === t)
  const usable = (t: ToolName) => {
    const d = info(t)
    return !tools || (d?.installed === true && d.loggedIn)
  }
  const blocked = tools ? !usable(tool) : false

  return (
    <Modal onClose={onClose} testId="new-session-dialog" align="top">
      <form
        className="w-[480px] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') return onClose()
          /*
           * 목록이 이 창의 본체이므로 화살표가 목록을 고른다 — 마우스 없이
           * ⌘N → ↓↓ → ↵ 로 이어가기가 끝나야 한다. 이미 열린 대화는 건너뛴다:
           * 그 줄의 클릭은 '이동+닫기'라 화살표로 지나가다 창이 닫히면 안 된다.
           */
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && past.status === 'ok') {
            e.preventDefault()
            const rows: (ExternalSession | null)[] = [null, ...past.sessions.filter((s) => !s.importedAs)]
            const at = rows.findIndex((r) => (r?.externalId ?? null) === (resume?.externalId ?? null))
            const next = rows[Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1)]
            setResume(next ?? null)
          }
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await createSession(projectId, {
              tool,
              // 이전 세션을 골랐다면 도구에게 그 대화를 이어달라고 하고(resume),
              // 화면에도 지난 대화를 복원한다(importHistory).
              resumeExternalId: resume?.externalId,
              importHistory: resume ? true : undefined,
              worktree: worktree || undefined,
            })
            onClose()
          } catch (err) {
            // 토스트는 2.5초 뒤 사라져서 '눌러도 아무 일이 없다'로 보인다 — 모달 안에 남긴다
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2 className="text-[13px] font-medium text-chalk">New session · {project?.name}</h2>

        {/* 도구 — 소제목 없이 필 두 개면 뜻이 선다. 모델·권한은 만든 뒤 헤더에서 */}
        <div className="mt-3 flex gap-1.5">
          {TOOL_NAMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTool(t)}
              data-testid={`tool-option-${t}`}
              title={info(t)?.detail}
              className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                tool === t ? 'border-ash bg-graphite/40 text-chalk' : 'border-edge text-ash hover:text-chalk'
              } ${tools && !usable(t) ? 'opacity-50' : ''}`}
            >
              {TOOL_META[t].label}
            </button>
          ))}
        </div>
        {/* 못 쓰는 이유를 숨기지 않는다 — 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다 */}
        {blocked && (
          <p className="mt-1.5 text-[11px] text-ash" data-testid="tool-blocked">
            {info(tool)?.installed
              ? `${TOOL_META[tool].label} needs a login — run ${TOOL_META[tool].login} in a terminal`
              : `${TOOL_META[tool].label} not found (${info(tool)?.detail ?? 'not installed'})`}
          </p>
        )}

        {/*
          이 창의 본체. 터미널에서 하던 대화를 그대로 끌고 올 수 있어야
          이 앱이 '또 하나의 창'이 되지 않는다.
        */}
        <div
          className="mt-3 max-h-64 overflow-y-auto rounded border border-edge bg-panel"
          data-testid="past-sessions"
        >
          <PastRow
            selected={!resume}
            onSelect={() => setResume(null)}
            testId="past-new"
            title="Start a new conversation"
            meta=""
          />
          {past.status === 'loading' && (
            <p className="px-2.5 py-2 text-[11px] text-slate" data-testid="past-loading">
              Looking for past conversations…
            </p>
          )}
          {/* 구버전 도구를 쓴다고 새 세션까지 막지 않는다 — 이유만 조용히 알린다 */}
          {past.status === 'unsupported' && (
            <p className="px-2.5 py-2 text-[11px] leading-relaxed text-slate" data-testid="past-unsupported">
              Could not load past conversations — {past.reason}
            </p>
          )}
          {past.status === 'ok' && past.sessions.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-slate" data-testid="past-empty">
              No past conversations in this folder.
            </p>
          )}
          {past.status === 'ok' &&
            past.sessions.map((s) => (
              <PastRow
                key={s.externalId}
                selected={resume?.externalId === s.externalId}
                onSelect={() => {
                  // 이미 열려 있으면 또 만들지 않는다 — 그 세션으로 데려간다.
                  // 표시만 하고 클릭을 막지 않았더니 같은 대화가 목록에 둘 생겼다 (실측).
                  if (s.importedAs) {
                    focusSession(s.importedAs)
                    onClose()
                    return
                  }
                  setResume(s)
                }}
                testId={`past-${s.externalId}`}
                title={s.title}
                /*
                  제목은 도구가 주는 것이고, 도구마다 뜻이 다르다:
                    Claude — 요약(대화 전체를 대표한다)
                    Codex  — **첫 사용자 메시지** (며칠 이어온 대화도 맨 처음 주제로 보인다)
                  그래서 "언제까지 이어졌나"를 제목 옆에 분명히 적는다 —
                  안 그러면 최근 대화가 옛날 것처럼 보여서 못 찾는다 (도그푸딩 지적).
                */
                meta={[
                  `last ${ago(s.updatedAt)}`,
                  s.branch,
                  s.importedAs ? 'Already open · click to jump' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))}
        </div>

        {/*
          경고와 해법을 같은 자리에 둔다 — "같은 파일을 고치면 유실될 수 있다"의 해법이
          워크트리다. 체크박스는 저장소일 때만 그린다: 쓸 수 없는 옵션의 설명은
          만들기라는 일에는 소음이다.
        */}
        {running.length > 0 && (
          <p className="mt-2.5 text-[11px] leading-relaxed text-ash" data-testid="concurrent-warning">
            {running.length} sessions are already running in this directory. Editing the same files can lose changes.
          </p>
        )}
        {isRepo && (
          <label
            className="mt-2.5 flex cursor-pointer items-center gap-2 text-[11px] text-ash hover:text-chalk"
            data-testid="worktree-toggle"
          >
            <input
              type="checkbox"
              className="accent-ash"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            <span>
              Run in a git worktree
              <span className="text-slate"> — own branch and directory, can’t touch the others’ files</span>
            </span>
          </label>
        )}

        {error && (
          <p className="mt-3 rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk" data-testid="create-session-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[10px] text-slate">
            <Kbd>↑↓</Kbd> pick · <Kbd>↵</Kbd> {resume ? 'Load' : 'Start'} · <Kbd>esc</Kbd> close
          </span>
          <button type="button" className="ml-auto rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onClose}>
            Cancel
          </button>
          <button
            /* 입력칸이 사라졌으므로 Enter가 곧 시작이다 — 기본 포커스가 여기 있어야 한다 */
            autoFocus
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
            disabled={busy || blocked}
            data-testid="create-session-confirm"
          >
            {busy ? (resume ? 'Loading…' : 'Starting…') : resume ? 'Load' : 'Start'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * 목록 한 줄. 선택은 밝기로만 말한다 (무채색 규칙) —
 * 체크박스를 그리면 '설정'처럼 보이고, 여기서 하는 일은 고르기다.
 */
function PastRow({
  selected,
  onSelect,
  title,
  meta,
  testId,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  meta: string
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      aria-pressed={selected}
      // 화살표로 고른 줄이 접힌 목록 밖에 있으면 선택이 안 보인다 — 보이는 곳까지만 따라간다
      ref={(el) => {
        if (selected) el?.scrollIntoView({ block: 'nearest' })
      }}
      className={`flex w-full flex-col gap-0.5 border-l-2 px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? 'border-l-ash bg-graphite/40 text-chalk'
          : 'border-l-transparent text-ash hover:bg-graphite/20 hover:text-chalk'
      }`}
    >
      <span className="truncate text-[12px] leading-snug">{title}</span>
      {meta && <span className="readout truncate text-[10px] text-slate">{meta}</span>}
    </button>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { ExternalSession, ToolName } from '@cc/protocol'
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

const TOOL_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

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
 * **여기서 고르는 것은 도구뿐이다.** 모델·권한은 세션을 만든 뒤 헤더에서 바꾼다 —
 * 시작하기 전에 정할 수 있는 것보다, 대화하며 바꿀 수 있는 것이 실제로 더 유용하다.
 * (도구만 예외인 이유: 도구는 프로세스 자체라 도중에 못 바꾼다)
 */
export function NewSessionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const createSession = useStore((s) => s.createSession)
  const running = useSessionsOf(projectId).filter((s) => !s.archived)

  const [tools, setTools] = useState<Detection[] | null>(null)
  const [tool, setTool] = useState<ToolName>(project?.defaultTool ?? 'claude')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
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

  const info = (t: ToolName) => tools?.find((x) => x.tool === t)
  const usable = (t: ToolName) => {
    const d = info(t)
    return !tools || (d?.installed === true && d.loggedIn)
  }
  const blocked = tools ? !usable(tool) : false

  return (
    <Modal onClose={onClose} testId="new-session-dialog" align="top">
      <form
        className="w-[480px] max-w-[92vw] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await createSession(projectId, {
              tool,
              initialPrompt: prompt.trim() || undefined,
              // 이전 세션을 골랐다면 도구에게 그 대화를 이어달라고 하고(resume),
              // 화면에도 지난 대화를 복원한다(importHistory).
              resumeExternalId: resume?.externalId,
              importHistory: resume ? true : undefined,
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

        {running.length > 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-ash" data-testid="concurrent-warning">
            {running.length} sessions are already running in this directory. Editing the same files can lose changes.
          </p>
        )}

        <section className="mt-3.5">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-slate">Tool</h3>
          <div className="flex gap-1.5">
            {(['claude', 'codex'] as const).map((t) => (
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
                {TOOL_LABEL[t]}
              </button>
            ))}
          </div>
          {/* 못 쓰는 이유를 숨기지 않는다 — 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다 */}
          {blocked && (
            <p className="mt-1.5 text-[11px] text-ash" data-testid="tool-blocked">
              {info(tool)?.installed
                ? `${TOOL_LABEL[tool]} needs a login — run ${tool === 'claude' ? 'claude' : 'codex login'} in a terminal`
                : `${TOOL_LABEL[tool]} not found (${info(tool)?.detail ?? 'not installed'})`}
            </p>
          )}
          <p className="mt-1.5 text-[10px] text-slate">Model and permissions are changed in the header after the session is created.</p>
        </section>

        {/*
          이어서 할 일이 이어서 할 대화보다 많지는 않다.
          터미널에서 하던 대화를 그대로 끌고 올 수 있어야 이 앱이 '또 하나의 창'이 되지 않는다.
        */}
        <section className="mt-3.5">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-slate">
            Conversations <span className="normal-case tracking-normal text-slate/70">{TOOL_LABEL[tool]}</span>
          </h3>
          <div
            className="max-h-52 overflow-y-auto rounded border border-edge bg-panel"
            data-testid="past-sessions"
          >
            <PastRow
              selected={!resume}
              onSelect={() => setResume(null)}
              testId="past-new"
              title="Start a new conversation"
              meta="Empty session"
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
          {resume && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate" data-testid="resume-note">
              Resumes a past conversation. The tool keeps its context, and recent messages are restored here.
            </p>
          )}
        </section>

        <section className="mt-3.5">
          <h3 className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-slate">
            {resume ? 'Continue with' : 'Initial prompt'}{' '}
            <span className="normal-case tracking-normal text-slate/70">optional</span>
          </h3>
          <textarea
            autoFocus
            className="max-h-32 w-full resize-none rounded border border-edge bg-panel px-2.5 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
            }}
            placeholder="What should it do?"
            data-testid="initial-prompt"
          />
        </section>

        {error && (
          <p className="mt-3 rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk" data-testid="create-session-error">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          <span className="text-[10px] text-slate">
            <Kbd>esc</Kbd> close · <Kbd>⌘</Kbd> <Kbd>↵</Kbd> {resume ? 'Load' : 'Start'}
          </span>
          <button type="button" className="ml-auto rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onClose}>
            Cancel
          </button>
          <button
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

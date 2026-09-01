import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { TOOL_META, TOOL_NAMES, type ExternalSession, type ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useSessionsOf } from '../../store/selectors.js'
import { Modal } from '../../components/Modal.jsx'

/** 칸 하나의 생김새. 셋이 같은 모양이어야 '같은 종류의 답'으로 읽힌다 */
const inputClass =
  'w-full rounded border border-edge bg-void px-2 py-1.5 font-mono text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none'

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

/**
 * 쉼표로 적은 목록 하나를 읽는다 (#76).
 *
 * 저장할 때(아래 copyFiles.split)와 **같은 규칙이어야 한다** — 후보 칩이 "이미 골랐나"를
 * 다르게 세면, 눌러 넣은 항목이 눌러도 안 빠지는 상태가 생긴다.
 */
const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)

/** 630MB · 8.5GB — 자릿수만 맞으면 된다. 이 숫자는 정확도가 아니라 규모를 말한다 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)}KB`
  const mb = kb / 1024
  return mb < 1024 ? `${Math.round(mb)}MB` : `${(mb / 1024).toFixed(1)}GB`
}

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
 *
 * 틀은 다른 창(Settings·Inbox)과 같다 — **머리 고정 / 본체 스크롤 / 발 고정.**
 * 도구와 시작 버튼은 창이 얼마나 길어지든 제자리에 있어야 하고, 길어지는 것은
 * 가운데(대화 목록·워크트리 설정)뿐이다. 예전에는 창 전체가 자라서, 워크트리를 켜고
 * 후보를 펼치면 시작 버튼이 화면 밖으로 밀려났다.
 */
export function NewSessionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const platform = usePlatform()
  const project = useStore((s) => s.projects[projectId])
  const createSession = useStore((s) => s.createSession)
  const saveWorktreeSetup = useStore((s) => s.saveWorktreeSetup)
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
  /**
   * 브랜치 이름 (#69). 브랜치 이름이 곧 세션 이름이자 디렉토리 이름 — 사실상 영구라
   * 만들기 전에 정할 자리가 있어야 한다. 비우면 host가 자동 이름을 쓴다 (강제 없음).
   */
  const [branch, setBranch] = useState(useStore.getState().newSessionBranch)
  /**
   * 프로비저닝 (#69). 저장된 설정이 있으면 접힌 요약으로, 없으면(첫 사용) 펼친 채 —
   * 처음 "아, node_modules 깔아야 하는데"가 떠오르는 순간에 입력칸이 눈앞에 있어야 한다.
   */
  const savedSetup = project?.worktreeSetup ?? null
  const [setupOpen, setSetupOpen] = useState(!savedSetup)
  const [setupCommand, setSetupCommand] = useState(savedSetup?.command ?? '')
  const [copyFiles, setCopyFiles] = useState(savedSetup?.copyFiles.join(', ') ?? '')
  const [error, setError] = useState<string | null>(null)
  /**
   * 복사 후보 (#76) — git이 무시하는 것들, 곧 **새 워크트리에 없을 것들**.
   *
   * 목록을 내밀되 앱이 고르지는 않는다: "무시된 건 전부 복사"를 기본값으로 삼으면 이
   * 저장소에서만 node_modules 637MB + Rust target 8.5GB가 딸려 온다. 대신 크기를 함께
   * 보여준다 — 이 목록에서 사람이 실제로 하는 판단이 "이건 너무 크다"라서다.
   * 워크트리를 켰을 때만 물어본다 (안 쓸 목록을 위해 du를 돌리지 않는다).
   */
  const [ignored, setIgnored] = useState<{ path: string; bytes: number | null }[] | null>(null)
  useEffect(() => {
    if (!isRepo || !worktree || ignored) return
    let alive = true
    void platform.git
      .ignoredEntries(projectId)
      .then((list) => alive && setIgnored(list))
      .catch(() => alive && setIgnored([]))
    return () => {
      alive = false
    }
  }, [isRepo, worktree, ignored, platform, projectId])

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

  // 복사로 딸려올 무게 — 이 목록에서 사람이 하는 판단이 "이건 너무 크다"라서 합계를 보여준다
  const picks = splitList(copyFiles)
  const pickedBytes = (ignored ?? [])
    .filter((e) => picks.includes(e.path))
    .reduce((n, e) => n + (e.bytes ?? 0), 0)

  return (
    <Modal onClose={onClose} testId="new-session-dialog" align="top">
      <form
        className="flex max-h-[calc(82vh/var(--text-zoom))] w-[480px] max-w-[calc(92vw/var(--text-zoom))] flex-col overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
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
            /*
             * 프로비저닝 설정은 **만들기 전에** 저장한다 (#69) — host가 워크트리를 만들면서
             * 저장된 설정을 읽어 돌리므로, 순서가 바뀌면 방금 적은 셋업이 이번 생성에는
             * 적용되지 않는다. 바뀌었을 때만 왕복한다.
             */
            if (worktree && setupOpen) {
              const next = { command: setupCommand.trim(), copyFiles: splitList(copyFiles) }
              const changed =
                next.command !== (savedSetup?.command ?? '') ||
                next.copyFiles.join('\n') !== (savedSetup?.copyFiles ?? []).join('\n')
              if (changed)
                await saveWorktreeSetup(projectId, next.command || next.copyFiles.length ? next : null)
            }
            await createSession(projectId, {
              tool,
              // 이전 세션을 골랐다면 도구에게 그 대화를 이어달라고 하고(resume),
              // 화면에도 지난 대화를 복원한다(importHistory).
              resumeExternalId: resume?.externalId,
              importHistory: resume ? true : undefined,
              worktree: worktree || undefined,
              worktreeBranch: (worktree && branch.trim()) || undefined,
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
        {/*
          머리는 고정하고 본체만 구른다 (Settings·Inbox와 같은 틀) — 워크트리를 켜면
          입력칸과 후보 칩이 붙어 창이 화면 밖으로 자라던 자리다. 시작 버튼은
          아래 붙박이라 어디까지 스크롤했든 항상 손에 있다.
        */}
        <header className="shrink-0 border-b border-edge px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-chalk">
            New session <span className="text-slate">·</span>{' '}
            <span className="text-ash">{project?.name}</span>
          </h2>
          {/* 도구 — 소제목 없이 필 두 개면 뜻이 선다. 모델·권한은 만든 뒤 헤더에서 */}
          <div className="mt-2.5 flex gap-1.5">
            {TOOL_NAMES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTool(t)}
                data-testid={`tool-option-${t}`}
                title={info(t)?.detail}
                className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                  tool === t
                    ? 'border-ash bg-graphite/40 text-chalk'
                    : 'border-edge text-ash hover:border-graphite hover:text-chalk'
                } ${tools && !usable(t) ? 'opacity-50' : ''}`}
              >
                {TOOL_META[t].label}
              </button>
            ))}
          </div>
          {/* 못 쓰는 이유를 숨기지 않는다 — 버튼만 죽어 있으면 '아무 동작 안 함'으로 보인다 */}
          {blocked && (
            <p className="mt-2 text-[11px] leading-relaxed text-ash" data-testid="tool-blocked">
              {info(tool)?.installed
                ? `${TOOL_META[tool].label} needs a login — run ${TOOL_META[tool].login} in a terminal`
                : `${TOOL_META[tool].label} not found (${info(tool)?.detail ?? 'not installed'})`}
            </p>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/*
          이 창의 본체. 터미널에서 하던 대화를 그대로 끌고 올 수 있어야
          이 앱이 '또 하나의 창'이 되지 않는다.
        */}
          <div
            className="max-h-64 overflow-y-auto rounded border border-edge bg-panel"
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
              <p
                className="px-2.5 py-2 text-[11px] leading-relaxed text-slate"
                data-testid="past-unsupported"
              >
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
              {running.length} sessions are already running in this directory. Editing the same files can lose
              changes.
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
          {/*
          켰을 때만 세부를 묻고, 물을 때는 **한 덩어리로** 묶는다 (삭제 확인 창의 워크트리
          칸과 같은 모양) — 전체폭 입력칸이 그냥 쌓이면 체크박스에 딸린 것인지, 창에
          딸린 것인지 눈으로 안 갈린다. 이름이 곧 세션 이름·디렉토리 이름이라(사실상 영구)
          만들기 전이 정할 유일한 순간이다.
        */}
          {isRepo && worktree && (
            <div
              className="mt-2 space-y-2.5 rounded border border-edge bg-panel p-2.5"
              data-testid="worktree-options"
            >
              <Field label="Branch" hint="blank = auto">
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="feature/…"
                  data-testid="worktree-branch-input"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              {/*
              프로비저닝 (#69) — 새 워크트리는 빈 작업대다 (추적 파일만 있고 node_modules도
              gitignored .env도 없다). 여기 적은 것이 생성 때 자동으로 돈다: 복사 → 셋업.
              저장돼 있으면 한 줄 요약으로 접는다 — 매번 펼치면 확인할 것 없는 확인이 된다.
            */}
              {setupOpen ? (
                <div className="space-y-2.5" data-testid="worktree-setup-edit">
                  <Field label="Setup command" hint="runs once, in the new worktree">
                    <input
                      type="text"
                      value={setupCommand}
                      onChange={(e) => setSetupCommand(e.target.value)}
                      placeholder="pnpm install"
                      data-testid="worktree-setup-command"
                      spellCheck={false}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Copy from the project" hint="comma-separated">
                    <input
                      type="text"
                      value={copyFiles}
                      onChange={(e) => setCopyFiles(e.target.value)}
                      placeholder=".env.local"
                      data-testid="worktree-copy-files"
                      spellCheck={false}
                      className={inputClass}
                    />
                    {/*
                    후보를 **짚어만 준다** (#76). 누르면 위 칸에 들어가고, 다시 누르면 빠진다 —
                    칸이 여전히 진실이라 손으로 친 것과 눌러 넣은 것이 갈리지 않는다.
                  */}
                    {ignored && ignored.length > 0 && (
                      <div className="mt-1.5" data-testid="worktree-ignored-suggestions">
                        <ul className="flex flex-wrap gap-1">
                          {ignored.map((e) => {
                            const picked = picks.includes(e.path)
                            return (
                              <li key={e.path}>
                                <button
                                  type="button"
                                  data-testid={`ignored-${e.path}`}
                                  onClick={() => {
                                    const next = picked
                                      ? picks.filter((f) => f !== e.path)
                                      : [...picks, e.path]
                                    setCopyFiles(next.join(', '))
                                  }}
                                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                                    picked
                                      ? 'border-ash bg-graphite/40 text-chalk'
                                      : 'border-edge text-slate hover:border-graphite hover:text-ash'
                                  }`}
                                >
                                  {e.path}
                                  {e.bytes !== null && (
                                    <span className="ml-1 text-slate">{fmtBytes(e.bytes)}</span>
                                  )}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                        {/*
                        고른 것의 **합계**를 적는다. 칩마다 크기가 붙어 있어도 사람은 그걸 더하지
                        않는다 — Rust target 하나로 8.5GB가 붙는 저장소에서, 합계가 없으면
                        워크트리를 만들고 나서야 무게를 안다.
                      */}
                        {picks.length > 0 && (
                          <p className="mt-1.5 text-[10px] text-slate" data-testid="copy-total">
                            {picks.length} to copy{pickedBytes > 0 ? ` · ~${fmtBytes(pickedBytes)}` : ''}
                            {pickedBytes > 1024 ** 3 && (
                              <span className="text-ash"> — every worktree pays this again</span>
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  </Field>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="worktree-setup-summary"
                  onClick={() => setSetupOpen(true)}
                  className="block w-full truncate rounded border border-edge px-2 py-1 text-left font-mono text-[10px] text-slate hover:border-graphite hover:text-ash"
                  title="Edit worktree setup"
                >
                  {savedSetup?.command ? `setup: ${savedSetup.command}` : 'setup: (none)'}
                  {savedSetup?.copyFiles.length ? ` · copies: ${savedSetup.copyFiles.join(', ')}` : ''}
                </button>
              )}
            </div>
          )}

          {error && (
            <p
              className="mt-3 rounded border border-edge bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-chalk"
              data-testid="create-session-error"
            >
              {error}
            </p>
          )}
        </div>

        {/*
          단축키 안내는 걷어냈다 (2026-09-02 도그푸딩) — ↑↓·↵·esc는 목록이 있는 창이면
          어차피 손이 먼저 아는 것이고, 매번 읽히는 자리에 놓기엔 값이 너무 작다.
          동작은 그대로다: 안내만 없앴다.
        */}
        <footer className="flex shrink-0 justify-end gap-2 border-t border-edge px-4 py-2.5">
          <button
            type="button"
            className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk"
            onClick={onClose}
          >
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
        </footer>
      </form>
    </Modal>
  )
}

/**
 * 라벨 + 칸.
 *
 * 긴 안내를 placeholder에 넣던 것을 라벨로 올렸다 — placeholder는 **타이핑을 시작하는
 * 순간 사라져서**, 정작 "여기 뭘 적는 칸이었지"를 되묻는 순간에는 없다. 게다가 480px
 * 창에서 "Setup command, runs once in the new worktree (e.g. pnpm install)"는 잘려서
 * 끝까지 읽히지도 않았다.
 *
 * label 대신 div인 이유: 이 안에 후보 칩(버튼)이 들어가는데, label 안의 클릭은 칸으로
 * 넘어간다 — 칩을 누를 때마다 입력칸이 잡히는 건 고르기를 방해한다.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] text-ash">
        {label}
        {hint && <span className="text-slate"> · {hint}</span>}
      </p>
      {children}
    </div>
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

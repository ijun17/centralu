import { useEffect, useState } from 'react'
// 문서의 모양은 호스트 절반과 같은 한 벌이다 (M4 P-5) — 전에는 여기와 agent-host의
// apps/control.ts에 따로 적혀 있었고, `notifies`의 필수 여부가 서로 달랐다.
import type { ControlDoc } from '@cc/protocol'
import {
  answerQuestion,
  focusSession,
  invokeAppTool,
  respondApproval,
  send,
  setAppState,
  useAppState,
  useInbox,
  useLastWords,
  useRunningTool,
  useSessionSummaries,
  type SessionSummary,
} from '../api.js'

/**
 * 관제 레일 (#80) — **사람의 작업대.**
 *
 * 사람은 N개 파이프라인에 박힌 하나의 공정이다: 에이전트가 한 바퀴 돌리면 사람
 * 차례가 오고, 그걸 후딱 처리하고 다음으로. 이 레일이 최적화하는 것은 그
 * **사람 턴의 처리량**이다 — 도착해서 맥락 찾기(스크롤)가 가장 큰 마찰이라
 * "무엇이 필요한가"를 줄에 먼저 쓰고, 한 줄짜리 답은 줄 안에서 끝낸다.
 *
 * 위 = 행동(내 차례), 아래 = 배경(진행 중) — 읽는 순서가 곧 우선순위다.
 * 진행 중 단면은 그리드의 감시 목적을 한 줄로 압축한 것이다: bypass로 도는
 * 세션은 멈추지 않으므로, 끼어들 타이밍은 대기 목록이 아니라 서사에서 읽힌다.
 */

/**
 * 판정 카운터 (#80: "계속 쓰는가"는 감이 아니라 숫자) — 줄 안 즉답과 레일 경유
 * 진입을 센다.
 *
 * 알려진 경합: 이 문서는 host와 나눠 쓰고, 양쪽 모두 문서 **전체를** 읽고-고치고-통째로
 * 쓴다. 늦게 쓴 쪽이 먼저 쓴 쪽의 칸을 되돌린다 — UI가 옛 사본으로 쓰면 그 사이 host가 올린
 * 알림이나 업무가 사라진다. 창이 초 단위이던 두 자리는 막았다 (#178): host의
 * control_create_task는 반장을 기다린 뒤 문서를 다시 읽고, 스토어는 아직 읽지 못한 문서 위에
 * 쓰지 않는다(그때 `doc`은 null이라 이 함수가 `{ metrics }`만으로 문서 전체를 덮었다). 남은 것은
 * 방송이 사본을 맞추기 전의 ms 창이다. 없애려면 통째 쓰기 대신 칸 단위 갱신이나 판본 비교가 필요하다.
 */
export function bumpMetric(doc: ControlDoc | null, key: 'inlineReplies' | 'railOpens'): void {
  const metrics = { ...(doc?.metrics ?? {}) }
  metrics[key] = (metrics[key] ?? 0) + 1
  setAppState('control', { ...(doc ?? {}), metrics })
}

export function ControlRail() {
  // 기다린 시간(waitingMs)이 흐르게 — 5초면 충분하다 (초시계가 아니라 감각이다)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [])

  const [creating, setCreating] = useState(false)
  const inbox = useInbox(now)
  const sessions = useSessionSummaries()
  const doc = useAppState<ControlDoc>('control')

  // 오케스트레이터(상주 대화)와 반장(메타 층 — Tasks 섹션의 몫)은 뺀다
  const meta = (id: string) => sessions[id]?.kind === 'orchestrator' || sessions[id]?.kind === 'coordinator'
  const mine = inbox.filter((i) => !meta(i.id))
  const running = Object.values(sessions).filter((s) => s.state === 'working' && !meta(s.id))
  const tasks = doc?.tasks ?? []
  const notifies = [...(doc?.notifies ?? [])].sort(
    (a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || b.ts - a.ts,
  )

  const dismiss = (id: string) =>
    setAppState('control', { ...(doc ?? {}), notifies: (doc?.notifies ?? []).filter((n) => n.id !== id) })

  return (
    <aside
      // 폭·테두리는 슬롯(AppRails)의 것 — 레일은 내용만 채운다 (#81 소유권 경계)
      className="flex w-full min-w-0 flex-col overflow-y-auto bg-void"
      data-testid="control-rail"
    >
      {/* 기계가 사람을 지목해 부른 것들 — 세션 상태로는 안 드러나는 호출 (control_notify) */}
      {notifies.length > 0 && (
        <section className="border-b border-edge px-3 py-2">
          <h2 className="text-[10px] uppercase text-slate">Notices</h2>
          {notifies.map((n) => (
            <div key={n.id} className="mt-1.5 flex items-start gap-1.5" data-testid={`rail-notify-${n.id}`}>
              <p className={`min-w-0 flex-1 text-[11px] leading-snug ${n.priority === 'high' ? 'text-chalk' : 'text-ash'}`}>
                {n.text}
                {n.sessionId && sessions[n.sessionId] && (
                  <button
                    className="ml-1 text-[10px] text-slate underline-offset-2 hover:text-chalk hover:underline"
                    onClick={() => focusSession(n.sessionId!)}
                  >
                    {sessions[n.sessionId]!.name} →
                  </button>
                )}
              </p>
              <button
                className="shrink-0 text-[11px] text-slate hover:text-chalk"
                onClick={() => dismiss(n.id)}
                data-testid={`rail-notify-dismiss-${n.id}`}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </section>
      )}

      {/* 내 차례 — 행동. 인박스 판정(@cc/core buildInbox)의 순서 그대로 */}
      <section className="border-b border-edge px-3 py-2">
        <h2 className="text-[10px] uppercase text-slate">
          My turn {mine.length > 0 && <span className="text-chalk">{mine.length}</span>}
        </h2>
        {mine.length === 0 && <p className="mt-1.5 text-[11px] text-slate">Nothing needs you right now.</p>}
        {mine.map((item) => (
          <TurnRow key={item.id} id={item.id} waitingMs={item.waitingMs} unread={item.unread} s={sessions[item.id]} />
        ))}
      </section>

      {/* 업무 — 반장이 조율하는 다중 세션 묶음 (#80 목적 2). 사람은 버스에서 내려 심판석으로 */}
      <section className="border-b border-edge px-3 py-2" data-testid="rail-tasks">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[10px] uppercase text-slate">Tasks {tasks.length > 0 && tasks.filter((t) => t.status === 'active').length}</h2>
          <button
            className="text-[10px] text-slate hover:text-chalk"
            onClick={() => setCreating(true)}
            data-testid="rail-new-task"
          >
            + New task
          </button>
        </div>
        {tasks
          .filter((t) => t.status === 'active')
          .map((t) => (
            <div key={t.id} className="mt-1.5" data-testid={`rail-task-${t.id}`}>
              <button
                className="block w-full text-left"
                onClick={() => focusSession(t.coordinatorId)}
                data-testid={`rail-task-open-${t.id}`}
              >
                <span className="block truncate text-[11px] text-ash">{t.title}</span>
                <span className="block truncate text-[10px] text-slate">
                  반장: {sessions[t.coordinatorId]?.state ?? 'gone'}
                </span>
              </button>
              {/*
                구성원 — 반장의 시야를 사람도 본다 (도그푸딩 지적 2026-09-06: 숫자만으로는
                어느 세션들이 이 업무인지 안 보였다). 칩을 누르면 그 세션으로 간다.
              */}
              <div className="mt-0.5 flex flex-wrap gap-1">
                {t.members.map((id) => (
                  <button
                    key={id}
                    onClick={() => focusSession(id)}
                    data-testid={`rail-task-member-${t.id}-${id}`}
                    title={sessions[id] ? `${sessions[id]!.name} — ${sessions[id]!.state}` : 'session gone'}
                    className="max-w-full truncate rounded border border-edge px-1 py-px text-[10px] text-slate transition-colors hover:border-graphite hover:text-chalk"
                  >
                    {sessions[id]?.name ?? '(gone)'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        {tasks.some((t) => t.status === 'done') && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[10px] text-slate">Done {tasks.filter((t) => t.status === 'done').length}</summary>
            {tasks
              .filter((t) => t.status === 'done')
              .map((t) => (
                <button
                  key={t.id}
                  className="mt-1 block w-full truncate text-left text-[10px] text-slate hover:text-chalk"
                  onClick={() => focusSession(t.coordinatorId)}
                >
                  ✅ {t.title}
                </button>
              ))}
          </details>
        )}
      </section>

      {creating && <NewTaskDialog sessions={sessions} onClose={() => setCreating(false)} />}

      {/* 진행 중 — 배경. 그리드의 감시를 세로 한 줄씩으로 압축 */}
      <section className="px-3 py-2">
        <h2 className="text-[10px] uppercase text-slate">Running {running.length > 0 && running.length}</h2>
        {running.length === 0 && <p className="mt-1.5 text-[11px] text-slate">No sessions working.</p>}
        {running.map((s) => (
          <RunningRow key={s.id} s={s} />
        ))}
      </section>
    </aside>
  )
}

/**
 * 진행 중 한 줄 — **서사(말)가 정본, 도구는 보조** (도그푸딩 2026-09-05).
 * preview만 쓰면 툴 호출이 말을 덮어 "pnpm verify" 한 줄만 남는다 — 끼어들
 * 타이밍은 도구 이름이 아니라 에이전트가 무슨 생각으로 가는지에서 읽힌다.
 */
function RunningRow({ s }: { s: SessionSummary }) {
  const words = useLastWords(s.id)
  const tool = useRunningTool(s.id)
  return (
    <button
      className="mt-1.5 block w-full text-left"
      onClick={() => focusSession(s.id)}
      data-testid={`rail-running-${s.id}`}
    >
      <span className="block truncate text-[11px] text-ash">{s.name}</span>
      <span className="block truncate text-[10px] leading-snug text-slate">{words ?? s.preview ?? '…'}</span>
      {tool && <span className="readout block truncate text-[9px] text-slate/70">{tool}</span>}
    </button>
  )
}

/** 초 단위는 소음이다 — 사람이 읽는 것은 "방금/몇 분/한참"의 감각 */
function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

/**
 * 내 차례 한 줄 — "무엇이 필요한가"가 먼저, 한 줄짜리 답은 여기서 끝낸다.
 * 깊게 봐야 하면 이름을 눌러 그 세션으로 (피크 발명 없음 — 기존 포커스 뷰).
 */
function TurnRow({ id, waitingMs, unread, s }: { id: string; waitingMs: number; unread: boolean; s?: SessionSummary }) {
  const [text, setText] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  // 말이 정본, preview는 대화가 안 실린 세션의 물러섬 (RunningRow와 같은 규칙)
  const words = useLastWords(id)
  const doc = useAppState<ControlDoc>('control')
  if (!s) return null

  const approval = s.pendingApproval
  const question = s.pendingQuestions[0]?.questions[0]
  const questionReq = s.pendingQuestions[0]?.requestId

  return (
    <div className="mt-2" data-testid={`rail-turn-${id}`}>
      <button
        className="flex w-full items-baseline gap-1.5 text-left"
        onClick={() => {
          bumpMetric(doc, 'railOpens')
          focusSession(id)
        }}
      >
        <span className={`min-w-0 flex-1 truncate text-[11px] ${unread ? 'text-chalk' : 'text-ash'}`}>{s.name}</span>
        <span className="readout shrink-0 text-[9px] text-slate">{ago(waitingMs)}</span>
      </button>

      {approval && (
        <div className="mt-1">
          <p className="readout truncate text-[10px] text-slate">
            {approval.detail.kind === 'command'
              ? `$ ${approval.detail.command}`
              : approval.detail.kind === 'file_edit'
                ? approval.detail.path
                : approval.detail.kind === 'capability'
                  ? `${approval.detail.app.name} wants to ${approval.detail.text}`
                  : 'approval requested'}
          </p>
          {/* diff는 줄에서 판단의 재료다 — 세션을 열지 않고 승인하려면 무엇이 바뀌는지 보여야 한다 */}
          {approval.detail.kind === 'file_edit' && showDiff && (
            <pre
              className="readout mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded border border-edge bg-panel p-1.5 text-[9px] leading-snug text-ash"
              data-testid={`rail-diff-${id}`}
            >
              {approval.detail.diffPreview}
            </pre>
          )}
          <div className="mt-1 flex gap-1.5">
            <button
              className="rounded border border-edge bg-panel px-2 py-0.5 text-[10px] text-chalk hover:border-graphite"
              onClick={() => {
                bumpMetric(doc, 'inlineReplies')
                respondApproval(id, approval.requestId, 'allow')
              }}
              data-testid={`rail-approve-${id}`}
            >
              Approve
            </button>
            <button
              className="rounded px-2 py-0.5 text-[10px] text-slate hover:text-chalk"
              onClick={() => {
                bumpMetric(doc, 'inlineReplies')
                respondApproval(id, approval.requestId, 'deny')
              }}
              data-testid={`rail-deny-${id}`}
            >
              Deny
            </button>
            {approval.detail.kind === 'file_edit' && (
              <button
                className="rounded px-2 py-0.5 text-[10px] text-slate hover:text-chalk"
                onClick={() => setShowDiff((v) => !v)}
                data-testid={`rail-diff-toggle-${id}`}
              >
                {showDiff ? 'Hide diff' : 'Diff'}
              </button>
            )}
          </div>
        </div>
      )}

      {!approval && question && questionReq && (
        <div className="mt-1">
          <p className="truncate text-[10px] text-slate">{question.question}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {/* 다중 선택은 줄에서 안 끝난다 — 세션을 열어 온전한 카드로 답한다 */}
            {!question.multiSelect &&
              question.options.slice(0, 3).map((o) => (
                <button
                  key={o.label}
                  className="rounded border border-edge bg-panel px-1.5 py-0.5 text-[10px] text-chalk hover:border-graphite"
                  onClick={() => {
                    bumpMetric(doc, 'inlineReplies')
                    answerQuestion(id, questionReq, [{ question: question.question, answers: [o.label] }])
                  }}
                  data-testid={`rail-option-${id}-${o.label}`}
                >
                  {o.label}
                </button>
              ))}
          </div>
        </div>
      )}

      {!approval && !question && s.state === 'error' && (
        <p className="mt-1 truncate text-[10px] text-del">{s.lastError?.message ?? 'error'}</p>
      )}

      {!approval && !question && s.state === 'waiting_input' && (
        <>
          {/*
            마지막 활동은 자기 줄에 — placeholder에 넣었더니 "제안된 답장"처럼 읽혔다
            (도그푸딩 2026-09-05: 입력창 안의 `pnpm verify`가 "이게 정상이야?"를 낳았다).
            입력창은 언제나 빈 종이처럼 보여야 한다.
          */}
          {(words ?? s.preview) && <p className="mt-1 truncate text-[10px] text-slate">{words ?? s.preview}</p>}
          <input
            className="mt-1 w-full rounded border border-edge bg-panel px-1.5 py-1 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
            placeholder="Reply…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && text.trim()) {
              bumpMetric(doc, 'inlineReplies')
              send(id, text.trim())
              setText('')
            }
          }}
          data-testid={`rail-input-${id}`}
          />
        </>
      )}
    </div>
  )
}

/**
 * 업무 만들기 — 구성원을 고르고 목표를 적으면 반장이 선다.
 * 생성 로직은 host 앱 도구(control_create_task) 하나뿐이다: 오케스트레이터가 만들든
 * 사람이 이 창으로 만들든 같은 문을 지난다 (구현이 둘이면 한쪽이 낡는다).
 */
function NewTaskDialog({ sessions, onClose }: { sessions: Record<string, SessionSummary>; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const workers = Object.values(sessions).filter((s) => s.kind === 'worker')

  const create = async () => {
    if (!title.trim() || members.length === 0 || busy) return
    setBusy(true)
    const r = await invokeAppTool('control', 'control_create_task', {
      title: title.trim(),
      goal: goal.trim(),
      memberSessionIds: members,
    })
    setBusy(false)
    if (r.isError) setError(r.text)
    else onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose} data-testid="new-task-dialog">
      <div
        className="w-[380px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13px] text-chalk">New task</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ash">
          Pick member sessions and state the goal — a foreman session will coordinate them, keep a
          board, and call you on the rail when needed.
        </p>
        <input
          className="mt-3 w-full rounded border border-edge bg-panel px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="Task name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="task-title"
        />
        <textarea
          className="mt-2 w-full resize-none rounded border border-edge bg-panel px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          rows={2}
          placeholder="Goal — becomes the foreman's brief"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          data-testid="task-goal"
        />
        <p className="mt-2 text-[10px] uppercase text-slate">Members</p>
        <div className="mt-1 max-h-40 overflow-y-auto">
          {workers.length === 0 && <p className="text-[11px] text-slate">No worker sessions yet.</p>}
          {workers.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-ash hover:text-chalk">
              <input
                type="checkbox"
                className="accent-ash"
                checked={members.includes(s.id)}
                onChange={(e) =>
                  setMembers((m) => (e.target.checked ? [...m, s.id] : m.filter((x) => x !== s.id)))
                }
                data-testid={`task-member-${s.id}`}
              />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
        {error && <p className="mt-2 text-[11px] text-del">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk hover:border-graphite disabled:opacity-40"
            disabled={!title.trim() || members.length === 0 || busy}
            onClick={() => void create()}
            data-testid="task-create"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

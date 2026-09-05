import { useEffect, useState } from 'react'
import {
  answerQuestion,
  focusSession,
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

type Notify = { id: string; text: string; sessionId?: string; priority?: 'high' | 'normal'; ts: number }
type ControlDoc = { notifies?: Notify[] }

export function ControlRail() {
  // 기다린 시간(waitingMs)이 흐르게 — 5초면 충분하다 (초시계가 아니라 감각이다)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [])

  const inbox = useInbox(now)
  const sessions = useSessionSummaries()
  const doc = useAppState<ControlDoc>('control')

  // 오케스트레이터 자신은 뺀다 — 상주 대화라 늘 응답 대기고, 이 레일이 그 화면 안에 있다
  const mine = inbox.filter((i) => sessions[i.id]?.kind !== 'orchestrator')
  const running = Object.values(sessions).filter((s) => s.state === 'working' && s.kind !== 'orchestrator')
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
          <h2 className="text-[10px] uppercase tracking-[0.12em] text-slate">Notices</h2>
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
        <h2 className="text-[10px] uppercase tracking-[0.12em] text-slate">
          My turn {mine.length > 0 && <span className="text-chalk">{mine.length}</span>}
        </h2>
        {mine.length === 0 && <p className="mt-1.5 text-[11px] text-slate">Nothing needs you right now.</p>}
        {mine.map((item) => (
          <TurnRow key={item.id} id={item.id} waitingMs={item.waitingMs} unread={item.unread} s={sessions[item.id]} />
        ))}
      </section>

      {/* 진행 중 — 배경. 그리드의 감시를 세로 한 줄씩으로 압축 */}
      <section className="px-3 py-2">
        <h2 className="text-[10px] uppercase tracking-[0.12em] text-slate">Running {running.length > 0 && running.length}</h2>
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
  // 말이 정본, preview는 대화가 안 실린 세션의 물러섬 (RunningRow와 같은 규칙)
  const words = useLastWords(id)
  if (!s) return null

  const approval = s.pendingApproval
  const question = s.pendingQuestions[0]?.questions[0]
  const questionReq = s.pendingQuestions[0]?.requestId

  return (
    <div className="mt-2" data-testid={`rail-turn-${id}`}>
      <button className="flex w-full items-baseline gap-1.5 text-left" onClick={() => focusSession(id)}>
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
                : 'approval requested'}
          </p>
          <div className="mt-1 flex gap-1.5">
            <button
              className="rounded border border-edge bg-panel px-2 py-0.5 text-[10px] text-chalk hover:border-graphite"
              onClick={() => respondApproval(id, approval.requestId, 'allow')}
              data-testid={`rail-approve-${id}`}
            >
              Approve
            </button>
            <button
              className="rounded px-2 py-0.5 text-[10px] text-slate hover:text-chalk"
              onClick={() => respondApproval(id, approval.requestId, 'deny')}
              data-testid={`rail-deny-${id}`}
            >
              Deny
            </button>
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
                  onClick={() => answerQuestion(id, questionReq, [{ question: question.question, answers: [o.label] }])}
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

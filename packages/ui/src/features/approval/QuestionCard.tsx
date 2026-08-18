import { useState } from 'react'
import type { Question, QuestionAnswer } from '@cc/protocol'
import { useStore } from '../../store/store.js'

/**
 * 에이전트가 내민 선택지 (AskUserQuestion).
 *
 * 승인 카드와 나눠 둔 이유는 돌아가는 것이 다르기 때문이다 — 승인은 실행 여부고,
 * 이건 **내용**이다. 그래서 예/아니오가 아니라 고른 답이 모델에게 간다.
 *
 * 도그푸딩에서 이 도구 호출은 선택지 UI 없이 원시 JSON으로 흐르다 중간에 잘렸다.
 * 두 번째 선택지부터 보이지 않아 **답할 수단 자체가 없었다.** 그래서 여기서는
 * 질문도 선택지도 설명도 자르지 않는다 — 자를 거면 애초에 물을 이유가 없다.
 */
export function QuestionCard({
  sessionId,
  requestId,
  questions,
}: {
  sessionId: string
  requestId: string
  questions: Question[]
}) {
  const answer = useStore((s) => s.answerQuestion)
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  /*
   * **직접 입력.**
   *
   * 도구의 스키마가 못을 박아 둔다: "There should be no 'Other' option, that will be
   * provided automatically." 즉 그 자리는 **화면이 만들어 주기로 되어 있는 것**이고,
   * 우리가 우리 화면을 그리기로 한 이상 이것도 우리 몫이다. 없으면 사람은 내민 둘 중
   * 하나로만 답할 수 있어서, 셋째 답이 있을 때 할 말이 없어진다.
   */
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [sending, setSending] = useState(false)

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((p) => {
      const cur = p[qi] ?? []
      if (!multi) return { ...p, [qi]: [label] }
      return { ...p, [qi]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
    })
    // 하나만 고르는 질문이면 직접 입력과 선택지는 서로를 밀어낸다
    if (!multi) setOtherOn((o) => ({ ...o, [qi]: false }))
  }

  const toggleOther = (qi: number, multi: boolean) => {
    setOtherOn((o) => ({ ...o, [qi]: !o[qi] }))
    if (!multi) setPicked((p) => ({ ...p, [qi]: [] }))
  }

  /** 이 질문에 대해 실제로 보낼 답 (고른 것 + 직접 쓴 것) */
  const answersFor = (qi: number): string[] => {
    const typed = otherOn[qi] ? (otherText[qi] ?? '').trim() : ''
    return [...(picked[qi] ?? []), ...(typed ? [typed] : [])]
  }

  // 모든 질문에 답해야 보낸다 — 반만 보내면 모델은 나머지를 지어낸다
  const ready = questions.every((_, i) => answersFor(i).length > 0)

  const submit = async () => {
    if (!ready || sending) return
    setSending(true)
    const answers: QuestionAnswer[] = questions.map((q, i) => ({
      question: q.question,
      answers: answersFor(i),
    }))
    await answer(sessionId, requestId, answers)
    setSending(false)
  }

  return (
    <div
      className="overflow-hidden rounded border border-edge border-l-2 border-l-beacon bg-panel"
      data-testid="question-card"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="beacon text-[10px] font-medium tracking-[0.1em]">Agent is asking</span>
        <span className="text-[11px] text-slate">
          {questions.length > 1 ? `${questions.length} questions` : 'Pick an option'}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-3 px-3">
        {questions.map((q, qi) => (
          <div key={qi} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              {q.header && (
                <span className="shrink-0 rounded bg-edge px-1.5 py-px text-[10px] text-slate">{q.header}</span>
              )}
              <span className="text-[13px] leading-snug text-chalk">{q.question}</span>
              {/* 여러 개 고를 수 있다는 것은 눌러보기 전에 알아야 한다 */}
              {q.multiSelect && <span className="shrink-0 text-[10px] text-slate">여러 개 가능</span>}
            </div>
            <div className="flex flex-col gap-1">
              {q.options.map((o) => {
                const on = (picked[qi] ?? []).includes(o.label)
                return (
                  <button
                    key={o.label}
                    type="button"
                    data-testid="question-option"
                    onClick={() => toggle(qi, o.label, q.multiSelect)}
                    className={`rounded border px-2.5 py-1.5 text-left transition-colors ${
                      on ? 'border-beacon bg-edge' : 'border-edge hover:bg-edge/50'
                    }`}
                  >
                    <div className="text-[12px] text-chalk">{o.label}</div>
                    {/* 설명이 판단 근거다 — 접거나 자르지 않는다 */}
                    {o.description && (
                      <div className="mt-0.5 text-[11px] leading-snug text-slate">{o.description}</div>
                    )}
                  </button>
                )
              })}

              {/* 내민 것 말고 다른 답 — 도구가 화면에게 맡겨 둔 자리다 */}
              <button
                type="button"
                data-testid="question-other"
                onClick={() => toggleOther(qi, q.multiSelect)}
                className={`rounded border px-2.5 py-1.5 text-left transition-colors ${
                  otherOn[qi] ? 'border-beacon bg-edge' : 'border-edge border-dashed hover:bg-edge/50'
                }`}
              >
                <div className="text-[12px] text-slate">기타 — 직접 입력</div>
              </button>

              {otherOn[qi] && (
                <textarea
                  data-testid="question-other-input"
                  autoFocus
                  rows={2}
                  value={otherText[qi] ?? ''}
                  onChange={(e) => setOtherText((t) => ({ ...t, [qi]: e.target.value }))}
                  placeholder="답을 직접 적습니다"
                  className="w-full resize-y rounded border border-edge bg-void px-2 py-1.5 text-[12px] text-chalk outline-none focus:border-beacon"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-edge px-3 py-2">
        <button
          type="button"
          data-testid="question-submit"
          disabled={!ready || sending}
          onClick={() => void submit()}
          className="rounded border border-edge px-2.5 py-1 text-[11px] text-chalk enabled:hover:bg-edge disabled:opacity-40"
        >
          {sending ? 'Sending…' : 'Answer'}
        </button>
        <span className="text-[11px] text-slate">
          {ready ? 'Sends your choice back to the agent' : 'Choose an option for every question'}
        </span>
      </div>
    </div>
  )
}

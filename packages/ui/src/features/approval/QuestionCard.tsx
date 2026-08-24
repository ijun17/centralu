import { useState } from 'react'
import type { Question, QuestionAnswer } from '@cc/protocol'
import { useStore } from '../../store/store.js'

/**
 * The choices an agent holds out (AskUserQuestion).
 *
 * Kept apart from the approval card because what travels back differs — an approval is
 * whether something runs, this is *content*: the picked answer goes to the model.
 *
 * In dogfooding this tool call used to flow as raw JSON and get cut off mid-stream; from
 * the second option on there was **no way to answer at all.** So nothing here truncates —
 * not the question, not the options, not the descriptions. If it had to be cut, there was
 * no point asking.
 *
 * **Several questions become tabs, not a stack** (issue #8). Stacked, three questions
 * with descriptions ran past a panel height and the Answer button sat below everything,
 * so the card read as a wall exactly where the agent is waiting on a person. One question
 * at a time is also how people actually answer; the tab row keeps the others in reach and
 * shows which still need one. A single question keeps the flat layout — a tab row of one
 * would be decoration.
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
   * **Free-form input.**
   *
   * The tool's schema pins this down: "There should be no 'Other' option, that will be
   * provided automatically." That slot is the screen's to provide — and since we draw our
   * own screen, it is ours. Without it a person can only answer with what was offered,
   * and has nothing to say when the real answer is a third thing.
   */
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [active, setActive] = useState(0)
  const [sending, setSending] = useState(false)

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((p) => {
      const cur = p[qi] ?? []
      if (!multi) return { ...p, [qi]: [label] }
      return { ...p, [qi]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
    })
    // On a single-select question, the free-form slot and the options push each other out
    if (!multi) setOtherOn((o) => ({ ...o, [qi]: false }))
  }

  const toggleOther = (qi: number, multi: boolean) => {
    setOtherOn((o) => ({ ...o, [qi]: !o[qi] }))
    if (!multi) setPicked((p) => ({ ...p, [qi]: [] }))
  }

  /** What would actually be sent for this question (picked + typed) */
  const answersFor = (qi: number): string[] => {
    const typed = otherOn[qi] ? (otherText[qi] ?? '').trim() : ''
    return [...(picked[qi] ?? []), ...(typed ? [typed] : [])]
  }

  // Every question must be answered before sending — send half and the model invents the rest
  const answered = questions.map((_, i) => answersFor(i).length > 0)
  const ready = answered.every(Boolean)
  const tabbed = questions.length > 1

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
          {tabbed ? `${questions.length} questions` : 'Pick an option'}
        </span>
      </div>

      {tabbed && (
        /*
          Same shapes as the evidence panel's tab row — one app, one way to draw a tab.
          The dot on a tab is its answered state: what still waits is legible without
          visiting every tab, which is the whole point of not stacking.
        */
        <nav className="mt-2 flex items-center gap-0.5 border-b border-edge px-2 pb-1" data-testid="question-tabs">
          {questions.map((q, qi) => (
            <button
              key={qi}
              type="button"
              data-testid={`question-tab-${qi}`}
              data-answered={answered[qi] || undefined}
              onClick={() => setActive(qi)}
              className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] transition-colors ${
                active === qi ? 'bg-graphite/50 text-chalk' : 'text-ash hover:text-chalk'
              }`}
            >
              {q.header || `Q${qi + 1}`}
              <span
                aria-hidden
                className={`size-1 rounded-full ${answered[qi] ? 'bg-ash' : 'bg-slate/40'}`}
              />
            </button>
          ))}
        </nav>
      )}

      <div className="mt-2 flex flex-col gap-3 px-3">
        {questions.map((q, qi) =>
          /*
            Inactive tabs are hidden, not unmounted. Unmounting would drop a half-typed
            free-form answer the moment someone peeks at the next question — losing what a
            person wrote is the one cost tabs must not introduce over the stack.
          */
          tabbed && qi !== active ? null : (
            <div key={qi} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                {!tabbed && q.header && (
                  <span className="shrink-0 rounded bg-edge px-1.5 py-px text-[10px] text-slate">{q.header}</span>
                )}
                <span className="text-[13px] leading-snug text-chalk">{q.question}</span>
                {/* That several answers are allowed must be known before pressing, not after */}
                {q.multiSelect && <span className="shrink-0 text-[10px] text-slate">multiple allowed</span>}
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
                      {/* The description is the grounds for the choice — never folded, never cut */}
                      {o.description && (
                        <div className="mt-0.5 text-[11px] leading-snug text-slate">{o.description}</div>
                      )}
                    </button>
                  )
                })}

                {/* An answer that wasn't offered — the slot the tool leaves to the screen */}
                <button
                  type="button"
                  data-testid="question-other"
                  onClick={() => toggleOther(qi, q.multiSelect)}
                  className={`rounded border px-2.5 py-1.5 text-left transition-colors ${
                    otherOn[qi] ? 'border-beacon bg-edge' : 'border-edge hover:bg-edge/50'
                  }`}
                >
                  <div className="text-[12px] text-slate">Other — write your own</div>
                </button>

                {otherOn[qi] && (
                  <textarea
                    data-testid="question-other-input"
                    autoFocus
                    rows={2}
                    value={otherText[qi] ?? ''}
                    onChange={(e) => setOtherText((t) => ({ ...t, [qi]: e.target.value }))}
                    placeholder="Type your answer"
                    className="w-full resize-y rounded border border-edge bg-void px-2 py-1.5 text-[12px] text-chalk outline-none focus:border-beacon"
                  />
                )}
              </div>
            </div>
          ),
        )}
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
          {ready
            ? 'Sends your choice back to the agent'
            : tabbed
              ? `${answered.filter(Boolean).length} of ${questions.length} answered`
              : 'Choose an option'}
        </span>
      </div>
    </div>
  )
}

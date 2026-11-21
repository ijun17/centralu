import { useRef, useState } from 'react'
import type { Question, QuestionAnswer } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { WaitCard, WaitFooter } from './WaitCard.jsx'

// AskUserQuestion: the answer is content for the model, not whether something runs, so apart from the approval card.
// Nothing is truncated: a cut option cannot be answered. Several questions are tabs, not a stack (#8): stacked, they
// outgrow a panel and push Answer below everything.

/**
 * A click is the whole answer for exactly one single-choice question (#543 item 5): Answer would be a second decision
 * (`M P B B`, 2.6 s). Several questions, or a multiple-choice one, keep Answer.
 */
export function answersOnPick(questions: Question[]): boolean {
  return questions.length === 1 && !questions[0]!.multiSelect
}

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
  // The free-form slot, ours to draw: the tool's schema says "There should be no 'Other' option, that will be provided
  // automatically."
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [active, setActive] = useState(0)
  const [sending, setSending] = useState(false)
  // Gates every send: two clicks (or click and Enter) before a re-render would both read `sending` as false
  const inFlight = useRef(false)

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

  /** Picked plus typed */
  const answersFor = (qi: number): string[] => {
    const typed = otherOn[qi] ? (otherText[qi] ?? '').trim() : ''
    return [...(picked[qi] ?? []), ...(typed ? [typed] : [])]
  }

  // All or nothing: sent half, the model invents the rest
  const answered = questions.map((_, i) => answersFor(i).length > 0)
  const ready = answered.every(Boolean)
  const tabbed = questions.length > 1

  const quick = answersOnPick(questions)

  const send = async (answers: QuestionAnswer[]) => {
    if (inFlight.current) return
    inFlight.current = true
    setSending(true)
    try {
      await answer(sessionId, requestId, answers)
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  const submit = async () => {
    if (!ready) return
    await send(
      questions.map((q, i) => ({
        question: q.question,
        answers: answersFor(i),
      })),
    )
  }

  // A quick pick is recorded first, so a failed send still shows it; one made while an answer is in flight is ignored.
  // "Other" never comes here: it opens the field, and Answer sends it.
  const pick = (qi: number, label: string, multi: boolean) => {
    if (quick) {
      if (inFlight.current) return
      toggle(qi, label, multi)
      void send([{ question: questions[qi]!.question, answers: [label] }])
      return
    }
    toggle(qi, label, multi)
  }

  return (
    <WaitCard
      pill="Agent is asking"
      testId="question-card"
      subtitle={tabbed ? `${questions.length} questions` : 'Pick an option'}
    >

      {tabbed && (
        /*
          The evidence panel's tab shapes; a tab's dot says whether it is answered, without visiting it.
        */
        <nav
          className="mt-2 flex items-center gap-0.5 border-b border-line px-2 pb-1"
          data-testid="question-tabs"
        >
          {questions.map((q, qi) => (
            <button
              key={qi}
              type="button"
              data-testid={`question-tab-${qi}`}
              data-answered={answered[qi] || undefined}
              onClick={() => setActive(qi)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-sm transition-colors ${
                active === qi ? 'bg-surface-hover/50 text-ink' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {q.header || `Q${qi + 1}`}
              <span
                aria-hidden
                className={`size-1 rounded-full ${answered[qi] ? 'bg-ink-muted' : 'bg-ink-faint/40'}`}
              />
            </button>
          ))}
        </nav>
      )}

      <div className="mt-2 flex flex-col gap-3 px-3">
        {questions.map((q, qi) =>
          /*
            An inactive tab renders nothing; its half-typed answer lives in this card's state, so a peek loses nothing.
          */
          tabbed && qi !== active ? null : (
            <div key={qi} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                {!tabbed && q.header && (
                  <span className="shrink-0 rounded-md bg-surface-selected px-1.5 py-px text-2xs text-ink-faint">
                    {q.header}
                  </span>
                )}
                <span className="text-md leading-tight text-ink">{q.question}</span>
                {/* Known before pressing, not after */}
                {q.multiSelect && <span className="shrink-0 text-2xs text-ink-faint">multiple allowed</span>}
              </div>
              <div className="flex flex-col gap-1">
                {q.options.map((o) => {
                  const on = (picked[qi] ?? []).includes(o.label)
                  return (
                    <button
                      key={o.label}
                      type="button"
                      data-testid="question-option"
                      onClick={() => pick(qi, o.label, q.multiSelect)}
                      className={`rounded-field border px-3 py-2 text-left transition-colors ${
                        on
                          ? 'border-ink-signal bg-surface-selected'
                          : 'border-line hover:bg-surface-selected/50'
                      }`}
                    >
                      <div className="text-sm text-ink">{o.label}</div>
                      {/* The description is the grounds for the choice — never folded, never cut */}
                      {o.description && (
                        <div className="mt-0.5 text-xs leading-tight text-ink-faint">{o.description}</div>
                      )}
                    </button>
                  )
                })}

                {/* An answer not offered */}
                <button
                  type="button"
                  data-testid="question-other"
                  onClick={() => toggleOther(qi, q.multiSelect)}
                  className={`rounded-field border px-3 py-2 text-left transition-colors ${
                    otherOn[qi]
                      ? 'border-ink-signal bg-surface-selected'
                      : 'border-line hover:bg-surface-selected/50'
                  }`}
                >
                  <div className="text-sm text-ink-faint">Other — write your own</div>
                </button>

                {otherOn[qi] && (
                  <textarea
                    data-testid="question-other-input"
                    autoFocus
                    rows={2}
                    value={otherText[qi] ?? ''}
                    onChange={(e) => setOtherText((t) => ({ ...t, [qi]: e.target.value }))}
                    placeholder="Type your answer"
                    className="w-full resize-y rounded-field border border-line bg-surface-floor px-2 py-1.5 text-sm text-ink outline-none focus:border-ink-signal"
                  />
                )}
              </div>
            </div>
          ),
        )}
      </div>

      <WaitFooter question>
        <button
          type="button"
          data-testid="question-submit"
          disabled={!ready || sending}
          onClick={() => void submit()}
          className="rounded-full border border-line-strong px-3 py-1 text-xs text-ink enabled:hover:bg-surface-selected disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Answer'}
        </button>
        <span className="text-xs text-ink-faint">
          {ready
            ? 'Sends your choice back to the agent'
            : tabbed
              ? `${answered.filter(Boolean).length} of ${questions.length} answered`
              : quick
                ? 'Click an option to answer, or write your own'
                : 'Choose an option'}
        </span>
      </WaitFooter>
    </WaitCard>
  )
}

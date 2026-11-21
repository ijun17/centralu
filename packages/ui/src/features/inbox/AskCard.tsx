import { useState } from 'react'
import type { MailThreadRow } from '@cc/protocol/client'
import { Button } from '../../components/Button.js'
import { ChoiceList } from '../../components/ChoiceList.js'
import { Fold } from '../../components/Fold.js'
import { RelativeAge } from '../../components/RelativeAge.js'
import { TextInput } from '../../components/TextField.js'
import { useSendKey } from '../session/useSendKey.js'
import { useStore } from '../../store/store.js'
import { choicesLabel, threadStateLabel } from './mailLabels.js'
import { PartyName } from './PartyName.js'

/**
 * A thread waiting on the person's answer, as a card (#2229): the question's first four lines (the rest under Open), its
 * choices as buttons, and a field for the person's own words (#2327), so it is answered without opening the thread.
 * A press or Send goes one way, `replyMail(words, 'answer', question, thread)`, sent at once; the card shows the answer
 * while the host takes it and fades out (`useLeavingCards`) when the list drops it. While one answer is on its way the
 * other is locked; a refused one unlocks both and keeps the words. No undo: a question is answered once, and anything
 * more goes in the thread.
 */
export function AskCard({ thread: t, ask, active, leaving }: { thread: MailThreadRow; ask: NonNullable<MailThreadRow['ask']>; active?: boolean; leaving?: boolean }) {
  const open = useStore((s) => s.openMailThread)
  const reply = useStore((s) => s.replyMail)
  const sendKey = useSendKey()
  // The answer on its way: the choice pressed, or null for words. Keyed by question: the thread's next one shows unpressed
  const [sending, setSending] = useState<{ ask: string; picked: number | null } | null>(null)
  // The words typed, the question's too: words written to one question never go to the next one unseen
  const [draft, setDraft] = useState<{ ask: string; text: string } | null>(null)
  const busy = sending?.ask === ask.id ? sending : null
  const text = draft?.ask === ask.id ? draft.text : ''
  const wrote = busy?.picked === null
  const answer = async (words: string, picked: number | null) => {
    if (busy || !words) return
    const question = ask.id
    setSending({ ask: question, picked })
    // A refused answer leaves the card to answer again, with the host's words in a toast
    if (!(await reply(words, 'answer', question, t.id))) setSending((p) => (p?.ask === question ? null : p))
  }
  return (
    <li
      data-cursor={active || undefined}
      inert={leaving || undefined}
      className={`mx-1 my-1 flex flex-col gap-1.5 rounded-field border border-line px-3 py-2.5 transition-colors ${active ? 'bg-surface-hover/50' : ''} ${leaving ? 'cc-fade-out pointer-events-none' : ''}`}
      data-testid={`mail-ask-${t.id}`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`min-w-0 truncate text-md text-ink ${t.unread > 0 ? 'font-medium' : ''}`} data-testid={`mail-ask-subject-${t.id}`}>
          {t.subject}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-2.5 text-xs text-ink-faint">
          <span data-testid={`mail-state-${t.id}`}>{threadStateLabel(t)}</span>
          <span className="readout">
            <RelativeAge when={t.updatedAt} />
          </span>
        </span>
      </div>
      <span className="text-xs text-ink-muted" data-testid={`mail-ask-from-${t.id}`}>
        <PartyName party={ask.sender} /> asks you
      </span>
      <p className="line-clamp-4 whitespace-pre-line text-sm text-ink-muted" data-testid={`mail-ask-text-${t.id}`}>
        {ask.text}
      </p>
      {ask.choices && (
        <ChoiceList
          choices={ask.choices}
          label={choicesLabel(wrote, busy?.picked != null, true)}
          picked={busy?.picked ?? null}
          locked={busy !== null}
          onPick={(c) => void answer(c, ask.choices?.indexOf(c) ?? 0)}
          testId={`mail-ask-choices-${t.id}`}
        />
      )}
      {/* The person's own words, one line: a longer answer is written in the thread, under Open */}
      <div className="flex items-center gap-1.5 pt-1">
        <TextInput
          size="sm"
          text="sm"
          surface="raised"
          className="min-w-0 flex-1"
          value={text}
          readOnly={busy !== null}
          onChange={(e) => setDraft({ ask: ask.id, text: e.target.value })}
          onKeyDown={(e) => sendKey(e) && void answer(text.trim(), null)}
          placeholder="Your answer"
          aria-label="Your answer"
          data-testid={`mail-ask-answer-${t.id}`}
        />
        <Button size="sm" disabled={!text.trim() || busy !== null} busy={wrote} onClick={() => void answer(text.trim(), null)} data-testid={`mail-ask-send-${t.id}`}>
          Send
        </Button>
        {/* A button, not the row's plain word: the row's "Open" is the state it is in, this one is what to press for the whole thread */}
        <Button size="sm" variant="quiet" onClick={() => void open(t.id)} data-testid={`mail-thread-${t.id}`}>
          Open
        </Button>
      </div>
      {/* Folds in and out as the thread's questions come and go (docs/design-system.md §9); on its way out it still says the one it counted last */}
      <Fold open={ask.open.length > 1} className="text-xs text-ink-faint" testId={`mail-ask-others-${t.id}`}>
        {Math.max(ask.open.length - 1, 1)} other waiting in this thread
      </Fold>
    </li>
  )
}

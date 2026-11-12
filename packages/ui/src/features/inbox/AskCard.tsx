import { useState } from 'react'
import type { MailThreadRow } from '@cc/protocol/client'
import { partyName } from '@cc/core'
import { Button } from '../../components/Button.js'
import { ChoiceList } from '../../components/ChoiceList.js'
import { RelativeAge } from '../../components/RelativeAge.js'
import { useStore } from '../../store/store.js'
import { choicesLabel, threadStateLabel } from './mailLabels.js'

/**
 * A thread that waits on the person's answer, drawn as a card like the mail held for them (#2229, owner 2026-11-12): its subject in `ink`, who asks, the
 * first lines of the question (four at most, the rest is under Open) and, when it offers any, its choices as buttons, so a pick answers without opening
 * the thread. Open is for words of one's own. The ordinary threads of the list stay rows (`MailThreadItem`).
 *
 * A press is the answer: it is sent at once, the picked choice stays lit with "You chose" while the host takes it, and the card fades out (`leaving`,
 * `useLeavingCards`) once the list no longer has it. There is no undo: the session has the answer, and a question is answered once. What the person
 * meant to add goes in the thread, which the session reads as the next message.
 */
export function AskCard({ thread: t, ask, active, leaving }: { thread: MailThreadRow; ask: NonNullable<MailThreadRow['ask']>; active?: boolean; leaving?: boolean }) {
  const open = useStore((s) => s.openMailThread)
  const reply = useStore((s) => s.replyMail)
  // The choice pressed, while its answer is on its way: one press is one answer, and the list says which it was
  const [picked, setPicked] = useState<number | null>(null)
  const pick = async (choice: string, index: number) => {
    if (picked !== null) return
    setPicked(index)
    // A refused answer leaves the choices to press again, with the host's words in a toast
    if (!(await reply(choice, 'answer', ask.id, t.id))) setPicked(null)
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
      <span className="text-xs text-ink-muted">{partyName(ask.sender)} asks you</span>
      <p className="line-clamp-4 whitespace-pre-line text-sm text-ink-muted" data-testid={`mail-ask-text-${t.id}`}>
        {ask.text}
      </p>
      {ask.choices && (
        <ChoiceList
          choices={ask.choices}
          label={choicesLabel(false, picked !== null, true)}
          picked={picked}
          locked={picked !== null}
          onPick={(c) => void pick(c, ask.choices?.indexOf(c) ?? 0)}
          testId={`mail-ask-choices-${t.id}`}
        />
      )}
      <div className="flex items-center gap-1.5">
        {ask.count > 1 && <span className="text-xs text-ink-faint">{ask.count - 1} other waiting in this thread</span>}
        {/* A button, not the row's plain word: the row's "Open" is the state it is in, this one is what to press for words of one's own */}
        <Button size="sm" variant="quiet" className="ml-auto" onClick={() => void open(t.id)} data-testid={`mail-thread-${t.id}`}>
          Open
        </Button>
      </div>
    </li>
  )
}

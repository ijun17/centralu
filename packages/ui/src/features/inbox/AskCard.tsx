import { useState } from 'react'
import type { MailThreadRow } from '@cc/protocol/client'
import { partyName } from '@cc/core'
import { Button } from '../../components/Button.js'
import { ChoiceList } from '../../components/ChoiceList.js'
import { RelativeAge } from '../../components/RelativeAge.js'
import { useStore } from '../../store/store.js'
import { threadStateLabel } from './mailLabels.js'

/**
 * A thread that waits on the person's answer, drawn as a card like the mail held for them (#2229, owner 2026-11-12): its subject in `ink`, who asks, the
 * first lines of the question and, when it offers any, its choices as buttons, so a pick answers without opening the thread. Open is for words of
 * one's own. The ordinary threads of the list stay rows (`MailThreadItem`).
 */
export function AskCard({ thread: t, ask, active }: { thread: MailThreadRow; ask: NonNullable<MailThreadRow['ask']>; active?: boolean }) {
  const open = useStore((s) => s.openMailThread)
  const reply = useStore((s) => s.replyMail)
  // One press is one answer: the choices are locked from it until the host has answered
  const [sending, setSending] = useState(false)
  const pick = async (choice: string) => {
    if (sending) return
    setSending(true)
    await reply(choice, 'answer', ask.id, t.id)
    setSending(false)
  }
  return (
    <li
      data-cursor={active || undefined}
      className={`mx-1 my-1 flex flex-col gap-1.5 rounded-field border border-line px-3 py-2.5 transition-colors ${active ? 'bg-surface-hover/50' : ''}`}
      data-testid={`mail-ask-${t.id}`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`min-w-0 truncate text-md ${t.unread > 0 ? 'font-medium' : ''} text-ink`} data-testid={`mail-ask-subject-${t.id}`}>
          {t.subject}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-2.5 text-xs text-ink-faint">
          <span data-testid={`mail-state-${t.id}`}>{threadStateLabel(t)}</span>
          <RelativeAge when={t.updatedAt} />
        </span>
      </div>
      <span className="text-xs text-ink-muted">{partyName(ask.sender)} asks you</span>
      <p className="line-clamp-3 whitespace-pre-line text-sm text-ink-muted" data-testid={`mail-ask-text-${t.id}`}>
        {ask.text}
      </p>
      {ask.choices && <ChoiceList choices={ask.choices} label="Choose one" locked={sending} onPick={(c) => void pick(c)} testId={`mail-ask-choices-${t.id}`} />}
      <div className="flex items-center gap-1.5">
        {ask.count > 1 && <span className="text-xs text-ink-faint">{ask.count - 1} other waiting in this thread</span>}
        <Button size="sm" variant="quiet" className="ml-auto" onClick={() => void open(t.id)} data-testid={`mail-thread-${t.id}`}>
          Open
        </Button>
      </div>
    </li>
  )
}

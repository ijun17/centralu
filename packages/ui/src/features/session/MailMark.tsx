import { useState } from 'react'
import { errorMessage, type MailDelivered } from '@cc/protocol/client'
import { partyName } from '@cc/core'
import { FromArrowIcon, MailIcon } from '../../components/icons.jsx'
import { MarkLine } from '../../components/MarkLine.jsx'
import { Button } from '../../components/Button.jsx'
import { bubbleLook } from '../../components/bubble.js'
import { useStore } from '../../store/store.js'
import type { DeliveredMail } from '../../store/state/mail.js'

/**
 * The line a mail delivery leaves in the receiver's conversation ("1 message from Centralu"): the mail icon and only how many and
 * from whom (owner, 2026-11-17, #2332 option C). The capsule, not a head, says it is mail.
 *
 * A line that names its messages (`delivered`, #2333) folds open in place to show them (`MarkLine`'s fold), each as a relayed message
 * is drawn (the sender over a bubble in the other side's colours, as a delegated task's message, #1948), its body cut at six lines,
 * with the way to its chain in the Inbox. Closed at first. The messages are read when it first opens, as a look in, so opening it
 * reads nothing for anyone; what was read is kept here, above the fold, so closing and opening again reads nothing more (#2333
 * review). A read that failed is tried again on the next open. A line from an older host, or stored before, names none and does not fold.
 */
export function MailMark({ text, delivered }: { text: string; delivered?: MailDelivered[] }) {
  const [read, setRead] = useState<Read | null>(null)
  const readDeliveredMail = useStore((s) => s.readDeliveredMail)
  const icon = <MailIcon size={12} />
  const words = <span data-testid="notice-summary">{text}</span>
  if (!delivered?.length) {
    return (
      <MarkLine icon={icon} data-mark="mail">
        {words}
      </MarkLine>
    )
  }
  const onOpen = () => {
    if (read && read.state !== 'failed') return
    setRead({ state: 'reading' })
    readDeliveredMail(delivered).then(
      (mail) => setRead({ state: 'read', mail }),
      (e: unknown) => setRead({ state: 'failed', reason: errorMessage(e) }),
    )
  }
  return (
    <MarkLine icon={icon} data-mark="mail" folded={<Delivered read={read ?? { state: 'reading' }} />} onOpen={onOpen}>
      {words}
    </MarkLine>
  )
}

type Read = { state: 'reading' } | { state: 'read'; mail: DeliveredMail } | { state: 'failed'; reason: string }

/** The messages the line delivered, as read */
function Delivered({ read }: { read: Read }) {
  if (read.state !== 'read') {
    return (
      <p className="pt-1.5 text-center text-2xs text-ink-faint" data-testid={`mail-line-${read.state}`}>
        {read.state === 'reading' ? 'Reading the mail…' : `Could not read this mail: ${read.reason}`}
      </p>
    )
  }
  const { messages, gone } = read.mail
  // One way to the Inbox per chain, under its last message here
  const lastOfThread = new Map(messages.map((m, i) => [m.threadId, i]))
  return (
    <div className="flex flex-col items-end gap-2 pt-2 pb-1">
      {messages.map(({ message: m, subject, threadId }, i) => (
        <div key={m.id} className="flex max-w-[75%] flex-col items-end" data-testid="mail-line-message">
          <div className="pb-0.5 text-xs text-ink-muted">
            {partyName(m.sender)} <FromArrowIcon />{' '}
            <span className="text-ink-faint">
              {m.kind} · {subject}
            </span>
          </div>
          <div className={`line-clamp-6 whitespace-pre-wrap break-words rounded-bubble border px-3 py-2 text-md ${bubbleLook('theirs')}`}>{m.body}</div>
          {lastOfThread.get(threadId) === i && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-0.5"
              data-testid="mail-line-inbox"
              onClick={() => {
                const store = useStore.getState()
                store.toggleInbox(true)
                void store.openMailThread(threadId)
              }}
            >
              Open in Inbox
            </Button>
          )}
        </div>
      ))}
      {gone > 0 && (
        <p className="self-center text-2xs text-ink-faint" data-testid="mail-line-gone">
          {gone === 1 ? '1 message is no longer kept' : `${gone} messages are no longer kept`}
        </p>
      )}
    </div>
  )
}

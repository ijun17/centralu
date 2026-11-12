import { useRef, useState } from 'react'
import type { MailMessage } from '@cc/protocol/client'
import { Button } from '../../components/Button.js'
import { ChevronIcon } from '../../components/icons.js'
import { usePresence } from '../../components/presence.js'
import { useDismiss } from '../../components/useDismiss.js'
import { questionLine } from './mailLabels.js'

/**
 * Which question the reply box answers, when more than one is open in the thread (#2191, owner 2026-11-12, mock-up A): "Answering Builder · “Keep the old
 * settings format?”" and how many others are open, with a list to answer another one. The reply box's words go to the question named here.
 */
export function AnsweringPicker({
  questions,
  target,
  onTarget,
}: {
  questions: readonly MailMessage[]
  target: MailMessage
  onTarget: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  useDismiss({ open, onClose: () => setOpen(false), refs: [button, list], returnFocusTo: button })
  // The list drops from the row and goes back up (usePresence keeps it for its exit)
  const { shown, leaving } = usePresence(open)
  return (
    <div
      className="relative flex items-center gap-2 px-4 pt-2 text-xs text-ink-muted"
      data-testid="mail-answering"
    >
      <span className="shrink-0">Answering</span>
      <Button
        ref={button}
        size="sm"
        variant="quiet"
        className="min-w-0 max-w-full !rounded-full"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="mail-answering-button"
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate" data-testid="mail-answering-target">
            {questionLine(target)}
          </span>
          <ChevronIcon open={open} size={10} />
        </span>
      </Button>
      <span className="shrink-0 text-ink-faint" data-testid="mail-answering-others">
        {questions.length - 1} other open
      </span>
      {shown && (
        <ul
          ref={list}
          role="listbox"
          aria-label="Send this as the answer to"
          className={`absolute inset-x-4 bottom-full z-10 flex flex-col gap-1 rounded-lg border border-line bg-surface-raised p-1.5 shadow-(--shadow-modal) ${leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'}`}
          data-testid="mail-answering-list"
        >
          <li className="px-1.5 pb-0.5 text-2xs text-ink-faint">Send this as the answer to</li>
          {questions.map((q) => (
            <li key={q.id} role="option" aria-selected={q.id === target.id}>
              <Button
                size="lg"
                variant="choice"
                className="w-full truncate text-left"
                aria-pressed={q.id === target.id}
                onClick={() => {
                  onTarget(q.id)
                  setOpen(false)
                }}
                data-testid={`mail-answering-${q.seq}`}
              >
                {questionLine(q)}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const oneLine = (body: string) => body.replace(/\s+/g, ' ').trim()

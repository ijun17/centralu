import type { MailHeldRow, MailThreadRow } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { Button } from '../../components/Button.js'
import { RelativeAge } from '../../components/RelativeAge.js'
import { crowdText, heldLabel, heldResume, partyName, threadStateLabel } from './mailLabels.js'

/**
 * The Mail section of the inbox (#1347, docs/plans/mailbox.md §10.1): the threads the person is in with the unread first, the
 * mail held for them to act on, and the one question about sleeping sessions after a long stop. Under the sessions that
 * wait; nothing here takes the list's keys, so Move, Open and Done still mean what they meant for the sessions above it.
 */
export function MailSection() {
  const mail = useStore((s) => s.mail)
  const open = useStore((s) => s.openMailThread)
  if (!mail || (mail.threads.length === 0 && mail.held.length === 0 && mail.waiting === 0)) return null
  return (
    <section className="border-t border-line/60" aria-label="Mail" data-testid="inbox-mail">
      <header className="flex items-baseline gap-2 px-4 py-2">
        <h3 className="text-sm font-medium text-ink">Mail</h3>
        <span className="readout text-xs text-ink-faint">{mail.threads.length}</span>
      </header>
      {mail.waiting > 0 && <CrowdCard waiting={mail.waiting} />}
      {mail.held.length > 0 && <HeldList rows={mail.held} />}
      {mail.threads.length > 0 && (
        <ul className="flex max-h-[calc(32vh/var(--text-zoom))] flex-col gap-0.5 overflow-y-auto p-1">
          {mail.threads.map((t) => (
            <li key={t.id} className="rounded-field transition-colors hover:bg-surface-hover/25">
              <button className="flex w-full min-w-0 items-center gap-2.5 py-2 pl-3 pr-3 text-left" onClick={() => void open(t.id)} data-testid={`mail-thread-${t.id}`}>
                <span className={`w-2 shrink-0 text-center text-2xs ${t.unread > 0 ? 'text-ink-signal' : 'text-transparent'}`} aria-label={t.unread > 0 ? 'Unread' : undefined} title={t.unread > 0 ? `${t.unread} unread` : undefined}>
                  ●
                </span>
                <span className={`truncate text-md ${t.unread > 0 ? 'text-ink' : 'text-ink-muted'}`}>{t.subject}</span>
                <span className="truncate text-xs text-ink-faint">{peopleOf(t)}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2.5">
                  {t.last && <span className="max-w-56 truncate text-xs text-ink-faint">{t.last.preview}</span>}
                  <span className="text-xs text-ink-faint" data-testid={`mail-state-${t.id}`}>
                    {threadStateLabel(t)}
                  </span>
                  <span className="readout w-12 text-right text-xs text-ink-faint">
                    <RelativeAge when={t.updatedAt} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Who the thread is between, from the person's side: the one who gave the work, and the one who has it */
function peopleOf(t: MailThreadRow): string {
  const owner = t.owner.kind === 'person' ? null : partyName(t.owner)
  const assignee = t.assignee ? partyName(t.assignee) : null
  if (owner && assignee) return `${owner} → ${assignee}`
  return owner ?? (assignee ? `→ ${assignee}` : '')
}

/** "12 sessions have mail from while Centralu was off": the host does not wake a crowd by itself, and asks once (§7.9) */
function CrowdCard({ waiting }: { waiting: number }) {
  const wake = useStore((s) => s.wakeMail)
  return (
    <div className="mx-2 mb-1 flex items-center gap-2 rounded-field border border-line px-3 py-2" data-testid="mail-crowd">
      <span className="text-sm text-ink">{crowdText(waiting)}</span>
      <span className="ml-auto flex shrink-0 gap-1.5">
        <Button size="sm" variant="quiet" onClick={() => void wake(false)} data-testid="mail-crowd-leave">
          Leave them
        </Button>
        <Button size="sm" variant="primary" onClick={() => void wake(true)} data-testid="mail-crowd-wake">
          Wake them
        </Button>
      </span>
    </div>
  )
}

/** Mail that waits for the person to say what happens to it, with why, and the button that frees it */
function HeldList({ rows }: { rows: MailHeldRow[] }) {
  const held = useStore((s) => s.heldMail)
  const resume = useStore((s) => s.resumeMail)
  const open = useStore((s) => s.openMailThread)
  return (
    <ul className="mx-2 mb-1 flex flex-col gap-1" aria-label="Mail held for you" data-testid="mail-held">
      {rows.map((r) => {
        const label = heldLabel(r.reason)
        const resumes = heldResume(r)
        return (
          <li key={`${r.recipient.address}:${r.messageId}`} className="flex items-center gap-2 rounded-field border border-line px-3 py-2" data-testid={`mail-held-${r.messageId}`}>
            <button className="flex min-w-0 flex-1 flex-col text-left" onClick={() => void open(r.threadId)}>
              <span className="truncate text-sm text-ink">
                {partyName(r.sender)} → {partyName(r.recipient)}: {r.subject}
              </span>
              <span className="truncate text-xs text-ink-faint">{label.why}</span>
              <span className="truncate text-xs text-ink-muted">{r.preview}</span>
            </button>
            <span className="flex shrink-0 gap-1.5">
              <Button size="sm" variant="quiet" onClick={() => void held('dismiss', r)} data-testid={`mail-dismiss-${r.messageId}`}>
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void (resumes ? resume(resumes) : held('release', r))}
                data-testid={`mail-release-${r.messageId}`}
              >
                {label.action}
              </Button>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

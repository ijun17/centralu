import { useEffect, useRef, useState } from 'react'
import type { MailMessage } from '@cc/protocol/client'
import { composingKey } from '../../app/keys.js'
import { Button } from '../../components/Button.js'
import { Fold } from '../../components/Fold.js'
import { Pill } from '../../components/Pill.js'
import { RelativeAge } from '../../components/RelativeAge.js'
import { useStore } from '../../store/store.js'
import { isComposerSendKey } from '../session/composerKeys.js'
import { closeStopsWork, partyName, replyKind, threadStateLabel } from './mailLabels.js'

/**
 * One conversation of the mailbox in the inbox (#1347, docs/plans/mailbox.md §10.1): who is in it, what was said, and the person's reply. Others' words are drawn as theirs, in a frame under their name, as text and never as markup;
 * the person's own are marked as theirs. Centralu's lines (a state moved, a party joined) are small and plain.
 */
export function MailThread({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const view = useStore((s) => s.mailThread)
  const back = useStore((s) => s.closeMailThread)
  const close = useStore((s) => s.closeMail)
  const older = useStore((s) => s.loadOlderMail)
  // A host of an older build stops the turn when the chain is closed: asked once first, with no way to close and leave it running. A host of this build stops nothing (it says so by sending `canReply`)
  const [confirming, setConfirming] = useState<'finished' | 'dropped' | null>(null)
  const list = useRef<HTMLOListElement>(null)
  // A conversation opens at its end, where the newest message is, and follows a message that comes after it; earlier pages added above do not move it
  const newest = view?.messages.at(-1)?.seq
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [view?.thread.id, newest])
  if (!view) return null
  const { thread } = view
  const done = thread.state === 'done'
  // The sessions in it, once each, to open from here
  const parties = [thread.owner, ...(thread.assignee ? [thread.assignee] : []), ...view.parties.map((p) => p.party)]
  const unique = [...new Map(parties.filter((p) => p.sessionId !== null).map((p) => [p.address, p])).values()]
  return (
    <div className="flex min-h-0 flex-col" data-testid="mail-thread">
      <header className="flex items-center gap-2 border-b border-line/60 px-4 py-2.5">
        <button className="shrink-0 rounded-full px-2 py-0.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink" onClick={back} aria-label="Back to the list" data-testid="mail-back">
          ←
        </button>
        <h2 className="min-w-0 truncate text-sm font-medium text-ink" title={thread.subject}>
          {thread.subject}
        </h2>
        <Pill size="label" data-testid="mail-thread-state">
          {threadStateLabel(thread)}
        </Pill>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {unique.map((p) => (
            <Button key={p.address} size="sm" variant="quiet" onClick={() => p.sessionId && onOpenSession(p.sessionId)} data-testid={`mail-open-${p.sessionId}`}>
              Open {partyName(p)}
            </Button>
          ))}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-ink-faint">
        <span>
          {partyName(thread.owner)}
          {thread.assignee ? ` → ${partyName(thread.assignee)}` : ''}
        </span>
      </div>

      <ol ref={list} className="flex max-h-[calc(40vh/var(--text-zoom))] min-h-0 flex-col gap-2 overflow-y-auto px-4 py-2" data-testid="mail-messages">
        {view.older && (
          <li className="text-center">
            <Button size="sm" variant="quiet" onClick={() => void older()} data-testid="mail-earlier">
              Earlier messages
            </Button>
          </li>
        )}
        {view.messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {view.more && <li className="text-center text-xs text-ink-faint">There are more messages. Open this again to read on.</li>}
      </ol>

      {/* Closing takes the reply box and the two acts away and brings the note in, each folding and fading for a moment (reduced motion: a fade), so nothing under them jumps */}
      <Fold open={done}>
        <p className="border-t border-line/60 px-4 py-3 text-sm text-ink-faint" data-testid="mail-done-note">
          This is done. Open a follow-up from a session to go on.
        </p>
      </Fold>
      <Fold open={!done}>
        {/* Only where there is something of the person's to answer: a chain of mail between sessions held for them has no one for a reply to go to (a host of an older build does not say, and has the box) */}
        <Fold open={view.canReply !== false}>
          <Reply />
        </Fold>
        {/* The row folds in and out like the reply box; its text does not depend on the outcome asked, so it stays whole while it folds closed */}
        <Fold open={confirming !== null}>
          <div className="flex items-center gap-2 border-t border-line/60 px-4 py-2 text-sm text-ink" role="alertdialog" data-testid="mail-stop-confirm">
            <span className="min-w-0">{thread.assignee ? partyName(thread.assignee) : 'The session'} is working on this. Stop its work and close this?</span>
            <Button
              size="sm"
              variant="danger"
              className="ml-auto shrink-0"
              onClick={() => {
                if (confirming === null) return
                const outcome = confirming
                setConfirming(null)
                void close(outcome)
              }}
              data-testid="mail-stop-close"
            >
              Stop and close
            </Button>
            <Button size="sm" variant="quiet" className="shrink-0" onClick={() => setConfirming(null)} data-testid="mail-stop-cancel">
              Cancel
            </Button>
          </div>
        </Fold>
        {/* Closing is at once: the session that was working on it is told, and its turn is not stopped (only a host of an older build stops it, and asks first) */}
        <div className="flex items-center gap-1.5 border-t border-line/60 px-4 py-2">
          <Button size="sm" variant="quiet" onClick={() => (closeStopsWork(view) ? setConfirming('finished') : void close('finished'))} data-testid="mail-finish">
            Mark done
          </Button>
          <Button size="sm" variant="quiet" onClick={() => (closeStopsWork(view) ? setConfirming('dropped') : void close('dropped'))} data-testid="mail-drop">
            Drop
          </Button>
        </div>
      </Fold>
    </div>
  )
}

function Message({ m }: { m: MailMessage }) {
  if (m.kind === 'event') {
    return (
      <li className="text-center text-xs text-ink-faint" data-testid={`mail-event-${m.seq}`}>
        {m.body}
      </li>
    )
  }
  // A script's message is the owner's work, sent by a script the person set up (§8.1, 3.8b): it is not the person's words, and not drawn as theirs
  const fromScript = scriptOf(m)
  const mine = m.sender.kind === 'person' && fromScript === undefined
  return (
    <li className={`flex flex-col gap-0.5 ${mine ? 'items-end' : 'items-start'}`} data-testid={`mail-message-${m.seq}`}>
      <span className="text-2xs text-ink-faint">
        {fromScript !== undefined ? `script ${fromScript}` : partyName(m.sender)} · {m.kind}
        {m.urgent ? ' · urgent' : ''} · <RelativeAge when={m.createdAt} />
      </span>
      <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-field border px-3 py-2 text-md text-ink ${mine ? 'border-line-strong bg-surface-hover/40' : 'border-line'}`}>{m.body}</div>
    </li>
  )
}

/** The label of the script that wrote this message (a fact of the host's, never a field a sender wrote), if one did */
function scriptOf(m: MailMessage): string | undefined {
  const s = m.facts.fromScript
  return s !== null && typeof s === 'object' && 'credential' in s && typeof s.credential === 'string' ? s.credential : undefined
}

/** The person's words: an answer when the last thing said to them was a question, a note otherwise (§7.1) */
function Reply() {
  const view = useStore((s) => s.mailThread)
  const reply = useStore((s) => s.replyMail)
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  if (!view) return null
  const send = async () => {
    const words = text.trim()
    if (!words || sending) return
    setSending(true)
    const ok = await reply(words, replyKind(view.messages))
    setSending(false)
    // What was refused stays in the box, with the host's words in the toast
    if (ok) setText('')
  }
  return (
    <div className="flex items-end gap-2 border-t border-line/60 px-4 py-2">
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const key = { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, composing: composingKey(e.nativeEvent) }
          if (isComposerSendKey(key, sendWithModifierEnter)) {
            e.preventDefault()
            void send()
          }
        }}
        placeholder="Reply"
        aria-label="Your reply"
        className="max-h-40 min-w-0 flex-1 resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-md text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        data-testid="mail-reply"
      />
      <Button size="md" variant="primary" disabled={!text.trim()} busy={sending} onClick={() => void send()} data-testid="mail-send">
        Send
      </Button>
    </div>
  )
}

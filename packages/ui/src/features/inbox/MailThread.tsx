import { useEffect, useRef, useState } from 'react'
import type { MailMessage } from '@cc/protocol/client'
import { composingKey } from '../../app/keys.js'
import { Button } from '../../components/Button.js'
import { Pill } from '../../components/Pill.js'
import { RelativeAge } from '../../components/RelativeAge.js'
import { useStore } from '../../store/store.js'
import { isComposerSendKey } from '../session/composerKeys.js'
import { canGiveWorkTo, partyName, replyKind, threadStateLabel } from './mailLabels.js'

/**
 * One thread of the mailbox in the inbox (#1347, docs/plans/mailbox.md §10.1): who is in it, what stands in its way, what was
 * said, and the person's reply. Others' words are drawn as theirs, in a frame under their name, as text and never as markup;
 * the person's own are marked as theirs. Centralu's lines (a state moved, a party joined) are small and plain.
 */
export function MailThread({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const view = useStore((s) => s.mailThread)
  const back = useStore((s) => s.closeMailThread)
  const close = useStore((s) => s.closeMail)
  const unblock = useStore((s) => s.unblockMail)
  const older = useStore((s) => s.loadOlderMail)
  const [giving, setGiving] = useState(false)
  // Closing a thread whose turn is going stops that turn: asked once first, with no way to close and leave it running (3.10)
  const [confirming, setConfirming] = useState<'finished' | 'dropped' | null>(null)
  const list = useRef<HTMLOListElement>(null)
  // A thread opens at its end, where the newest message is, and follows a message that comes after it; earlier pages added above do not move it
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
    <div className="flex flex-col" data-testid="mail-thread">
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
        {thread.next && <span className="truncate text-ink-muted">Next: {thread.next}</span>}
      </div>

      {view.blockers.some((b) => !b.resolved) && (
        <ul className="flex flex-col gap-1 px-4 pb-2" aria-label="Blockers" data-testid="mail-blockers">
          {view.blockers
            .filter((b) => !b.resolved)
            .map((b) => (
              <li key={b.n} className="flex items-center gap-2 rounded-field border border-line px-3 py-1.5 text-xs text-ink-muted">
                <span className="min-w-0 truncate">{blockerText(b)}</span>
                <Button size="sm" variant="quiet" className="ml-auto shrink-0" onClick={() => void unblock(b.n)} data-testid={`mail-unblock-${b.n}`}>
                  Unblock
                </Button>
              </li>
            ))}
        </ul>
      )}

      <ol ref={list} className="flex max-h-[calc(40vh/var(--text-zoom))] flex-col gap-2 overflow-y-auto px-4 py-2" data-testid="mail-messages">
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
        {view.more && <li className="text-center text-xs text-ink-faint">There are more messages. Open the thread again to read on.</li>}
      </ol>

      {done ? (
        <p className="border-t border-line/60 px-4 py-3 text-sm text-ink-faint" data-testid="mail-done-note">
          This thread is done. Open a follow-up from a session to go on.
        </p>
      ) : (
        <>
          <Reply />
          {confirming !== null && (
            <div className="flex items-center gap-2 border-t border-line/60 px-4 py-2 text-sm text-ink" role="alertdialog" data-testid="mail-stop-confirm">
              <span className="min-w-0">{thread.assignee ? partyName(thread.assignee) : 'The session'} is working on this. Stop its work and close the thread?</span>
              <Button
                size="sm"
                variant="danger"
                className="ml-auto shrink-0"
                onClick={() => {
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
          )}
          <div className="flex items-center gap-1.5 border-t border-line/60 px-4 py-2">
            <Button size="sm" variant="quiet" onClick={() => (thread.working ? setConfirming('finished') : void close('finished'))} data-testid="mail-finish">
              Mark done
            </Button>
            <Button size="sm" variant="quiet" onClick={() => (thread.working ? setConfirming('dropped') : void close('dropped'))} data-testid="mail-drop">
              Drop
            </Button>
            <Button size="sm" variant="quiet" className="ml-auto" onClick={() => setGiving((g) => !g)} aria-expanded={giving} data-testid="mail-give">
              Give to another session…
            </Button>
          </div>
          {giving && <Reassign onDone={() => setGiving(false)} />}
        </>
      )}
    </div>
  )
}

function blockerText(b: { kind: string; ref: string | null; text: string }): string {
  const what = b.kind === 'text' ? b.text : [b.kind, b.ref, b.text].filter(Boolean).join(' ')
  return `Waiting for ${what}`
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
        placeholder="Write to this thread"
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

/** Gives the work to another session with the words that go with it: the sessions the host would accept it for (`canGiveWorkTo`), other than those in the thread */
function Reassign({ onDone }: { onDone: () => void }) {
  const sessions = useStore((s) => s.sessions)
  const view = useStore((s) => s.mailThread)
  const reassign = useStore((s) => s.reassignMail)
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  if (!view) return null
  const inIt = new Set(view.parties.map((p) => p.party.sessionId))
  const options = Object.values(sessions).filter((x) => canGiveWorkTo(x) && !inIt.has(x.id))
  const submit = async () => {
    if (!to || !text.trim()) return
    if (await reassign(to, text.trim())) onDone()
  }
  return (
    <div className="flex flex-col gap-2 border-t border-line/60 px-4 py-2" data-testid="mail-reassign">
      <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Session to give it to" className="rounded-field border border-line bg-surface-raised px-2 py-1 text-sm text-ink" data-testid="mail-reassign-to">
        <option value="">Choose a session…</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What it should do"
        aria-label="Words that go with the work"
        className="resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-md text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        data-testid="mail-reassign-text"
      />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!to || !text.trim()} onClick={() => void submit()} data-testid="mail-reassign-send">
          Give it
        </Button>
      </div>
    </div>
  )
}

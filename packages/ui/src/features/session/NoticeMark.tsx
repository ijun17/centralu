import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronIcon, MarkIcon } from '../../components/icons.jsx'
import { MarkLine } from '../../components/MarkLine.jsx'
import { MailMark } from './MailMark.jsx'
import { audienceText, type NoticeLine } from '../../store/store.js'

/** `a \`b\` c` with the quoted part set apart, the way Codex and the host quote a file or a setting */
function quoted(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <span key={i} className="text-ink-muted">{part}</span> : part))
}

/**
 * A tool's notice made readable (#342), a line of the conversation like every marker (`MarkLine`, #2338 option 1).
 *
 * The capsule says who is speaking and what kind of notice (`Codex · config warning`) and whose it is to act on (`for you` /
 * `for Centralu`). It opens to the plain explanation, or the tool's text when there is none; under it, what the explanation
 * names (one setting per line) and the hint. The tool's own words stay one click away, so a cause the explanation did not
 * anticipate is never lost.
 *
 * The owner's case (packaged 0.1.0-beta.9): a `config.toml` warning and a deprecation addressed to Centralu read like the same
 * kind of problem. So a notice for the person starts open and one for Centralu starts closed (owner, 2026-11-17, #2338), and
 * `for Centralu` is fainter than `for you`: a notice the person cannot act on does not look like one they must. A notice whose
 * audience the host did not place starts open, as every notice used to be.
 * The host places the audience, not this rule from the notice's level: Centralu's lines about a compaction are placed for Centralu, so they start
 * closed with a head that says what happened (owner, 2026-11-18), while an `info` notice the host did not place keeps its words open.
 */
export function NoticeMark({ notice }: { notice: NoticeLine }) {
  // The line a mail delivery leaves, and the messages it opens to (#2332, #2333)
  if (notice.mail) return <MailMark text={notice.body} delivered={notice.delivered} />
  return (
    <MarkLine
      icon={<MarkIcon kind="notice" />}
      data-mark="notice"
      data-notice-audience={notice.audience ?? ''}
      open={notice.audience !== 'centralu'}
      folded={<Explanation notice={notice} />}
    >
      <span className="text-ink-muted" data-testid="notice-head">
        {notice.head}
      </span>
      {notice.audience && (
        <>
          {' · '}
          <span className={notice.audience === 'you' ? 'text-ink-muted' : 'text-ink-faint'} data-testid="notice-audience">
            {audienceText(notice.audience)}
          </span>
        </>
      )}
    </MarkLine>
  )
}

/** Centred under the capsule like the line itself; only the tool's own words, which run over several lines, read left-aligned */
function Explanation({ notice }: { notice: NoticeLine }) {
  const [open, setOpen] = useState(false)
  const originalId = useId()
  return (
    <div className="mx-auto flex max-w-[34rem] flex-col items-center pt-1 text-center text-2xs text-ink-faint">
      <p className="max-w-full break-words" data-testid="notice-summary">
        {quoted(notice.body)}
      </p>
      {notice.items?.length ? (
        <ul className="max-w-full" data-testid="notice-items">
          {notice.items.map((it) => (
            <li key={it} className="break-words text-ink-muted">
              {quoted(it)}
            </li>
          ))}
        </ul>
      ) : null}
      {notice.hint && (
        <p className="max-w-full break-words" data-testid="notice-hint">
          {quoted(notice.hint)}
        </p>
      )}
      {notice.original && (
        <button
          type="button"
          className="mt-0.5 inline-flex items-center gap-1 text-ink-faint hover:text-ink-muted"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={originalId}
          data-testid="notice-original-toggle"
        >
          <ChevronIcon open={open} size={10} />
          {notice.from}'s words
        </button>
      )}
      {open && notice.original && (
        <pre
          id={originalId}
          className="mt-1 max-w-full whitespace-pre-wrap break-words border-l border-line pl-2 text-left font-mono text-2xs text-ink-faint"
          data-testid="notice-original"
        >
          {notice.original}
        </pre>
      )}
    </div>
  )
}

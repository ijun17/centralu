import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronIcon, MarkIcon } from '../../components/icons.jsx'
import { MarkLine } from '../../components/MarkLine.jsx'
import { MailMark } from './MailMark.jsx'
import { audienceShown, audienceText, type NoticeLine } from '../../store/store.js'

/** `a \`b\` c` with the quoted part set apart, the way Codex and the host quote a file or a setting */
function quoted(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <span key={i} className="text-ink-muted">{part}</span> : part))
}

/**
 * A tool's notice made readable (#342), a line of the conversation like every marker (`MarkLine`, #2338 option 1).
 * The capsule says who is speaking, what kind of notice and whose it is to act on; it opens to the plain explanation
 * (or the tool's text when there is none), what that names, and the hint. The tool's own words stay one click away.
 * Which notices start open or closed, and the fainter `for Centralu`: docs/design-system.md §7. The host places the
 * audience, not this rule from the notice's level. A notice from Centralu for Centralu does not print `for Centralu`
 * (`audienceShown`) but still starts closed, since the rule reads the audience, not what is printed.
 */
export function NoticeMark({ notice }: { notice: NoticeLine }) {
  // The line a mail delivery leaves, and the messages it opens to (#2332, #2333)
  if (notice.mail) return <MailMark text={notice.body} delivered={notice.delivered} />
  const shown = audienceShown(notice)
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
      {shown && (
        <>
          {' · '}
          <span className={shown === 'you' ? 'text-ink-muted' : 'text-ink-faint'} data-testid="notice-audience">
            {audienceText(shown)}
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

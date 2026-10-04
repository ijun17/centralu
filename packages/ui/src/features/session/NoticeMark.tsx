import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronIcon } from '../../components/icons.jsx'
import { audienceText, type NoticeLine } from '../../store/store.js'

/** `a \`b\` c` with the quoted part set apart, the way Codex and the host quote a file or a setting */
function quoted(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <span key={i} className="text-ink-muted">{part}</span> : part))
}

/**
 * A tool's notice made readable (#342), in the quiet marker style of the conversation: a centred line between two
 * rules, faint text, nothing that interrupts.
 *
 * First line: who is speaking and what kind of notice (`Codex · config warning`), whose it is to act on (`for you` /
 * `for Centralu`), then the plain explanation, or the tool's text when there is none. Under it, what the explanation
 * names (one setting per line) and the hint. The tool's own words stay one click away, so a cause the explanation did
 * not anticipate is never lost.
 *
 * The owner's case (packaged 0.1.0-beta.9): a `config.toml` warning and a deprecation addressed to Centralu read like
 * the same kind of problem. `for Centralu` is fainter than `for you` so a notice the person cannot act on does not look
 * like one they must.
 */
export function NoticeMark({ notice }: { notice: NoticeLine }) {
  const [open, setOpen] = useState(false)
  const originalId = useId()
  const below = !!notice.items?.length || !!notice.hint || !!notice.original
  return (
    <div className="py-1" data-testid="msg-mark" data-notice-audience={notice.audience ?? ''}>
      <div className="flex items-center gap-2">
        <span className="h-px flex-1 bg-line" />
        <span className="readout min-w-0 break-words text-center text-2xs text-ink-faint">
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
          {' — '}
          <span data-testid="notice-summary">{quoted(notice.body)}</span>
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {below && (
        // Centred under the line like the line itself; only the tool's own words, which run over several lines, read left-aligned
        <div className="readout mt-0.5 flex flex-col items-center text-center text-2xs text-ink-faint">
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
      )}
    </div>
  )
}

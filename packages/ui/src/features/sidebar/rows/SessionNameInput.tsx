import { useRef, useState } from 'react'
import { isPlainEnter, isPlainEscape } from '../../../app/keys.js'
import { ROW_PAD } from '../layout.js'

/**
 * Edits a session name in place (#5), not in a modal: a name is chosen among the other rows, which must stay visible.
 * An empty name cancels, so a slip cannot leave a nameless row.
 */
export function SessionNameInput({
  id,
  initial,
  onDone,
}: {
  id: string
  initial: string
  onDone: (name: string) => void
}) {
  const [text, setText] = useState(initial)
  // Enter removes the input, which fires one more blur: without a guard the name is sent twice and the second fails
  const done = useRef(false)
  const selected = useRef(false)
  const finish = (name: string) => {
    if (done.current) return
    done.current = true
    onDone(name.trim())
  }

  return (
    <input
      autoFocus
      className={`w-full border-l-2 border-l-ink-muted bg-surface-hover/40 py-1.5 ${ROW_PAD} pr-3 text-md text-ink outline-none`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      /*
        Select all on the first focus only: a generated name is usually replaced, but the focus given back after ⌘Tab
        would select a half-typed name for the next key to replace.
      */
      onFocus={(e) => {
        if (selected.current) return
        selected.current = true
        e.currentTarget.select()
      }}
      onKeyDown={(e) => {
        // Stopped here so global shortcuts (⌘K, etc.) do not intercept the typing
        e.stopPropagation()
        // The Enter that finishes a syllable and the Esc that cancels one are the input method's (#181)
        if (isPlainEnter(e.nativeEvent)) finish(text)
        else if (isPlainEscape(e.nativeEvent)) finish(initial)
      }}
      /*
        Blur saves. Not when the window lost focus (⌘Tab, #842 item 14): the edit stays open until the window is back, and
        is saved then if the browser does not give the field focus back.
      */
      onBlur={(e) => {
        if (typeof document !== 'undefined' && !document.hasFocus()) {
          const field = e.currentTarget
          const latest = () => field.value
          window.addEventListener(
            'focus',
            () => setTimeout(() => {
              if (document.activeElement !== field) finish(latest())
            }, 0),
            { once: true },
          )
          return
        }
        finish(text)
      }}
      data-testid={`session-name-input-${id}`}
      spellCheck={false}
    />
  )
}

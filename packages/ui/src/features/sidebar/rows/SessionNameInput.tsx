import { useRef, useState } from 'react'
import { isPlainEnter, isPlainEscape } from '../../../app/keys.js'
import { ROW_PAD } from '../layout.js'

/**
 * Edits a session name in place (issue #5).
 *
 * **No modal is shown.** A name only gets its meaning by being chosen among the other names — if
 * a dialog covers the screen, the person ends up naming it without being able to see what it might
 * be confused with. This was the problem where auto-generated names, since they truncate the first
 * prompt, produced four rows all reading `This session is being continued…` in a row, so the other
 * four rows have to stay visible while one is being edited.
 *
 * An empty name is **treated as a cancel.** If a slip of deleting the text and clicking away
 * produced a nameless row, that row could no longer point at anything in the list.
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
  /*
   * Confirming with Enter makes the input disappear, and disappearing also fires one more blur
   * event. Without a guard, the same name gets sent twice — one succeeds and one fails, and an
   * error toast pops up for no apparent reason.
   */
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
        An auto-generated name is usually replaced wholesale, so the whole text is selected (press → once to append
        instead). Only on the first focus: the focus the window gives back after ⌘Tab selected the half-typed name again,
        and the next key replaced it.
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
        Clicking elsewhere to leave still keeps the edited value — there is no separate confirm button. Not when the window
        itself lost focus (⌘Tab to look something up, #842 item 14): the field blurs then too, and the half-typed name was
        saved. The edit stays open, and the browser gives the field focus back with the window.
      */
      onBlur={() => {
        if (typeof document !== 'undefined' && !document.hasFocus()) return
        finish(text)
      }}
      data-testid={`session-name-input-${id}`}
      spellCheck={false}
    />
  )
}

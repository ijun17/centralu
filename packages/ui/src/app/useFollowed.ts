import { useState } from 'react'

/** What a field holds while it follows a value that can change outside it: the draft, and the outside value it was last made from */
export type Followed = { draft: string; seen: string }

/**
 * The rule of `useFollowed` without React: while `value` is the one the draft was made from, the draft stays (the
 * person is typing); a different `value` replaces it. Returns `state` itself when nothing changed.
 */
export function followOutside(state: Followed, value: string): Followed {
  return state.seen === value ? state : { draft: value, seen: value }
}

/**
 * A text field's draft that follows a value edited outside it (a theme file edited by hand, #312). Kept apart from the
 * value so the person can type something not yet valid, and replaced when the value changes underneath: a draft
 * captured once wrote the old value back on blur, undoing the outside edit (the theme's name, and every token row,
 * which had its own copy of this).
 */
export function useFollowed(value: string): [draft: string, setDraft: (draft: string) => void] {
  const [state, setState] = useState<Followed>({ draft: value, seen: value })
  const current = followOutside(state, value)
  // Adjusting state while rendering: the outside change replaces the draft before anything is drawn from the old one
  if (current !== state) setState(current)
  return [current.draft, (draft) => setState({ draft, seen: current.seen })]
}

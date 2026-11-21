import { useState } from 'react'

/** `seen`: the outside value the draft was last made from */
export type Followed = { draft: string; seen: string }

export function followOutside(state: Followed, value: string): Followed {
  return state.seen === value ? state : { draft: value, seen: value }
}

/**
 * A field's draft that follows a value edited outside it (a theme file edited by hand, #312): a draft captured once
 * would write the old value back on blur, undoing the outside edit.
 */
export function useFollowed(value: string): [draft: string, setDraft: (draft: string) => void] {
  const [state, setState] = useState<Followed>({ draft: value, seen: value })
  const current = followOutside(state, value)
  // Adjusting state while rendering: the outside change replaces the draft before anything is drawn from the old one
  if (current !== state) setState(current)
  return [current.draft, (draft) => setState({ draft, seen: current.seen })]
}

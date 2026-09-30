/**
 * Recalling sent messages with the arrow keys (#38).
 *
 * Only the judgment is pulled out here — knows neither the DOM nor the store. That way "when
 * does the caret move, and when does history come up" can be tested as plain values (the same
 * reason scroll.ts was pulled out).
 */

import type { ChatItem } from '../../store/store.js'

/**
 * Sent messages, oldest first.
 *
 * Not stored separately — the conversation already has them all as `{ kind: 'user' }`, split
 * per session, and surviving restarts. A second store just for history would eventually drift
 * out of sync with that one.
 *
 * The same message sent back to back is counted once. This is the same rule a shell uses, and
 * for the same reason: sending the same command twice is common (retrying, confirming), and
 * counting it as two entries would mean pressing the arrow key twice to reach the previous one
 * — to the person pressing it, it looks as though nothing happened.
 */
export function sentMessages(chat: ChatItem[]): string[] {
  const out: string[] = []
  for (const item of chat) {
    if (item.kind !== 'user') continue
    if (out[out.length - 1] === item.text) continue
    out.push(item.text)
  }
  return out
}

/**
 * Whether the caret is on the first line / the last line — **by newlines only**.
 *
 * This does not count visually wrapped lines. Counting those needs the caret's on-screen
 * coordinates, which is not a judgment that can be tested as plain values without a DOM.
 * Wrapped lines are measured by caret.ts with a mirror element, and SessionView combines the
 * two — filtering first with the cheap judgment keeps the expensive measurement rare.
 *
 * (For a while this counted newlines only, full stop. When a long line wrapped, pressing the
 * up arrow on the wrapped second line brought up history instead of moving the caret, and it
 * looked as though what the person was typing had vanished — reported by a user on 2026-09-07.)
 */
export const onFirstLine = (text: string, caret: number): boolean => !text.slice(0, caret).includes('\n')

export const onLastLine = (text: string, caret: number): boolean => !text.slice(caret).includes('\n')

/**
 * The result of one arrow-key press.
 *
 *   `none`    this is not history's place to act — move the caret as usual
 *   `recall`  put this text in the composer
 *   `draft`   fully stepped out of history — go back to the unsent draft
 */
export type HistoryStep = { kind: 'none' } | { kind: 'recall'; at: number; text: string } | { kind: 'draft' }

/**
 * Where things are now, and where to go next.
 *
 * When `at` is null, history is not being browsed — the composer holds an unsent draft.
 *
 * Going further up from the oldest entry **stays put.** Letting the caret move instead would
 * make "history has ended" look like "the arrow key stopped working".
 */
export function stepHistory(p: { history: string[]; at: number | null; dir: -1 | 1 }): HistoryStep {
  const last = p.history.length - 1
  if (last < 0) return { kind: 'none' }

  if (p.dir === -1) {
    const at = p.at === null ? last : Math.max(0, p.at - 1)
    return { kind: 'recall', at, text: p.history[at]! }
  }

  // Down arrow outside of history is just the caret — there is nowhere to go back to
  if (p.at === null) return { kind: 'none' }
  if (p.at >= last) return { kind: 'draft' }
  return { kind: 'recall', at: p.at + 1, text: p.history[p.at + 1]! }
}

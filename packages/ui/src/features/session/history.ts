/** Recalling sent messages with the arrow keys (#38), the judgment alone, as plain values a test holds */

import type { ChatItem } from '../../store/store.js'

/**
 * Oldest first, read from the conversation rather than kept apart, which would drift. A repeat
 * counts once, as in a shell: otherwise one press seems to do nothing.
 */
export function sentMessages(chat: ChatItem[]): string[] {
  const out: string[] = []
  for (const item of chat) {
    if (item.kind !== 'user') continue
    // Only what the person typed here (#745), not a brief from another session, an app or a script
    if (item.from || item.fromApp || item.fromScript) continue
    if (out[out.length - 1] === item.text) continue
    out.push(item.text)
  }
  return out
}

/** By newlines only; wrapped lines are caret.ts's, measured only after this cheap check passes */
export const onFirstLine = (text: string, caret: number): boolean => !text.slice(0, caret).includes('\n')

export const onLastLine = (text: string, caret: number): boolean => !text.slice(caret).includes('\n')

/** `none`: the caret moves as usual; `draft`: stepped out of history, back to the unsent draft */
export type HistoryStep = { kind: 'none' } | { kind: 'recall'; at: number; text: string } | { kind: 'draft' }

/**
 * `at` null: the draft is shown. Up from the oldest entry stays there; a moving caret would read
 * as the key no longer working.
 */
export function stepHistory(p: { history: string[]; at: number | null; dir: -1 | 1 }): HistoryStep {
  const last = p.history.length - 1
  if (last < 0) return { kind: 'none' }

  if (p.dir === -1) {
    const at = p.at === null ? last : Math.max(0, p.at - 1)
    return { kind: 'recall', at, text: p.history[at]! }
  }

  if (p.at === null) return { kind: 'none' }
  if (p.at >= last) return { kind: 'draft' }
  return { kind: 'recall', at: p.at + 1, text: p.history[p.at + 1]! }
}

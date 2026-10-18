import { dayKey, formatDayLong } from '../../../app/format.js'
import type { ChatItem } from '../../../store/store.js'

/**
 * Where a row stands in the agent's answer bubble (owner, 2026-10-18): what the agent says to the person stands in a
 * bubble on the left, like the person's own message on the right. Rows of text in a row share one bubble. Tool calls,
 * images, approvals, markers (compaction, handoff, an error line) and reasoning summaries (Codex's "Tuning preview
 * size") are what it did, thought or what happened, not what it said, so they stand outside, on the page, and split
 * it (owner: a tool card inside the bubble read as a box in a box; a reasoning line inside it read as a message).
 *
 * The list is virtual, so the bubble is drawn in pieces, one per row: the first rounds the top, the last the
 * bottom, the ones between carry only the sides. No gap between rows inside a bubble: the spacing is the piece's
 * own padding, so the background runs on. Full width, with the bubble corner (`rounded-bubble`, 14px, the person's
 * bubble's too). No tail corner: the side, the width and the shade already say who spoke.
 */
export type BubblePart = 'solo' | 'first' | 'mid' | 'last'

function inBubble(item: ChatItem | undefined): boolean {
  return item?.kind === 'assistant'
}

/** Whether the row's bubble runs on into the next row, so no gap may stand between them */
export function joinsNext(part: BubblePart | null): boolean {
  return part === 'first' || part === 'mid'
}

export function bubbleOf(chat: readonly ChatItem[], i: number): BubblePart | null {
  if (!inBubble(chat[i])) return null
  const before = inBubble(chat[i - 1])
  const after = inBubble(chat[i + 1])
  return before ? (after ? 'mid' : 'last') : after ? 'first' : 'solo'
}

/*
 * The answer's last bubble before the person speaks again (or the conversation ends): the one that carries the
 * answer's time. A chat app writes the time once under the last of several bubbles sent together; an answer split
 * by tool calls into several bubbles would otherwise carry the same minute under each.
 */
export function answerEnds(chat: readonly ChatItem[]): Set<number> {
  const ends = new Set<number>()
  let seen = false
  for (let i = chat.length - 1; i >= 0; i--) {
    const item = chat[i]!
    if (item.kind === 'user') seen = false
    else if (inBubble(item) && !seen) {
      ends.add(i)
      seen = true
    }
  }
  return ends
}

/*
 * Where a new day begins (owner, 2026-10-18, as a chat app does): the first row with a time, and every row whose
 * day differs from the last time before it. Rows with no time never start one. Index → the day's name.
 */
export function dayBreaks(chat: readonly ChatItem[]): Map<number, string> {
  const at = new Map<number, string>()
  let last = ''
  chat.forEach((item, i) => {
    if (item.at === undefined) return
    const day = dayKey(item.at)
    if (day === last) return
    last = day
    at.set(i, formatDayLong(item.at))
  })
  return at
}

import { asObj, str } from '../../json-value.js'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * Keeps the summary parts of Codex's reasoning apart (#1464).
 *
 * A summary is `**Heading**` and a paragraph, one per part. Within one reasoning item, `summaryPartAdded` says a new part
 * begins, and `normalize` turns it into a blank line. A second reasoning item (Codex thinks again after a tool call that
 * records nothing, or in a turn with two) starts at part 0 again and says nothing, so its first chunk was appended to the
 * row of the item before it with nothing between: `**Checking projects child process****흰 화면의…**`, four asterisks
 * in the middle and the second heading glued to the first, on the screen and in the stored row.
 *
 * This is the one place that sees one chunk after another: the first chunk of an item that is not the one before, in a
 * row still open, takes a blank line in front. The row is open until something ends it (`endsStreamRow`, told by `reset`),
 * so the first chunk of a row never starts with one.
 */
export class ReasoningParts {
  private item: string | null = null

  /** Something ended the open row (a tool call, the end of the turn, an image): the next chunk starts a row, not a part */
  reset(): void {
    this.item = null
  }

  /** The events one notification maps to, with the blank line in front of a new item's first chunk */
  join(n: { method: string; params?: unknown }, events: NormalizedEvent[]): NormalizedEvent[] {
    if (n.method !== 'item/reasoning/summaryTextDelta') return events
    const p = asObj(n.params)
    const item = str(p.itemId)
    if (!item) return events
    const apart = this.item !== null && this.item !== item
    this.item = item
    // A part after the first of its item has its own blank line from `summaryPartAdded`; only the first part of an item has none
    if (!apart || (typeof p.summaryIndex === 'number' && p.summaryIndex > 0)) return events
    return events.map((e) => (e.type === 'reasoning_delta' && e.text ? { ...e, text: `\n\n${e.text}` } : e))
  }
}

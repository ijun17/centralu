import { asObj, str } from '../../json-value.js'
import type { NormalizedEvent } from '@cc/protocol'

const UNNAMED = ''

/**
 * The text of an agentMessage that came whole (#2447). `normalize` maps a completed agentMessage to an empty chunk, since
 * its deltas already carried the text. When no delta of that item carried any, the completed item's own text is the
 * message, live and stored; without it the message was lost. This is the one place that sees one chunk after another.
 */
export class StreamedMessages {
  // `UNNAMED`: a delta that named no item (an older CLI) may be any item's, so no completed item of that turn is taken
  private readonly streamed = new Set<string>()

  /** The events one notification maps to, with a completed item's text when none of it streamed */
  join(n: { method: string; params?: unknown }, events: NormalizedEvent[]): NormalizedEvent[] {
    const p = asObj(n.params)
    if (n.method === 'item/agentMessage/delta') {
      if (events.some((e) => e.type === 'message_delta' && e.text)) this.streamed.add(str(p.itemId) || UNNAMED)
      return events
    }
    // An item that never completed (an interrupted one) is not kept past its turn
    if (n.method === 'turn/completed') this.streamed.clear()
    if (n.method !== 'item/completed') return events
    const item = asObj(p.item)
    if (str(item.type) !== 'agentMessage' || this.streamed.delete(str(item.id)) || this.streamed.has(UNNAMED)) return events
    return events.map((e) => (e.type === 'message_delta' ? { ...e, text: str(item.text) } : e))
  }
}

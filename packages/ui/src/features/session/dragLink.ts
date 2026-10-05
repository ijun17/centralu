/**
 * A link or text dropped on the composer (#308): what it becomes in the message, and where it goes.
 *
 * The drag carries the two standard types an item puts on: `text/uri-list` (the item's address) and
 * `text/plain` (its words, `#306 App panels too narrow` for a board card). A link becomes a Markdown
 * link, `[#306 App panels too narrow](https://…/issues/306)`: the agent reads both the words and the
 * address, and can open the address or call the app's own tools with what it names. Text with no
 * address goes in as it is, as a drop into any text field would.
 */
import { INTERNAL_DRAG_MIME } from '../files/dragPath.js'

export type DroppedText = { kind: 'link'; url: string; title: string } | { kind: 'text'; text: string }

/**
 * Only these become a link. Anything else in `text/uri-list` (`file:`, `blob:`, `data:`,
 * `javascript:`) is not an address the agent can open: a `blob:` or `data:` URL is an image dragged
 * out of the conversation, and an OS file arrives as a file, not here.
 */
const LINKABLE = /^(https?:\/\/|mailto:)\S+$/i

/** The first address in a `text/uri-list`: one per line, `#` starts a comment (RFC 2483) */
function firstUri(list: string): string | null {
  for (const line of list.split(/\r?\n/)) {
    const uri = line.trim()
    if (uri && !uri.startsWith('#')) return uri
  }
  return null
}

/**
 * What a drag's two text types become, or null when there is nothing to insert.
 *
 * The title is `text/plain` when it is one line and says something other than the address; a title
 * of several lines (a paragraph someone selected) is not a link's title, so the address stands as
 * its own title. A drag with no `text/uri-list` whose text is one address (a link dragged out of
 * some pages carries only `text/plain`) is a link too.
 */
export function droppedText(uriList: string, plain: string): DroppedText | null {
  const words = plain.trim()
  const listed = firstUri(uriList)
  const url = listed && LINKABLE.test(listed) ? listed : !listed && LINKABLE.test(words) ? words : null
  if (url) {
    const title = words && !/[\r\n]/.test(words) && words !== url ? words : url
    return { kind: 'link', url, title }
  }
  return words ? { kind: 'text', text: plain } : null
}

/**
 * A Markdown link that survives what the title and address carry: brackets and backslashes in the
 * title are escaped, so `[x] done` does not end the link text, and the characters that would end
 * the address (spaces, parentheses, angle brackets) are percent-encoded. Runs of whitespace in the
 * title become one space.
 */
export function markdownLink(title: string, url: string): string {
  const t = title.replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, (c) => `\\${c}`)
  // encodeURIComponent leaves parentheses as they are, and they are what ends the address
  const u = url.replace(/[\s()<>]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)))
  return `[${t}](${u})`
}

/** The text a dropped item puts into the message */
export function droppedPiece(d: DroppedText): string {
  return d.kind === 'link' ? markdownLink(d.title, d.url) : d.text
}

/**
 * Puts `piece` in place of the selection `start`..`end` of `text`, with a space on either side
 * where it would otherwise touch a word, and a space after it at the end so typing can go on.
 * Returns the new text and where the caret goes: right after what was inserted (and its space).
 */
export function insertAtCaret(text: string, start: number, end: number, piece: string): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  const before = text.slice(0, from)
  const after = text.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = /^\s/.test(after) ? '' : ' '
  const head = `${before}${lead}${piece}${trail}`
  return { text: `${head}${after}`, caret: head.length }
}

/**
 * Whether a drag is text or a link the composer takes, judged from its types alone (its data is
 * hidden until the drop). A drag carrying one of our own types other than the window's mark is a
 * session, a panel, a project or a path, and belongs to whoever handles those (#286). Our mark alone
 * is text or a link dragged out of the conversation, which goes in like any other.
 */
export function isTextDrag(types: readonly string[]): boolean {
  if (types.some((t) => t.startsWith('application/x-cc-') && t !== INTERNAL_DRAG_MIME)) return false
  return types.includes('text/uri-list') || types.includes('text/plain')
}

/**
 * A link dragged in from outside the window (a browser's address, a link in a mail): the whole
 * session pane takes it, as it takes a file (#116), since the composer is often folded away. A link
 * or text from inside the window only lands on the composer itself: a selection dragged a little way
 * inside the conversation should not end up in the message.
 */
export function isOutsideLink(types: readonly string[]): boolean {
  return types.includes('text/uri-list') && !types.includes('Files') && !types.some((t) => t.startsWith('application/x-cc-'))
}

import { isObj } from '../../json-value.js'

/** The loose shape the adapter reads SDK messages in, and the string reader it uses on them (one meaning, json-value.ts, #850) */
export type Json = Record<string, unknown>
export { str } from '../../json-value.js'

/**
 * The blocks of an SDK message's `message.content`, always a list of objects. The CLI writes a plain string there when a
 * message is only words — the summary it feeds back after `/compact` is one — and a reader that took the field for a list
 * threw inside the stream loop, which the adapter reported as the whole process crashed. A string reads as one text block
 * (as the imported history does, history.ts `readableMessage`); anything else that is not a list reads as none, and a
 * block that is not an object is left out.
 */
export function contentBlocks(m: Json): Json[] {
  const content = (m.message as Json | undefined)?.content
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content.filter(isObj) : []
}

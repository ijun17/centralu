import { z } from 'zod'

/**
 * Reading JSON the store (or a setting in it) holds (#850 item 5): **a value that cannot be read fails only itself.**
 *
 * A stored value can be unreadable for reasons this build cannot rule out: a write cut short, a newer build that wrote
 * another shape (the old and new host of a swap share the file), a hand edit. Each reader decides what such a value
 * reads as — a row keeps its place with an empty payload, a list drops the element, a setting reads as its default —
 * but none of them may throw, because a throw fails the whole list or page the value was read in.
 */

/** The parsed value, or `undefined` for nothing stored or text that is not JSON */
export function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** A JSON object (not a list, not null), every field kept */
export const JsonObject = z.record(z.string(), z.unknown())
export type JsonObject = z.infer<typeof JsonObject>

/** `raw` read as `schema`; `fallback` when nothing is stored, the text is not JSON, or the value is not that shape */
export function readJson<T>(raw: string | null | undefined, schema: z.ZodType<T>, fallback: T): T {
  const r = schema.safeParse(parseJson(raw))
  return r.success ? r.data : fallback
}

/**
 * `raw` read as a list of `item`: anything that is not a list reads as empty, and an element that is not that shape is
 * skipped, so one bad element does not cost the others. An element keeps whatever the schema keeps: use a loose
 * object for a list written back after a change, so a field a newer build added survives.
 */
export function readJsonList<T>(raw: string | null | undefined, item: z.ZodType<T>): T[] {
  const v = parseJson(raw)
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (const x of v) {
    const r = item.safeParse(x)
    if (r.success) out.push(r.data)
  }
  return out
}

/**
 * `raw` read as a list of objects, the way another build may have left it (#384): a value that is not JSON or not a
 * list reads as empty, and an element that is not an object or lacks what `has` asks for is skipped. An element keeps
 * every field it has, so writing the list back after a change does not drop what a newer build added to it.
 */
export function readJsonObjects<T extends object>(raw: string | null | undefined, has: (x: JsonObject) => boolean): T[] {
  return readJsonList(raw, JsonObject).filter(has) as unknown as T[]
}

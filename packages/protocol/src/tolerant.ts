import type { z } from 'zod'

/**
 * Reads a payload another build sent, so that **its defaults apply** and **one value this build
 * does not understand costs only that value** (docs/protocol.md §4).
 *
 * The first half is the reason this exists. A field the protocol added carries a `.default()`, and
 * the types on this side are the parser's output, so the code reads the field as always present.
 * That is true only if the payload went through the schema. A beta.9 window attached to a beta.7
 * host (#280 lets a window outlive its host's build) took the session list as it came, without
 * `backgroundTasks` (#305), and the first `.filter` on it took the screen down.
 *
 * The second half keeps the other direction working. A newer host can send a word this build's
 * enum does not have, or a value of a shape it later widened. A plain parse fails the whole
 * payload for it, and a session list is a lot to lose over one badge. So when the whole parse
 * fails, the payload is read again piece by piece: objects field by field, arrays element by
 * element, and a value that still fails on its own is kept as it came, which is exactly what this
 * client did with every payload before it parsed any. Fields the schema does not know are dropped,
 * as a successful parse drops them, unless the object is declared loose.
 *
 * Not a validator. Nothing here rejects; the host's own answers are trusted, and this only fills
 * in what an older one could not have known to send.
 */
export function parseTolerant<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw)
  return (parsed.success ? parsed.data : salvage(schema, raw)) as z.output<S>
}

/** The parts of a schema's definition the piecewise read walks through */
type Def = {
  type: string
  innerType?: z.ZodType
  shape?: Record<string, z.ZodType>
  catchall?: z.ZodType
  element?: z.ZodType
  valueType?: z.ZodType
  getter?: () => z.ZodType
  options?: z.ZodType[]
  discriminator?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function salvage(schema: z.ZodType, raw: unknown): unknown {
  const def = schema.def as unknown as Def
  switch (def.type) {
    case 'optional':
    case 'nullable':
      return raw === undefined || raw === null ? raw : parseTolerant(def.innerType!, raw)
    case 'default':
    case 'prefault':
      // A missing value parses to the default on its own, so only a present one can be what failed
      return raw === undefined ? schema.safeParse(undefined).data : parseTolerant(def.innerType!, raw)
    case 'lazy':
      return parseTolerant(def.getter!(), raw)
    case 'object': {
      if (!isRecord(raw)) return raw
      const shape = def.shape!
      // A loose object keeps what it does not declare; a plain one drops it, as a successful parse would
      const out: Record<string, unknown> = def.catchall && def.catchall.def.type !== 'never' ? { ...raw } : {}
      for (const [key, field] of Object.entries(shape)) {
        const value = parseTolerant(field, raw[key])
        if (value !== undefined || key in raw) out[key] = value
      }
      return out
    }
    case 'array':
      return Array.isArray(raw) ? raw.map((item) => parseTolerant(def.element!, item)) : raw
    case 'record':
      return isRecord(raw) ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, parseTolerant(def.valueType!, v)])) : raw
    case 'union': {
      // A tagged union can still be read piecewise as the branch its tag names; an untagged one cannot be told apart
      if (!def.discriminator || !isRecord(raw)) return raw
      const tag = raw[def.discriminator]
      const branch = def.options!.find((o) => (o.def as unknown as Def).shape?.[def.discriminator!]?.safeParse(tag).success)
      return branch ? salvage(branch, raw) : raw
    }
    default:
      // An enum, a primitive, a transform: nothing smaller to fall back to than the value itself
      return raw
  }
}

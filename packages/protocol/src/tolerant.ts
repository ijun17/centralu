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
export function parseTolerant<S extends z.ZodType>(schema: S, raw: unknown): z.output<S>
// What was salvaged is the payload as it came, not a parse: declaring it as the schema's output is the point of the
// function (a tolerant client reads what an older or newer host sent as its own types), so the declaration is here and
// the implementation answers `unknown`.
export function parseTolerant(schema: z.ZodType, raw: unknown): unknown {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : salvage(schema, raw)
}

/** The parts of a schema's definition the piecewise read walks through */
type Def = {
  type: string
  innerType?: z.ZodType
  shape?: Record<string, z.ZodType>
  catchall?: z.ZodType
  element?: z.ZodType
  valueType?: z.ZodType
  getter?: () => z.ZodType | undefined
  options?: z.ZodType[]
  discriminator?: string
}

/** A JSON object (not an array, not null): what the tolerant reader and the schema test helpers walk into */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isSchema = (v: unknown): v is z.ZodType => isRecord(v) && typeof v.safeParse === 'function' && isRecord(v.def)
const isFunction = (v: unknown): v is () => unknown => typeof v === 'function'
const schemaOrUndefined = (v: unknown): z.ZodType | undefined => (isSchema(v) ? v : undefined)

/** What a schema's definition holds of the parts above; zod's own types do not name them for every kind of schema */
function defOf(schema: z.ZodType): Def {
  const d: Record<string, unknown> = isRecord(schema.def) ? schema.def : {}
  const { shape, getter, options, discriminator } = d
  return {
    type: typeof d.type === 'string' ? d.type : '',
    innerType: schemaOrUndefined(d.innerType),
    shape: isRecord(shape) ? Object.fromEntries(Object.entries(shape).filter((e): e is [string, z.ZodType] => isSchema(e[1]))) : undefined,
    catchall: schemaOrUndefined(d.catchall),
    element: schemaOrUndefined(d.element),
    valueType: schemaOrUndefined(d.valueType),
    getter: isFunction(getter) ? () => schemaOrUndefined(getter()) : undefined,
    options: Array.isArray(options) ? options.filter(isSchema) : undefined,
    discriminator: typeof discriminator === 'string' ? discriminator : undefined,
  }
}

function salvage(schema: z.ZodType, raw: unknown): unknown {
  const def = defOf(schema)
  switch (def.type) {
    case 'optional':
    case 'nullable':
      return raw === undefined || raw === null || !def.innerType ? raw : parseTolerant(def.innerType, raw)
    case 'default':
    case 'prefault':
      // A missing value parses to the default on its own, so only a present one can be what failed
      if (raw === undefined) return schema.safeParse(undefined).data
      return def.innerType ? parseTolerant(def.innerType, raw) : raw
    case 'lazy': {
      const inner = def.getter?.()
      return inner ? parseTolerant(inner, raw) : raw
    }
    case 'object': {
      if (!isRecord(raw)) return raw
      // A loose object keeps what it does not declare; a plain one drops it, as a successful parse would
      const out: Record<string, unknown> = def.catchall && def.catchall.def.type !== 'never' ? { ...raw } : {}
      for (const [key, field] of Object.entries(def.shape ?? {})) {
        const value = parseTolerant(field, raw[key])
        if (value !== undefined || key in raw) out[key] = value
      }
      return out
    }
    case 'array': {
      const element = def.element
      return Array.isArray(raw) && element ? raw.map((item: unknown) => parseTolerant(element, item)) : raw
    }
    case 'record': {
      const valueType = def.valueType
      return isRecord(raw) && valueType ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, parseTolerant(valueType, v)])) : raw
    }
    case 'union': {
      // A tagged union can still be read piecewise as the branch its tag names; an untagged one cannot be told apart
      const tagName = def.discriminator
      if (!tagName || !isRecord(raw)) return raw
      const tag = raw[tagName]
      const branch = def.options?.find((o) => defOf(o).shape?.[tagName]?.safeParse(tag).success)
      return branch ? salvage(branch, raw) : raw
    }
    default:
      // An enum, a primitive, a transform: nothing smaller to fall back to than the value itself
      return raw
  }
}

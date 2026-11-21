import type { z } from 'zod'

/**
 * Reads another build's payload so its defaults apply and a value this build cannot read costs only that value
 * (docs/protocol.md §4). Not a validator: nothing here rejects, as the host's own answers are trusted.
 */
export function parseTolerant<S extends z.ZodType>(schema: S, raw: unknown): z.output<S>
// What was salvaged is the payload as it came, not a parse: declaring it as the schema's output is the point of the
// function (a tolerant client reads what an older or newer host sent as its own types), so the declaration is here and
// the implementation answers `unknown`.
export function parseTolerant(schema: z.ZodType, raw: unknown): unknown {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : salvage(schema, raw)
}

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

/** Not an array, not null */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isSchema = (v: unknown): v is z.ZodType =>
  isRecord(v) && typeof v.safeParse === 'function' && isRecord(v.def)
const isFunction = (v: unknown): v is () => unknown => typeof v === 'function'
const schemaOrUndefined = (v: unknown): z.ZodType | undefined => (isSchema(v) ? v : undefined)

/** zod's own types do not name these parts for every kind of schema */
function defOf(schema: z.ZodType): Def {
  const d: Record<string, unknown> = isRecord(schema.def) ? schema.def : {}
  const { shape, getter, options, discriminator } = d
  return {
    type: typeof d.type === 'string' ? d.type : '',
    innerType: schemaOrUndefined(d.innerType),
    shape: isRecord(shape)
      ? Object.fromEntries(Object.entries(shape).filter((e): e is [string, z.ZodType] => isSchema(e[1])))
      : undefined,
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
      return isRecord(raw) && valueType
        ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, parseTolerant(valueType, v)]))
        : raw
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

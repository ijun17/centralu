import type { z } from 'zod'
import { SessionInfo, sessionLiveDefaults } from './commands.js'

/**
 * Test-only helpers for the rule in docs/protocol.md §4: a field added to a host payload has a
 * default, and the client applies it. Not exported from the package index, so nothing ships them.
 */

type Def = {
  type: string
  innerType?: z.ZodType
  in?: z.ZodType
  shape?: Record<string, z.ZodType>
  element?: z.ZodType
  valueType?: z.ZodType
  getter?: () => z.ZodType
  options?: z.ZodType[]
  discriminator?: string
}

const defOf = (s: z.ZodType) => s.def as unknown as Def
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The schema a value is read by once optional, nullable, default, catch, lazy and pipe wrappers are taken off */
function core(schema: z.ZodType): z.ZodType {
  const def = defOf(schema)
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
      return core(def.innerType!)
    case 'lazy':
      return core(def.getter!())
    case 'pipe':
      return core(def.in!)
    default:
      return schema
  }
}

/** Whether a missing value parses to something: a `.default()` anywhere among the field's wrappers */
function hasDefault(field: z.ZodType): boolean {
  const def = defOf(field)
  if (def.type === 'default' || def.type === 'prefault') return true
  if (['optional', 'nullable', 'catch', 'readonly'].includes(def.type)) return hasDefault(def.innerType!)
  return false
}

/** The branch of a union this value belongs to: by its tag when the union has one, else the first that accepts it */
function branchOf(schema: z.ZodType, value: unknown): z.ZodType | undefined {
  const def = defOf(schema)
  if (def.discriminator && isRecord(value)) {
    return def.options!.find((o) => defOf(core(o)).shape?.[def.discriminator!]?.safeParse(value[def.discriminator!]).success)
  }
  return def.options!.find((o) => o.safeParse(value).success)
}

/**
 * The payload as a host from before every defaulted field would have sent it: each field whose schema carries a
 * `.default()` is taken out, at every depth. A field the protocol added later always has a default (§4), so this is a
 * superset of any older host's omissions — it also drops fields that were there from the start and happen to have a
 * default, which a client has to survive just the same.
 */
export function withoutDefaultedFields(schema: z.ZodType, value: unknown): unknown {
  const c = core(schema)
  const def = defOf(c)
  if (value === undefined || value === null) return value
  switch (def.type) {
    case 'object': {
      if (!isRecord(value)) return value
      const out: Record<string, unknown> = {}
      for (const [key, v] of Object.entries(value)) {
        const field = def.shape![key]
        if (!field) out[key] = v
        else if (!hasDefault(field)) out[key] = withoutDefaultedFields(field, v)
      }
      return out
    }
    case 'array':
      return Array.isArray(value) ? value.map((v) => withoutDefaultedFields(def.element!, v)) : value
    case 'record':
      return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutDefaultedFields(def.valueType!, v)])) : value
    case 'union': {
      const branch = branchOf(c, value)
      return branch ? withoutDefaultedFields(branch, value) : value
    }
    default:
      return value
  }
}

/** Every path at which a field with a default is missing from `value` — empty when the client applied them all */
export function missingDefaults(schema: z.ZodType, value: unknown, path = '$'): string[] {
  const c = core(schema)
  const def = defOf(c)
  if (value === undefined || value === null) return []
  switch (def.type) {
    case 'object': {
      if (!isRecord(value)) return []
      return Object.entries(def.shape!).flatMap(([key, field]) => {
        if (hasDefault(field) && value[key] === undefined) return [`${path}.${key}`]
        return missingDefaults(field, value[key], `${path}.${key}`)
      })
    }
    case 'array':
      return Array.isArray(value) ? value.flatMap((v, i) => missingDefaults(def.element!, v, `${path}[${i}]`)) : []
    case 'record':
      return isRecord(value) ? Object.entries(value).flatMap(([k, v]) => missingDefaults(def.valueType!, v, `${path}.${k}`)) : []
    case 'union': {
      const branch = branchOf(c, value)
      return branch ? missingDefaults(branch, value, path) : []
    }
    default:
      return []
  }
}

/** A session as the current host lists it, with every live field filled in */
export function currentSession(id: string): SessionInfo {
  return SessionInfo.parse({
    id,
    projectId: 'p1',
    kind: 'worker',
    tool: 'some-tool',
    externalId: null,
    name: id,
    autoNamed: false,
    state: 'working',
    lastReadSeq: 0,
    lastSeq: 3,
    createdAt: 1,
    waitingSince: null,
    live: true,
    model: null,
    effort: null,
    verbosity: null,
    serviceTier: null,
    permissionPreset: 'normal',
    importedFrom: null,
    worktree: null,
    parentSessionId: null,
    scopeSessionIds: null,
    roleAppend: null,
    appId: null,
    ...sessionLiveDefaults(),
    backgroundTasks: [{ id: 't1', kind: 'shell', description: 'npm run dev', status: 'running' }],
  })
}


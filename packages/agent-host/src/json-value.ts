/**
 * Reading JSON another program sent (a linked machine, an agent CLI, its files), one field at a time.
 *
 * Each of these was written by hand about a dozen times under the same few names with three meanings (#850):
 * `str` was "a string, else ''" in one file and "a trimmed, non-empty string, else undefined" in the next, and
 * `obj` took a list for an object in one adapter and not in the links. Each meaning has one name here, so a
 * caller says which it means.
 */

/** A JSON object, before its fields are read */
export type Obj = Record<string, unknown>

/** Whether a value is a JSON object: not null, not a list */
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The value if it is a JSON object, else an empty one, so its fields read as absent */
export const asObj = (v: unknown): Obj => (isObj(v) ? v : {})

/** A string as it is, empty included; `fallback` ('' unless given) for anything else */
export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** Whether a value is a string with at least one character in it (whitespace counts) */
export const isFilled = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** A string with at least one character in it, as it is; null for anything else, an empty string included */
export const filled = (v: unknown): string | null => (isFilled(v) ? v : null)

/** A string with something other than whitespace in it, trimmed; undefined for anything else, a blank string included */
export const trimmed = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A finite number; undefined for anything else */
export const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

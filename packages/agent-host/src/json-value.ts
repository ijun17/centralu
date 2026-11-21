/** Reading JSON another program sent (a linked machine, an agent CLI, its files) one field at a time; each meaning has one name here (#850) */

export type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export const asObj = (v: unknown): Obj => (isObj(v) ? v : {})

/** A string as it is, empty included; `fallback` ('' unless given) for anything else */
export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

/** Whether a value is a string with at least one character in it (whitespace counts) */
export const isFilled = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** A string with at least one character in it, as it is; null for anything else, an empty string included */
export const filled = (v: unknown): string | null => (isFilled(v) ? v : null)

/** A string with something other than whitespace in it, trimmed; undefined for anything else, a blank string included */
export const trimmed = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The JSON in `text`; undefined when it is not JSON (JSON has no undefined, so a parsed value never reads as a failure) */
export const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}


export const jsonObject = (v: unknown): Obj => (typeof v === 'string' ? jsonObject(tryParseJson(v)) : asObj(v))

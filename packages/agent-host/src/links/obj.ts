/** A JSON object another machine sent, before its fields are read (#428: the links' four copies of this check) */
export type Obj = Record<string, unknown>

/** Whether a value a machine sent is a JSON object: not null, not an array */
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

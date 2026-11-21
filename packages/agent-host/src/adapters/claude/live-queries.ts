import type { ModelQuery } from './models.js'
import type { UsageQuery } from './usage.js'

/**
 * Usage and the model list are properties of the **account**, but the SDK puts both only on a Query, so a live query
 * is borrowed: any session gives the same answer. **Only live queries are kept here** (#157): a closed or dead one
 * cannot answer while an older session still can. Insertion order is start order.
 */
export const liveQueries = new Set<UsageQuery & ModelQuery>()
/** The ids of usage probe sessions (#726): they are never in `liveQueries` */
export const probeIds = new Set<string>()
/** Which session each live query belongs to, for the log line when one cannot answer (#481) */
export const querySessions = new WeakMap<object, string>()

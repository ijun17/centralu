import type { ModelQuery } from './models.js'
import type { UsageQuery } from './usage.js'

/**
 * The channel used to ask about usage.
 *
 * Usage is a property of the **account**, but the SDK only puts that method on a session
 * (Query). So this borrows one live query — the answer is the same no matter which session is
 * asked.
 */
/**
 * Usage and the model list are both properties of the account, but the SDK puts both only on a
 * Query — a live query is borrowed for both.
 *
 * **Only live queries are kept here** (#157). This used to hold on to the single most-recently
 * started query even after that session closed or died, so it kept asking a dead query while an
 * older session was still alive. Insertion order is the same as start order.
 */
export const liveQueries = new Set<UsageQuery & ModelQuery>()
/** The ids of usage probe sessions (#726): they are never in `liveQueries` */
export const probeIds = new Set<string>()
/** Which session each live query belongs to, for the log line when one cannot answer (#481) */
export const querySessions = new WeakMap<object, string>()

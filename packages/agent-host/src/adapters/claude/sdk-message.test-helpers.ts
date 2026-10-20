import type { ClaudeMessage } from './json.js'

/**
 * A message for a test, written with only the fields the code under test reads, or on purpose with fields the SDK's
 * type does not allow (a string where it has a list, a `null` block). The stream hands the adapter whole SDK messages
 * (#1339); a test's are shorter, so it says so here instead of at the adapter.
 */
export const sdk = (m: unknown): ClaudeMessage => m as ClaudeMessage

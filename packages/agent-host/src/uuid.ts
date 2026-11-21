import type { randomUUID } from 'node:crypto'

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A UUID as `randomUUID` writes one: the ids the host mints for inputs (#1377), sessions and worktree folders. Stricter than
 * `isSessionId` (@cc/protocol), which asks only for one path segment
 */
export function isUuid(s: string): s is ReturnType<typeof randomUUID> {
  return UUID_FORMAT.test(s)
}

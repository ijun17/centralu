// An agent's path is often relative to where it was looking (`Media/X.cs` for `Widgets.Cli/Media/X.cs`), so a link is
// matched by suffix, at segment boundaries, against files that exist (#39). Several matches: the person picks.

import { wireSegments } from '@cc/protocol/client'

/** Shallowest first. The closer to the root, the more likely it is what the person meant */
function depth(path: string): number {
  return wireSegments(path).length
}

/**
 * Whichever of `paths` end with `ref`, an exact match first. An empty `ref` would match every path; one starting with
 * `/` was already resolved against the root (parseFileRef).
 */
export function suffixMatches(paths: readonly string[], ref: string): string[] {
  if (!ref || ref.startsWith('/')) return []
  const tail = `/${ref}`
  const hits = paths.filter((p) => p === ref || p.endsWith(tail))
  return [...new Set(hits)].sort((a, b) => (a === ref ? -1 : b === ref ? 1 : depth(a) - depth(b) || a.localeCompare(b)))
}

/**
 * Matching a path an agent wrote to a real file inside the project (the story behind #39).
 *
 * A link always opens **relative to the project root**. But the path an agent writes is often
 * relative to wherever it happened to be looking — especially true in a monorepo or a solution.
 * An actual case (user's observation, 2026-09-07):
 *
 *     What the agent wrote: `Media/ImageSearch.cs`
 *     Where it really is:   `WzComparerR2.Cli/Media/ImageSearch.cs`
 *
 * Since that file does not exist at the root, the viewer could only say "could not open it." To
 * a person's eye, a perfectly fine-looking path looks like a dead link.
 *
 * So it does **suffix matching**: it looks through the project's file list for a path that ends
 * with `…/<the written path>`. Only matched at segment boundaries — `Media/ImageSearch.cs`
 * matches `X/Media/ImageSearch.cs` but not `X/OldMedia/ImageSearch.cs`. This uses the property
 * that a truncated-at-the-front path still has its tail intact, and this is a confirmation, not
 * a guess — the candidates are files that actually exist.
 *
 * If there is one, it opens. If there are several, **the person is asked to pick** — picking one
 * for them would be a guess dressed up as a fact.
 */

import { wireSegments } from '@cc/protocol'

/** Shallowest first. The closer to the root, the more likely it is what the person meant */
function depth(path: string): number {
  return wireSegments(path).length
}

/**
 * Whichever of `paths` end with `ref`. An exact match always comes first.
 *
 * Nothing is matched if `ref` is empty or starts with `/` — an absolute path should already have
 * been resolved relative to the root (parseFileRef), and an empty value would match every path.
 */
export function suffixMatches(paths: readonly string[], ref: string): string[] {
  if (!ref || ref.startsWith('/')) return []
  const tail = `/${ref}`
  const hits = paths.filter((p) => p === ref || p.endsWith(tail))
  return [...new Set(hits)].sort((a, b) => (a === ref ? -1 : b === ref ? 1 : depth(a) - depth(b) || a.localeCompare(b)))
}

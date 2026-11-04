import type { Store } from '../dev-services/store.js'

/**
 * The generation walk of `HandoffNotes.handoffHeir`, over the store alone (also the stale-id help's, #1981): the newest successor
 * of this session that `isLive` accepts. A successor that was removed passes on to its own successors, newest first; the nearest
 * generation with a live one wins.
 */
export function liveHeirOf(store: Pick<Store, 'handoffs'>, sessionId: string, isLive: (id: string) => boolean): string | null {
  const seen = new Set([sessionId])
  let generation = [sessionId]
  while (generation.length) {
    const heirs = generation.flatMap((at) => store.handoffs.handoffHeirs(at)).filter((h) => !seen.has(h.sessionId))
    for (const h of heirs) seen.add(h.sessionId)
    const live = heirs.find((h) => !h.trashed && isLive(h.sessionId))
    if (live) return live.sessionId
    generation = heirs.map((h) => h.sessionId)
  }
  return null
}

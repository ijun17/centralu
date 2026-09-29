import { CLIENT_INFO } from '@cc/protocol'
import type { ModelOption } from '@cc/protocol'
import { homedir } from 'node:os'
import { CodexClient } from './client.js'
import { isUnknownMethod, UNSUPPORTED } from './history.js'

/**
 * The list of models available to choose from (`model/list`).
 *
 * **We do not maintain this list ourselves.** Whatever codex reports is carried through as-is —
 * hard-coding it would leave only this app silently falling behind every time a new model ships.
 *
 * Reasoning effort levels come along here too (`supportedReasoningEfforts`). Since the levels
 * differ per model, they have to stay attached to the model so that "does this combination work?"
 * has one single answer.
 *
 * Takes no cwd, since this is a property of the account. Starting the client just needs some
 * directory, so home is used (the same approach as reading usage).
 */
/** The page ceiling. Set well above the actual number of models, so hitting it means something has gone wrong */
const MAX_PAGES = 20

/**
 * Follows the cursor to collect **all the way to the end.**
 *
 * At first, only the first page was read. This is the kind of bug where a short-looking list just
 * gets accepted as "I guess that is all of them" — nobody noticed until a user asked "does this
 * really fetch everything?"
 *
 * Kept as a pure function that receives paging as an argument: being able to verify "does it
 * really run to the end" without starting codex means a test catches this mistake first if it
 * happens again.
 */
export async function collectModels(
  fetchPage: (cursor: string | null) => Promise<{ data?: unknown; nextCursor?: unknown }>,
): Promise<ModelOption[]> {
  const out: ModelOption[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(cursor)
    out.push(...toModelOptions(res?.data))
    cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null
    if (!cursor) return out
  }
  // Does not truncate silently — the worst outcome is showing a cut-off list as though it were complete
  throw new Error(`Too many models; read only ${MAX_PAGES} pages (list truncated)`)
}

export async function listCodexModels(command: string): Promise<ModelOption[]> {
  const client = new CodexClient(
    { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
    { cwd: homedir(), command },
  )
  try {
    await client.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    })
    client.notify('initialized')
    /*
     * **Reads all the way to the end.** The response has a nextCursor — reading only the first
     * page silently drops the later models. This is exactly the kind of bug a short-looking list
     * lets slide as "I guess that is all of them", so this loops until the cursor is null.
     *
     * A ceiling is placed on the number of pages. If the server just keeps returning a cursor
     * forever, stopping is better than looping forever — but instead **it says it was truncated**.
     */
    /*
     * **The await here must not be removed.** A bare return would let finally run right there and
     * kill the server while the request is still in flight — this was the reason the codex model
     * list never once succeeded (the screen was left with only "Default").
     */
    return await collectModels(async (cursor) => {
      try {
        return await client.request<{ data?: unknown; nextCursor?: unknown }>(
          'model/list',
          cursor ? { cursor } : {},
        )
      } catch (err) {
        throw isUnknownMethod(err) ? new Error(UNSUPPORTED) : err
      }
    })
  } finally {
    await client.dispose().catch(() => {})
  }
}

/** Response into our own type. Split out as a pure function so a format change is caught without starting codex */
export function toModelOptions(data: unknown): ModelOption[] {
  const rows = Array.isArray(data) ? data : []
  const out: ModelOption[] = []
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>
    const id = typeof row.model === 'string' && row.model ? row.model : undefined
    if (!id) continue
    // A model hidden from the default list is hidden by us too — codex has a reason for hiding it
    if (row.hidden === true) continue
    /*
     * The actual shape of an effort entry is `{ reasoningEffort, description }`
     * (generated/v2/ReasoningEffortOption.ts). We first guessed `{ effort }` and read that, which
     * always produced an empty array — so the effort selector never showed up at all for codex
     * sessions. A test was even written against the guessed shape, so it passed too.
     * A plain string is also accepted here: if the format changes, the list does not go entirely empty.
     */
    const efforts: string[] = []
    for (const e of Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []) {
      const v = typeof e === 'string' ? e : ((e ?? {}) as { reasoningEffort?: unknown }).reasoningEffort
      if (typeof v === 'string' && v) efforts.push(v)
    }
    /*
     * Response-speed tiers. Measured shape: serviceTiers: [{id:'priority', name:'Fast',
     * description:'1.5x speed, increased usage'}] — the name and description are carried through
     * unchanged. (additionalSpeedTiers is deprecated, so it is not read.)
     */
    const tiers: { id: string; name: string; description: string }[] = []
    for (const t of Array.isArray(row.serviceTiers) ? row.serviceTiers : []) {
      const tier = (t ?? {}) as { id?: unknown; name?: unknown; description?: unknown }
      if (typeof tier.id === 'string' && tier.id) {
        tiers.push({
          id: tier.id,
          name: typeof tier.name === 'string' && tier.name ? tier.name : tier.id,
          description: typeof tier.description === 'string' ? tier.description : '',
        })
      }
    }
    out.push({
      id,
      label: typeof row.displayName === 'string' && row.displayName ? row.displayName : id,
      description: typeof row.description === 'string' && row.description ? row.description : undefined,
      efforts: [...new Set(efforts)],
      defaultEffort:
        typeof row.defaultReasoningEffort === 'string' && row.defaultReasoningEffort
          ? row.defaultReasoningEffort
          : null,
      tiers,
    })
  }
  return out
}

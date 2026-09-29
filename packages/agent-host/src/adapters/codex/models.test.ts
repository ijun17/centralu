import { describe, expect, it } from 'vitest'
import { collectModels, toModelOptions } from './models.js'

/**
 * Since we decided not to maintain the list ourselves, **a test must be the first thing** to say
 * so if the response format changes. This is why it is split out as a pure function that can be
 * verified without starting codex.
 */
describe('toModelOptions', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'x',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    description: '설명',
    hidden: false,
    /*
     * **Uses the generated type exactly.** This shape used to be written from a guess, and the
     * implementation was making the same guess, so the two happily agreed on the wrong shape and
     * passed anyway. A test that checks one guess against another guarantees nothing — pinning it
     * to the type is what nails it down.
     */
    /*
     * The shape is written out here instead of importing the generated
     * ReasoningEffortOption: generated/ is deliberately not committed (see
     * codex-bindings.mjs — the adapter imports none of it, and protocol drift
     * is caught by the contract check, not by these types). Importing it here
     * broke the first CI typecheck ever run on Linux, because only machines
     * with the codex CLI have the files. If codex renames these fields, the
     * contract check is the tripwire — not this literal.
     */
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '빠르게' },
      { reasoningEffort: 'medium', description: '보통' },
      { reasoningEffort: 'high', description: '깊게' },
    ] satisfies { reasoningEffort: string; description: string }[],
    defaultReasoningEffort: 'medium',
    ...over,
  })

  it('carries the model and its reasoning effort levels together — effort must stay attached to the model for the answer to be single', () => {
    expect(toModelOptions([row()])).toEqual([
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        description: '설명',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        tiers: [],
      },
    ])
  })

  /** Response-speed tiers — measured shape: serviceTiers: [{id:'priority', name:'Fast', description:'1.5x…'}] */
  it('carries a speed tier through with its name and description — the usage warning text is codex\'s own wording, verbatim', () => {
    const out = toModelOptions([
      row({ serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] }),
    ])
    expect(out[0]!.tiers).toEqual([{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }])
  })

  it('drops a broken tier entry but keeps the rest of the list alive', () => {
    const out = toModelOptions([row({ serviceTiers: [{ name: 'no-id' }, { id: 'ok' }] })])
    expect(out[0]!.tiers).toEqual([{ id: 'ok', name: 'ok', description: '' }])
  })

  it('a model codex hides is hidden by us too', () => {
    expect(toModelOptions([row({ hidden: true })])).toEqual([])
  })

  it('reads effort even when it arrives as plain strings — so a format change does not empty the list entirely', () => {
    const out = toModelOptions([row({ supportedReasoningEfforts: ['low', 'high'] })])
    expect(out[0]!.efforts).toEqual(['low', 'high'])
  })

  it('drops an effort entry that has only unknown keys — an empty string must not land in the selector', () => {
    const out = toModelOptions([row({ supportedReasoningEfforts: [{ effort: 'low' }, {}] })])
    expect(out[0]!.efforts).toEqual([])
  })

  it('passes over an unrecognized shape silently — one bad entry must not kill the whole list', () => {
    expect(toModelOptions([null, { model: '' }, 'nope', row()])).toHaveLength(1)
    expect(toModelOptions(undefined)).toEqual([])
  })

  it('falls back to the id when there is no display name — better than showing a blank line', () => {
    expect(toModelOptions([row({ displayName: '' })])[0]!.label).toBe('gpt-5.6-terra')
  })
})

/**
 * "Does this actually fetch every model codex has available?" — it did not. Only the first page
 * was being read, and nextCursor was thrown away. This guards against that regression.
 */
describe('collectModels — follows the cursor all the way to the end', () => {
  const m = (name: string) => ({ model: name, displayName: name, supportedReasoningEfforts: [] })

  it('stitches multiple pages together', async () => {
    const pages: Record<string, { data: unknown[]; nextCursor: string | null }> = {
      '': { data: [m('a'), m('b')], nextCursor: 'c1' },
      c1: { data: [m('c')], nextCursor: 'c2' },
      c2: { data: [m('d')], nextCursor: null },
    }
    const seen: (string | null)[] = []
    const out = await collectModels(async (cursor) => {
      seen.push(cursor)
      return pages[cursor ?? '']!
    })
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
    // No cursor is sent on the first request; after that, the cursor received is sent back exactly as-is
    expect(seen).toEqual([null, 'c1', 'c2'])
  })

  it('asks only once when there is just one page', async () => {
    let calls = 0
    const out = await collectModels(async () => {
      calls++
      return { data: [m('only')], nextCursor: null }
    })
    expect(out).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it('when the cursor never ends, it does not silently truncate — it says it was truncated', async () => {
    await expect(collectModels(async () => ({ data: [m('x')], nextCursor: 'never-ends' }))).rejects.toThrow(
      /list truncated/,
    )
  })
})

import { describe, expect, it } from 'vitest'
import { readClaudeModels } from './models.js'

const q = (rows: unknown[]) => ({ supportedModels: async () => rows as never })

describe('readClaudeModels', () => {
  it('carries the list the SDK gives as-is — we do not hardcode model names', async () => {
    const out = await readClaudeModels(
      q([
        { value: 'fable', displayName: 'Fable', supportsEffort: true, supportedEffortLevels: ['high', 'max'] },
        { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
      ]),
    )
    expect(out.map((m) => m.id)).toEqual(['fable', 'haiku'])
    expect(out[0]!.efforts).toEqual(['high', 'max'])
  })

  it('ignores effort levels sent along when supportsEffort is false — two answers would conflict', async () => {
    const out = await readClaudeModels(
      q([{ value: 'x', supportsEffort: false, supportedEffortLevels: ['low', 'high'] }]),
    )
    expect(out[0]!.efforts).toEqual([])
  })

  it('uses the id as the label when there is no name', async () => {
    expect((await readClaudeModels(q([{ value: 'opus' }])))[0]!.label).toBe('opus')
  })
})

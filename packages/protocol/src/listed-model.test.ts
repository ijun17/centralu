import { describe, expect, it } from 'vitest'
import { listedModel, type ModelOption } from './entities.js'

const option = (id: string, resolved?: string): ModelOption => ({ id, label: id, efforts: [], defaultEffort: null, tiers: [], ...(resolved ? { resolved } : {}) })

describe('listedModel (#1989)', () => {
  it("finds the entry by its id, else the one alias that names the model, else nothing", () => {
    const list = [option('opus', 'claude-opus-5-5'), option('sonnet')]
    expect(listedModel(list, 'sonnet')?.id).toBe('sonnet')
    expect(listedModel(list, 'claude-opus-5-5')?.id).toBe('opus')
    expect(listedModel(list, 'claude-fable-9')).toBeUndefined()
    expect(listedModel(list, null)).toBeUndefined()
  })

  it("does not count Claude's default row, which names the same model as the alias beside it", () => {
    const list = [option('default', 'claude-opus-5-5'), option('opus', 'claude-opus-5-5'), option('fable', 'claude-fable-5-1')]
    expect(listedModel(list, 'claude-opus-5-5')?.id).toBe('opus')
    expect(listedModel([option('default', 'claude-opus-5-5')], 'claude-opus-5-5')).toBeUndefined()
  })

  it('leaves an id two aliases name as it is', () => {
    expect(listedModel([option('opus', 'claude-opus-5-5'), option('opus[1m]', 'claude-opus-5-5')], 'claude-opus-5-5')).toBeUndefined()
  })
})

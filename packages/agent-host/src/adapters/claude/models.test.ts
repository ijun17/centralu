import { describe, expect, it } from 'vitest'
import { readClaudeModels } from './models.js'

const q = (rows: unknown[]) => ({ supportedModels: async () => rows as never })

describe('readClaudeModels', () => {
  it('SDK가 주는 목록을 그대로 나른다 — 우리가 모델 이름을 적지 않는다', async () => {
    const out = await readClaudeModels(
      q([
        { value: 'fable', displayName: 'Fable', supportsEffort: true, supportedEffortLevels: ['high', 'max'] },
        { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
      ]),
    )
    expect(out.map((m) => m.id)).toEqual(['fable', 'haiku'])
    expect(out[0]!.efforts).toEqual(['high', 'max'])
  })

  it('지원하지 않는다고 했으면 단계가 실려 와도 무시한다 — 답이 둘이면 어긋난다', async () => {
    const out = await readClaudeModels(
      q([{ value: 'x', supportsEffort: false, supportedEffortLevels: ['low', 'high'] }]),
    )
    expect(out[0]!.efforts).toEqual([])
  })

  it('이름이 없으면 id를 쓴다', async () => {
    expect((await readClaudeModels(q([{ value: 'opus' }])))[0]!.label).toBe('opus')
  })
})

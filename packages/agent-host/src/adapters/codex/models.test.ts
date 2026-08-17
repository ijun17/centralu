import { describe, expect, it } from 'vitest'
import type { ReasoningEffortOption } from './generated/v2/ReasoningEffortOption.js'
import { collectModels, toModelOptions } from './models.js'

/**
 * 목록을 우리가 적지 않기로 했으므로, 응답 포맷이 바뀌면 **테스트가 먼저** 알려줘야 한다.
 * codex를 띄우지 않고 검증할 수 있게 순수 함수로 분리해 둔 이유다.
 */
describe('toModelOptions', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'x',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    description: '설명',
    hidden: false,
    /*
     * **생성된 타입 그대로 쓴다.** 전에는 여기 모양을 짐작해서 적었는데,
     * 구현도 같은 짐작을 하고 있어서 둘이 사이좋게 틀린 채로 통과했다.
     * 짐작끼리 맞춰보는 테스트는 아무것도 지켜주지 못한다 — 타입으로 못을 박는다.
     */
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '빠르게' },
      { reasoningEffort: 'medium', description: '보통' },
      { reasoningEffort: 'high', description: '깊게' },
    ] satisfies ReasoningEffortOption[],
    defaultReasoningEffort: 'medium',
    ...over,
  })

  it('모델과 추론 강도를 함께 나른다 — 강도는 모델에 붙어야 답이 하나가 된다', () => {
    expect(toModelOptions([row()])).toEqual([
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        description: '설명',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    ])
  })

  it('codex가 숨긴 모델은 우리도 숨긴다', () => {
    expect(toModelOptions([row({ hidden: true })])).toEqual([])
  })

  it('강도가 문자열로만 와도 읽는다 — 포맷이 바뀌어도 통째로 비지는 않게', () => {
    const out = toModelOptions([row({ supportedReasoningEfforts: ['low', 'high'] })])
    expect(out[0]!.efforts).toEqual(['low', 'high'])
  })

  it('모르는 키만 든 강도 항목은 버린다 — 빈 문자열이 셀렉터에 들어가면 안 된다', () => {
    const out = toModelOptions([row({ supportedReasoningEfforts: [{ effort: 'low' }, {}] })])
    expect(out[0]!.efforts).toEqual([])
  })

  it('모르는 모양은 조용히 흘려보낸다 — 하나가 이상해도 목록 전체가 죽으면 안 된다', () => {
    expect(toModelOptions([null, { model: '' }, 'nope', row()])).toHaveLength(1)
    expect(toModelOptions(undefined)).toEqual([])
  })

  it('이름이 없으면 id를 쓴다 — 빈 줄이 보이는 것보다 낫다', () => {
    expect(toModelOptions([row({ displayName: '' })])[0]!.label).toBe('gpt-5.6-terra')
  })
})

/**
 * "코덱스도 사용 가능한 모델 다 가져오는거지?" — 아니었다.
 * 첫 페이지만 읽고 nextCursor를 버리고 있었다. 그 회귀를 여기서 막는다.
 */
describe('collectModels — 커서를 끝까지 따라간다', () => {
  const m = (name: string) => ({ model: name, displayName: name, supportedReasoningEfforts: [] })

  it('여러 페이지를 이어붙인다', async () => {
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
    // 첫 요청엔 커서를 보내지 않고, 이후엔 받은 커서를 그대로 되돌려준다
    expect(seen).toEqual([null, 'c1', 'c2'])
  })

  it('한 페이지뿐이면 한 번만 묻는다', async () => {
    let calls = 0
    const out = await collectModels(async () => {
      calls++
      return { data: [m('only')], nextCursor: null }
    })
    expect(out).toHaveLength(1)
    expect(calls).toBe(1)
  })

  it('커서가 끝나지 않으면 조용히 자르지 않고 잘렸다고 말한다', async () => {
    await expect(collectModels(async () => ({ data: [m('x')], nextCursor: 'never-ends' }))).rejects.toThrow(
      /list truncated/,
    )
  })
})
